# Multi-Tenant SaaS Expense Tracker

Multi-tenant, subscription-grade expense platform: OCR receipt ingestion, quota & billing
(Stripe), CSV export, git auto-sync, Super Admin plan/cost management. MVP backend + dashboard.

> **Status:** phased MVP. Express + TypeScript backend is functional end-to-end;
> Scraping (Puppeteer), Google Drive/agentmail delivery, and full Stripe OAuth are
> stubbed behind clean driver interfaces. Stripe runs in mock mode by default.

## Stack

| Layer | Choice |
|-------|--------|
| Backend | Node.js + Express + TypeScript |
| ORM / DB | Prisma + PostgreSQL (strict application-level multi-tenant scoping) |
| Queue | BullMQ (Redis) |
| Frontend | React + Vite + Tailwind v4 + Recharts |
| Billing | Stripe (mock by default, real wiring ready) |
| Storage | Local FS driver under `/tenants/{org}/receipts/` (S3/Drive swappable) |
| Email | Driver abstraction: `agentmail` / `gmail` (toggle via env) |

## Multi-tenant + subscription model

- Every query is scoped by `org_id`. A JWT carries `user_id`+`org_id`; middleware enforces it.
- RBAC roles: `super_admin`, `org_owner`, `org_admin`, `member`.
- Plans: **Free** 20/mo, **Starter** 100/mo, **Pro** 300/mo — defined in `subscription_plans`
  (managed by the Super Admin portal), source of truth for billing.
- Quota: atomic consume-per-ingestion, monthly window resets at UTC month boundary. Uploading
  past the cap returns `429 quota_exceeded`.
- Super Admin can edit plan price/caps (syncs to Stripe), track unit costs (`cost_metrics`),
  and compute margin / break-even per plan. Grandfathering + proration supported.

## Quick start (dev)

```bash
# 1) infra
docker compose up -d postgres redis

# 2) backend
cd backend
npm install
npx prisma generate
export DATABASE_URL="postgresql://expense:expense_dev_pw@localhost:5438/expense_tracker"
npx prisma migrate dev
npx tsx prisma/seed.ts          # seeds plans, cost metrics, super_admin, demo org
npm run dev                     # API on :8080 (or PORT=<n>)

# 3) frontend (proxy → backend)
cd ../frontend
npm install
npm run dev                     # http://localhost:5173
```

Default seeded logins (override via env in `seed.ts`):

| Role | Email | Password |
|------|-------|----------|
| Super Admin | `admin@example.com` | `ChangeMe123!` |
| Demo org_owner (Pro, 300/mo) | `demo@example.com` | `Demo12345!` |

> `npm run seed` applies the same logins to the Docker `api` container's DB.

## Key endpoints

```
POST /api/auth/register      # creates org (free) + org_owner + tenant API key
POST /api/auth/login
POST /api/ocr/ingest         # n8n webhook — Bearer <tenant_api_key>, quota-checked
GET  /api/billing/usage      # plan + quota progress
POST /api/billing/webhook    # mock Stripe events (checkout/subs.updated/deleted)
GET  /api/export/csv?template=xero|quickbooks|myob
GET  /api/export/analytics
GET/POST /api/receipts       # org-scoped CRUD + multipart upload
GET/POST /api/git/integrations          # connect a repo (token, encrypted at rest)
POST /api/git/integrations/:id/export-and-push?month=YYYY-MM
GET  /api/admin/plans | /costs | /orgs  # Super Admin (RBAC-super_admin)
```

## n8n OCR webhook

Point an n8n pipeline at `POST https://<host>/api/ocr/ingest` with
`Authorization: Bearer <tenant_api_key>`. Body field mapping — see `docs/n8n-ocr-webhook.md`.

## Stripe mock mode

`STRIPE_MOCK=true` (default) skips real Stripe calls. Simulate a checkout completion with:

```bash
curl -X POST $API/api/billing/webhook -H 'Content-Type: application/json' \
  -d '{"type":"checkout.session.completed","org_id":"<orgId>","plan_code":"pro"}'
```

Set `STRIPE_MOCK=false` + real keys to go live (billing + admin plan-price sync call Stripe).

## Production notes

- Change `JWT_SECRET` and `ENCRYPTION_KEY` (used to encrypt stored git/OAuth tokens).
- Set `EMAIL_SERVICE_PROVIDER` + provider keys for real email delivery.
- Swap `storage` driver for S3/Drive when ready; file layout already tenant-scoped.
- Real Stripe webhook signature must be verified with `STRIPE_WEBHOOK_SECRET`.
- Run BullMQ workers as separate processes in multi-node deploys (see `src/workers.ts`).

## License / status

Private demo/research project. Not yet hardened for public production multi-tenancy —
review authN, rate limiting, MFA for the Super Admin portal, and file scanning before
exposing beyond a trusted group.