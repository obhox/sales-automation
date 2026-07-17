import { randomUUID } from "crypto";
import { resolveMx, resolveTxt } from "dns/promises";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { sendEmailDurably } from "@/lib/email/infrastructure";
import { emitDomainEvent } from "@/lib/platform/events";

export async function checkDomainDeliverability(input: { workspaceId: string; domain: string; emailAccountId?: string; selector?: string }) {
  const domain = input.domain.toLowerCase().replace(/^www\./, "").trim();
  const [spf, dmarc, mx, dkim] = await Promise.all([
    txt(domain, (records) => records.some((v) => v.toLowerCase().startsWith("v=spf1"))),
    txt(`_dmarc.${domain}`, (records) => records.some((v) => v.toLowerCase().startsWith("v=dmarc1"))),
    resolveMx(domain).then((rows) => ({ ok: rows.length > 0, records: rows })).catch((error) => ({ ok: false, error: message(error), records: [] })),
    findDkim(domain, input.selector),
  ]);
  const account = input.emailAccountId ? getDb().prepare("SELECT is_verified FROM email_accounts WHERE id = ? AND workspace_id = ?").get(input.emailAccountId, input.workspaceId) as { is_verified: number } | undefined : undefined;
  const bounce = input.emailAccountId ? (getDb().prepare(`SELECT
      COUNT(CASE WHEN l.message LIKE 'Email sent%' THEN 1 END) sent,
      COUNT(CASE WHEN l.message LIKE '%bounce%' THEN 1 END) bounced
    FROM logs l JOIN runs r ON r.id = l.run_id JOIN run_profiles rp ON rp.run_id = r.id
    WHERE rp.email_account_id = ? AND l.created_at >= datetime('now','-30 days')`).get(input.emailAccountId) as { sent: number; bounced: number }) : { sent: 0, bounced: 0 };
  const bounceRate = bounce.sent ? bounce.bounced / bounce.sent : 0;
  const score = Math.max(0, Math.round((spf.ok ? 25 : 0) + (dkim.ok ? 25 : 0) + (dmarc.ok ? 30 : 0) + (mx.ok ? 10 : 0) + (account?.is_verified ? 10 : 0) - Math.min(30, bounceRate * 200)));
  const id = randomUUID();
  const details = { domain, spf, dkim, dmarc, mx, bounce_rate: bounceRate, recommendations: recommendations({ spf: spf.ok, dkim: dkim.ok, dmarc: dmarc.ok, mx: mx.ok, bounceRate }) };
  getDb().prepare(`INSERT INTO deliverability_checks
    (id, workspace_id, email_account_id, domain, spf_status, dkim_status, dmarc_status, mx_status, score, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.workspaceId, input.emailAccountId ?? null, domain, status(spf.ok), status(dkim.ok), status(dmarc.ok), status(mx.ok), score, JSON.stringify(details));
  return { id, score, ...details };
}

export function scheduleWarmup(workspaceId: string, emailAccountId: string, dailyTarget: number) {
  const db = getDb();
  // Platform-wide warmup pool: peers are every OTHER warmup-enabled, verified inbox
  // across the whole platform (not just this workspace), so inboxes warm each other
  // up even when a workspace has only one connected account.
  const peers = db.prepare(`SELECT ea.id FROM email_accounts ea JOIN warmup_settings ws ON ws.email_account_id = ea.id
    WHERE ws.enabled = 1 AND ea.is_verified = 1 AND ea.id != ? ORDER BY random()`).all(emailAccountId) as Array<{ id: string }>;
  if (!peers.length) return 0;
  const existing = (db.prepare(`SELECT COUNT(*) c FROM warmup_messages WHERE from_account_id = ? AND date(scheduled_at) = date('now')
    AND status IN ('scheduled','sent')`).get(emailAccountId) as { c: number }).c;
  const count = Math.max(0, dailyTarget - existing);
  const subjects = ["Quick project update", "Following up on our notes", "A thought for this week", "Checking in", "Next steps"];
  const insert = db.prepare(`INSERT INTO warmup_messages
    (id, workspace_id, from_account_id, to_account_id, subject, body, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < count; i++) {
    const peer = peers[i % peers.length];
    const scheduled = new Date(Date.now() + (9 + Math.random() * 8) * 3600_000).toISOString();
    insert.run(randomUUID(), workspaceId, emailAccountId, peer.id, subjects[i % subjects.length], `Hi,\n\nSharing a short update and making sure this reaches you correctly. No action needed right now.\n\nBest,`, scheduled);
  }
  return count;
}

/**
 * Turn warmup + ramp-up ON for an email account with sensible defaults. Called
 * automatically when an account is connected so warmup is live from day one
 * (it exchanges controlled warmup mail with the workspace's other warmup-enabled
 * inboxes, and gradually ramps campaign send volume). Safe to call repeatedly.
 */
export function enableWarmup(workspaceId: string, emailAccountId: string, opts: { dailyTarget?: number; replyRate?: number } = {}) {
  const db = getDb();
  const dailyTarget = Math.min(Math.max(opts.dailyTarget ?? 5, 1), 50);
  const replyRate = Math.min(Math.max(opts.replyRate ?? 60, 0), 100);
  db.prepare(`INSERT INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate, started_at, updated_at)
    VALUES (?, ?, 1, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(email_account_id) DO UPDATE SET enabled=1, daily_target=excluded.daily_target,
      reply_rate=excluded.reply_rate, started_at=COALESCE(warmup_settings.started_at, excluded.started_at), updated_at=datetime('now')`)
    .run(emailAccountId, workspaceId, dailyTarget, replyRate);
  db.prepare("UPDATE email_accounts SET ramp_up_enabled = 1, ramp_start_date = COALESCE(ramp_start_date, date('now')) WHERE id = ? AND workspace_id = ?")
    .run(emailAccountId, workspaceId);
  return { dailyTarget, replyRate };
}

export async function processWarmupCycle(limit = 10) {
  const db = getDb();
  const enabled = db.prepare("SELECT workspace_id, email_account_id, daily_target FROM warmup_settings WHERE enabled = 1").all() as Array<{ workspace_id: string; email_account_id: string; daily_target: number }>;
  for (const setting of enabled) scheduleWarmup(setting.workspace_id, setting.email_account_id, setting.daily_target);
  const rows = db.prepare(`SELECT wm.*, sender.*, receiver.from_email recipient
    FROM warmup_messages wm
    JOIN email_accounts sender ON sender.id = wm.from_account_id
    JOIN email_accounts receiver ON receiver.id = wm.to_account_id
    JOIN warmup_settings ws ON ws.email_account_id = sender.id AND ws.enabled = 1
    WHERE wm.status = 'scheduled' AND wm.scheduled_at <= datetime('now') ORDER BY wm.scheduled_at LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
  for (const row of rows) {
    try {
      const receipt=await sendEmailDurably({workspaceId:String(row.workspace_id),emailAccountId:String(row.from_account_id),idempotencyKey:`warmup:${String(row.id)}`,source:"warmup",to:String(row.recipient),subject:String(row.subject),body:String(row.body),headers:{"X-Linki-Warmup-ID":String(row.id)}});
      db.prepare("UPDATE warmup_messages SET status = 'sent', sent_at = datetime('now'),message_id=? WHERE id = ?").run(receipt.messageId,row.id);
      emitDomainEvent({ workspaceId: String(row.workspace_id), type: "email.warmup_sent", entityType: "warmup_message", entityId: String(row.id), payload: { from_account_id: row.from_account_id, to_account_id: row.to_account_id } });
    } catch (error) {
      db.prepare("UPDATE warmup_messages SET status = 'failed', error = ? WHERE id = ?").run(message(error), row.id);
    }
  }
  return rows.length;
}

async function txt(name: string, predicate: (records: string[]) => boolean) {
  try { const rows = (await resolveTxt(name)).map((parts) => parts.join("")); return { ok: predicate(rows), records: rows }; }
  catch (error) { return { ok: false, error: message(error), records: [] as string[] }; }
}
async function findDkim(domain: string, preferred?: string) {
  const selectors = [...new Set([preferred, "default", "google", "selector1", "selector2", "s1", "s2"].filter(Boolean) as string[])];
  for (const selector of selectors) {
    const result = await txt(`${selector}._domainkey.${domain}`, (records) => records.some((v) => /v=dkim1|p=/i.test(v)));
    if (result.ok) return { ...result, selector };
  }
  return { ok: false, records: [] as string[], selectors_checked: selectors };
}
function status(ok: boolean) { return ok ? "pass" : "fail"; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function recommendations(x: { spf: boolean; dkim: boolean; dmarc: boolean; mx: boolean; bounceRate: number }) {
  const out: string[] = [];
  if (!x.spf) out.push("Publish one SPF TXT record authorizing every sending provider.");
  if (!x.dkim) out.push("Enable DKIM signing and publish the provider selector.");
  if (!x.dmarc) out.push("Publish a DMARC record, beginning with p=none and aggregate reporting.");
  if (!x.mx) out.push("Configure valid MX records for the sending domain.");
  if (x.bounceRate > 0.03) out.push("Pause campaigns and clean the list; the 30-day bounce rate exceeds 3%.");
  return out;
}
