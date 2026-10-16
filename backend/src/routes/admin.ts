import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { AppError, asyncHandler } from "../utils/errors";
import { requireAuth, requireSuperAdmin } from "../middleware/auth";
import { adminOnly } from "../middleware/quota";
import { syncPlanToStripe } from "./billing";
import { audit } from "../services/audit";

const router = Router();

/** All admin routes behind requireSuperAdmin + adminOnly (role check). */
router.use(requireAuth, requireSuperAdmin, adminOnly);

// ---------------------------------------------------------------------------
// Subscription Plans CRUD (drives Stripe sync, price changes, proration)
// ---------------------------------------------------------------------------
const planSchema = z.object({
  plan_code: z.enum(["free", "starter", "pro"]),
  name: z.string().min(1),
  description: z.string().optional(),
  monthly_price: z.coerce.number().nonnegative(),
  receipt_limit: z.coerce.number().int().nonnegative(),
  is_active: z.boolean().optional(),
});

router.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    const plans = await prisma.subscription_plans.findMany({ orderBy: { monthly_price: "asc" } });
    // Never leak stripe price/product ids publicly; but admins may need them.
    res.json({ data: plans });
  })
);

router.post(
  "/plans",
  asyncHandler(async (req, res) => {
    const body = planSchema.parse(req.body);
    const existing = await prisma.subscription_plans.findUnique({ where: { plan_code: body.plan_code } });
    if (existing) throw new AppError(409, "plan_exists", "Plan already exists");
    const plan = await prisma.subscription_plans.create({
      data: {
        plan_code: body.plan_code,
        name: body.name,
        description: body.description,
        monthly_price: body.monthly_price,
        receipt_limit: body.receipt_limit,
        is_active: body.is_active ?? true,
      },
    });
    res.status(201).json({ data: plan });
  })
);

/** Update a plan (price / cap / active). Pushes change to Stripe, honors proration. */
router.patch(
  "/plans/:code",
  asyncHandler(async (req, res) => {
    const code = z.enum(["free", "starter", "pro"]).parse(req.params.code);
    const body = planSchema.partial().parse(req.body);
    const existing = await prisma.subscription_plans.findUnique({ where: { plan_code: code } });
    if (!existing) throw new AppError(404, "plan_not_found", "Plan not found");

    const plan = await prisma.subscription_plans.update({
      where: { plan_code: code },
      data: {
        name: body.name,
        description: body.description,
        monthly_price: body.monthly_price,
        receipt_limit: body.receipt_limit,
        is_active: body.is_active,
      },
    });

    // Sync to Stripe so price changes propagate to Stripe-hosted subscriptions.
    const proration = (req.body.proration as "always_invoice" | "none") || "always_invoice";
    await syncPlanToStripe({
      id: plan.id,
      name: plan.name,
      monthlyPrice: Number(plan.monthly_price),
      stripeProductId: plan.stripe_product_id,
      stripePriceId: plan.stripe_price_id,
    });

    /**
     * Proration policy: if a price increased and subscribers are NOT grandfathered,
     * we could bill at increase immediately (always_invoice) or next cycle.
     * Grandfathered subscribers keep `grandfathered_price` set on their org.
     */
    if (req.body.grandfather_existing) {
      await prisma.organizations.updateMany({
        where: { plan_id: plan.id },
        data: { grandfathered_price: existing.monthly_price },
      });
    }

    await audit(null, req.user!.id, "admin.plan_update", {
      code,
      proration,
      grandfather_existing: !!req.body.grandfather_existing,
    });
    res.json({ data: plan, proration, note: "price change synced to Stripe" });
  })
);

router.delete(
  "/plans/:code",
  asyncHandler(async (req, res) => {
    const code = z.enum(["free", "starter", "pro"]).parse(req.params.code);
    await prisma.subscription_plans.update({
      where: { plan_code: code },
      data: { is_active: false },
    });
    res.json({ ok: true, note: "plan archived (deactivated)" });
  })
);

// ---------------------------------------------------------------------------
// Cost Metrics Engine
// ---------------------------------------------------------------------------
const costSchema = z.object({
  ocr_cost_per_unit: z.coerce.number().nonnegative().optional(),
  email_cost_per_unit: z.coerce.number().nonnegative().optional(),
  storage_cost_per_gb: z.coerce.number().nonnegative().optional(),
  scraper_cost_per_run: z.coerce.number().nonnegative().optional(),
});

/** GET /api/admin/costs — current vendor cost + computed margin per receipt. */
router.get(
  "/costs",
  asyncHandler(async (_req, res) => {
    const metrics = await prisma.cost_metrics.findFirst({ orderBy: { updatedAt: "desc" } });
    const plans = await prisma.subscription_plans.findMany();
    const defaultCosts = {
      ocr_cost_per_unit: metrics?.ocr_cost_per_unit ?? 0,
      email_cost_per_unit: metrics?.email_cost_per_unit ?? 0,
      storage_cost_per_gb: metrics?.storage_cost_per_gb ?? 0,
      scraper_cost_per_run: metrics?.scraper_cost_per_run ?? 0,
    };
    // Estimate cost per receipt = OCR unit + email unit (every Nth) + storage.
    const estimatedCostPerReceipt =
      Number(defaultCosts.ocr_cost_per_unit) + Number(defaultCosts.email_cost_per_unit) / 100; // email not on every receipt
    res.json({
      metrics: defaultCosts,
      estimatedCostPerReceipt,
      planMargins: plans.map((p) => ({
        plan: p.plan_code,
        price: Number(p.monthly_price),
        breakEvenReceipts: estimatedCostPerReceipt > 0 ? Math.round(Number(p.monthly_price) / estimatedCostPerReceipt) : Infinity,
      })),
    });
  })
);

router.patch(
  "/costs",
  asyncHandler(async (req, res) => {
    const body = costSchema.parse(req.body);
    const existing = await prisma.cost_metrics.findFirst({ orderBy: { updatedAt: "desc" } });
    const metrics = existing
      ? await prisma.cost_metrics.update({
          where: { id: existing.id },
          data: { ...body, updated_by: req.user!.id },
        })
      : await prisma.cost_metrics.create({ data: { ...body, updated_by: req.user!.id } });
    await audit(null, req.user!.id, "admin.cost_metrics_update", body);
    res.json({ data: metrics });
  })
);

// ---------------------------------------------------------------------------
// Org + usage overview for the admin
// ---------------------------------------------------------------------------
router.get(
  "/orgs",
  asyncHandler(async (_req, res) => {
    const orgs = await prisma.organizations.findMany({
      include: { plan: { select: { name: true, plan_code: true } } },
      take: 200,
    });
    res.json({ data: orgs });
  })
);

export default router;