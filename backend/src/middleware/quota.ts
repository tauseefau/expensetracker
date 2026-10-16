import { Request, Response, NextFunction } from "express";
import { getOrCreateUsage } from "../services/quota";
import { AppError } from "../utils/errors";

/**
 * Quota middleware for receipt ingestion. Attaches current usage to the request
 * and rejects 429 when the org's monthly cap is hit. Use on upload + OCR paths.
 */
export async function quotaMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const org = req.orgPlans;
    if (!org) throw new AppError(403, "no_org", "Not a tenant user");
    const usage = await getOrCreateUsage(org.id);
    (req as Request & { usage?: unknown }).usage = usage;
    if (usage.over) {
      throw new AppError(
        429,
        "quota_exceeded",
        `Monthly receipt quota reached (${usage.used}/${usage.limit}). Upgrade your plan.`,
        { used: usage.used, limit: usage.limit }
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Guard: route only accessible to super_admin role. Use AFTER requireAuth. */
export function adminOnly(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new AppError(401, "unauthorized", "Not authenticated"));
  if (req.user.role !== "super_admin") {
    return next(new AppError(403, "forbidden", "Super admin only"));
  }
  next();
}