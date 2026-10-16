import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "../config";

const ROOT = process.env.STORAGE_ROOT || path.resolve(__dirname, "../../../storage");

/**
 * Storage abstraction. Current driver: local filesystem under
 * /storage/tenants/{org_id}/receipts/. S3/Drive drivers can swap in here.
 */
export const storage = {
  /** Store a binary buffer under the org-scoped receipts dir. Returns tenant-path. */
  async save(orgId: string, filename: string, buffer: Buffer): Promise<string> {
    const safeName = path.basename(filename).replace(/[^\w.\- ]/g, "_");
    const dir = path.join(ROOT, "tenants", orgId, "receipts");
    fs.mkdirSync(dir, { recursive: true });
    const stored = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`;
    fs.writeFileSync(path.join(dir, stored), buffer);
    return `/tenants/${orgId}/receipts/${stored}`;
  },

  /** Resolve a tenant-path to an absolute path on disk. Guards against traversal. */
  resolve(tenantPath: string): string {
    const abs = path.resolve(ROOT, "." + tenantPath);
    if (!abs.startsWith(path.resolve(ROOT))) {
      throw new Error("Invalid storage path");
    }
    return abs;
  },

  /** Delete a stored object (idempotent). */
  remove(tenantPath: string): void {
    const abs = this.resolve(tenantPath);
    fs.rmSync(abs, { force: true });
  },
};

export const DEFAULT_STORAGE_MODE: "normal" | "no_storage" =
  config.defaultStorageMode === "no_storage" ? "no_storage" : "normal";