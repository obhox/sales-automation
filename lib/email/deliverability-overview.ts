// What the Deliverability screen shows: for one sending domain, how its mail is being
// received, its mailboxes, its DNS records and what would improve them, its warm-up; and
// for the workspace, what the guards have done lately and who is not to be contacted.
//
// Nothing here changes anything.
import type DatabaseType from "better-sqlite3";
import type { RecordStatus } from "@/lib/email/dns";
import { getDomainSelector } from "@/lib/email/dns-changes";
import { domainRates, ON_DOMAIN } from "@/lib/email/domain-health";
import { domainScore, type DomainScore } from "@/lib/email/domain-score";
import { listGuardEvents, type GuardEvent } from "@/lib/email/guard-events";
import { listMailboxes, type MailboxView } from "@/lib/email/mailbox-list";
import { getMailboxSettings, type MailboxSettings } from "@/lib/email/mailbox-settings";
import { listPlacementRuns, listSeeds, placementSummary, type PlacementRun, type PlacementSummary, type Seed } from "@/lib/email/placement";

type DB = DatabaseType.Database;

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

export function parseRangeDays(value: unknown): RangeDays {
  const days = Number(value);
  return (RANGES as readonly number[]).includes(days) ? (days as RangeDays) : 30;
}

export interface DnsRecordView {
  status: RecordStatus;
  /** The record as published, or what stands for it. */
  value: string | null;
  /** What is wrong with it, when something is. */
  note: string | null;
  /** The last check could not look it up, so "missing" is not known to be true. */
  lookup_failed: boolean;
}

export interface DomainDnsDetail {
  /** Null when the domain has never been checked. */
  checked_at: string | null;
  records: { spf: DnsRecordView; dkim: DnsRecordView; dmarc: DnsRecordView; mx: DnsRecordView } | null;
  /** The selector the DKIM key was found under at the last check. */
  dkim_selector: string | null;
  /** The selector someone entered for this domain, tried first at every check. */
  dkim_selector_set: string | null;
  score: DomainScore | null;
}

export interface DomainDeliverability {
  domain: string;
  /** Over the chosen range. */
  figures: {
    /** Campaign emails sent. */
    sent: number;
    /** That, as a share of what the mailboxes' limits allow over the range. Null with no mailbox that can send. */
    capacity_share: number | null;
    /** Emails of every kind, which is what the two rates are out of (and what a mailbox's guard goes by). */
    sent_all: number;
    bounces: number;
    bounce_rate: number | null;
    complaints: number;
    complaint_rate: number | null;
    placement: PlacementSummary;
  };
  mailboxes: MailboxView[];
  dns: DomainDnsDetail;
  warmup: {
    in_pool: number;
    /** The last seven days, for the domain's mailboxes. */
    sent_week: number;
    replied_week: number;
    rescued_week: number;
    /** The mailbox furthest from the end of its ramp, if any is ramping. */
    ramping: { from_email: string; day: number; days: number; limit: number; limit_full: number } | null;
  };
  /** The latest placement runs for the domain. */
  placement_runs: PlacementRun[];
}

export interface DoNotContact {
  counts: { email: number; domain: number; linkedin: number; phone: number };
  total: number;
  /** Sends refused in the last 30 days because the recipient was on the list. */
  blocked_30d: number;
}

export interface DeliverabilityOverview {
  /** Every sending domain, for the tabs, the one with most mailboxes first. */
  domains: Array<{ domain: string; mailboxes: number; score: number | null }>;
  /** The domain asked for, or the first. Null when the workspace has no mailbox. */
  domain: DomainDeliverability | null;
  range: RangeDays;
  /** The last 24 hours across every mailbox. */
  guard: { events: GuardEvent[]; total: number };
  do_not_contact: DoNotContact;
  seeds: Seed[];
  settings: MailboxSettings;
}

interface CheckRow {
  spf_status: string | null; dkim_status: string | null; dmarc_status: string | null; mx_status: string | null;
  details_json: string | null; checked_at: string;
}

const asStatus = (value: unknown): RecordStatus => (value === "pass" || value === "weak" ? value : "fail");

/** One record out of a stored check, whichever of the two shapes it was stored in. */
function recordView(stored: unknown, column: string | null): DnsRecordView {
  const record = (stored && typeof stored === "object" ? stored : {}) as { status?: string; value?: string | null; note?: string | null; lookup_failed?: boolean; records?: unknown[] };
  // Checks kept before records had a standing hold only pass or fail, and a list of raw records.
  const legacy = Array.isArray(record.records) && typeof record.records[0] === "string" ? (record.records[0] as string) : null;
  return { status: asStatus(record.status ?? column), value: typeof record.value === "string" ? record.value : legacy, note: record.note ?? null, lookup_failed: Boolean(record.lookup_failed) };
}

