import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { z } from "zod";
import { encryptSecret } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { testImapConnection, testSmtpConnection } from "@/lib/email/sender";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

const requestSchema = z.object({
  email: z.string().trim().email(),
  app_password: z.string().transform((value) => value.replace(/\s/g, "")).refine(
    (value) => /^[A-Za-z0-9]{16}$/.test(value),
    "Google app password must be 16 characters",
  ),
  from_name: z.string().trim().max(120).optional().default(""),
  name: z.string().trim().max(120).optional().default(""),
  daily_email_limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  timezone: z.string().trim().min(1).max(100).optional().default("UTC"),
});

function friendlyGmailError(error: string): string {
  const normalized = error.toLowerCase();
  if (
    normalized.includes("invalid login") ||
    normalized.includes("username and password not accepted") ||
    normalized.includes("application-specific password required") ||
    normalized.includes("authentication failed")
  ) {
    return "Google rejected the credentials. Make sure 2-Step Verification is enabled and paste a newly generated 16-character app password, not your normal Google password.";
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "Gmail did not respond in time. Please try connecting again.";
  }
  return error;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const ctx = requireWorkspace(req, res, "admin");
  if (!ctx) return;

  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid Gmail connection details" });
  }

  const { app_password: appPassword, from_name: fromName, daily_email_limit: dailyLimit, timezone } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM email_accounts WHERE workspace_id = ? AND lower(from_email) = ?")
    .get(ctx.workspaceId, email) as { id: string } | undefined;

  if (existing) {
    return res.status(409).json({ error: `An email account for ${email} is already connected` });
  }

  const [smtpError, imapError] = await Promise.all([
    testSmtpConnection({
      from_email: email,
      from_name: fromName || null,
      smtp_host: "smtp.gmail.com",
      smtp_port: 587,
      smtp_secure: 0,
      username: email,
      password: appPassword,
    }),
    testImapConnection({
      imap_host: "imap.gmail.com",
      imap_port: 993,
      username: email,
      password: appPassword,
      imap_username: null,
      imap_password: null,
    }),
  ]);

  if (smtpError || imapError) {
    const rawError = smtpError ?? imapError ?? "Gmail authentication failed";
    return res.status(400).json({
      error: friendlyGmailError(rawError),
      smtp: smtpError ? { ok: false, error: friendlyGmailError(smtpError) } : { ok: true },
      imap: imapError ? { ok: false, error: friendlyGmailError(imapError) } : { ok: true },
    });
  }

  const id = randomUUID();
  const encryptedPassword = encryptSecret(appPassword);
  const name = parsed.data.name || `Gmail — ${email}`;
  const rampStartDate = new Date().toISOString().slice(0, 10);

  db.prepare(`
    INSERT INTO email_accounts
      (id, workspace_id, name, from_email, from_name, smtp_host, smtp_port, smtp_secure,
       imap_host, imap_port, username, password, daily_email_limit,
       active_hours_start, active_hours_end, timezone, working_days,
       is_verified, ramp_up_enabled, ramp_start_date, provider)
    VALUES (?, ?, ?, ?, ?, 'smtp.gmail.com', 587, 0,
            'imap.gmail.com', 993, ?, ?, ?, 9, 18, ?, '1,2,3,4,5', 1, 1, ?, 'gmail_app_password')
  `).run(
    id,
    ctx.workspaceId,
    name,
    email,
    fromName || null,
    email,
    encryptedPassword,
    dailyLimit,
    timezone,
    rampStartDate,
  );

  recordAudit(ctx, "email_account.gmail_app_password_connected", "email_account", id, { email });
  return res.status(201).json({ id, email, verified: true });
}
