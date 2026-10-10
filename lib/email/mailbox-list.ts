// A workspace's mailboxes as the Mailboxes screen shows them: grouped by the domain they
// send from, each with what it has sent today against what it may, where it is in its
// ramp and its warm-up, its reputation, and whether it can sign in.
//
// Nothing here changes anything, and nothing here returns a password.
import type DatabaseType from "better-sqlite3";
import { domainOf, type RecordStatus } from "@/lib/email/dns";
import { isAutoPause, readSenderHealth } from "@/lib/email/infrastructure";
import { mailboxRamp, type MailboxRamp } from "@/lib/email/mailbox-policy";
import { getMailboxSettings, type MailboxSettings } from "@/lib/email/mailbox-settings";
import { reputation, reputationBand, type Reputation, type ReputationBand } from "@/lib/email/reputation";
import { latestMailboxTest, type TestSend } from "@/lib/email/test-send";
import { localDayBoundsUtc } from "@/lib/outreach/schedule";

type DB = DatabaseType.Database;

/**
 * The one word for where a mailbox stands, in the order a person needs to know it: it
 * cannot sign in, then it was stopped (by its guard, or by someone), then it has never
 * been tested, then it has nothing left to send today.
 */
export type MailboxStatus = "disconnected" | "auto_paused" | "paused" | "untested" | "at_limit" | "active";

/** off: not in the warm-up pool. stopped / paused: in it, and held because the mailbox is. */
export type WarmupState = "off" | "stopped" | "paused" | "warming" | "warmed";

export interface MailboxView {
  id: string;
  name: string;
  from_email: string;
  from_name: string | null;
  reply_to: string | null;
  domain: string;
  /** Who runs the mail server, and how Linki signs in to it. */
  provider: { key: string; label: string; method: string };
  status: MailboxStatus;
  /** When it was paused or disconnected, and why. Null while it is sending. */
  held: { at: string; reason: string | null } | null;
  /** False for a mailbox with no IMAP server: replies and bounces to it are never seen. */
  reads_replies: boolean;
  schedule: { start: number; end: number; days: string; timezone: string };
  /** Campaign emails today, on the mailbox's own calendar day, against today's limit. */
  sending: { sent_today: number; limit_today: number; limit_full: number };
  ramp: (MailboxRamp & { start_date: string; custom_days: number | null; start_limit: number | null }) | null;
  ramp_enabled: boolean;
  warmup: { state: WarmupState; enabled: boolean; daily_target: number; reply_rate: number; sent_today: number; sent_week: number; rescued_week: number; peers: number };
  reputation: (Reputation & { band: ReputationBand }) | null;
  /** The last 30 days. Rates are null when nothing was sent. */
  health: { sent: number; bounces: number; complaints: number; bounce_rate: number | null; complaint_rate: number | null;
    /** The figures are over the guard right now: resumed, the mailbox would be paused again at the next check. */
    over_guard: boolean };
  guard: { bounce_threshold: number; complaint_threshold: number; min_health_sample: number };
  signature: string | null;
  signature_first_only: boolean;
  /** How it connects. Passwords are never part of this. */
  connection: { smtp_host: string; smtp_port: number; smtp_secure: boolean; imap_host: string | null; imap_port: number | null; username: string; imap_username: string | null; allow_self_signed: boolean };
  /** Campaigns running or paused that have contacts with this mailbox. */
  active_campaigns: number;
  last_test: TestSend | null;
  created_at: string;
}

export interface DomainDnsView {
  spf: RecordStatus | null;
  dkim: RecordStatus | null;
  dmarc: RecordStatus | null;
  mx: RecordStatus | null;
  /** Null when the domain has never been checked. */
  checked_at: string | null;
}

export interface DomainView {
  domain: string;
  dns: DomainDnsView;
  mailboxes: MailboxView[];
}

export interface MailboxesOverview {
  domains: DomainView[];
  settings: MailboxSettings;
}

