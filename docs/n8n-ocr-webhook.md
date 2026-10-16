# n8n OCR → expense-tracker webhook

Feed parsed receipt lines from an n8n pipeline (or any OCR step) into the platform.

## Endpoint

```
POST /api/ocr/ingest
Authorization: Bearer <tenant_api_key>
Content-Type: application/json
```

`tenant_api_key` is issued at org registration and returned in the register response
(`POST /api/auth/register`). Re-fetch it anytime as owner/admin:
`GET /api/auth/me/tenant-key`.

## Behavior

1. Validates the per-tenant key → resolves the owning organization.
2. **Quota check + atomic consume**: 429 `quota_exceeded` if the org is at its
   monthly cap (Free 20 / Starter 100 / Pro 300, or an override).
3. Maps the payload, persists a `receipts` row (+ nested `items`), stores the raw
   OCR blob in `raw_ocr_json`, writes an audit log, returns the receipt + usage.

## Request body

```jsonc
{
  "store_name": "Coles",
  "date": "2026-10-14",          // ISO date or "YYYY-MM-DD"
  "time": "14:32",
  "total": 42.5,
  "subtotal": 40.0,
  "tax": 2.5,
  "payment_method": "VISA",
  "items": [
    { "name": "Milk",   "quantity": 2, "price": 1.50 },
    { "name": "Bread",  "quantity": 1, "price": 2.00 }
  ]
}
```

All fields optional except the structure itself. Unknown extra fields are tolerated.

## n8n worker example

- HTTP Request node → Method `POST`, URL `https://<host>/api/ocr/ingest`
- Header `Authorization` = `Bearer {{your tenant key}}`
- Body = JSON of the mapped OCR output (relay n8n's extracted values as above).

## Response

```jsonc
201
{
  "receipt": { "id": "...", "store_name": "Coles", "items": [ ... ] },
  "usage":   { "used": 4, "limit": 300 }
}
```

## Errors

| Code | Status | Meaning |
|------|--------|---------|
| `missing_key` / `invalid_key` | 401 | bad/missing tenant API key |
| `quota_exceeded` | 429 | monthly cap reached — upgrade plan |
| `no_org` | 401/403 | key not bound to an organization |