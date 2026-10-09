import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { CONNECTION_MAX_WAIT_DAYS, DAILY_WITHDRAW_LIMIT } from "@/lib/linkedin/limits";
import { localDayBoundsUtc } from "@/lib/outreach/schedule";

/**
 * Old invitations nobody answered, and the record of withdrawing them.
 *
 * A campaign withdraws an invitation at the moment its connect step gives up on the contact.
 * That leaves everything it gave up on before it could do that, and every contact whose
 * campaign ended while the invitation was still out. This is the clean-up for those: it
 * finds them in the database and takes the invitations back a few a day.
 *
 * What it will and will not touch:
 *
 *  - Only invitations this app sent, to a contact it still has. An invitation sent by hand
 *    has no contact here and is never looked for.
 *  - Who it picks is decided from the database alone. It never reads LinkedIn's
 *    sent-invitations list to decide anything: that list loads lazily, and inferring from
 *    what had not loaded yet is how contacts were once marked connected by the hundred.
 *  - Never a contact a live campaign is still working on — that campaign's own connect
 *    step withdraws when its wait runs out, and a withdrawal from here would make it
 *    invite the contact a second time three weeks later.
 *  - Never a contact who has replied. Someone is in conversation with them; what happens
 *    to their invitation is that person's call.
 *
 * `linkedin_withdrawals` is both the day's budget and this clean-up's memory. Every
 * confirmed withdrawal is a row, whichever path made it, so one cap covers them all; and a
 * contact LinkedIn showed no invitation for is not visited again on every pass.
 *
 * This file is the database half only — which contacts, how many today, what happened —
 * so pages and tests can read it without loading the browser. The visit itself is
 * `withdrawStaleInvite` in lib/linkedin/stale-invites.ts.
 */

type DB = DatabaseType.Database;

/** Who asked for a withdrawal: a campaign giving up, this clean-up, or a person. */
export type WithdrawalSource = "campaign" | "cleanup" | "manual";

/**
 *  - `withdrawn`          taken back, and LinkedIn's profile confirmed it.
 *  - `already_withdrawn`  LinkedIn showed it as withdrawn before we touched anything.
 *  - `not_pending`        no invitation there at all: declined, expired, or never sent.
 *  - `connected`          they had accepted; the contact is now marked connected.
 *  - `unconfirmed`        LinkedIn reported it withdrawn and the profile went on showing it
 *                         as pending. Not a withdrawal — and a sign LinkedIn is not applying
 *                         them just now, so the account stops trying for the day.
 *  - `failed`             the page would not load or LinkedIn ignored the click.
 */
export type WithdrawalOutcome = "withdrawn" | "already_withdrawn" | "not_pending" | "connected" | "unconfirmed" | "failed";

// A contact whose visit did not settle anything (`failed` or `unconfirmed`) is left alone
// for a day between tries, and for good after this many, so one stubborn profile cannot
// hold the head of the queue.
const MAX_FAILED_ATTEMPTS = 3;
const UNSETTLED = "('failed', 'unconfirmed')";

