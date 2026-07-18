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

interface WarmupSchedule { active_hours_start: number | null; active_hours_end: number | null; timezone: string | null; working_days: string | null }

/** Local wall-clock parts in a timezone. Falls back to UTC for an unknown timezone. */
function localParts(tz: string, date = new Date()): { hour: number; minute: number; isoWeekday: number } {
  const safeZone = (() => { try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; } catch { return "UTC"; } })();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: safeZone, hour: "numeric", minute: "numeric", weekday: "short", hour12: false }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { hour: parseInt(get("hour"), 10) % 24, minute: parseInt(get("minute"), 10), isoWeekday: weekdayMap[get("weekday")] ?? 1 };
}

/** Is it currently inside the sender's active hours (its own timezone)? Warmup runs every
 *  day — including weekends — for consistent reputation-building, and deliberately ignores
 *  `working_days` (unlike campaigns). It still stays within the mailbox's active hours-of-day
 *  so sends land at human times. */
function isWithinActiveHours(acct: WarmupSchedule): boolean {
  const { hour, minute } = localParts(acct.timezone || "UTC");
  const frac = hour + minute / 60;
  return frac >= (acct.active_hours_start ?? 9) && frac < (acct.active_hours_end ?? 18);
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

const WARMUP_SUBJECTS = ["Quick project update", "Following up on our notes", "A thought for this week", "Checking in", "Next steps"];
const WARMUP_BODY = "Hi,\n\nSharing a short update and making sure this reaches you correctly. No action needed right now.\n\nBest,";

/**
 * Warmup sends ON-DEMAND and never builds a scheduled backlog. Each cycle, for every
 * warmup-enabled inbox that is inside its active hours and still under its daily target,
 * it sends one warmup mail to a random peer — paced so the daily quota spreads naturally
 * across the working day. Only completed sends are recorded; any legacy queued/expired/
 * failed rows are purged, so nothing ever accumulates.
 */
export async function processWarmupCycle(limit = 10): Promise<number> {
  const db = getDb();
  // No backlog, ever: drop anything that isn't a completed send (also clears legacy queues).
  db.prepare("DELETE FROM warmup_messages WHERE status != 'sent'").run();

  const enabled = db.prepare("SELECT workspace_id, email_account_id, daily_target FROM warmup_settings WHERE enabled = 1")
    .all() as Array<{ workspace_id: string; email_account_id: string; daily_target: number }>;
  let processed = 0;
  for (const setting of enabled) {
    if (processed >= limit) break;
    const acct = db.prepare("SELECT active_hours_start, active_hours_end, timezone, working_days FROM email_accounts WHERE id = ?")
      .get(setting.email_account_id) as WarmupSchedule | undefined;
    if (!acct || !isWithinActiveHours(acct)) continue; // only send during business hours

    const sentToday = (db.prepare("SELECT COUNT(*) c FROM warmup_messages WHERE from_account_id = ? AND status = 'sent' AND date(sent_at) = date('now')")
      .get(setting.email_account_id) as { c: number }).c;
    if (sentToday >= setting.daily_target) continue; // daily quota already met

    // Pace: one send per (active-window / daily_target) interval, so the quota trickles out
    // across the day instead of bursting. Uses the last real send time (persisted), so
    // restarts don't cause a burst.
    const windowHours = Math.max(1, (acct.active_hours_end ?? 18) - (acct.active_hours_start ?? 9));
    const gapMs = (windowHours / setting.daily_target) * 3600_000;
    const last = db.prepare("SELECT sent_at FROM warmup_messages WHERE from_account_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1")
      .get(setting.email_account_id) as { sent_at: string } | undefined;
    if (last && Date.now() - new Date(last.sent_at.replace(" ", "T") + "Z").getTime() < gapMs) continue;

    // Platform-wide pool: any other warmup-enabled, verified inbox is a valid peer.
    const peer = db.prepare(`SELECT ea.id, ea.from_email FROM email_accounts ea JOIN warmup_settings ws ON ws.email_account_id = ea.id
      WHERE ws.enabled = 1 AND ea.is_verified = 1 AND ea.id != ? ORDER BY random() LIMIT 1`)
      .get(setting.email_account_id) as { id: string; from_email: string } | undefined;
    if (!peer) continue; // no peers to warm with yet

    const id = randomUUID();
    const subject = WARMUP_SUBJECTS[Math.floor(Math.random() * WARMUP_SUBJECTS.length)];
    try {
      const receipt = await sendEmailDurably({ workspaceId: setting.workspace_id, emailAccountId: setting.email_account_id, idempotencyKey: `warmup:${id}`, source: "warmup", to: peer.from_email, subject, body: WARMUP_BODY, headers: { "X-Linki-Warmup-ID": id } });
      db.prepare(`INSERT INTO warmup_messages (id, workspace_id, from_account_id, to_account_id, subject, body, status, scheduled_at, sent_at, message_id)
        VALUES (?, ?, ?, ?, ?, ?, 'sent', datetime('now'), datetime('now'), ?)`)
        .run(id, setting.workspace_id, setting.email_account_id, peer.id, subject, WARMUP_BODY, receipt.messageId);
      emitDomainEvent({ workspaceId: setting.workspace_id, type: "email.warmup_sent", entityType: "warmup_message", entityId: id, payload: { from_account_id: setting.email_account_id, to_account_id: peer.id } });
      processed++;
    } catch (error) {
      console.warn(`[warmup] send failed ${peer.from_email} <- account ${setting.email_account_id}: ${message(error)}`);
    }
  }
  if (processed > 0) console.log(`[warmup] sent ${processed} this cycle`);
  return processed;
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
