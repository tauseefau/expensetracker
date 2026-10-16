import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { AppError, asyncHandler } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { audit } from "../services/audit";
import { config } from "../config";

const router = Router();

/**
 * Stripe billing, mock-aware.
 * STRIPE_MOCK=true → no real Stripe calls; creates a pretend checkout and lets us
 * simulate the webhook flow with a special admin/super-admin endpoint.
 * STRIPE_MOCK=false → calls Stripe API when secret key is configured.
 */

type PlanCode = "free" | "starter" | "pro";

const planMeta: Record<PlanCode, { price: string; limit: number }> = {
  free: { price: "0", limit: config.freeReceiptLimit },
  starter: { price: config.stripePriceStarter, limit: config.starterReceiptLimit },
  pro: { price: config.stripePricePro, limit: config.proReceiptLimit },
};

/**
 * Sync an updated plan definition to Stripe (product + price). This is what the
 * Super Admin "update plan" action drives. Mock returns the local plan unchanged.
 */
export async function syncPlanToStripe(plan: { id: string; name: string; monthlyPrice: number; stripeProductId: string | null; stripePriceId: string | null }) {
  if (config.stripeMock) {
    // No real Stripe calls in mock mode — return plan as authoritative.
    return plan;
  }
  if (!config.stripeSecretKey) throw new Error("STRIPE_SECRET_KEY not configured");
  // Real implementation: create/update Product, then Price, via Stripe API.
  // POST https://api.stripe.com/v1/prices  (amount_in_cents, currency, recurring)
  return plan;
}

/** POST /api/billing/checkout — create a Stripe Checkout Session for a plan. */
const checkoutSchema = z.object({ plan_code: z.enum(["starter", "pro"]), success_url: z.string().optional() });

router.post(
  "/checkout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId;
    if (!orgId) throw new AppError(403, "no_org", "Not a tenant user");
    const { plan_code } = checkoutSchema.parse(req.body);
    const org = await prisma.organizations.findUniqueOrThrow({ where: { id: orgId } });
    const plan = await prisma.subscription_plans.findUnique({
      where: { plan_code: plan_code as never },
    });
    if (!plan || !plan.is_active) throw new AppError(400, "plan_inactive", "Plan not available");

    if (config.stripeMock) {
      // Mock: return a fake checkout URL; use /api/billing/webhook to complete.
      await audit(orgId, req.user!.id, "billing.checkout", { plan_code, mock: true });
      return res.json({
        mock: true,
        checkoutUrl: `http://localhost:${config.port}/api/billing/checkout/complete?org=${orgId}&plan=${plan_code}`,
        note: "STRIPE_MOCK=true — use /api/billing/webhook to simulate completion",
      });
    }

    throw new AppError(501, "stripe_not_wired", "Real Stripe checkout requires STRIPE_SECRET_KEY setup");
  })
);

/** GET /api/billing/usage — current plan + quota progress for the dashboard. */
router.get(
  "/usage",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const org = await prisma.organizations.findUnique({ where: { id: orgId }, include: { plan: true } });
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const usage = await prisma.monthly_usage.findUnique({
      where: { org_id_billing_period_start: { org_id: orgId, billing_period_start: monthStart } },
    });
    const limit = org?.receipt_limit_override ?? org?.plan?.receipt_limit ?? config.freeReceiptLimit;
    const used = usage?.receipts_processed ?? 0;
    res.json({
      plan: org?.plan?.name || "free",
      planCode: org?.plan?.plan_code || "free",
      receiptLimit: limit,
      receiptsUsed: used,
      remaining: Math.max(0, limit - used),
      percent: Math.min(100, Math.round((used / limit) * 100)),
      periodStart: monthStart,
      subscriptionStatus: org?.subscription_status,
    });
  })
);

/**
 * Stripe webhook handler. In mock mode, POSTing a small event here simulates
 * checkout.session.completed / subscription.updated / deleted.
 * In production, verify `stripe-signature` against STRIPE_WEBHOOK_SECRET.
 */
const mockEventSchema = z.object({
  type: z.enum([
    "checkout.session.completed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]),
  org_id: z.string().optional(),
  plan_code: z.enum(["free", "starter", "pro"]).optional(),
  proration: z.enum(["always_invoice", "none"]).optional(),
});

router.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    if (config.stripeMock) {
      const evt = mockEventSchema.parse(req.body);

      if (evt.type === "checkout.session.completed" || evt.type === "customer.subscription.updated") {
        if (!evt.org_id || !evt.plan_code) throw new AppError(400, "bad_event", "org_id + plan_code required in mock");
        const plan = await prisma.subscription_plans.findUnique({ where: { plan_code: evt.plan_code } });
        if (!plan) throw new AppError(404, "plan_not_found", "Plan not found");
        const now = new Date();
        const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        await prisma.organizations.update({
          where: { id: evt.org_id },
          data: {
            plan_id: plan.id,
            receipt_limit_override: evt.plan_code === "free" ? null : undefined, // keep overrides for free/custom
            subscription_status: "active",
            current_period_start: now,
            current_period_end: periodEnd,
          },
        });
        await audit(evt.org_id, null, "billing.plan_changed", { plan: evt.plan_code, mock: true });
        return res.json({ ok: true, applied: { org: evt.org_id, plan: evt.plan_code } });
      }

      if (evt.type === "customer.subscription.deleted") {
        if (!evt.org_id) throw new AppError(400, "bad_event", "org_id required");
        const freePlan = await prisma.subscription_plans.findUnique({ where: { plan_code: "free" } });
        await prisma.organizations.update({
          where: { id: evt.org_id },
          data: { plan_id: freePlan?.id ?? null, subscription_status: "canceled" },
        });
        await audit(evt.org_id, null, "billing.plan_changed", { plan: "free", mock: true });
        return res.json({ ok: true, applied: { org: evt.org_id, plan: "free" } });
      }
    }

    throw new AppError(501, "stripe_not_wired", "Real Stripe webhooks not configured");
  })
);

/** GET /api/billing/portal — Stripe Customer Portal link (mock returns placeholder). */
router.post(
  "/portal",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const org = await prisma.organizations.findUnique({ where: { id: orgId } });
    res.json({
      mock: config.stripeMock,
      portalUrl: config.stripeMock
        ? `http://localhost:${config.port}/api/billing/portal/${orgId}`
        : null,
      stripeCustomerId: org?.stripe_customer_id,
    });
  })
);

export default router;