import { startWorker, enqueue } from "./services/queue";
import { gitCommit } from "./services/git";
import { sendEmail } from "./services/email";
import { prisma } from "./db/client";

/**
 * Background workers for async work. Each maps queue jobs to handlers.
 * In mock/dev these run in-process; in multi-node deploys they'd run as
 * separate jobs on shared Redis.
 */
export function startWorkers(): void {
  // Git pushes (CSV / JSON auto-sync)
  startWorker("git", async (job: { name: string; data: unknown }) => {
    const d = job.data as { integrationId: string; path: string; content: string; message: string };
    const result = await gitCommit(d.integrationId, {
      path: d.path,
      content: d.content,
      message: d.message,
    });
    const integration = await prisma.git_integrations.findUnique({ where: { id: d.integrationId } });
    if (integration?.org_id) {
      await prisma.audit_logs.create({
        data: {
          org_id: integration.org_id,
          action: "git.commit",
          details: { path: d.path, sha: result.sha } as object,
        },
      });
    }
    console.log(`[worker:git] committed ${d.path} -> ${result.sha} (${result.provider})`);
  });

  // OCR post-processing hook (esto: enqueue scraping of items, extras)
  startWorker("ocr", async (job: { name: string; data: unknown }) => {
    const d = job.data as { receiptId: string };
    console.log("[worker:ocr] post-process receipt", d.receiptId);
  });

  // Email (quota alerts, receipts, warranties, digests)
  startWorker("email", async (job: { name: string; data: unknown }) => {
    const d = job.data as { to: string; subject: string; text: string };
    const r = await sendEmail({ to: d.to, subject: d.subject, text: d.text });
    console.log(`[worker:email] sent to ${d.to} via ${r.provider}`);
  });

  // Price scraping (scrape competitors for recent receipt items)
  startWorker("scrape", async (job: { name: string; data: unknown }) => {
    const d = job.data as { receiptItemId: string; itemName: string };
    console.log("[worker:scrape] (mock) would scrape prices for", d.itemName);
  });
}

/** Helper to dispatch a quota alert email asynchronously. */
export function sendQuotaAlert(to: string, subject: string, text: string): Promise<unknown> {
  return enqueue("email", `alert_${Date.now()}`, { to, subject, text });
}