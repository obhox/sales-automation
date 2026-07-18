import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;

  if (req.method === "GET") {
    const account = db
      .prepare("SELECT id, name, from_email, from_name, reply_to, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, username, imap_username, daily_email_limit, active_hours_start, active_hours_end, timezone, working_days, is_verified, signature, ramp_up_enabled, ramp_start_date, provider, paused_at, paused_reason, created_at FROM email_accounts WHERE id = ? AND workspace_id = ?")
      .get(id, ctx.workspaceId);
    if (!account) return res.status(404).json({ error: "not found" });
    return res.json(account);
  }

  // Manual deactivate / reactivate. A paused sender never sends (the durable mail plane
  // refuses to send from a paused account) but stays connected, so you can flip it back on.
  if (req.method === "PATCH") {
    const { paused } = req.body as { paused?: boolean };
    if (typeof paused !== "boolean") return res.status(400).json({ error: "paused (boolean) is required" });
    if (paused) {
      db.prepare("UPDATE email_accounts SET paused_at = datetime('now'), paused_reason = 'Manually paused' WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    } else {
      db.prepare("UPDATE email_accounts SET paused_at = NULL, paused_reason = NULL WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    }
    recordAudit(ctx, paused ? "email_account.paused" : "email_account.activated", "email_account", id);
    return res.json({ ok: true, paused });
  }

  if (req.method === "PUT") {
    const {
      name, from_email, from_name, reply_to,
      smtp_host, smtp_port, smtp_secure,
      imap_host, imap_port,
      username, password,
      imap_username, imap_password,
      daily_email_limit,
      active_hours_start, active_hours_end,
      timezone, working_days,
      signature,
      ramp_up_enabled,
      ramp_start_date,
    } = req.body;

    const rampEnabled = ramp_up_enabled != null ? (ramp_up_enabled ? 1 : 0) : null;

    // Build password SET clauses only when provided (don't wipe on partial update)
    const pwClause = password ? "password = ?," : "";
    const imapPwClause = imap_password ? "imap_password = ?," : "";

    const pwParams = password ? [encryptSecret(password)] : [];
    const imapPwParams = imap_password ? [encryptSecret(imap_password)] : [];

    db.prepare(`
      UPDATE email_accounts SET
        name = COALESCE(?, name), from_email = COALESCE(?, from_email),
        from_name = ?, reply_to = ?, smtp_host = COALESCE(?, smtp_host),
        smtp_port = COALESCE(?, smtp_port), smtp_secure = COALESCE(?, smtp_secure),
        imap_host = ?, imap_port = COALESCE(?, imap_port),
        username = COALESCE(?, username), ${pwClause}
        imap_username = ?, ${imapPwClause}
        daily_email_limit = COALESCE(?, daily_email_limit),
        active_hours_start = COALESCE(?, active_hours_start),
        active_hours_end = COALESCE(?, active_hours_end),
        timezone = COALESCE(?, timezone), working_days = COALESCE(?, working_days),
        signature = ?, ramp_up_enabled = COALESCE(?, ramp_up_enabled),
        ramp_start_date = COALESCE(?, ramp_start_date)
      WHERE id = ? AND workspace_id = ?
    `).run(
      name ?? null, from_email ?? null, from_name ?? null, reply_to ?? null,
      smtp_host ?? null, smtp_port ?? null, smtp_secure ?? null,
      imap_host ?? null, imap_port ?? null,
      username ?? null, ...pwParams,
      imap_username ?? null, ...imapPwParams,
      daily_email_limit ?? null,
      active_hours_start ?? null, active_hours_end ?? null,
      timezone ?? null, working_days ?? null,
      signature ?? null, rampEnabled, ramp_start_date ?? null,
      id, ctx.workspaceId
    );
    recordAudit(ctx, "email_account.updated", "email_account", id);
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM email_accounts WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "email_account.deleted", "email_account", id);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
