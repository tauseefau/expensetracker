import { Prisma } from "@prisma/client";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        orgId: string | null;
        role: string;
        email: string;
      };
      org?: {
        id: string;
        name: string;
        planId: string | null;
        receiptLimitOverride: number | null;
        subscriptionStatus: string;
        currentPeriodEnd: Date | null;
      };
    }
  }
}

// Keeps Prisma's Decimal type resolvable for type references in route handlers.
export type OrgWithPlan = Prisma.organizationsGetPayload<{
  include: { plan: true };
}>;

declare global {
  namespace Express {
    interface Request {
      orgPlans?: OrgWithPlan | null;
    }
  }
}

export {};