interface Row {
  id: string; workspace_id: string; name: string; from_email: string; from_name: string | null; reply_to: string | null;
  smtp_host: string; smtp_port: number | null; smtp_secure: number | null; imap_host: string | null; imap_port: number | null;
  username: string; imap_username: string | null; allow_self_signed: number | null;
  daily_email_limit: number | null; active_hours_start: number | null; active_hours_end: number | null; timezone: string | null; working_days: string | null;
  is_verified: number | null; signature: string | null; signature_first_only: number | null;
  ramp_up_enabled: number | null; ramp_start_date: string | null; ramp_days: number | null; ramp_start_limit: number | null;
  provider: string | null; paused_at: string | null; paused_reason: string | null; disconnected_at: string | null; disconnect_reason: string | null;
  bounce_threshold: number; complaint_threshold: number; min_health_sample: number; created_at: string;
}

// Everything but the two passwords and the provider connection.
const COLUMNS = `id, workspace_id, name, from_email, from_name, reply_to, smtp_host, smtp_port, smtp_secure, imap_host, imap_port,
  username, imap_username, allow_self_signed, daily_email_limit, active_hours_start, active_hours_end, timezone, working_days,
  is_verified, signature, signature_first_only, ramp_up_enabled, ramp_start_date, ramp_days, ramp_start_limit,
  provider, paused_at, paused_reason, disconnected_at, disconnect_reason, bounce_threshold, complaint_threshold, min_health_sample, created_at`;

const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)gmail\.com$|(^|\.)googlemail\.com$|(^|\.)google\.com$/, "Gmail"],
  [/office365\.com$|outlook\.com$|(^|\.)office\.com$|hotmail\.com$/, "Microsoft 365"],
  [/mailgun\.(org|com)$/, "Mailgun"],
  [/postmarkapp\.com$/, "Postmark"],
  [/sendgrid\.net$/, "SendGrid"],
  [/amazonaws\.com$/, "Amazon SES"],
  [/zoho\.(com|eu|in)$/, "Zoho Mail"],
  [/fastmail\.com$/, "Fastmail"],
  [/(^|\.)mail\.me\.com$|icloud\.com$/, "iCloud Mail"],
];

/** Who runs a mailbox's mail server and how Linki signs in, as two short labels. */
export function providerOf(row: { provider: string | null; smtp_host: string; imap_host: string | null }): MailboxView["provider"] {
  if (row.provider === "gmail") return { key: "google", label: "Google Workspace", method: "Google sign-in" };
  if (row.provider === "microsoft") return { key: "microsoft", label: "Microsoft 365", method: "Microsoft sign-in" };
  if (row.provider === "gmail_app_password") return { key: "google", label: "Gmail", method: "App password" };
  const host = row.smtp_host.toLowerCase();
  const known = HOSTS.find(([pattern]) => pattern.test(host))?.[1];
  const method = row.imap_host ? "SMTP/IMAP" : "SMTP only";
  if (known === "Gmail") return { key: "google", label: known, method };
  if (known === "Microsoft 365") return { key: "microsoft", label: known, method };
  return { key: "smtp", label: known ? `SMTP · ${known}` : `SMTP · ${host}`, method };
}

/**
 * Campaign emails each mailbox has sent today, on its own calendar day. This is the count
 * the runner holds a mailbox to (the run log, matched to the mailbox each contact is
 * with), so the screen and the runner never disagree about whether a mailbox is at its limit.
 */
export function emailsSentToday(db: DB, mailboxes: Array<{ id: string; timezone: string | null }>, now: Date = new Date()): Map<string, number> {
  const counts = new Map<string, number>();
  const byZone = new Map<string, string[]>();
  for (const mailbox of mailboxes) byZone.set(mailbox.timezone || "UTC", [...(byZone.get(mailbox.timezone || "UTC") ?? []), mailbox.id]);
  for (const [zone, ids] of byZone) {
    const day = localDayBoundsUtc(zone, now);
    const rows = db.prepare(`SELECT rp.email_account_id AS id, COUNT(*) AS c FROM logs l
        JOIN run_profiles rp ON rp.run_id = l.run_id AND rp.target_id = l.target_id
      WHERE l.message LIKE 'Email sent%' AND l.created_at >= ? AND l.created_at < ? AND rp.email_account_id IN (${ids.map(() => "?").join(",")})
      GROUP BY rp.email_account_id`).all(day.start, day.end, ...ids) as Array<{ id: string; c: number }>;
    for (const row of rows) counts.set(row.id, row.c);
  }
  return counts;
}

