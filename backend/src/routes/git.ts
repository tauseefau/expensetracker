import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { AppError, asyncHandler } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { createGitIntegration, gitCommit } from "../services/git";
import { enqueue } from "../services/queue";
import { audit } from "../services/audit";
import { config } from "../config";

const router = Router();

/** GET /api/git/integrations — list this org's connected repos. */
router.get(
  "/integrations",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId;
    if (!orgId) throw new AppError(403, "no_org", "Not a tenant user");
    const list = await prisma.git_integrations.findMany({
      where: { org_id: orgId },
      select: {
        id: true,
        provider: true,
        repository_owner: true,
        repository_name: true,
        branch: true,
        auto_sync_csv: true,
        auto_sync_json: true,
        createdAt: true,
      },
    });
    res.json({ data: list });
  })
);

/** POST /api/git/integrations — create a git integration (manual token for now). */
const createSchema = z.object({
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  owner: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().default("main"),
  token: z.string().min(1),
  auto_sync_csv: z.boolean().optional(),
  auto_sync_json: z.boolean().optional(),
});

router.post(
  "/integrations",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const body = createSchema.parse(req.body);
    if (!["org_owner", "org_admin"].includes(req.user!.role)) {
      throw new AppError(403, "forbidden", "Owner/admin only");
    }
    const integration = await createGitIntegration({
      orgId,
      provider: body.provider,
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      token: body.token,
      autoSyncCsv: body.auto_sync_csv,
      autoSyncJson: body.auto_sync_json,
    });
    await audit(orgId, req.user!.id, "git.connect", { repo: `${body.owner}/${body.repo}` });
    res.status(201).json({
      data: {
        id: integration.id,
        provider: integration.provider,
        repository_owner: integration.repository_owner,
        repository_name: integration.repository_name,
        branch: integration.branch,
        auto_sync_csv: integration.auto_sync_csv,
        auto_sync_json: integration.auto_sync_json,
      },
    });
  })
);

/** POST /api/git/integrations/:id/push-CSV — build CSV for a period and enqueue a git push. */
router.post(
  "/integrations/:id/export-and-push",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orgId = req.user!.orgId!;
    const integration = await prisma.git_integrations.findFirst({
      where: { id: req.params.id, org_id: orgId },
    });
    if (!integration) throw new AppError(404, "not_found", "Integration not found");

    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7); // YYYY-MM
    const [y, m] = month.split("-").map((n) => parseInt(n, 10));
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));

    const receipts = await prisma.receipts.findMany({
      where: { org_id: orgId, date: { gte: start, lt: end } },
      orderBy: { createdAt: "asc" },
    });

    // Build a minimal CSV (can reuse export templates; here a simple columns set).
    const header = "Date,Description,Amount,PaymentMethod,ReceiptId";
    const rows = receipts.map((r) =>
      [
        r.date ? r.date.toISOString().slice(0, 10) : "",
        `"Receipt ${r.store_name || ""}"`.replace(/"/g, '').trim() && `Receipt ${r.store_name || ""}`,
        r.total ?? "",
        r.payment_method ?? "",
        r.id,
      ].join(",")
    );
    const csv = [header, ...rows].join("\n");
    const path = `expenses/${month}.csv`;

    const jobId = `push_${orgId}_${month}_${integration.id}`;
    enqueue("git", jobId, {
      integrationId: integration.id,
      path,
      content: csv,
      message: `blimpexp: auto-sync expenses ${month}`,
    });

    await audit(orgId, req.user!.id, "git.push", { path, month });
    res.status(202).json({ queued: true, jobId, path, rows: receipts.length });
  })
);

/**
 * POST /api/git/oauth/start — redirect to provider OAuth. (GitHub example.)
 * Real flow exchanges the code for a token in /oauth/callback. Mock-friendly.
 */
router.post(
  "/oauth/start",
  requireAuth,
  asyncHandler(async (req, res) => {
    const provider = (req.body.provider as string) || "github";
    const url =
      provider === "github" && config.githubClientId
        ? `https://github.com/login/oauth/authorize?client_id=${config.githubClientId}&scope=repo,user&redirect_uri=${encodeURIComponent(config.githubOauthCallback)}&state=${req.user!.orgId}`
        : null;
    if (!url) throw new AppError(501, "oauth_not_configured", `OAuth for ${provider} not configured`);
    res.json({ redirectUrl: url });
  })
);

/** GET /api/git/oauth/callback — exchange code for token (GitHub). */
router.get(
  "/oauth/callback",
  asyncHandler(async (_req, res) => {
    // Real: exchange `code` for access_token using GITHUB_CLIENT_ID/SECRET, then
    // call githubDriver to fetch default repos. For the mock, return instructions.
    res.json({ ok: true, note: "OAuth callback — wire the code exchange to complete the connection" });
  })
);

export default router;