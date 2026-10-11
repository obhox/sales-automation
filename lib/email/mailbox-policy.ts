import type DatabaseType from "better-sqlite3";

// The numbers and rules that govern one mailbox right now: what it may send today while
// it ramps up, and whether its signature goes on an email. Pure functions of the mailbox
// row (and, for the signature, one look at what has been sent), so the runner, the API
// and the tests all agree.

type DB = DatabaseType.Database;

const DAY_MS = 86_400_000;

/** Emails a mailbox with the original ramp may send on its first day; it gains this many each day. */
export const LEGACY_RAMP_STEP = 2;

export interface MailboxPolicyRow {
  daily_email_limit: number | null;
  ramp_up_enabled: number | null;
  ramp_start_date: string | null;
  /** Days the ramp takes. NULL: the original ramp, two more emails a day until the limit. */
  ramp_days?: number | null;
  /** Emails allowed on the first day of a ramp with a length. NULL: LEGACY_RAMP_STEP. */
  ramp_start_limit?: number | null;
}

export interface MailboxRamp {
  /** 1 on the start date. */
  day: number;
  /** The day the full limit is reached. */
  days: number;
  /** Emails allowed today. */
  limit: number;
  /** The full limit has been reached. */
  complete: boolean;
}

const fullLimit = (row: MailboxPolicyRow) => row.daily_email_limit ?? 50;

/** Days since the ramp began, counting the first as 1. The clock is the one the ramp has always used. */
function rampDay(startDate: string, now: Date): number {
  return Math.max(1, Math.floor((now.getTime() - new Date(startDate).getTime()) / DAY_MS) + 1);
}

/**
 * Where a mailbox is in its ramp, or null when it has none.
 *
 * With no length set the limit is two emails on the first day and two more each day after,
 * which is how every mailbox has ramped until now. With a length, it rises in a straight
 * line from the starting figure on the first day to the full limit on the last.
 */
export function mailboxRamp(row: MailboxPolicyRow, now: Date = new Date()): MailboxRamp | null {
  if (!row.ramp_up_enabled || !row.ramp_start_date) return null;
  const full = fullLimit(row);
  const day = rampDay(row.ramp_start_date, now);
  if (Number.isNaN(day)) return null;

  const days = row.ramp_days ?? 0;
  if (days < 2) {
    const length = Math.max(1, Math.ceil(full / LEGACY_RAMP_STEP));
    const limit = Math.min(full, day * LEGACY_RAMP_STEP);
    return { day: Math.min(day, length), days: length, limit, complete: limit >= full };
  }
  if (day >= days) return { day: days, days, limit: full, complete: true };
  const from = Math.min(Math.max(1, row.ramp_start_limit ?? LEGACY_RAMP_STEP), full);
  const limit = Math.min(full, Math.round(from + ((full - from) * (day - 1)) / (days - 1)));
  return { day, days, limit, complete: false };
}

/** Emails the mailbox may send today: its limit, or less while it ramps up. */
export function effectiveEmailLimit(row: MailboxPolicyRow, now: Date = new Date()): number {
  return mailboxRamp(row, now)?.limit ?? fullLimit(row);
}

export const MAX_RAMP_DAYS = 90;

/** What is wrong with ramp settings as a person typed them, or null. Missing fields are not checked. */
export function rampProblem(input: { ramp_days?: unknown; ramp_start_limit?: unknown; daily_email_limit?: unknown }): string | null {
  const { ramp_days: days, ramp_start_limit: start, daily_email_limit: limit } = input;
  if (days !== undefined && days !== null) {
    if (!Number.isInteger(days) || (days as number) < 2 || (days as number) > MAX_RAMP_DAYS) return `The ramp must take between 2 and ${MAX_RAMP_DAYS} days.`;
  }
  if (start !== undefined && start !== null) {
    if (!Number.isInteger(start) || (start as number) < 1) return "The ramp must start at one email a day or more.";
    if (typeof limit === "number" && (start as number) > limit) return "The ramp cannot start above the daily limit.";
  }
  return null;
}

// ── Signature ─────────────────────────────────────────────────────────────────

export interface SignatureMailbox {
  signature: string | null;
  signature_first_only?: number | null;
}

/**
 * The signature for a campaign email, or null for none.
 *
 * A step's own signature always wins and is always used. Otherwise it is the mailbox's,
 * which a mailbox can keep to the first email a campaign sends a contact: a follow-up in
 * the same conversation already has it further down.
 */
export function campaignSignature(db: DB, mailbox: SignatureMailbox, stepSignature: string | null | undefined, runId: string, targetId: string): string | null {
  if (stepSignature !== null) return stepSignature?.trim() || null;
  const signature = mailbox.signature?.trim();
  if (!signature) return null;
  if (mailbox.signature_first_only === 1 && hasCampaignEmail(db, runId, targetId)) return null;
  return signature;
}

/** Whether this campaign run has already sent the contact an email. */
export function hasCampaignEmail(db: DB, runId: string, targetId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM email_jobs WHERE run_id = ? AND target_id = ? AND source = 'campaign' AND status = 'sent' LIMIT 1").get(runId, targetId));
}

/** An email body with a signature under it, set off the way it always has been. */
export function withSignature(body: string, signature: string | null): string {
  return signature ? `${body}\n\n--\n${signature}` : body;
}

// ── Guard thresholds ──────────────────────────────────────────────────────────

/** What a mailbox's guard is until somebody changes it. */
export const DEFAULT_GUARD = { bounce_threshold: 0.03, complaint_threshold: 0.001, min_health_sample: 50 } as const;

/** What is wrong with guard thresholds as sent, or null. Rates are fractions (0.03 is 3%). */
export function guardProblem(input: { bounce_threshold?: unknown; complaint_threshold?: unknown; min_health_sample?: unknown }): string | null {
  const rate = (value: unknown, low: number, high: number) => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
  if (input.bounce_threshold !== undefined && !rate(input.bounce_threshold, 0.005, 0.2)) return "The bounce guard must be between 0.5% and 20%.";
  if (input.complaint_threshold !== undefined && !rate(input.complaint_threshold, 0.0001, 0.02)) return "The complaint guard must be between 0.01% and 2%.";
  if (input.min_health_sample !== undefined && !(Number.isInteger(input.min_health_sample) && (input.min_health_sample as number) >= 10 && (input.min_health_sample as number) <= 5000)) {
    return "The guard needs between 10 and 5,000 emails before it can act.";
  }
  return null;
}