function latestCheck(db: DB, workspaceId: string, domain: string): CheckRow | undefined {
  return db.prepare(`SELECT spf_status, dkim_status, dmarc_status, mx_status, details_json, checked_at FROM deliverability_checks
    WHERE workspace_id = ? AND domain = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1`).get(workspaceId, domain) as CheckRow | undefined;
}

export function domainDns(db: DB, workspaceId: string, domain: string): DomainDnsDetail {
  const check = latestCheck(db, workspaceId, domain);
  const selectorSet = getDomainSelector(db, workspaceId, domain);
  if (!check) return { checked_at: null, records: null, dkim_selector: null, dkim_selector_set: selectorSet, score: null };
  let details: Record<string, unknown> = {};
  try { details = check.details_json ? (JSON.parse(check.details_json) as Record<string, unknown>) : {}; } catch { /* statuses still stand */ }
  const records = {
    spf: recordView(details.spf, check.spf_status), dkim: recordView(details.dkim, check.dkim_status),
    dmarc: recordView(details.dmarc, check.dmarc_status), mx: recordView(details.mx, check.mx_status),
  };
  const selector = (details.dkim && typeof details.dkim === "object" ? (details.dkim as { selector?: unknown }).selector : null);
  const rates = domainRates(db, workspaceId, domain, 30);
  return {
    checked_at: check.checked_at, records, dkim_selector: typeof selector === "string" && selector ? selector : null, dkim_selector_set: selectorSet,
    score: domainScore(domain, { spf: records.spf.status, dkim: records.dkim.status, dmarc: records.dmarc.status, mx: records.mx.status, bounce_rate: rates.bounce_rate, complaint_rate: rates.complaint_rate }),
  };
}

export function domainDeliverability(db: DB, workspaceId: string, domain: string, range: RangeDays, mailboxes: MailboxView[]): DomainDeliverability {
  const own = mailboxes.filter((mailbox) => mailbox.domain === domain);
  const since = `-${range} days`;
  const campaign = (db.prepare(`SELECT COUNT(*) AS c FROM step_sends ss JOIN email_accounts ea ON ea.id = ss.email_account_id
    WHERE ss.workspace_id = ? AND ss.channel = 'email' AND ss.sent_at >= datetime('now', ?) AND ${ON_DOMAIN}`).get(workspaceId, since, domain) as { c: number }).c;
  const rates = domainRates(db, workspaceId, domain, range);
  // What the limits would have let through: every mailbox that can send, at its full limit, every day of the range.
  const capacity = own.filter((mailbox) => mailbox.status !== "disconnected" && mailbox.status !== "untested").reduce((sum, mailbox) => sum + mailbox.sending.limit_full, 0) * range;

  const ids = own.map((mailbox) => mailbox.id);
  const warm = ids.length
    ? (db.prepare(`SELECT COUNT(*) AS sent, COUNT(CASE WHEN replied_at IS NOT NULL THEN 1 END) AS replied, COUNT(CASE WHEN rescued_at IS NOT NULL THEN 1 END) AS rescued
        FROM warmup_messages WHERE status = 'sent' AND sent_at >= datetime('now', '-7 days') AND from_account_id IN (${ids.map(() => "?").join(",")})`).get(...ids) as { sent: number; replied: number; rescued: number })
    : { sent: 0, replied: 0, rescued: 0 };
  const ramping = own
    .filter((mailbox) => mailbox.ramp && !mailbox.ramp.complete && mailbox.status !== "disconnected" && mailbox.status !== "untested")
    .sort((a, b) => (a.ramp!.day / a.ramp!.days) - (b.ramp!.day / b.ramp!.days))[0];

  return {
    domain,
    figures: {
      sent: campaign, capacity_share: capacity > 0 ? campaign / capacity : null, sent_all: rates.sent,
      bounces: rates.bounces, bounce_rate: rates.bounce_rate, complaints: rates.complaints, complaint_rate: rates.complaint_rate,
      placement: placementSummary(db, workspaceId, domain, range),
    },
    mailboxes: own,
    dns: domainDns(db, workspaceId, domain),
    warmup: {
      in_pool: own.filter((mailbox) => mailbox.warmup.enabled).length, sent_week: warm.sent, replied_week: warm.replied, rescued_week: warm.rescued,
      ramping: ramping?.ramp ? { from_email: ramping.from_email, day: ramping.ramp.day, days: ramping.ramp.days, limit: ramping.ramp.limit, limit_full: ramping.sending.limit_full } : null,
    },
    placement_runs: listPlacementRuns(db, workspaceId, domain, 5),
  };
}

