import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import authRoutes from "./routes/auth";
import receiptRoutes from "./routes/receipts";
import ocrRoutes from "./routes/ocr";
import exportRoutes from "./routes/export";
import billingRoutes from "./routes/billing";
import gitRoutes from "./routes/git";
import emailRoutes from "./routes/email";
import driveRoutes from "./routes/drive";
import adminRoutes from "./routes/admin";
import { errorHandler, notFoundHandler } from "./utils/errors";
import { startWorkers } from "./workers";

const app = express();

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

// Health
app.get("/health", (_req, res) => res.json({ ok: true, service: "expense-tracker" }));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/receipts", receiptRoutes);
app.use("/api/ocr", ocrRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/git", gitRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/drive", driveRoutes);
app.use("/api/admin", adminRoutes);

// Serve the built frontend (SPA) from one port so nginx can expose the whole
// app under /expense/ with a single proxy_pass. Only non-API browser GETs fall
// back to index.html; API routes were mounted above (JSON 404 stays intact).
const frontendDist = path.resolve(__dirname, "../../frontend/dist");
if (fs.existsSync(path.join(frontendDist, "index.html"))) {
  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    if (req.method !== "GET") return next();
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

export async function boot() {
  // Start background job workers (OCR, git, email, scrape). Non-fatal if Redis absent.
  try {
    startWorkers();
  } catch (e) {
    console.warn("[workers] not started (Redis down?)", (e as Error).message);
  }
  return app;
}

// Allow direct run too (tsx src/index.ts)
if (require.main === module) {
  import("./config").then(async ({ config }) => {
    await boot();
    app.listen(config.port, () => {
      console.log(`[expense-tracker] listening on :${config.port} (${config.env})`);
    });
  }).catch((e) => {
    console.error("boot failed", e);
    process.exit(1);
  });
}