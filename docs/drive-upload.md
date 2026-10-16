# Google Drive upload (driver + route)

The platform can push receipt binaries to Google Drive via a per-org folder, storing
the Drive file id + view link on the receipt row.

## Driver

`backend/src/services/drive.ts` — Drive API v3 multipart upload:

- `uploadToDrive({ name, mime, buffer, orgId, shareLink })`
- `uploadLocalFile(filePath, opts)`

Files land under `ExpenseTracker-<org_id>/`. No token → throws (clear error).

## Route

```
POST /api/drive/upload/:receiptId      # upload the receipt's stored file
     ?share=1                          # optional: make a public "anyone with link" viewer
GET  /api/drive/status                 # configured? + guidance
```

Success stores `drive_file_id` + `drive_web_link` on the receipt and writes an
`audit_logs` row (`drive.upload`).

## Enabling

Requires a Drive OAuth **access token** (Bearer) in env:

```bash
GOOGLE_DRIVE_ACCESS_TOKEN=ya29.a0ARrdaM...   # in backend/.env
```

Tokens last ~1h. Production needs real OAuth (refresh token) — planned. For a quick
manual token today:

1. Get a token using the OAuth Playground scoped to `https://www.googleapis.com/auth/drive.file`
   (https://developers.google.com/oauthplayground), OR
2. Use `gcloud auth application-default print-access-token` if on a GCP box.

Paste the token into `backend/.env` and restart the API:

```bash
cd backend
# edit .env  -> GOOGLE_DRIVE_ACCESS_TOKEN=...
pkill -f "tsx src/index.ts"; (PORT=8090 npx tsx src/index.ts &)
```

Then confirm:

```bash
curl -H "Authorization: Bearer $TOK" localhost:8090/api/drive/status
# {"configured":true}
```

## OAuth upgrade path (plan)

Replace the static token with a refreshed OAuth flow:
1. `drive.scopes` → `drive.file`; JS origin + redirect URI registered in Google Cloud console.
2. Store the **refresh token encrypted** (same pattern as git tokens) in `git_integrations`-style table.
3. Background worker refreshes before each upload.