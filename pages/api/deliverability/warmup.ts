import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { normaliseDomain } from "@/lib/email/dns";
import { mailboxIdsOnDomain } from "@/lib/email/domain-health";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * POST { domain, enabled } : put every mailbox on a sending domain into the warm-up pool,
 * or take them all out (admin). A mailbox keeps its own daily number and reply rate.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "admin"); if (!ctx) return;
  const db = getDb();
  const domain = typeof req.body?.domain === "string" ? normaliseDomain(req.body.domain) : "";
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
  const ids = mailboxIdsOnDomain(db, ctx.workspaceId, domain);
  if (!domain || ids.length === 0) return res.status(404).json({ error: "No mailbox in this workspace sends from that domain" });

  const enabled = req.body.enabled ? 1 : 0;
  const save = db.prepare(`INSERT INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate, started_at, updated_at)
    VALUES (?, ?, ?, 5, 60, CASE WHEN ? THEN datetime('now') ELSE NULL END, datetime('now'))
    ON CONFLICT(email_account_id) DO UPDATE SET enabled = excluded.enabled, started_at = COALESCE(warmup_settings.started_at, excluded.started_at), updated_at = datetime('now')`);
  db.transaction(() => { for (const id of ids) save.run(id, ctx.workspaceId, enabled, enabled); })();
  recordAudit(ctx, "warmup.configured", "domain", domain, { enabled: Boolean(enabled), mailboxes: ids.length });
  return res.json({ ok: true, mailboxes: ids.length, enabled: Boolean(enabled) });
}
