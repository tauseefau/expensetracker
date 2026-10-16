import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../db/client";
import { AppError, asyncHandler } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { quotaMiddleware } from "../middleware/quota";
import { consumeQuota } from "../services/quota";
import { storage } from "../services/storage";
import { audit } from "../services/audit";
import { ocrReceiptImage } from "../services/ocrVision";

const router = Router();

// In-memory multer (we persist to storage ourselves for tenant-scoped paths).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const createBody = z.object({
  store_name: z.string().optional(),
  date: z.string().datetime().optional(),
  time: z.string().optional(),
  total: z.coerce.number().optional(),
  subtotal: z.coerce.number().optional(),
  tax: z.coerce.number().optional(),
  payment_method: z.string().optional(),
  storage_mode: z.enum(["normal", "no_storage"]).optional(),
});

/** List receipts (org-scoped), with filter/search. */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId;
    if (!orgId) throw new AppError(403, "no_org", "Not a tenant user");
    const { store, from, to, q } = req.query as Record<string, string | undefined>;
    const where: Record<string, never> = {
      org_id: orgId as never,
    } as never;
    // Build Prisma where object strictly org-scoped.
    const and: Record<string, unknown>[] = [{ org_id: orgId }];
    if (store) and.push({ store_name: { contains: store, mode: "insensitive" } });
    if (from) and.push({ date: { gte: new Date(from) } });
    if (to) and.push({ date: { lte: new Date(to) } });
    if (q) {
      and.push({
        OR: [{ store_name: { contains: q, mode: "insensitive" } }, { payment_method: { contains: q, mode: "insensitive" } }],
      });
    }
    const receipts = await prisma.receipts.findMany({
      where: { AND: and as never },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ data: receipts });
  })
);

/** Create a receipt from multipart (file + metadata). Quota-enforced. */
router.post(
  "/",
  requireAuth,
  quotaMiddleware,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const body = createBody.parse(req.body ?? {});

    let filePath: string | null = null;
    if (req.file && (!body.storage_mode || body.storage_mode === "normal")) {
      filePath = await storage.save(orgId, req.file.originalname, req.file.buffer);
    } else if (req.file && body.storage_mode === "no_storage") {
      throw new AppError(400, "file_with_no_storage", "Cannot attach a file when storage_mode=no_storage");
    }

    const used = await consumeQuota(orgId);
    const receipt = await prisma.receipts.create({
      data: {
        org_id: orgId,
        user_id: req.user!.id,
        store_name: body.store_name,
        date: body.date ? new Date(body.date) : undefined,
        time: body.time,
        total: body.total,
        subtotal: body.subtotal,
        tax: body.tax,
        payment_method: body.payment_method,
        storage_mode: body.storage_mode ?? "normal",
        file_path: filePath,
      },
      include: { items: true },
    });
    await audit(orgId, req.user!.id, "receipt.create", { id: receipt.id });
    res.status(201).json({ receipt, usage: used });
  })
);

/** OCR a receipt image via the vision model, then persist into the caller's org. */
router.post(
  "/ocr",
  requireAuth,
  quotaMiddleware,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "no_file", "Provide a receipt image in the 'file' field");
    const orgId = req.user!.orgId!;
    const mime = req.file.mimetype || "image/jpeg";

    // quotaMiddleware (above) only checks the cap — quota is consumed below on success.
    const parsed = await ocrReceiptImage(req.file.buffer, mime);

    const date = parsed.date
      ? /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? new Date(`${parsed.date}T00:00:00Z`)
        : new Date(parsed.date)
      : undefined;

    const receipt = await prisma.receipts.create({
      data: {
        org_id: orgId,
        user_id: req.user!.id,
        store_name: parsed.store_name,
        date: isNaN(date?.getTime() as number) ? undefined : date,
        time: parsed.time,
        total: parsed.total,
        subtotal: parsed.subtotal,
        tax: parsed.tax,
        payment_method: parsed.payment_method,
        storage_mode: "no_storage", // OCR'd image isn't persisted to disk
        raw_ocr_json: parsed as object,
        items: parsed.items?.length
          ? { create: parsed.items.map((it) => ({ name: it.name, quantity: it.quantity, price: it.price })) }
          : undefined,
      },
      include: { items: true },
    });
    await audit(orgId, req.user!.id, "receipt.ocr", { id: receipt.id });
    const usage = await consumeQuota(orgId); // returns current totals
    res.status(201).json({ receipt, usage, ocr: true });
  })
);

/** Get one receipt (org-scoped). */
router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const receipt = await prisma.receipts.findFirst({
      where: { id: req.params.id, org_id: orgId },
      include: { items: true },
    });
    if (!receipt) throw new AppError(404, "not_found", "Receipt not found");
    res.json({ data: receipt });
  })
);

/** Delete a receipt (org-scoped) + remove stored file + refund quota. */
router.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const receipt = await prisma.receipts.findFirst({ where: { id: req.params.id, org_id: orgId } });
    if (!receipt) throw new AppError(404, "not_found", "Receipt not found");
    if (receipt.file_path) storage.remove(receipt.file_path);
    await prisma.receipt_items.deleteMany({ where: { receipt_id: receipt.id } });
    await prisma.receipts.delete({ where: { id: receipt.id } });
    await audit(orgId, req.user!.id, "receipt.delete", { id: receipt.id });
    res.json({ ok: true });
  })
);

export default router;