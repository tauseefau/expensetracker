import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const config = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "8080", 10),
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://expense:expense_dev_pw@localhost:5438/expense_tracker",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6380",
  encryptionKey: process.env.ENCRYPTION_KEY || "dev-encryption-key-32-char-min!!",
  emailProvider: process.env.EMAIL_SERVICE_PROVIDER || "agentmail",
  agentmailApiKey: process.env.AGENTMAIL_API_KEY || "",
  agentmailInbox: process.env.AGENTMAIL_INBOX || "",
  defaultEmailRecipient: process.env.AGENTMAIL_TO || "you@example.com",
  googleDriveToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN || "",
  openRouterKey: process.env.OPENROUTER_API_KEY || "",
  openRouterVisionModel: process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini",
  stripeMock: process.env.STRIPE_MOCK === "true",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePriceStarter: process.env.STRIPE_PRICE_STARTER || "price_starter_250",
  stripePricePro: process.env.STRIPE_PRICE_PRO || "price_pro_500",
  githubClientId: process.env.GITHUB_CLIENT_ID || "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || "",
  githubOauthCallback:
    process.env.GITHUB_OAUTH_CALLBACK_URL ||
    "http://localhost:8080/api/git/oauth/callback",
  defaultTenantApiKey: process.env.TENANT_API_KEY_DEFAULT || "dev-tenant-key-0000",
  defaultStorageMode: process.env.DEFAULT_STORAGE_MODE || "normal",
  freeReceiptLimit: parseInt(process.env.FREE_RECEIPT_LIMIT || "20", 10),
  starterReceiptLimit: parseInt(process.env.STARTER_RECEIPT_LIMIT || "100", 10),
  proReceiptLimit: parseInt(process.env.PRO_RECEIPT_LIMIT || "300", 10),
} as const;

export type Config = typeof config;