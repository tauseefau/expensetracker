import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const prisma = new PrismaClient();

async function main() {
  console.log("[seed] starting");

  // ---- Subscription plans (source of truth, admin can edit later) ----
  const plans = [
    { plan_code: "free" as const, name: "Free", description: "20 receipts/month", monthly_price: 0, receipt_limit: 20 },
    { plan_code: "starter" as const, name: "Starter", description: "100 receipts/month", monthly_price: 2.5, receipt_limit: 100 },
    { plan_code: "pro" as const, name: "Pro", description: "300 receipts/month", monthly_price: 5.0, receipt_limit: 300 },
  ];
  for (const p of plans) {
    await prisma.subscription_plans.upsert({
      where: { plan_code: p.plan_code },
      update: p,
      create: p,
    });
    console.log("[seed] plan", p.plan_code);
  }

  // ---- Cost metrics (operational cost engine defaults) ----
  const costCount = await prisma.cost_metrics.count();
  if (costCount === 0) {
    await prisma.cost_metrics.create({
      data: {
        ocr_cost_per_unit: 0.004,
        email_cost_per_unit: 0.001,
        storage_cost_per_gb: 0.02,
        scraper_cost_per_run: 0.005,
      },
    });
    console.log("[seed] cost_metrics default row");
  }

  // ---- Bootstrap super admin ----
  const superEmail = process.env.SUPER_ADMIN_EMAIL || "admin@example.com";
  const superPass = process.env.SUPER_ADMIN_PASSWORD || "ChangeMe123!";
  const existingAdmin = await prisma.user.findUnique({ where: { email: superEmail } });
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        name: "Super Admin",
        email: superEmail,
        password_hash: await bcrypt.hash(superPass, 10),
        role: "super_admin",
      },
    });
    console.log("[seed] super admin", superEmail);
  } else {
    console.log("[seed] super admin exists");
  }

  // ---- Demo tenant (only if org "Demo Org" absent) ----
  const demoPlan = await prisma.subscription_plans.findUnique({ where: { plan_code: "pro" } });
  const existingOrg = await prisma.organizations.findFirst({ where: { name: "Demo Org" } });
  if (!existingOrg) {
    const org = await prisma.organizations.create({
      data: {
        name: "Demo Org",
        plan_id: demoPlan?.id ?? null,
        subscription_status: "active",
      },
    });
    const demoEmail = process.env.DEMO_USER_EMAIL || "demo@example.com";
    await prisma.user.create({
      data: {
        org_id: org.id,
        name: "Demo Owner",
        email: demoEmail,
        password_hash: await bcrypt.hash("Demo12345!", 10),
        role: "org_owner",
        tenant_api_key: crypto.randomBytes(24).toString("hex"),
      },
    });
    console.log("[seed] demo org + user (", demoEmail, ")");
  } else {
    console.log("[seed] demo org exists");
  }

  console.log("[seed] done");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });