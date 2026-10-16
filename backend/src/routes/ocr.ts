import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { AppError, asyncHandler } from "../utils/errors";
import { consumeQuota } from "../services/quota";
import { audit } from "../services/audit";

const router = Router();

/**
 * n8n OCR ingestion webhook.
 * Auth:  Authorization: Bearer <tenant_api_key>  (per-tenant key issued at registration)
 * Body:  JSON with normalized OCR fields + optional items[].
 * Flow:  validate key → resolve org → quota check+consume → map & persist.
 */
const ocrItemSchema = z.object({
  name: z.string().min(1),
  quantity: z.coerce.number().optional().default(1),
  price: z.coerce.number().optional(),
});

const ocrSchema = z.object({
  store_name: z.string().optional(),
  date: z.string().optional(), // accept ISO date or "YYYY-MM-DD"
  time: z.string().optional(),
  total: z.coerce.number().optional(),
  subtotal: z.coerce.number().optional(),
  tax: z.coerce.number().optional(),
  payment_method: z.string().optional(),
  raw_ocr_json: z.any().optional(),
  items: z.array(ocrItemSchema).optional(),
});

const webhookAuth = async (req: { headers: { authorization?: string } }): Promise<{ orgId: string; userId: string }> => {
  const key = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  if (!key) throw new AppError(401, "missing_key", "Missing tenant API key");
  const user = await prisma.user.findUnique({ where: { tenant_api_key: key } });
  if (!user || !user.is_active) throw new AppError(401, "invalid_key", "Invalid tenant API key");
  if (!user.org_id) throw new AppError(401, "no_org", "API key not bound to an organization");
  return { orgId: user.org_id, userId: user.id };
};

router.post(
  "/ingest",
  asyncHandler(async (req, res) => {
    const { orgId, userId } = await webhookAuth(req);
    const body = ocrSchema.parse(req.body);
    const { used, limit } = await consumeQuota(orgId); // throws 429 when over

    const date = body.date
      ? /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? new Date(`${body.date}T00:00:00Z`)
        : new Date(body.date)
      : undefined;

    const receipt = await prisma.receipts.create({
      data: {
        org_id: orgId,
        user_id: userId,
        store_name: body.store_name,
        date: isNaN(date?.getTime() as number) ? undefined : date,
        time: body.time,
        total: body.total,
        subtotal: body.subtotal,
        tax: body.tax,
        payment_method: body.payment_method,
        storage_mode: "no_storage", // OCR payloads carry no binary
        raw_ocr_json: (body.raw_ocr_json ?? body) as object,
        items: body.items?.length
          ? {
              create: body.items.map((it) => ({
                name: it.name,
                quantity: it.quantity,
                price: it.price as number | undefined,
              })),
            }
          : undefined,
      },
      include: { items: true },
    });
    await audit(orgId, userId, "ocr.ingest", { id: receipt.id });
    res.status(201).json({ receipt, usage: { used, limit } });
  })
);

/** Readiness probe used by n8n to confirm the endpoint is alive. */
router.get("/health", (_req, res) => res.json({ ok: true, service: "expense-ocr" }));

export default router;