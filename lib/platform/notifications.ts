import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { ROLE_LEVEL, isWorkspaceRole, type WorkspaceRole } from "@/lib/roles";

// In-app notifications: the list behind the bell.
//
// A notification belongs to a workspace. It is either for one member (user_id) or for
// everyone in the workspace at or above a role (min_role). Whether a member has read it
// is kept per member, so one person opening the bell does not clear it for the rest.

export type NotificationTone = "info" | "good" | "warn" | "bad";

export const NOTIFICATION_KINDS = ["reply.positive", "mailbox.paused", "linkedin.signin_needed", "linkedin.weekly_limit", "linkedin.proxy_unreachable", "import.finished", "runner.stalled"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotifyInput {
  workspaceId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Where clicking it goes: a path inside the app. */
  link?: string;
  tone?: NotificationTone;
  /** For one member only. Leave out to address a role. */
  userId?: string;
  /** The lowest role that sees it when it is not addressed to one member. Default: member. */
  minRole?: WorkspaceRole;
  /**
   * Something that is true for a while (a stalled runner, a paused mailbox) is raised
   * once: a second notification with the same key in the same workspace is dropped.
   */
  dedupeKey?: string;
}

const KEEP_DAYS = 60;

/** Record a notification. Never throws: failing to tell someone must not undo what happened. Returns the id, or null if it was a duplicate or could not be written. */
export function notify(input: NotifyInput, db: Database.Database = getDb()): string | null {
  try {
    const id = randomUUID();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO notifications (id, workspace_id, user_id, min_role, kind, tone, title, body, link, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.workspaceId, input.userId ?? null, input.minRole ?? "member", input.kind, input.tone ?? "info", input.title.slice(0, 200), input.body?.slice(0, 500) ?? null, input.link ?? null, input.dedupeKey ?? null);
    if (result.changes === 0) return null;
    // Old notifications are not kept: the bell is for what is new.
    db.prepare("DELETE FROM notifications WHERE workspace_id = ? AND created_at < datetime('now', ?)").run(input.workspaceId, `-${KEEP_DAYS} days`);
    return id;
  } catch (error) {
    console.warn("[notifications] could not record a notification:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** The SQL condition for "this member can see it", with its parameters. */
function visibleTo(userId: string, role: WorkspaceRole): { where: string; params: unknown[] } {
  const roles = (Object.keys(ROLE_LEVEL) as WorkspaceRole[]).filter(candidate => ROLE_LEVEL[candidate] <= ROLE_LEVEL[role]);
  return {
    where: `(n.user_id = ? OR (n.user_id IS NULL AND n.min_role IN (${roles.map(() => "?").join(",")})))`,
    params: [userId, ...roles],
  };
}

export interface NotificationRow {
  id: string;
  kind: string;
  tone: NotificationTone;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read: boolean;
}

export function listNotifications(workspaceId: string, userId: string, role: WorkspaceRole, limit = 30, db: Database.Database = getDb()): NotificationRow[] {
  if (!isWorkspaceRole(role)) return [];
  const scope = visibleTo(userId, role);
  const rows = db
    .prepare(
      `SELECT n.id, n.kind, n.tone, n.title, n.body, n.link, n.created_at, (r.notification_id IS NOT NULL) AS read
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
       WHERE n.workspace_id = ? AND ${scope.where}
       ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?`,
    )
    .all(userId, workspaceId, ...scope.params, Math.min(Math.max(limit, 1), 100)) as (Omit<NotificationRow, "read"> & { read: number })[];
  return rows.map(row => ({ ...row, read: Boolean(row.read) }));
}

export function unreadNotificationCount(workspaceId: string, userId: string, role: WorkspaceRole, db: Database.Database = getDb()): number {
  if (!isWorkspaceRole(role)) return 0;
  const scope = visibleTo(userId, role);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM notifications n
       WHERE n.workspace_id = ? AND ${scope.where}
         AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?)`,
    )
    .get(workspaceId, ...scope.params, userId) as { c: number };
  return row.c;
}

/** Mark one notification, or with no id every notification this member can see, as read. Returns how many were newly marked. */
export function markNotificationsRead(workspaceId: string, userId: string, role: WorkspaceRole, id?: string, db: Database.Database = getDb()): number {
  if (!isWorkspaceRole(role)) return 0;
  const scope = visibleTo(userId, role);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO notification_reads (notification_id, user_id)
       SELECT n.id, ? FROM notifications n WHERE n.workspace_id = ? AND ${scope.where} ${id ? "AND n.id = ?" : ""}`,
    )
    .run(userId, workspaceId, ...scope.params, ...(id ? [id] : []));
  return result.changes;
}
