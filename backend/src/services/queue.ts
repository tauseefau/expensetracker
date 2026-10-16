import { Queue, Worker } from "bullmq";
import { config } from "../config";

/**
 * BullMQ job queue (Redis-backed) for async work: OCR parsing, git pushes,
 * Drive uploads, email dispatch, scraping. HTTP threads never block.
 */
export const queue = {
  ocr: new Queue("ocr", { connection: { url: config.redisUrl } }),
  git: new Queue("git", { connection: { url: config.redisUrl } }),
  email: new Queue("email", { connection: { url: config.redisUrl } }),
  scrape: new Queue("scrape", { connection: { url: config.redisUrl } }),
};

/** Convenience: enqueue a job and return the job. */
export function enqueue(name: keyof typeof queue, id: string, payload: unknown) {
  return queue[name].add(id, payload as object);
}

/** Start a worker for a queue. Single-process dev workers attached here. */
export function startWorker(
  name: keyof typeof queue,
  handler: (job: { name: string; data: unknown }) => Promise<void>
): Worker {
  const worker = new Worker(name, async (job) => handler(job as never), {
    connection: { url: config.redisUrl },
  });
  worker.on("failed", (job, err) => {
    console.error(`[queue:${name}] job ${job?.name} failed`, err.message);
  });
  return worker;
}

/** Tear down all BullMQ resources on shutdown. */
export async function closeQueues(): Promise<void> {
  await Promise.all([
    queue.ocr.close(),
    queue.git.close(),
    queue.email.close(),
    queue.scrape.close(),
  ]);
}