import { prisma } from "../db/client";

/** Idempotently record an audit event. Never throws (auditing must not break the request). */
export async function audit(
  orgId: string | null,
  userId: string | null,
  action: string,
  details?: unknown
): Promise<void> {
  if (!orgId) return; // super_admin/global actions get logged without an org by caller directly
  try {
    await prisma.audit_logs.create({
      data: {
        org_id: orgId,
        user_id: userId,
        action,
        details: details === undefined ? undefined : (details as object),
      },
    });
  } catch (e) {
    console.error("[audit] failed", e);
  }
}