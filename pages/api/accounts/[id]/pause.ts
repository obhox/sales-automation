import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";

/**
 * Pause or resume a LinkedIn account.
 *   POST { paused: true, reason? }   stop everything this account does on LinkedIn
 *   POST { paused: false }           let it carry on
 *
 * A pause keeps the account signed in and keeps every contact where they are: campaign
 * steps, reply reading, imports and clean-up all wait, and pick up again on resume. It is
 * held where a session is opened (lib/linkedin/session.ts), so nothing can slip past it.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "manager"); if (!ctx) return;

  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "accounts", id)) return;
  if (typeof req.body?.paused !== "boolean") return res.status(400).json({ error: "paused must be true or false" });

  if (req.body.paused) {
    const reason = typeof req.body.reason === "string" && req.body.reason.trim() ? req.body.reason.trim().slice(0, 200) : null;
    db.prepare("UPDATE accounts SET paused_at = COALESCE(paused_at, datetime('now')), paused_reason = ? WHERE id = ? AND workspace_id = ?").run(reason, id, ctx.workspaceId);
    // Drop the open browser now rather than at its next use.
    const { closeSession } = await import("@/lib/linkedin/session");
    try { await closeSession(id); } catch { /* it is closed at the next use anyway */ }
    recordAudit(ctx, "account.paused", "account", id, reason ? { reason } : undefined);
  } else {
    db.prepare("UPDATE accounts SET paused_at = NULL, paused_reason = NULL WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "account.resumed", "account", id);
  }
  const row = db.prepare("SELECT paused_at, paused_reason FROM accounts WHERE id = ?").get(id) as { paused_at: string | null; paused_reason: string | null };
  return res.json({ ok: true, paused: Boolean(row.paused_at), paused_at: row.paused_at, reason: row.paused_reason });
}
