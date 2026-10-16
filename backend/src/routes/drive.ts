import { Router } from "express";
import fs from "fs";
import { prisma } from "../db/client";
import { AppError, asyncHandler } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { uploadLocalFile } from "../services/drive";
import { storage } from "../services/storage";
import { audit } from "../services/audit";

const router = Router();

/**
 * POST /api/drive/upload/:receiptId
 * Upload the receipt's stored file to Google Drive, store the Drive file id + link.
 * Requires GOOGLE_DRIVE_ACCESS_TOKEN in env. Optionally ?share=1 to make a public link.
 */
router.post(
  "/upload/:receiptId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const receipt = await prisma.receipts.findFirst({
      where: { id: req.params.receiptId, org_id: orgId },
    });
    if (!receipt) throw new AppError(404, "not_found", "Receipt not found");
    if (!receipt.file_path) throw new AppError(400, "no_file", "Receipt has no stored file");

    let abs: string;
    try {
      abs = storage.resolve(receipt.file_path);
    } catch {
      throw new AppError(400, "bad_path", "Stored path invalid");
    }
    if (!fs.existsSync(abs)) throw new AppError(404, "file_missing", "Stored file missing on disk");

    const share = (req.query.share as string) === "1";
    const result = await uploadLocalFile(abs, {
      name: `${receipt.store_name || receipt.id}-${receipt.id}.jpg`.replace(/[^\w.\- ]/g, "_"),
      mime: "image/jpeg", // best-effort; n8n OCR payloads carry no binary anyway
      orgId,
      shareLink: share,
    });

    const updated = await prisma.receipts.update({
      where: { id: receipt.id },
      data: { drive_file_id: result.fileId, drive_web_link: result.webViewLink },
    });

    await audit(orgId, req.user!.id, "drive.upload", { fileId: result.fileId, share });
    res.json({
      ok: true,
      fileId: result.fileId,
      webViewLink: updated.drive_web_link,
      folderId: result.folderId,
      shared: share,
    });
  })
);

/** GET /api/drive/status — is a Drive token configured? */
router.get(
  "/status",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({
      configured: !!process.env.GOOGLE_DRIVE_ACCESS_TOKEN,
      note: "Set GOOGLE_DRIVE_ACCESS_TOKEN to enable Drive uploads. See docs/drive-upload.md",
    });
  })
);

export default router;