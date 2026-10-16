import fs from "fs";

/**
 * Google Drive upload driver. Uses Drive API v3 multipart upload with a bearer
 * access token (env: GOOGLE_DRIVE_ACCESS_TOKEN). OAuth setup is documented in
 * docs/drive-upload.md. Folder isolation: files go under /ExpenseTracker/{org}.
 */
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";

function getToken(): string {
  const t = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
  if (!t) throw new Error("GOOGLE_DRIVE_ACCESS_TOKEN not configured — set it to a Drive OAuth access token");
  return t;
}

/** Ensure a folder exists (by name, under root), return its id. */
async function ensureFolder(token: string, name: string): Promise<string> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await fetch(`${DRIVE_FILES}?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = (await r.json()) as { files?: { id: string }[] };
  if (j.files?.length) return j.files[0].id;
  // create folder
  const c = await fetch(DRIVE_FILES, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
  });
  const cj = (await c.json()) as { id: string };
  return cj.id;
}

/** Upload bytes as a file. Returns id + webViewLink (not made public). */
export async function uploadToDrive(
  opts: { name: string; mime: string; buffer: Buffer; orgId?: string; shareLink?: boolean }
): Promise<{ fileId: string; webViewLink?: string; folderId?: string }> {
  const token = getToken();
  const folderId = opts.orgId ? await ensureFolder(token, `ExpenseTracker-${opts.orgId}`) : undefined;

  const boundary = `----expensetracker${Date.now()}`;
  const meta = JSON.stringify({ name: opts.name, mimeType: opts.mime, ...(folderId ? { parents: [folderId] } : {}) });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${opts.mime}\r\n\r\n`),
    opts.buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const r = await fetch(`${DRIVE_UPLOAD}&fields=id,name,webViewLink`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Drive upload failed (${r.status}): ${text.slice(0, 200)}`);
  const j = JSON.parse(text) as { id: string; webViewLink?: string };

  if (opts.shareLink) {
    // Make anyone-with-link a viewer so a public link works (common for shared dashboards).
    const p = await fetch(`${DRIVE_FILES}/${j.id}/permissions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
  }
  return { fileId: j.id, webViewLink: j.webViewLink, folderId };
}

/** Download + re-upload a local receipt file to Drive. */
export async function uploadLocalFile(
  filePath: string,
  opts: { name: string; mime: string; orgId?: string; shareLink?: boolean }
): Promise<{ fileId: string; webViewLink?: string; folderId?: string }> {
  const buffer = fs.readFileSync(filePath);
  return uploadToDrive({ ...opts, buffer });
}