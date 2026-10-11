import type DatabaseType from "better-sqlite3";
import { outboxSentBetween } from "@/lib/linkedin/outbox";
import { withdrawalsToday } from "@/lib/linkedin/withdrawals";
import { localDayBoundsUtc } from "@/lib/outreach/schedule";

type DB = DatabaseType.Database;

/**
 * What a LinkedIn account has done today and over the last seven days.
 *
 * Counted from step_sends, which records every campaign action against the account that
 * performed it. The runner used to count text matches in the run log ("Connection request
 * sent…") through the runs that currently name the account: that table has no index, a
 * deleted run took its log lines with it and reset the day's count, and it could not be
 * shown to anyone because it lived inside the tick. The day is the account's own calendar
 * day, the same boundaries the caps have always used.
 */
export interface AccountUsage {
  connects: number;
  messages: number;
  inmails: number;
  visits: number;
  withdrawals: number;
  /** Invitations over the last seven days, for the weekly limit. */
  connects_7d: number;
}

export function accountUsage(db: DB, accountId: string, timezone: string | null, now: Date = new Date()): AccountUsage {
  const day = localDayBoundsUtc(timezone || "UTC", now);
  const rows = db
    .prepare("SELECT action, COUNT(*) AS c FROM step_sends WHERE account_id = ? AND sent_at >= ? AND sent_at < ? GROUP BY action")
    .all(accountId, day.start, day.end) as { action: string; c: number }[];
  const today = (action: string) => rows.find(row => row.action === action)?.c ?? 0;
  const weekStart = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const week = db.prepare("SELECT COUNT(*) AS c FROM step_sends WHERE account_id = ? AND action = 'connect' AND sent_at >= ?").get(accountId, weekStart) as { c: number };
  return {
    connects: today("connect"),
    // Replies sent by hand from the inbox use up the same daily allowance.
    messages: today("message") + outboxSentBetween(db, accountId, day.start, day.end),
    inmails: today("inmail"),
    visits: today("visit"),
    withdrawals: withdrawalsToday(db, accountId, timezone),
    connects_7d: week.c,
  };
}