export function recordWithdrawal(
  db: DB,
  row: { accountId: string; targetId: string | null; source: WithdrawalSource; outcome: WithdrawalOutcome; detail?: string | null },
): void {
  db.prepare("INSERT INTO linkedin_withdrawals (id, account_id, target_id, source, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), row.accountId, row.targetId, row.source, row.outcome, row.detail?.slice(0, 500) ?? null);
}

/**
 * LinkedIn reported a withdrawal today that did not take effect, so the account makes no
 * more attempts until its next calendar day. Seen live: once LinkedIn starts answering
 * "withdrawn" without withdrawing, it does so for every invitation tried, and each further
 * attempt is a profile visit and a click that achieve nothing.
 */
export function withdrawalsOnHold(db: DB, accountId: string, timezone: string | null): boolean {
  const day = localDayBoundsUtc(timezone || "UTC");
  return db.prepare(
    "SELECT 1 FROM linkedin_withdrawals WHERE account_id = ? AND outcome = 'unconfirmed' AND created_at >= ? AND created_at < ? LIMIT 1"
  ).get(accountId, day.start, day.end) !== undefined;
}

/** Invitations the account has withdrawn so far today, on its own calendar day, by any path. */
export function withdrawalsToday(db: DB, accountId: string, timezone: string | null): number {
  const day = localDayBoundsUtc(timezone || "UTC");
  return (db.prepare(
    "SELECT COUNT(*) AS c FROM linkedin_withdrawals WHERE account_id = ? AND outcome = 'withdrawn' AND created_at >= ? AND created_at < ?"
  ).get(accountId, day.start, day.end) as { c: number }).c;
}

export interface StaleInvite {
  id: string;
  full_name: string | null;
  linkedin_url: string;
  connection_requested_at: string;
}

/** The FROM/WHERE that defines a stale invitation for one account, and its parameters. */
function staleInviteQuery(db: DB, accountId: string): { sql: string; params: unknown[] } | null {
  const account = db.prepare("SELECT workspace_id FROM accounts WHERE id = ?").get(accountId) as { workspace_id: string | null } | undefined;
  if (!account?.workspace_id) return null;

  // With one LinkedIn account in the workspace every invitation recorded there is its own.
  // With several, this account answers only for the contacts it worked — the same rule the
  // connections sync applies, for the same reason.
  const accountsInWorkspace = (db.prepare("SELECT COUNT(*) AS c FROM accounts WHERE workspace_id = ?").get(account.workspace_id) as { c: number }).c;
  const ownContactsOnly = accountsInWorkspace > 1
    ? `AND EXISTS (SELECT 1 FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE rp.target_id = t.id AND r.account_id = ?)`
    : "";

  const sql = `
    FROM targets t
    WHERE t.workspace_id = ?
      AND t.linkedin_url LIKE '%/in/%'
      AND t.connection_requested_at IS NOT NULL
      AND datetime(t.connection_requested_at) <= datetime('now', ?)
      AND (t.degree IS NULL OR t.degree != 1)
      AND t.invite_withdrawn_at IS NULL
      AND t.last_replied_at IS NULL AND t.email_replied_at IS NULL
      ${ownContactsOnly}
      -- a campaign that has not finished with them: running, or able to resume
      AND NOT EXISTS (
        SELECT 1 FROM run_profile_tracks rt
        JOIN run_profiles rp ON rp.id = rt.run_profile_id
        JOIN runs r ON r.id = rp.run_id
        WHERE rp.target_id = t.id AND rt.track = 'linkedin'
          AND rt.state IN ('pending', 'in_progress') AND r.status IN ('pending', 'running', 'paused'))
      -- already settled for this invitation
      AND NOT EXISTS (
        SELECT 1 FROM linkedin_withdrawals w
        WHERE w.target_id = t.id AND w.outcome NOT IN ${UNSETTLED}
          AND datetime(w.created_at) >= datetime(t.connection_requested_at))
      -- a visit that settled nothing: one try a day, and a limit to how many
      AND NOT EXISTS (
        SELECT 1 FROM linkedin_withdrawals w
        WHERE w.target_id = t.id AND w.outcome IN ${UNSETTLED} AND datetime(w.created_at) > datetime('now', '-1 day'))
      AND (SELECT COUNT(*) FROM linkedin_withdrawals w
           WHERE w.target_id = t.id AND w.outcome IN ${UNSETTLED}
             AND datetime(w.created_at) >= datetime(t.connection_requested_at)) < ${MAX_FAILED_ATTEMPTS}`;
  const params: unknown[] = [account.workspace_id, `-${CONNECTION_MAX_WAIT_DAYS} days`];
  if (ownContactsOnly) params.push(accountId);
  return { sql, params };
}

/** The account's stale invitations, longest-pending first. */
export function staleInvites(db: DB, accountId: string, limit: number): StaleInvite[] {
  const query = staleInviteQuery(db, accountId);
  if (!query) return [];
  return db.prepare(
    `SELECT t.id, t.full_name, t.linkedin_url, t.connection_requested_at ${query.sql}
     ORDER BY datetime(t.connection_requested_at) ASC, t.id LIMIT ?`
  ).all(...query.params, limit) as StaleInvite[];
}

/** Whether one contact is, right now, a stale invitation of this account's. */
export function staleInvite(db: DB, accountId: string, targetId: string): StaleInvite | null {
  const query = staleInviteQuery(db, accountId);
  if (!query) return null;
  return (db.prepare(`SELECT t.id, t.full_name, t.linkedin_url, t.connection_requested_at ${query.sql} AND t.id = ?`)
    .get(...query.params, targetId) as StaleInvite | undefined) ?? null;
}

export interface StaleInviteStats {
  /** An invitation counts as stale once it has gone unanswered for this many days. */
  after_days: number;
  /**
   * Contacts the clean-up still has to look at. An upper bound on what it will withdraw:
   * the database only knows an invitation was recorded and no acceptance was, and on a
   * live account a good share of these turn out to be accepted already, or not pending.
   */
  waiting: number;
  /** Withdrawn today by any path — what the daily limit is measured against. */
  withdrawn_today: number;
  daily_limit: number;
  /** Withdrawn by the clean-up since it was first used. */
  withdrawn_by_cleanup: number;
  /** No more withdrawals today: LinkedIn reported one that did not take effect. */
  on_hold: boolean;
}

export function staleInviteStats(db: DB, accountId: string, timezone: string | null): StaleInviteStats {
  const query = staleInviteQuery(db, accountId);
  const waiting = query ? (db.prepare(`SELECT COUNT(*) AS c ${query.sql}`).get(...query.params) as { c: number }).c : 0;
  const byCleanup = (db.prepare(
    "SELECT COUNT(*) AS c FROM linkedin_withdrawals WHERE account_id = ? AND source = 'cleanup' AND outcome = 'withdrawn'"
  ).get(accountId) as { c: number }).c;
  return {
    after_days: CONNECTION_MAX_WAIT_DAYS, waiting,
    withdrawn_today: withdrawalsToday(db, accountId, timezone), daily_limit: DAILY_WITHDRAW_LIMIT, withdrawn_by_cleanup: byCleanup,
    on_hold: withdrawalsOnHold(db, accountId, timezone),
  };
}
