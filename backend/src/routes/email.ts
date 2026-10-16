import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { AppError, asyncHandler } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { sendEmail, defaultRecipient } from "../services/email";
import { audit } from "../services/audit";

const router = Router();

/**
 * Product email routes — receipt copies, quota alerts, monthly digests.
 * Delivery goes through the configured provider (agentmail / gmail).
 */

/** POST /api/email/receipt/:receiptId  — email a summary copy of one receipt. */
router.post(
  "/receipt/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const receipt = await prisma.receipts.findFirst({
      where: { id: req.params.id, org_id: orgId },
      include: { items: true },
    });
    if (!receipt) throw new AppError(404, "not_found", "Receipt not found");

    const lines = (receipt.items ?? [])
      .map((it) => `  - ${it.name}  x${it.quantity ?? 1}  ${it.price ?? 0}`)
      .join("\n");

    const body = z.object({ to: z.string().email().optional() }).parse(req.body ?? {});
    const to = body.to || defaultRecipient();

    const result = await sendEmail({
      to,
      subject: `Receipt ${receipt.store_name || receipt.id}`,
      text: [
        `Receipt copy`,
        `Store: ${receipt.store_name || "—"}`,
        `Date:  ${receipt.date ? receipt.date.toISOString().slice(0, 10) : "—"}`,
        `Total: $${Number(receipt.total ?? 0).toFixed(2)}`,
        receipt.tax ? `Tax:   $${Number(receipt.tax).toFixed(2)}` : "",
        ``,
        `Items:`,
        lines || "  (none)",
      ].filter(Boolean).join("\n"),
    });

    await audit(orgId, req.user!.id, "email.receipt_copy", { receiptId: receipt.id, to });
    res.json({ ok: true, to, provider: result.provider, messageId: result.messageId });
  })
);

/** POST /api/email/quota-alert  — send the org's current quota status (shown at 80%/100%). */
router.post(
  "/quota-alert",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const org = await prisma.organizations.findUnique({ where: { id: orgId }, include: { plan: true } });
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const usage = await prisma.monthly_usage.findUnique({
      where: { org_id_billing_period_start: { org_id: orgId, billing_period_start: monthStart } },
    });
    const limit = org?.receipt_limit_override ?? org?.plan?.receipt_limit ?? 20;
    const used = usage?.receipts_processed ?? 0;
    const pct = Math.round((used / limit) * 100);

    const body = z.object({ to: z.string().email().optional() }).parse(req.body ?? {});
    const to = body.to || defaultRecipient();

    const result = await sendEmail({
      to,
      subject: `Quota alert — ${org?.plan?.name || "free"} plan at ${pct}%`,
      text: `You've used ${used} of ${limit} receipts (${pct}%). ${
        pct >= 100 ? "Cap reached — upgrade to keep ingesting." : pct >= 80 ? "Upgrade soon to avoid hitting the cap." : ""
      }`,
    });

    await audit(orgId, req.user!.id, "email.quota_alert", { used, limit, pct });
    res.json({ ok: true, to, used, limit, pct, provider: result.provider, messageId: result.messageId });
  })
);

/** POST /api/email/digest  — monthly spending summary for the org. */
router.post(
  "/digest",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const month = (req.body?.month as string) || new Date().toISOString().slice(0, 7);
    const [y, m] = month.split("-").map((n) => parseInt(n, 10));
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));

    const receipts = await prisma.receipts.findMany({
      where: { org_id: orgId, date: { gte: start, lt: end } },
    });
    const total = receipts.reduce((s, r) => s + Number(r.total ?? 0), 0);
    const store = (Object.entries(receipts
      .reduce<Record<string, number>>((acc, r) => {
        const k = r.store_name || "Unknown";
        acc[k] = (acc[k] || 0) + Number(r.total ?? 0);
        return acc;
      }, {})).map(([k, v]) => `  - ${k}: $${v.toFixed(2)}`).join("\n") || "  (none)");

    const to = (req.body?.to as string) || defaultRecipient();
    const result = await sendEmail({
      to,
      subject: `Expense digest — ${month}`,
      text: `Spend for ${month}: $${total.toFixed(2)} across ${receipts.length} receipts.\n\nBy store:\n${store}`,
    });
    await audit(orgId, req.user!.id, "email.digest", { month, total, count: receipts.length });
    res.json({ ok: true, to, month, total, count: receipts.length, provider: result.provider, messageId: result.messageId });
  })
);

export default router;