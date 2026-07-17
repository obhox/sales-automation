import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { checkDomainDeliverability, scheduleWarmup } from "@/lib/platform/deliverability";
import { sendEmailDurably } from "@/lib/email/infrastructure";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    return res.json({
      latest_checks: db.prepare(`SELECT dc.*, ea.name account_name, ea.from_email FROM deliverability_checks dc
        LEFT JOIN email_accounts ea ON ea.id = dc.email_account_id WHERE dc.workspace_id = ?
        AND dc.checked_at = (SELECT MAX(dc2.checked_at) FROM deliverability_checks dc2 WHERE dc2.workspace_id = dc.workspace_id AND dc2.domain = dc.domain)
        ORDER BY dc.checked_at DESC`).all(ctx.workspaceId),
      warmup: db.prepare(`SELECT ws.*, ea.name, ea.from_email,
        (SELECT COUNT(*) FROM warmup_messages wm WHERE wm.from_account_id = ea.id AND date(wm.sent_at) = date('now') AND wm.status = 'sent') sent_today,
        (SELECT COUNT(*) FROM warmup_messages wm WHERE wm.from_account_id = ea.id AND wm.engaged_at IS NOT NULL) delivered_total,
        (SELECT COUNT(*) FROM warmup_messages wm WHERE wm.from_account_id = ea.id AND wm.rescued_at IS NOT NULL) rescued_total,
        (SELECT COUNT(*) FROM warmup_messages wm WHERE wm.from_account_id = ea.id AND wm.rescued_at IS NOT NULL AND date(wm.rescued_at) = date('now')) rescued_today
        FROM warmup_settings ws JOIN email_accounts ea ON ea.id = ws.email_account_id WHERE ws.workspace_id = ?`).all(ctx.workspaceId),
      placement_tests: db.prepare("SELECT * FROM inbox_placement_tests WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100").all(ctx.workspaceId),
    });
  }
  if (req.method !== "POST") return res.status(405).end();
  const { action } = req.body as { action?: string };
  if (action === "check_domain") {
    const { domain, email_account_id, selector } = req.body;
    if (!domain) return res.status(400).json({ error: "domain is required" });
    if(email_account_id&&!db.prepare("SELECT 1 FROM email_accounts WHERE id=? AND workspace_id=?").get(email_account_id,ctx.workspaceId))return res.status(400).json({error:"Email account not found"});
    const result = await checkDomainDeliverability({ workspaceId: ctx.workspaceId, domain, emailAccountId: email_account_id, selector });
    recordAudit(ctx, "deliverability.checked", "domain", domain, { score: result.score });
    return res.json(result);
  }
  if (action === "configure_warmup") {
    const { email_account_id, enabled, daily_target = 5, reply_rate = 60 } = req.body;
    const account = db.prepare("SELECT id FROM email_accounts WHERE id = ? AND workspace_id = ?").get(email_account_id, ctx.workspaceId);
    if (!account) return res.status(404).json({ error: "Email account not found" });
    db.prepare(`INSERT INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END, datetime('now'))
      ON CONFLICT(email_account_id) DO UPDATE SET enabled=excluded.enabled, daily_target=excluded.daily_target,
      reply_rate=excluded.reply_rate, started_at=COALESCE(warmup_settings.started_at, excluded.started_at), updated_at=datetime('now')`)
      .run(email_account_id, ctx.workspaceId, enabled ? 1 : 0, Math.min(Math.max(Number(daily_target), 1), 50), Math.min(Math.max(Number(reply_rate), 0), 100), enabled ? 1 : 0);
    const scheduled = enabled ? scheduleWarmup(ctx.workspaceId, email_account_id, Number(daily_target)) : 0;
    recordAudit(ctx, "warmup.configured", "email_account", email_account_id, { enabled, daily_target, reply_rate, scheduled });
    return res.json({ ok: true, scheduled });
  }
  if (action === "placement_test") {
    const { email_account_id, seed_email } = req.body;
    const account = db.prepare("SELECT * FROM email_accounts WHERE id = ? AND workspace_id = ?").get(email_account_id, ctx.workspaceId) as Record<string, unknown> | undefined;
    if (!account || !seed_email) return res.status(400).json({ error: "email_account_id and seed_email are required" });
    const id = randomUUID();
    const subject = `[Linki placement ${id.slice(0, 8)}] inbox test`;
    const receipt=await sendEmailDurably({workspaceId:ctx.workspaceId,emailAccountId:email_account_id,idempotencyKey:`placement:${id}`,source:"placement",to:seed_email,subject,body:"This is an authorized inbox placement test from Linki."});
    db.prepare(`INSERT INTO inbox_placement_tests (id, workspace_id, email_account_id, seed_email, subject, status, sent_at)
      VALUES (?, ?, ?, ?, ?, 'sent', datetime('now'))`).run(id, ctx.workspaceId, email_account_id, seed_email, subject);
    db.prepare("UPDATE inbox_placement_tests SET message_id=? WHERE id=?").run(receipt.messageId,id);
    recordAudit(ctx, "placement_test.sent", "inbox_placement_test", id, { seed_email });
    return res.status(201).json({ id, subject, status: "sent" });
  }
  if (action === "mark_placement") {
    const { id, placement } = req.body;
    if (!["inbox", "promotions", "spam", "missing"].includes(placement)) return res.status(400).json({ error: "Invalid placement" });
    db.prepare("UPDATE inbox_placement_tests SET placement = ?, status = 'checked', checked_at = datetime('now') WHERE id = ? AND workspace_id = ?").run(placement, id, ctx.workspaceId);
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: "Unknown action" });
}
