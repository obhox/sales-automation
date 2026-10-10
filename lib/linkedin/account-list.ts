// A workspace's LinkedIn accounts as the app lists them.
//
// Two shapes come from here. `listLinkedinAccounts` is the row with its stale-invitation
// figures, which the API and the MCP tool are given. `linkedinAccountsOverview` adds everything
// the LinkedIn accounts screen shows: today's usage against each limit, the session's
// state, warm-up, the weekly limit, and who owns the account.
import type DatabaseType from "better-sqlite3";
import { effectiveConnectionLimit, rampState, weeklyHold, weeklyNear, withdrawLimit, inviteWaitDays, type RampState, type WeeklyHold } from "@/lib/linkedin/account-policy";
import { storedContext } from "@/lib/linkedin/session-context";
import { accountUsage, type AccountUsage } from "@/lib/linkedin/usage";
import { staleInviteStats, type StaleInviteStats } from "@/lib/linkedin/withdrawals";

type DB = DatabaseType.Database;

// Excludes cookies_json: nothing on a screen uses the raw session, only is_authenticated,
// so there is no reason to send it (even encrypted) to the browser.
export const LINKEDIN_ACCOUNT_COLUMNS = `id, name, email, is_authenticated, daily_connection_limit, daily_message_limit, daily_inmail_limit, daily_visit_limit,
    active_hours_start, active_hours_end, timezone, working_days, withdraw_stale_invites, sync_inbox, created_at,
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

// ── The LinkedIn accounts screen ──────────────────────────────────────────────

/**
 * The one word for where an account stands, in the order a person needs to know it:
 * a session problem first, then a deliberate pause, then anything limiting it.
 */
export type AccountStatus = "never_connected" | "disconnected" | "needs_signin" | "paused" | "weekly_hold" | "warming_up" | "active";

export interface LinkedinAccountView {
  id: string;
  name: string;
  email: string;
  plan: string | null;
  owner: { id: string; name: string } | null;
  status: AccountStatus;
  session: {
    signed_in: boolean;
    /** 'login' (signed in through the server) or 'cookie'; null when unknown or never connected. */
    method: string | null;
    state: string | null;
    error: string | null;
    changed_at: string | null;
  };
  paused: { at: string; reason: string | null } | null;
  /** Today, on the account's own calendar day. */
  usage: AccountUsage;
  /** What the account may do today. `connections` is the number after warm-up. */
  limits: { connections: number; connections_full: number; messages: number; visits: number; inmails: number; withdrawals: number };
  weekly: { used: number; limit: number | null; hold: WeeklyHold | null; near: boolean };
  ramp: (RampState & { start_date: string; start_limit: number | null }) | null;
  /** A warm-up that is set up and starts on the day the account first signs in. */
  ramp_planned: { days: number; start_limit: number | null } | null;
  schedule: { start: number; end: number; days: string; timezone: string };
  invites: { wait_days: number; wait_days_own: number | null; withdraw_limit_own: number | null; auto_withdraw: boolean; pending: number | null; stale: StaleInviteStats };
  /** The proxy as configured, and whether the signed-in session is actually using it yet. */
  proxy: { server: string; label: string | null; has_credentials: boolean; in_use: boolean } | null;
  read_replies: boolean;
  synced: { replies_at: string | null; connections_at: string | null; stats_at: string | null };
  stats: { connections: number | null; profile_views: number | null };
  created_at: string;
}

interface AccountRow {
  id: string; name: string; email: string; plan: string | null; owner_id: string | null; owner_name: string | null; owner_email: string | null;
  is_authenticated: number | null; auth_method: string | null; session_state: string | null; session_error: string | null; session_changed_at: string | null;
  paused_at: string | null; paused_reason: string | null;
  daily_connection_limit: number | null; daily_message_limit: number | null; daily_inmail_limit: number | null; daily_visit_limit: number | null;
  weekly_connection_limit: number | null; weekly_limit_hit_at: string | null; daily_withdraw_limit: number | null; invite_max_wait_days: number | null;
  ramp_start_date: string | null; ramp_days: number | null; ramp_start_limit: number | null;
  active_hours_start: number | null; active_hours_end: number | null; timezone: string | null; working_days: string | null;
  withdraw_stale_invites: number; sync_inbox: number; proxy_url: string | null; proxy_username: string | null; proxy_label: string | null;
  session_context_json: string | null; inbox_synced_at: string | null; accepted_sync_at: string | null; li_stats_synced_at: string | null;
  li_connections: number | null; li_pending: number | null; li_profile_views: number | null; created_at: string; has_session: number;
}

const nameFromEmail = (email: string) => (email.split("@")[0] ?? "").split(/[._\-+]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(" ") || email;

function statusOf(row: AccountRow, hold: WeeklyHold | null, ramp: RampState | null): AccountStatus {
  if (!row.is_authenticated) {
    if (row.session_state === "disconnected") return "disconnected";
    return row.has_session || row.session_state === "needs_signin" ? "needs_signin" : "never_connected";
  }
  if (row.paused_at) return "paused";
  if (hold) return "weekly_hold";
  if (ramp) return "warming_up";
  return "active";
}

function view(db: DB, row: AccountRow, now: Date): LinkedinAccountView {
  const timezone = row.timezone || "UTC";
  const usage = accountUsage(db, row.id, timezone, now);
  const ramp = rampState(row, now);
  const hold = weeklyHold(row, usage.connects_7d, now);
  const session = storedContext(row.session_context_json);
  return {
    id: row.id, name: row.name, email: row.email, plan: row.plan,
    owner: row.owner_id ? { id: row.owner_id, name: row.owner_name?.trim() || nameFromEmail(row.owner_email ?? "") } : null,
    status: statusOf(row, hold, ramp),
    session: { signed_in: Boolean(row.is_authenticated), method: row.auth_method, state: row.session_state, error: row.session_error, changed_at: row.session_changed_at },
    paused: row.paused_at ? { at: row.paused_at, reason: row.paused_reason } : null,
    usage,
    limits: {
      connections: effectiveConnectionLimit(row, now), connections_full: row.daily_connection_limit ?? 20,
      messages: row.daily_message_limit ?? 50, visits: row.daily_visit_limit ?? 150, inmails: row.daily_inmail_limit ?? 15, withdrawals: withdrawLimit(row),
    },
    weekly: { used: usage.connects_7d, limit: row.weekly_connection_limit, hold, near: weeklyNear(row, usage.connects_7d) },
    ramp: ramp && row.ramp_start_date ? { ...ramp, start_date: row.ramp_start_date, start_limit: row.ramp_start_limit } : null,
    ramp_planned: row.ramp_days && !row.ramp_start_date ? { days: row.ramp_days, start_limit: row.ramp_start_limit } : null,
    schedule: { start: row.active_hours_start ?? 9, end: row.active_hours_end ?? 18, days: row.working_days || "1,2,3,4,5", timezone },
    invites: {
      wait_days: inviteWaitDays(row), wait_days_own: row.invite_max_wait_days, withdraw_limit_own: row.daily_withdraw_limit,
      auto_withdraw: Boolean(row.withdraw_stale_invites), pending: row.li_pending, stale: staleInviteStats(db, row.id, timezone),
    },
    proxy: row.proxy_url
      ? { server: row.proxy_url, label: row.proxy_label, has_credentials: Boolean(row.proxy_username), in_use: Boolean(row.is_authenticated) && session.proxy?.server === row.proxy_url }
      : null,
    read_replies: Boolean(row.sync_inbox),
    synced: { replies_at: row.inbox_synced_at, connections_at: row.accepted_sync_at, stats_at: row.li_stats_synced_at },
    stats: { connections: row.li_connections, profile_views: row.li_profile_views },
    created_at: row.created_at,
  };
}

const OVERVIEW_SELECT = `
  SELECT a.id, a.name, a.email, a.plan, a.owner_id, u.name AS owner_name, u.email AS owner_email,
         a.is_authenticated, a.auth_method, a.session_state, a.session_error, a.session_changed_at, a.paused_at, a.paused_reason,
         a.daily_connection_limit, a.daily_message_limit, a.daily_inmail_limit, a.daily_visit_limit,
         a.weekly_connection_limit, a.weekly_limit_hit_at, a.daily_withdraw_limit, a.invite_max_wait_days,
         a.ramp_start_date, a.ramp_days, a.ramp_start_limit, a.active_hours_start, a.active_hours_end, a.timezone, a.working_days,
         a.withdraw_stale_invites, a.sync_inbox, a.proxy_url, a.proxy_username, a.proxy_label, a.session_context_json,
         a.inbox_synced_at, a.accepted_sync_at, a.li_stats_synced_at, a.li_connections, a.li_pending, a.li_profile_views, a.created_at,
         (a.cookies_json IS NOT NULL) AS has_session
  FROM accounts a LEFT JOIN users u ON u.id = a.owner_id`;

export function linkedinAccountView(db: DB, workspaceId: string, id: string, now: Date = new Date()): LinkedinAccountView | null {
  const row = db.prepare(`${OVERVIEW_SELECT} WHERE a.id = ? AND a.workspace_id = ?`).get(id, workspaceId) as AccountRow | undefined;
  return row ? view(db, row, now) : null;
}

export interface LinkedinAccountsOverview {
  accounts: LinkedinAccountView[];
  /** Share of invitations sent in a week that were accepted, this week and the one before (null: none sent). */
  acceptance: { rate: number | null; previous: number | null; sent: number };
}

/** Everything the LinkedIn accounts screen shows, oldest account first so cards do not move as accounts are added. */
export function linkedinAccountsOverview(db: DB, workspaceId: string, now: Date = new Date()): LinkedinAccountsOverview {
  const rows = db.prepare(`${OVERVIEW_SELECT} WHERE a.workspace_id = ? ORDER BY a.created_at ASC, a.rowid ASC`).all(workspaceId) as AccountRow[];
  // Acceptance is measured on the contact: invited in the window, connected by now.
  const window = (fromDays: number, toDays: number) =>
    db.prepare(
      `SELECT COUNT(*) AS sent, SUM(CASE WHEN degree = 1 OR connected_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted
       FROM targets WHERE workspace_id = ? AND connection_requested_at IS NOT NULL
         AND datetime(connection_requested_at) >= datetime(?, ?) AND datetime(connection_requested_at) < datetime(?, ?)`,
    ).get(workspaceId, now.toISOString(), `-${fromDays} days`, now.toISOString(), `-${toDays} days`) as { sent: number; accepted: number | null };
  const current = window(7, 0);
  const before = window(14, 7);
  return {
    accounts: rows.map(row => view(db, row, now)),
    acceptance: {
      rate: current.sent ? (current.accepted ?? 0) / current.sent : null,
      previous: before.sent ? (before.accepted ?? 0) / before.sent : null,
      sent: current.sent,
    },
  };
}
