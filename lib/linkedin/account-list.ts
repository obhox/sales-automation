// A workspace's LinkedIn accounts as the app lists them. The settings page reads this
// when it is first rendered and again, through GET /api/accounts, after every action on
// an account. The two used to be separate queries, and only the first carried the
// stale-invitation figures the page prints for each account, so the page broke on the
// first refresh.
import type DatabaseType from "better-sqlite3";
import { staleInviteStats, type StaleInviteStats } from "@/lib/linkedin/withdrawals";

type DB = DatabaseType.Database;

// Excludes cookies_json: nothing on a screen uses the raw session, only is_authenticated,
// so there is no reason to send it (even encrypted) to the browser.
export const LINKEDIN_ACCOUNT_COLUMNS = `id, name, email, is_authenticated, daily_connection_limit, daily_message_limit, daily_inmail_limit, daily_visit_limit,
    active_hours_start, active_hours_end, timezone, working_days, withdraw_stale_invites, created_at,
    inbox_synced_at, accepted_sync_at, li_connections, li_pending, li_profile_views,
    li_stats_synced_at, connections_synced_through_ms`;

export type ListedLinkedinAccount = Record<string, unknown> & { id: string; timezone: string | null; stale_invites: StaleInviteStats };

const withInviteStats = (db: DB, account: { id: string; timezone: string | null }): ListedLinkedinAccount =>
  ({ ...account, stale_invites: staleInviteStats(db, account.id, account.timezone) });

/** Every LinkedIn account of a workspace, newest first, each with its stale-invitation figures. */
export function listLinkedinAccounts(db: DB, workspaceId: string): ListedLinkedinAccount[] {
  return (db.prepare(`SELECT ${LINKEDIN_ACCOUNT_COLUMNS} FROM accounts WHERE workspace_id = ? ORDER BY created_at DESC`).all(workspaceId) as Array<{ id: string; timezone: string | null }>)
    .map((account) => withInviteStats(db, account));
}

/** One account in the same shape, or null if the workspace has no such account. */
export function listedLinkedinAccount(db: DB, workspaceId: string, id: string): ListedLinkedinAccount | null {
  const account = db.prepare(`SELECT ${LINKEDIN_ACCOUNT_COLUMNS} FROM accounts WHERE id = ? AND workspace_id = ?`).get(id, workspaceId) as { id: string; timezone: string | null } | undefined;
  return account ? withInviteStats(db, account) : null;
}
