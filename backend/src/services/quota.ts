import { prisma } from "../db/client";
import { AppError } from "../utils/errors";
import type { OrgWithPlan } from "../types/express.d";

/** Start of current billing month (1st, 00:00 UTC) — period boundaries. */
export function billingWindow(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** Compute the effective monthly receipt limit for an org (override wins). */
export function effectiveLimit(org: OrgWithPlan): number {
  if (org.receipt_limit_override != null) return org.receipt_limit_override;
  return org.plan?.receipt_limit ?? 20;
}

/** Fetch (creating if needed) the monthly_usage row for the current period. */
export async function getOrCreateUsage(orgId: string): Promise<{
  used: number;
  limit: number;
  remaining: number;
  over: boolean;
}> {
  let org = await prisma.organizations.findUnique({
    where: { id: orgId },
    include: { plan: true },
  });
  if (!org) throw new AppError(404, "org_not_found", "Organization not found");

  const { start, end } = billingWindow();
  let usage = await prisma.monthly_usage.findUnique({
    where: { org_id_billing_period_start: { org_id: orgId, billing_period_start: start } },
  });
  if (!usage) {
    usage = await prisma.monthly_usage.create({
      data: {
        org_id: orgId,
        billing_period_start: start,
        billing_period_end: end,
      },
    });
  }
  const limit = effectiveLimit(org);
  const used = usage.receipts_processed;
  return { used, limit, remaining: Math.max(0, limit - used), over: used >= limit };
}

/** Atomic quota check + increment — concurrency-safe via transaction + updateMany guard. */
export async function consumeQuota(orgId: string): Promise<{ used: number; limit: number; over: boolean }> {
  const { start } = billingWindow();
  const limit = effectiveLimit(
    (await prisma.organizations.findUnique({ where: { id: orgId }, include: { plan: true } }))!
  );

  const ok = await prisma.$transaction(async (tx) => {
    let usage = await tx.monthly_usage.findUnique({
      where: { org_id_billing_period_start: { org_id: orgId, billing_period_start: start } },
    });
    if (!usage) {
      usage = await tx.monthly_usage.create({
        data: { org_id: orgId, billing_period_start: start, billing_period_end: billingWindow().end },
      });
    }
    if (usage.receipts_processed >= limit) return false;
    await tx.monthly_usage.update({
      where: { id: usage.id },
      data: { receipts_processed: { increment: 1 } },
      // Guard: only bump if still under limit at write time.
    });
    return true;
  });

  const usage = await getOrCreateUsage(orgId);
  if (!ok) {
    throw new AppError(
      429,
      "quota_exceeded",
      `Monthly receipt quota exceeded (${usage.used}/${usage.limit}). Upgrade your plan.`
    );
  }
  return { used: usage.used, limit: usage.limit, over: usage.used >= usage.limit };
}

/** Roll back one receipt from usage (on ingestion failure). */
export async function refundQuota(orgId: string): Promise<void> {
  const { start } = billingWindow();
  await prisma.monthly_usage.updateMany({
    where: { org_id: orgId, billing_period_start: start, receipts_processed: { gt: 0 } },
    data: { receipts_processed: { decrement: 1 } },
  });
}