function statusOf(row: Row, sentToday: number, limitToday: number): MailboxStatus {
  if (row.disconnected_at) return "disconnected";
  if (row.paused_at) return isAutoPause(row.paused_reason) ? "auto_paused" : "paused";
  if (!row.is_verified) return "untested";
  return sentToday >= limitToday ? "at_limit" : "active";
}

/** The latest DNS check of each sending domain in a workspace. */
export function latestDomainChecks(db: DB, workspaceId: string): Map<string, DomainDnsView> {
  const rows = db.prepare(`SELECT dc.domain, dc.spf_status, dc.dkim_status, dc.dmarc_status, dc.mx_status, dc.checked_at FROM deliverability_checks dc
    WHERE dc.workspace_id = ? AND dc.rowid = (SELECT dc2.rowid FROM deliverability_checks dc2 WHERE dc2.workspace_id = dc.workspace_id AND dc2.domain = dc.domain
      ORDER BY dc2.checked_at DESC, dc2.rowid DESC LIMIT 1)`).all(workspaceId) as Array<{ domain: string; spf_status: string | null; dkim_status: string | null; dmarc_status: string | null; mx_status: string | null; checked_at: string }>;
  const status = (value: string | null): RecordStatus | null => (value === "pass" || value === "weak" || value === "fail" ? value : null);
  return new Map(rows.map((row) => [row.domain, { spf: status(row.spf_status), dkim: status(row.dkim_status), dmarc: status(row.dmarc_status), mx: status(row.mx_status), checked_at: row.checked_at }]));
}

const NO_DNS: DomainDnsView = { spf: null, dkim: null, dmarc: null, mx: null, checked_at: null };

