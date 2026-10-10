import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { recheckDisconnectedMailboxes } from "@/lib/email/connection";
import { domainOf } from "@/lib/email/dns";
import { checkDomainDeliverability } from "@/lib/platform/deliverability";
import { pruneGuardEvents, recordGuardEvent } from "@/lib/email/guard-events";
import { emailsSentToday } from "@/lib/email/mailbox-list";
import { effectiveEmailLimit, type MailboxPolicyRow } from "@/lib/email/mailbox-policy";
import { lookForRecentPlacementRuns } from "@/lib/email/placement";
import { localDayBoundsUtc } from "@/lib/outreach/schedule";

// The checks that keep what the Mailboxes screen says true without anyone asking: each
// sending domain's DNS records once a day, and each disconnected mailbox every half hour.

type DB = DatabaseType.Database;

/** A domain's records are looked up again once they are this old. */
export const DNS_RECHECK_HOURS = 24;

/** Domains looked up in one pass, so a workspace with many never holds the loop for long. */
const DOMAINS_PER_PASS = 3;

interface DueDomain {
  workspace_id: string;
  domain: string;
  selector: string | null;
}

/** Every sending domain whose last check is older than a day, or that has never had one. Oldest first. */
export function domainsDueForCheck(db: DB = getDb()): DueDomain[] {
  const mailboxes = db.prepare("SELECT DISTINCT workspace_id, from_email FROM email_accounts WHERE workspace_id IS NOT NULL").all() as Array<{ workspace_id: string; from_email: string }>;
  const seen = new Set<string>();
  const due: Array<DueDomain & { checked_at: string | null }> = [];
  const last = db.prepare("SELECT checked_at, details_json, checked_at <= datetime('now', ?) AS stale FROM deliverability_checks WHERE workspace_id = ? AND domain = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1");
  for (const mailbox of mailboxes) {
    const domain = domainOf(mailbox.from_email);
    if (!domain || seen.has(`${mailbox.workspace_id}:${domain}`)) continue;
    seen.add(`${mailbox.workspace_id}:${domain}`);
    const check = last.get(`-${DNS_RECHECK_HOURS} hours`, mailbox.workspace_id, domain) as { checked_at: string; details_json: string | null; stale: number } | undefined;
    if (check && !check.stale) continue;
    due.push({ workspace_id: mailbox.workspace_id, domain, selector: lastSelector(check?.details_json), checked_at: check?.checked_at ?? null });
  }
  return due.sort((a, b) => (a.checked_at ?? "").localeCompare(b.checked_at ?? "")).map(({ workspace_id, domain, selector }) => ({ workspace_id, domain, selector }));
}

/** The DKIM selector the last check found the key under, so the next one looks there first. */
export function lastSelector(detailsJson: string | null | undefined): string | null {
  if (!detailsJson) return null;
  try {
    const selector = (JSON.parse(detailsJson) as { dkim?: { selector?: unknown } }).dkim?.selector;
    return typeof selector === "string" && selector ? selector : null;
  } catch {
    return null;
  }
}

