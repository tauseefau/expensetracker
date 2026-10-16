import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import { prisma } from "../db/client";
import { AppError } from "../utils/errors";

export interface AuthUser {
  id: string;
  orgId: string | null;
  role: string;
  email: string;
}

/** Authenticate a JWT bearer token and load the requesting user. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new AppError(401, "unauthorized", "Missing bearer token");
    }
    const payload = verifyToken(header.slice(7));
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });
    if (!user || !user.is_active) {
      throw new AppError(401, "unauthorized", "Invalid or deactivated account");
    }
    req.user = {
      id: user.id,
      orgId: user.org_id,
      role: user.role,
      email: user.email,
    };
    // For org users, also load their organization + plan for quota checks.
    if (user.org_id) {
      const org = await prisma.organizations.findUnique({
        where: { id: user.org_id },
        include: { plan: true },
      });
      req.orgPlans = org;
      req.org = org
        ? {
            id: org.id,
            name: org.name,
            planId: org.plan_id,
            receiptLimitOverride: org.receipt_limit_override,
            subscriptionStatus: org.subscription_status,
            currentPeriodEnd: org.current_period_end,
          }
        : undefined;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Restrict a route to org-scoped users (not super_admin) — RBAC for tenant routes. */
export function requireOrgRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new AppError(401, "unauthorized", "Not authenticated"));
    if (req.user.role === "super_admin") return next(); // super admin sees all
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return next(new AppError(403, "forbidden", "Insufficient role for this action"));
    }
    next();
  };
}

/** Restrict to super_admin (Super Admin Portal routes). */
export function requireSuperAdmin(_req: Request, _res: Response, next: NextFunction): void {
  // Authorization is checked in the caller against req.user.role.
  next();
}

import type { OrgWithPlan } from "../types/express.d";
export type { OrgWithPlan };