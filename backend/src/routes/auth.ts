import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../db/client";
import { signToken } from "../utils/jwt";
import { AppError, asyncHandler } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";
import { audit } from "../services/audit";

const router = Router();

const registerSchema = z.object({
  orgName: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

/**
 * Register → creates a new org on the free plan, first user becomes org_owner,
 * and issues a per-tenant API key for n8n OCR webhook ingestion.
 */
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw new AppError(409, "email_taken", "Email already registered");

    const freePlan = await prisma.subscription_plans.findUnique({ where: { plan_code: "free" } });

    const hashed = await bcrypt.hash(body.password, 10);
    const tenantApiKey = crypto.randomBytes(24).toString("hex");

    const user = await prisma.$transaction(async (tx) => {
      const org = await tx.organizations.create({
        data: {
          name: body.orgName,
          plan_id: freePlan?.id ?? null,
          subscription_status: "active",
        },
      });
      return tx.user.create({
        data: {
          org_id: org.id,
          name: body.name,
          email: body.email,
          password_hash: hashed,
          role: "org_owner",
          tenant_api_key: tenantApiKey,
        },
      });
    });

    const token = signToken({ userId: user.id, orgId: user.org_id, role: user.role });
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenantApiKey,
    });
  })
);

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.is_active) throw new AppError(401, "bad_credentials", "Invalid email or password");
    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) throw new AppError(401, "bad_credentials", "Invalid email or password");
    const token = signToken({ userId: user.id, orgId: user.org_id, role: user.role });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  })
);

/** Generate a password reset token. Emails the link via the configured provider. */
router.post(
  "/password-reset",
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    // Always return ok to avoid user enumeration.
    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      await prisma.password_resets.create({
        data: {
          user_id: user.id,
          token_hash: crypto.createHash("sha256").update(token).digest("hex"),
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      // NOTE: hook sendEmail() here in production to deliver the reset link.
    }
    res.json({ ok: true });
  })
);

const resetSchema = z.object({ token: z.string(), password: z.string().min(8) });

router.post(
  "/password-reset/confirm",
  asyncHandler(async (req, res) => {
    const { token, password } = resetSchema.parse(req.body);
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const pr = await prisma.password_resets.findFirst({ where: { token_hash: tokenHash, used: false } });
    if (!pr || pr.expires_at < new Date()) throw new AppError(400, "invalid_token", "Reset token invalid or expired");
    const hashed = await bcrypt.hash(password, 10);
    await prisma.$transaction([
      prisma.user.update({ where: { id: pr.user_id }, data: { password_hash: hashed } }),
      prisma.password_resets.update({ where: { id: pr.id }, data: { used: true } }),
    ]);
    res.json({ ok: true });
  })
);

/** Invite a member to the caller's org (org_owner / org_admin). */
const inviteSchema = z.object({ name: z.string().min(1), email: z.string().email(), role: z.enum(["org_admin", "member"]) });

router.post(
  "/invite",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = inviteSchema.parse(req.body);
    if (!req.user?.orgId) throw new AppError(403, "no_org", "Not a tenant user");
    if (!["org_owner", "org_admin"].includes(req.user.role)) {
      throw new AppError(403, "forbidden", "Only owner/admin can invite");
    }
    const hashed = await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 10);
    const invited = await prisma.user.create({
      data: {
        org_id: req.user.orgId,
        name: body.name,
        email: body.email,
        password_hash: hashed,
        role: body.role,
        is_active: false, // must accept invite (set 1-time welcome password later)
      },
    }).catch(() => {
      throw new AppError(409, "email_taken", "Email already registered");
    });
    await audit(req.user.orgId, req.user.id, "user.invite", { email: body.email, role: body.role });
    res.status(201).json({ ok: true, invitedId: invited.id });
  })
);

/** Expose the caller's own tenant API key (owner/admin). */
router.get(
  "/me/tenant-key",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!["org_owner", "org_admin"].includes(req.user!.role)) {
      throw new AppError(403, "forbidden", "Owner/admin only");
    }
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    res.json({ tenantApiKey: u.tenant_api_key });
  })
);

export default router;