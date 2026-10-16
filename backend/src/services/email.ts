import { config } from "../config";

/**
 * Email abstraction. Switches on EMAIL_SERVICE_PROVIDER.
 * agentmail: production REST driver (AgentMail API).
 * gmail: stub — wire Gmail OAuth (GMAIL_CLIENT_ID/SECRET) for real delivery.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  inbox?: string;
  from?: string;
  from_name?: string;
}

export interface EmailResult {
  ok: boolean;
  provider: "agentmail" | "gmail";
  messageId?: string;
}

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  if (config.emailProvider === "gmail") return gmailDriver.send(msg);
  return agentmailDriver.send(msg);
}

const agentmailDriver = {
  async send(msg: EmailMessage): Promise<EmailResult> {
    if (!config.agentmailApiKey) throw new Error("AGENTMAIL_API_KEY not configured");
    if (!config.agentmailInbox) throw new Error("AGENTMAIL_INBOX not configured (sending inbox)");
    if (!msg.to) throw new Error("recipient 'to' required");
    const inbox = encodeURIComponent(msg.inbox || config.agentmailInbox);
    // AgentMail send path: POST /v0/inboxes/{inbox}/messages/send
    const res = await fetch(`https://api.agentmail.to/v0/inboxes/${inbox}/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.agentmailApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html }),
    });
    const bodyText = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`AgentMail send failed (${res.status}): ${bodyText.slice(0, 200)}`);
    let messageId: string | undefined;
    try { messageId = JSON.parse(bodyText)?.message_id ?? JSON.parse(bodyText)?.id; } catch { /* noop */ }
    return { ok: true, provider: "agentmail", messageId };
  },
};

const gmailDriver = {
  async send(_msg: EmailMessage): Promise<EmailResult> {
    throw new Error("Gmail driver not configured — set GMAIL_CLIENT_ID/SECRET and wire OAuth");
  },
};

/** Default landing address for product emails (env AGENTMAIL_TO). */
export const defaultRecipient = () =>
  process.env.AGENTMAIL_TO || "you@example.com";