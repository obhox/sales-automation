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
    // True partial-merge: only update columns actually present in the request body, so an
    // unsupplied field is never wiped. (Previously several fields — imap_host, from_name,
    // reply_to, imap_username, signature — were assigned `?` directly and got nulled on any
    // partial update, silently breaking reply syncing when imap_host went null.)
    const body = req.body as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const sets: string[] = []; const params: unknown[] = [];
    const put = (col: string, val: unknown) => { sets.push(`${col} = ?`); params.push(val); };
    for (const col of ["name", "from_email", "from_name", "reply_to", "smtp_host", "smtp_port", "smtp_secure", "imap_host", "imap_port", "username", "imap_username", "daily_email_limit", "active_hours_start", "active_hours_end", "timezone", "working_days", "signature", "ramp_start_date"]) {
      if (has(col)) put(col, body[col] ?? null);
    }
    if (has("ramp_up_enabled")) put("ramp_up_enabled", body.ramp_up_enabled ? 1 : 0);
    // Secrets: only rewrite when a non-empty value is supplied.
    if (body.password) put("password", encryptSecret(String(body.password)));
    if (body.imap_password) put("imap_password", encryptSecret(String(body.imap_password)));
    if (sets.length === 0) return res.json({ ok: true });
    db.prepare(`UPDATE email_accounts SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`).run(...params, id, ctx.workspaceId);
    recordAudit(ctx, "email_account.updated", "email_account", id);
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    // Detach the references that don't cascade before removing the row, otherwise the
    // delete fails with a foreign-key error whenever the account is (or was) attached to
    // a campaign run or an inbox reply. Warmup/sent/health rows cascade on their own.
    db.transaction(() => {
      db.prepare("UPDATE runs SET email_account_id = NULL WHERE email_account_id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
      db.prepare("UPDATE run_profiles SET email_account_id = NULL WHERE email_account_id = ?").run(id);
      db.prepare("UPDATE email_replies SET email_account_id = NULL WHERE email_account_id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
      db.prepare("DELETE FROM email_accounts WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    })();
    recordAudit(ctx, "email_account.deleted", "email_account", id);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