/** Look up the records of the domains that are due. Returns how many were checked. */
export async function recheckDueDomains(db: DB = getDb(), check: typeof checkDomainDeliverability = checkDomainDeliverability): Promise<number> {
  let checked = 0;
  for (const due of domainsDueForCheck(db).slice(0, DOMAINS_PER_PASS)) {
    try {
      await check({ workspaceId: due.workspace_id, domain: due.domain, selector: due.selector ?? undefined });
      checked++;
    } catch (error) {
      console.warn(`[mailbox] DNS check of ${due.domain} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return checked;
}

// ── What goes in the guard log without anyone doing anything ──────────────────

/**
 * A line for each mailbox that has reached today's limit, once a day per mailbox. The
 * runner says so in each campaign's own log, a line per contact it puts off; this is the
 * one place it is said per mailbox.
 */
export function recordDailyLimits(db: DB = getDb(), now: Date = new Date()): number {
  const rows = db.prepare(`SELECT id, workspace_id, from_email, timezone, daily_email_limit, ramp_up_enabled, ramp_start_date, ramp_days, ramp_start_limit
    FROM email_accounts WHERE workspace_id IS NOT NULL AND paused_at IS NULL AND disconnected_at IS NULL AND is_verified = 1`).all() as Array<MailboxPolicyRow & { id: string; workspace_id: string; from_email: string; timezone: string | null }>;
  if (rows.length === 0) return 0;
  const sent = emailsSentToday(db, rows, now);
  let recorded = 0;
  for (const row of rows) {
    const limit = effectiveEmailLimit(row, now);
    const count = sent.get(row.id) ?? 0;
    if (count < limit) continue;
    const day = localDayBoundsUtc(row.timezone || "UTC", now);
    // Contacts the runner put off today because this mailbox had no room left.
    const putOff = (db.prepare(`SELECT COUNT(*) AS c FROM logs l JOIN run_profiles rp ON rp.run_id = l.run_id AND rp.target_id = l.target_id
      WHERE l.message LIKE 'Daily email limit reached%' AND l.created_at >= ? AND l.created_at < ? AND rp.email_account_id = ?`).get(day.start, day.end, row.id) as { c: number }).c;
    const id = recordGuardEvent({
      workspaceId: row.workspace_id, kind: "daily_limit", tone: "warn", emailAccountId: row.id, domain: domainOf(row.from_email), dedupeKey: `daily-limit:${row.id}:${day.start.slice(0, 10)}`,
      title: `${row.from_email} reached its daily limit`,
      detail: `${count} of ${limit} sent. ${putOff ? `${putOff} more ${putOff === 1 ? "email waits" : "emails wait"} until tomorrow.` : "Anything else due today waits until tomorrow."}`,
      data: { sent: count, limit, put_off: putOff },
    }, db);
    if (id) recorded++;
  }
  return recorded;
}

/**
 * One line a day per workspace saying what the day before's warm-up came to. Written the
 * first time the loop comes round after midnight UTC.
 */
export function recordWarmupSummaries(db: DB = getDb(), now: Date = new Date()): number {
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT workspace_id, COUNT(*) AS sent, COUNT(DISTINCT from_account_id) AS mailboxes,
      COUNT(CASE WHEN rescued_at IS NOT NULL THEN 1 END) AS rescued, COUNT(CASE WHEN replied_at IS NOT NULL THEN 1 END) AS replied
    FROM warmup_messages WHERE status = 'sent' AND date(sent_at) = ? GROUP BY workspace_id`).all(yesterday) as Array<{ workspace_id: string; sent: number; mailboxes: number; rescued: number; replied: number }>;
  let recorded = 0;
  for (const row of rows) {
    const id = recordGuardEvent({
      workspaceId: row.workspace_id, kind: "warmup_cycle", tone: "mail", dedupeKey: `warmup:${yesterday}`,
      title: "Warm-up day completed",
      detail: `${row.sent} warm-up ${row.sent === 1 ? "email" : "emails"} sent from ${row.mailboxes} ${row.mailboxes === 1 ? "mailbox" : "mailboxes"} yesterday, ${row.replied} replied to, ${row.rescued} moved out of spam.`,
      data: { day: yesterday, sent: row.sent, mailboxes: row.mailboxes, rescued: row.rescued, replied: row.replied },
    }, db);
    if (id) recorded++;
  }
  return recorded;
}

// The log does not need looking at every time the loop comes round.
const LOG_EVERY_MS = 5 * 60_000;
const g = global as typeof global & { __linkiGuardLogAt?: number; __linkiGuardPrunedOn?: string };

/** One pass of the mailbox upkeep loop. */
/** One pass of the mailbox upkeep loop. */
export async function mailboxUpkeep(): Promise<void> {
  const reconnected = await recheckDisconnectedMailboxes();
  if (reconnected > 0) console.log(`[mailbox] ${reconnected} mailbox${reconnected === 1 ? "" : "es"} reconnected`);
  await recheckDueDomains();
  await lookForRecentPlacementRuns();
  if (Date.now() - (g.__linkiGuardLogAt ?? 0) >= LOG_EVERY_MS) {
    g.__linkiGuardLogAt = Date.now();
    recordDailyLimits();
    recordWarmupSummaries();
    const today = new Date().toISOString().slice(0, 10);
    if (g.__linkiGuardPrunedOn !== today) {
      g.__linkiGuardPrunedOn = today;
      pruneGuardEvents();
    }
  }
}
