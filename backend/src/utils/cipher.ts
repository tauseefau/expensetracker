import crypto from "crypto";

/** Encrypt (AES-256-GCM) a secret. Returns `iv:tag:ct` base64. */
export function encryptSecret(plain: string, key: string): string {
  const derived = crypto.createHash("sha256").update(key).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derived, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** Decrypt a `iv:tag:ct` base64 blob produced by encryptSecret. */
export function decryptSecret(blob: string, key: string): string {
  const [ivb, tagb, ctb] = blob.split(":");
  const derived = crypto.createHash("sha256").update(key).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", derived, Buffer.from(ivb, "base64"));
  decipher.setAuthTag(Buffer.from(tagb, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctb, "base64")), decipher.final()]).toString("utf8");
}