import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { encryptSecret } from "@/lib/crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { enableWarmup } from "@/lib/platform/deliverability";
import { mailboxesOverview } from "@/lib/email/mailbox-list";
import { mailboxSettingsProblem, withNumbers } from "@/lib/email/mailbox-settings";
import { probeImap, probeSmtp } from "@/lib/email/sender";

/**
 * A workspace's mailboxes.
 *   GET                  the bare list, as the API and the MCP tool have always had it
 *   GET ?view=overview   what the Mailboxes screen reads: grouped by sending domain
 *   POST { ...fields }   connect one over SMTP (admin). With `verify: true` the sign-in is
 *                        tried first and nothing is saved if the server refuses it.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;

  if (req.method === "GET") {
    if (req.query.view === "overview") return res.json(mailboxesOverview(db, ctx.workspaceId));
    // Never return passwords to the client
    const accounts = db
      .prepare(`
        SELECT ea.id, ea.name, ea.from_email, ea.from_name, ea.reply_to,
               ea.smtp_host, ea.smtp_port, ea.smtp_secure,
               ea.imap_host, ea.imap_port, ea.username, ea.imap_username,
               ea.daily_email_limit, ea.active_hours_start, ea.active_hours_end,
               ea.timezone, ea.working_days, ea.is_verified, ea.signature,
               ea.ramp_up_enabled, ea.ramp_start_date, ea.ramp_days, ea.ramp_start_limit, ea.signature_first_only,
               ea.provider, ea.paused_at, ea.paused_reason, ea.disconnected_at, ea.disconnect_reason, ea.created_at,
               (SELECT COUNT(DISTINCT rp.run_id) FROM run_profiles rp
                JOIN runs r ON rp.run_id = r.id
                WHERE rp.email_account_id = ea.id
                AND r.status IN ('running', 'paused')) AS active_run_count
        FROM email_accounts ea WHERE ea.workspace_id = ? ORDER BY ea.created_at DESC
      `)
      .all(ctx.workspaceId);
    return res.json(accounts);
  }

  if (req.method === "POST") {
    const {
      name, from_email, from_name, reply_to,
      smtp_host, smtp_port = 587, smtp_secure = 0,
      imap_host, imap_port = 993,
      username, password,
      imap_username, imap_password,
      daily_email_limit = 50,
      active_hours_start = 9, active_hours_end = 18,
      timezone = "UTC", working_days = "1,2,3,4,5",
      signature,
      ramp_up_enabled = 1,
      ramp_start_date,
      ramp_days = null,
      ramp_start_limit = null,
      signature_first_only = false,
      allow_self_signed = false,
      verify = false,
    } = withNumbers((req.body ?? {}) as Record<string, unknown>) as Record<string, never>;

    if (!name || !from_email || !smtp_host || !username || !password) {
      return res.status(400).json({ error: "name, from_email, smtp_host, username, password required" });
    }
    const problem = mailboxSettingsProblem({
      from_email, daily_email_limit, active_hours_start, active_hours_end, timezone, working_days, smtp_port, imap_port,
      ...(reply_to ? { reply_to } : {}), ...(signature ? { signature } : {}), ...(ramp_days !== null ? { ramp_days } : {}), ...(ramp_start_limit !== null ? { ramp_start_limit } : {}),
    });
    if (problem) return res.status(400).json({ error: problem });

    // The Mailboxes screen asks for the sign-in to be tried before anything is saved, so a
    // mistyped password never becomes a mailbox that cannot send.
    let verified = false;
    if (verify) {
      const duplicate = db.prepare("SELECT 1 FROM email_accounts WHERE workspace_id = ? AND lower(from_email) = lower(?)").get(ctx.workspaceId, String(from_email).trim());
      if (duplicate) return res.status(409).json({ error: `${String(from_email).trim()} is already connected` });
      const selfSigned = allow_self_signed ? 1 : 0;
      const [smtp, imap] = await Promise.all([
        probeSmtp({ from_email, from_name: from_name ?? null, smtp_host, smtp_port: Number(smtp_port), smtp_secure: smtp_secure ? 1 : 0, username, password, allow_self_signed: selfSigned }),
        imap_host ? probeImap({ imap_host, imap_port: Number(imap_port), username, password, imap_username: imap_username ?? null, imap_password: imap_password || null, allow_self_signed: selfSigned }) : Promise.resolve(null),
      ]);
      if (smtp.error || imap?.error) {
        return res.status(400).json({
          error: smtp.error ? `The SMTP server did not accept the connection: ${smtp.error}` : `The IMAP server did not accept the connection: ${imap!.error}`,
          smtp: smtp.error ? { ok: false, error: smtp.error } : { ok: true },
          imap: imap ? (imap.error ? { ok: false, error: imap.error } : { ok: true }) : null,
        });
      }
      verified = true;
    }

    const id = randomUUID();
    const resolvedRampStart = ramp_start_date ?? new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO email_accounts
        (id, workspace_id, name, from_email, from_name, reply_to, smtp_host, smtp_port, smtp_secure,
         imap_host, imap_port, username, password,
         imap_username, imap_password,
         daily_email_limit, active_hours_start, active_hours_end, timezone, working_days, signature,
         ramp_up_enabled, ramp_start_date, ramp_days, ramp_start_limit, signature_first_only, allow_self_signed, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, ctx.workspaceId, name, from_email, from_name ?? null, reply_to ?? null,
      smtp_host, smtp_port, smtp_secure,
      imap_host ?? null, imap_port,
      username, encryptSecret(password),
      imap_username ?? null, imap_password ? encryptSecret(imap_password) : null,
      daily_email_limit, active_hours_start, active_hours_end, timezone, working_days,
      signature ?? null,
      ramp_up_enabled ? 1 : 0, resolvedRampStart,
      ramp_days, ramp_start_limit, signature_first_only ? 1 : 0, allow_self_signed ? 1 : 0, verified ? 1 : 0
    );

    try { enableWarmup(ctx.workspaceId, id); } catch { /* non-fatal */ }

    recordAudit(ctx, "email_account.created", "email_account", id);
    return res.status(201).json({ id, verified });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}