/** How many entries of each kind are on the do-not-contact list, and how many sends it stopped lately. */
export function doNotContact(db: DB, workspaceId: string): DoNotContact {
  const counts = { email: 0, domain: 0, linkedin: 0, phone: 0 };
  for (const row of db.prepare("SELECT kind, COUNT(*) AS c FROM suppressions WHERE workspace_id = ? GROUP BY kind").all(workspaceId) as Array<{ kind: keyof typeof counts; c: number }>) {
    if (row.kind in counts) counts[row.kind] = row.c;
  }
  // A campaign step stopped by the list leaves a line in its run's log; an email stopped
  // outside a campaign (a test, a reply from the inbox) leaves a failed job.
  const steps = (db.prepare(`SELECT COUNT(*) AS c FROM logs l JOIN runs r ON r.id = l.run_id
    WHERE r.workspace_id = ? AND l.created_at >= datetime('now', '-30 days') AND l.message LIKE '%is suppressed%'`).get(workspaceId) as { c: number }).c;
  const jobs = (db.prepare(`SELECT COUNT(*) AS c FROM email_jobs WHERE workspace_id = ? AND run_id IS NULL AND status = 'failed'
    AND last_error LIKE 'Recipient is suppressed%' AND updated_at >= datetime('now', '-30 days')`).get(workspaceId) as { c: number }).c;
  return { counts, total: counts.email + counts.domain + counts.linkedin + counts.phone, blocked_30d: steps + jobs };
}

export function deliverabilityOverview(db: DB, workspaceId: string, query: { domain?: string | null; range?: unknown } = {}): DeliverabilityOverview {
  const range = parseRangeDays(query.range);
  const mailboxes = listMailboxes(db, workspaceId);
  const byDomain = new Map<string, number>();
  for (const mailbox of mailboxes) byDomain.set(mailbox.domain, (byDomain.get(mailbox.domain) ?? 0) + 1);
  const domains = [...byDomain.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([domain, count]) => ({ domain, mailboxes: count, score: domainDns(db, workspaceId, domain).score?.score ?? null }));
  const wanted = query.domain?.trim().toLowerCase();
  const selected = domains.find((item) => item.domain === wanted)?.domain ?? domains[0]?.domain ?? null;
  return {
    domains,
    domain: selected ? domainDeliverability(db, workspaceId, selected, range, mailboxes) : null,
    range,
    guard: listGuardEvents(db, workspaceId, { hours: 24, limit: 8 }),
    do_not_contact: doNotContact(db, workspaceId),
    seeds: listSeeds(db, workspaceId),
    settings: getMailboxSettings(workspaceId, db),
  };
}

// ── The report ────────────────────────────────────────────────────────────────

export type ReportRow = Record<string, string | number | null>;

/** One row per mailbox, with its domain's figures beside its own: what "Export report" downloads. */
export function deliverabilityReport(db: DB, workspaceId: string, range: RangeDays, onlyDomain?: string | null): ReportRow[] {
  const mailboxes = listMailboxes(db, workspaceId);
  const domains = [...new Set(mailboxes.map((mailbox) => mailbox.domain))].filter((domain) => !onlyDomain || domain === onlyDomain).sort();
  const rows: ReportRow[] = [];
  const percent = (rate: number | null) => (rate === null ? null : Number((rate * 100).toFixed(2)));
  for (const domain of domains) {
    const detail = domainDeliverability(db, workspaceId, domain, range, mailboxes);
    for (const mailbox of detail.mailboxes) {
      rows.push({
        domain, domain_score: detail.dns.score?.score ?? null,
        spf: detail.dns.records?.spf.status ?? null, dkim: detail.dns.records?.dkim.status ?? null, dmarc: detail.dns.records?.dmarc.status ?? null, mx: detail.dns.records?.mx.status ?? null,
        dns_checked_at: detail.dns.checked_at,
        domain_emails_sent: detail.figures.sent, domain_bounce_rate_percent: percent(detail.figures.bounce_rate), domain_complaint_rate_percent: percent(detail.figures.complaint_rate),
        placement_copies_checked: detail.figures.placement.checked, placement_in_inbox: detail.figures.placement.inbox, placement_in_spam: detail.figures.placement.spam, placement_missing: detail.figures.placement.missing,
        mailbox: mailbox.from_email, provider: mailbox.provider.label, status: mailbox.status,
        sent_today: mailbox.sending.sent_today, limit_today: mailbox.sending.limit_today, daily_limit: mailbox.sending.limit_full,
        ramp_day: mailbox.ramp?.day ?? null, ramp_days: mailbox.ramp?.days ?? null,
        reputation: mailbox.reputation?.score ?? null,
        emails_30d: mailbox.health.sent, bounces_30d: mailbox.health.bounces, bounce_rate_30d_percent: percent(mailbox.health.bounce_rate),
        complaints_30d: mailbox.health.complaints, complaint_rate_30d_percent: percent(mailbox.health.complaint_rate),
        warmup: mailbox.warmup.state, warmup_sent_7d: mailbox.warmup.sent_week, warmup_rescued_7d: mailbox.warmup.rescued_week,
      });
    }
  }
  return rows;
}