/** Every mailbox of a workspace as the screen shows it, oldest first. */
export function listMailboxes(db: DB, workspaceId: string, now: Date = new Date()): MailboxView[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM email_accounts WHERE workspace_id = ? ORDER BY created_at, rowid`).all(workspaceId) as Row[];
  if (rows.length === 0) return [];
  const sent = emailsSentToday(db, rows, now);
  const dns = latestDomainChecks(db, workspaceId);
  const settings = getMailboxSettings(workspaceId, db);

  const warmupSettings = new Map((db.prepare("SELECT email_account_id, enabled, daily_target, reply_rate FROM warmup_settings WHERE workspace_id = ?").all(workspaceId) as Array<{ email_account_id: string; enabled: number; daily_target: number; reply_rate: number }>)
    .map((row) => [row.email_account_id, row]));
  const warmupFigures = new Map((db.prepare(`SELECT from_account_id AS id,
      COUNT(CASE WHEN date(sent_at) = date('now') THEN 1 END) AS sent_today,
      COUNT(CASE WHEN sent_at >= datetime('now', '-7 days') THEN 1 END) AS sent_week,
      COUNT(CASE WHEN rescued_at >= datetime('now', '-7 days') THEN 1 END) AS rescued_week,
      COUNT(CASE WHEN engaged_at IS NOT NULL AND sent_at >= datetime('now', '-30 days') THEN 1 END) AS checked,
      COUNT(CASE WHEN rescued_at IS NOT NULL AND sent_at >= datetime('now', '-30 days') THEN 1 END) AS spam
    FROM warmup_messages WHERE workspace_id = ? AND status = 'sent' GROUP BY from_account_id`).all(workspaceId) as Array<{ id: string; sent_today: number; sent_week: number; rescued_week: number; checked: number; spam: number }>)
    .map((row) => [row.id, row]));
  // Mailboxes a warm-up email can go to: this workspace's own, and other workspaces' while
  // both sides share. The same rule the warm-up cycle picks a peer by.
  const peers = db.prepare(`SELECT ea.id, ea.workspace_id FROM email_accounts ea JOIN warmup_settings ws ON ws.email_account_id = ea.id
    WHERE ws.enabled = 1 AND ea.is_verified = 1 AND ea.disconnected_at IS NULL
      AND (ea.workspace_id = ? OR (? = 1 AND NOT EXISTS (
        SELECT 1 FROM workspace_settings off WHERE off.workspace_id = ea.workspace_id AND off.key = 'warmup_shared_pool' AND off.value = '0')))`)
    .all(workspaceId, settings.shared_pool ? 1 : 0) as Array<{ id: string; workspace_id: string }>;
  const campaigns = new Map((db.prepare(`SELECT rp.email_account_id AS id, COUNT(DISTINCT rp.run_id) AS c FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
    WHERE r.workspace_id = ? AND r.status IN ('running', 'paused') AND rp.email_account_id IS NOT NULL GROUP BY rp.email_account_id`).all(workspaceId) as Array<{ id: string; c: number }>)
    .map((row) => [row.id, row.c]));

  return rows.map((row): MailboxView => {
    const domain = domainOf(row.from_email) ?? "unknown";
    const full = row.daily_email_limit ?? 50;
    const ramp = mailboxRamp(row, now);
    const limitToday = ramp?.limit ?? full;
    const sentToday = sent.get(row.id) ?? 0;
    const status = statusOf(row, sentToday, limitToday);
    const health = readSenderHealth(row.id, db);
    const warm = warmupSettings.get(row.id);
    const figures = warmupFigures.get(row.id);
    const warmupEnabled = Boolean(warm?.enabled);
    const warmupState: WarmupState = !warmupEnabled ? "off" : status === "disconnected" ? "stopped" : row.paused_at ? "paused" : ramp && !ramp.complete ? "warming" : "warmed";
    const domainDns = dns.get(domain);
    // A mailbox that cannot sign in or has never been tested has no reputation to speak of.
    const score = status === "disconnected" || status === "untested" ? null : reputation({
      sent: health?.sent ?? 0, bounces: health?.bounces ?? 0, complaints: health?.complaints ?? 0,
      warmup_checked: figures?.checked ?? 0, warmup_spam: figures?.spam ?? 0,
      dns: domainDns?.spf && domainDns.dkim && domainDns.dmarc ? { spf: domainDns.spf, dkim: domainDns.dkim, dmarc: domainDns.dmarc } : null,
    });
    return {
      id: row.id, name: row.name, from_email: row.from_email, from_name: row.from_name, reply_to: row.reply_to, domain,
      provider: providerOf(row),
      status,
      held: row.disconnected_at ? { at: row.disconnected_at, reason: row.disconnect_reason } : row.paused_at ? { at: row.paused_at, reason: row.paused_reason } : null,
      reads_replies: Boolean(row.imap_host),
      schedule: { start: row.active_hours_start ?? 9, end: row.active_hours_end ?? 18, days: row.working_days || "1,2,3,4,5", timezone: row.timezone || "UTC" },
      sending: { sent_today: sentToday, limit_today: limitToday, limit_full: full },
      ramp: ramp && row.ramp_start_date ? { ...ramp, start_date: row.ramp_start_date, custom_days: row.ramp_days && row.ramp_days >= 2 ? row.ramp_days : null, start_limit: row.ramp_start_limit } : null,
      ramp_enabled: Boolean(row.ramp_up_enabled),
      warmup: {
        state: warmupState, enabled: warmupEnabled, daily_target: warm?.daily_target ?? 5, reply_rate: warm?.reply_rate ?? 60,
        sent_today: figures?.sent_today ?? 0, sent_week: figures?.sent_week ?? 0, rescued_week: figures?.rescued_week ?? 0,
        peers: peers.filter((peer) => peer.id !== row.id).length,
      },
      reputation: score ? { ...score, band: reputationBand(score.score) } : null,
      health: { sent: health?.sent ?? 0, bounces: health?.bounces ?? 0, complaints: health?.complaints ?? 0, bounce_rate: health?.sent ? health.bounce_rate : null, complaint_rate: health?.sent ? health.complaint_rate : null, over_guard: Boolean(health?.trip) },
      guard: { bounce_threshold: row.bounce_threshold, complaint_threshold: row.complaint_threshold, min_health_sample: row.min_health_sample },
      signature: row.signature, signature_first_only: row.signature_first_only === 1,
      connection: {
        smtp_host: row.smtp_host, smtp_port: row.smtp_port ?? 587, smtp_secure: row.smtp_secure === 1, imap_host: row.imap_host || null, imap_port: row.imap_host ? row.imap_port ?? 993 : null,
        username: row.username, imap_username: row.imap_username, allow_self_signed: row.allow_self_signed === 1,
      },
      active_campaigns: campaigns.get(row.id) ?? 0,
      last_test: latestMailboxTest(db, workspaceId, row.id),
      created_at: row.created_at,
    };
  });
}

/** One mailbox in the same shape, or null if the workspace has no such mailbox. */
export function listedMailbox(db: DB, workspaceId: string, id: string): MailboxView | null {
  return listMailboxes(db, workspaceId).find((mailbox) => mailbox.id === id) ?? null;
}

/** The screen's data: the mailboxes under the domain each sends from, largest domain first. */
export function mailboxesOverview(db: DB, workspaceId: string, now: Date = new Date()): MailboxesOverview {
  const mailboxes = listMailboxes(db, workspaceId, now);
  const dns = latestDomainChecks(db, workspaceId);
  const byDomain = new Map<string, MailboxView[]>();
  for (const mailbox of mailboxes) byDomain.set(mailbox.domain, [...(byDomain.get(mailbox.domain) ?? []), mailbox]);
  const domains = [...byDomain.entries()]
    .map(([domain, list]) => ({ domain, dns: dns.get(domain) ?? NO_DNS, mailboxes: list }))
    .sort((a, b) => b.mailboxes.length - a.mailboxes.length || a.domain.localeCompare(b.domain));
  return { domains, settings: getMailboxSettings(workspaceId, db) };
}

// ── Upcoming sends ────────────────────────────────────────────────────────────

export interface QueueItem {
  key: string;
  /** sent: it went today. sending: on its way out now. due: a contact's next step, at the time it is expected. */
  status: "sent" | "sending" | "due";
  at: string;
  contact: { id: string | null; name: string; company: string | null };
  campaign: { id: string | null; name: string };
  /** The email's place among the campaign's email steps, from 1. */
  step: number | null;
}

export interface MailboxQueue {
  /** Contacts whose next email is expected before the end of the mailbox's day. */
  due_today: number;
  /** Emails the limit still allows today. */
  room_today: number;
  /** Contacts enrolled and not yet given a first send time. */
  waiting: number;
  /** When the next one is expected. Null when nothing is scheduled. */
  next_at: string | null;
  items: QueueItem[];
}

const nameOf = (row: { full_name: string | null; first_name: string | null; last_name: string | null; email: string | null }) =>
  row.full_name?.trim() || [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.email || "Unknown contact";

/**
 * What a mailbox has sent today and what it is expected to send next.
 *
 * An email is only written and queued at the moment it is sent, so there is no queue to
 * read. What comes next is worked out from each contact's next step time, which the runner
 * moves as it paces the day: every time here is an estimate.
 */
export function mailboxQueue(db: DB, workspaceId: string, emailAccountId: string, now: Date = new Date()): MailboxQueue | null {
  const mailbox = listedMailbox(db, workspaceId, emailAccountId);
  if (!mailbox) return null;
  const day = localDayBoundsUtc(mailbox.schedule.timezone, now);
  type ContactRow = { full_name: string | null; first_name: string | null; last_name: string | null; email: string | null; company: string | null };

  const sent = db.prepare(`SELECT ss.id, ss.sent_at AS at, ss.target_id, ss.workflow_id, w.name AS campaign, t.full_name, t.first_name, t.last_name, t.email, t.company,
      (SELECT COUNT(*) FROM workflow_steps s2 JOIN workflow_steps s ON s.id = ss.step_id
        WHERE s2.workflow_id = s.workflow_id AND s2.track = 'email' AND s2.step_order <= s.step_order) AS step
    FROM step_sends ss LEFT JOIN targets t ON t.id = ss.target_id LEFT JOIN workflows w ON w.id = ss.workflow_id
    WHERE ss.workspace_id = ? AND ss.email_account_id = ? AND ss.channel = 'email' AND ss.sent_at >= ?
    ORDER BY ss.sent_at DESC LIMIT 2`).all(workspaceId, emailAccountId, day.start) as Array<ContactRow & { id: string; at: string; target_id: string | null; workflow_id: string | null; campaign: string | null; step: number }>;

  const sending = db.prepare(`SELECT j.id, j.updated_at AS at, j.target_id, r.workflow_id, w.name AS campaign, t.full_name, t.first_name, t.last_name, t.email, t.company
    FROM email_jobs j LEFT JOIN runs r ON r.id = j.run_id LEFT JOIN workflows w ON w.id = r.workflow_id LEFT JOIN targets t ON t.id = j.target_id
    WHERE j.workspace_id = ? AND j.email_account_id = ? AND j.source = 'campaign' AND j.status IN ('leased', 'sending')
    ORDER BY j.updated_at LIMIT 3`).all(workspaceId, emailAccountId) as Array<ContactRow & { id: string; at: string; target_id: string | null; workflow_id: string | null; campaign: string | null }>;

  // Contacts with a time for their next email, in campaigns that are running.
  const DUE = `FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id JOIN runs r ON r.id = rp.run_id
    WHERE r.workspace_id = ? AND rp.email_account_id = ? AND r.status = 'running' AND rt.track = 'email' AND rt.state = 'in_progress' AND rt.next_step_at IS NOT NULL`;
  const due = db.prepare(`SELECT rt.id, rt.next_step_at AS at, rt.current_step, rp.target_id, r.workflow_id, w.name AS campaign, t.full_name, t.first_name, t.last_name, t.email, t.company
    ${DUE.replace("JOIN runs r ON r.id = rp.run_id", "JOIN runs r ON r.id = rp.run_id LEFT JOIN workflows w ON w.id = r.workflow_id LEFT JOIN targets t ON t.id = rp.target_id")}
    ORDER BY datetime(rt.next_step_at) LIMIT 8`).all(workspaceId, emailAccountId) as Array<ContactRow & { id: string; at: string; current_step: number; target_id: string | null; workflow_id: string | null; campaign: string | null }>;
  const dueToday = (db.prepare(`SELECT COUNT(*) AS c ${DUE} AND datetime(rt.next_step_at) < datetime(?)`).get(workspaceId, emailAccountId, day.end) as { c: number }).c;
  const waiting = (db.prepare(`SELECT COUNT(*) AS c FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id JOIN runs r ON r.id = rp.run_id
    WHERE r.workspace_id = ? AND rp.email_account_id = ? AND r.status = 'running' AND rt.track = 'email' AND rt.state = 'pending'`).get(workspaceId, emailAccountId) as { c: number }).c;

  const item = (status: QueueItem["status"], row: ContactRow & { id: string; at: string; target_id: string | null; workflow_id: string | null; campaign: string | null }, step: number | null): QueueItem => ({
    key: `${status}:${row.id}`, status, at: row.at,
    contact: { id: row.target_id, name: nameOf(row), company: row.company?.trim() || null },
    campaign: { id: row.workflow_id, name: row.campaign?.trim() || "A deleted campaign" },
    step,
  });

  // Nothing leaves a mailbox that is held, whatever its contacts' next step times say.
  const held = mailbox.status === "disconnected" || mailbox.status === "auto_paused" || mailbox.status === "paused";
  return {
    due_today: held ? 0 : dueToday,
    room_today: Math.max(0, mailbox.sending.limit_today - mailbox.sending.sent_today),
    waiting,
    next_at: held ? null : due[0]?.at ?? null,
    items: [
      ...sent.reverse().map((row) => item("sent", row, row.step || null)),
      ...sending.map((row) => item("sending", row, null)),
      ...(held ? [] : due.map((row) => item("due", row, row.current_step + 1))),
    ],
  };
}
