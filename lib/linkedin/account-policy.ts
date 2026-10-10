import { CONNECTION_MAX_WAIT_DAYS, DAILY_WITHDRAW_LIMIT } from "@/lib/linkedin/limits";

// The numbers that govern one LinkedIn account right now: its limits after warm-up, how
// long it waits for an invitation, and whether new invitations are on hold. Pure
// functions of the account row, so the runner, the API and tests all agree.

export interface AccountPolicyRow {
  daily_connection_limit: number | null;
  weekly_connection_limit?: number | null;
  weekly_limit_hit_at?: string | null;
  daily_withdraw_limit?: number | null;
  invite_max_wait_days?: number | null;
  ramp_start_date?: string | null;
  ramp_days?: number | null;
  ramp_start_limit?: number | null;
}

const DAY_MS = 86_400_000;

/** After LinkedIn says an account has hit its weekly limit, how long before one invitation is tried again. */
export const WEEKLY_HOLD_HOURS = 24;

/** When an own weekly cap counts as "near": this share of it used. */
export const WEEKLY_NEAR_RATIO = 0.9;

export interface RampState {
  /** 1 on the start date. */
  day: number;
  days: number;
  /** Invitations allowed today. */
  limit: number;
}

/**
 * Where an account is in its warm-up, or null when it has none or has finished. The daily
 * invitation limit rises in a straight line from `ramp_start_limit` on the first day to
 * the account's full limit on the last.
 */
export function rampState(row: AccountPolicyRow, now: Date = new Date()): RampState | null {
  const full = row.daily_connection_limit ?? 20;
  const days = row.ramp_days ?? 0;
  if (!row.ramp_start_date || days < 2) return null;
  const start = Date.parse(`${row.ramp_start_date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = Math.floor((today - start) / DAY_MS) + 1;
  if (day < 1 || day >= days) return null; // not started yet, or at the full limit
  const from = Math.min(Math.max(1, row.ramp_start_limit ?? Math.min(20, full)), full);
  const limit = Math.min(full, Math.round(from + ((full - from) * (day - 1)) / (days - 1)));
  return { day, days, limit };
}

/** Invitations the account may send today: its limit, or less while it is warming up. */
export function effectiveConnectionLimit(row: AccountPolicyRow, now: Date = new Date()): number {
  return rampState(row, now)?.limit ?? row.daily_connection_limit ?? 20;
}

/** Invitations the account may withdraw in a day: its own number, or the instance's. */
export function withdrawLimit(row: Pick<AccountPolicyRow, "daily_withdraw_limit">): number {
  return row.daily_withdraw_limit && row.daily_withdraw_limit > 0 ? row.daily_withdraw_limit : DAILY_WITHDRAW_LIMIT;
}

/** Days an invitation may stay unanswered before it is taken back: the account's own, or the instance's. */
export function inviteWaitDays(row: Pick<AccountPolicyRow, "invite_max_wait_days">): number {
  return row.invite_max_wait_days && row.invite_max_wait_days > 0 ? row.invite_max_wait_days : CONNECTION_MAX_WAIT_DAYS;
}

export type WeeklyHold =
  /** LinkedIn said the account has reached its weekly invitation limit. */
  | { reason: "linkedin"; until: string }
  /** The account's own seven-day cap is used up. */
  | { reason: "cap"; used: number; limit: number };

/**
 * Whether new invitations are on hold for this account, and why. `connectsLast7Days` is
 * the count over the last seven days (a rolling window: a calendar week would let two
 * full quotas out either side of its boundary).
 */
export function weeklyHold(row: AccountPolicyRow, connectsLast7Days: number, now: Date = new Date()): WeeklyHold | null {
  if (row.weekly_limit_hit_at) {
    const hit = Date.parse(row.weekly_limit_hit_at.includes("T") ? row.weekly_limit_hit_at : `${row.weekly_limit_hit_at.replace(" ", "T")}Z`);
    const until = hit + WEEKLY_HOLD_HOURS * 3_600_000;
    if (!Number.isNaN(hit) && now.getTime() < until) return { reason: "linkedin", until: new Date(until).toISOString() };
  }
  const cap = row.weekly_connection_limit;
  if (cap && cap > 0 && connectsLast7Days >= cap) return { reason: "cap", used: connectsLast7Days, limit: cap };
  return null;
}

/** True when an own weekly cap is nearly used up but not yet reached. */
export function weeklyNear(row: AccountPolicyRow, connectsLast7Days: number): boolean {
  const cap = row.weekly_connection_limit;
  return Boolean(cap && cap > 0 && connectsLast7Days < cap && connectsLast7Days >= Math.floor(cap * WEEKLY_NEAR_RATIO));
}
