// A workspace's people: who is in it, what they may do, when they were last here, and the
// rules for changing someone's role or suspending them.
import type DatabaseType from "better-sqlite3";
import { ROLE_LEVEL, isWorkspaceRole, type WorkspaceRole } from "@/lib/roles";

type DB = DatabaseType.Database;

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  suspended: boolean;
  suspended_at: string | null;
  /** The last request they made in this workspace, to the minute. Null: not since this was recorded. */
  last_active_at: string | null;
  joined_at: string;
  /** Campaigns that are theirs and not archived. */
  campaigns: number;
}

/** "jordan.mertens" → "Jordan Mertens", for members who have not set a name. */
export function nameFromEmail(email: string): string {
  const words = (email.split("@")[0] ?? "").split(/[._\-+]+/).filter(Boolean);
  if (words.length === 0) return email;
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function hasColumn(db: DB, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((info) => info.name === column);
  } catch {
    return false;
  }
}

/**
 * How many live campaigns each member has. A campaign is a member's when they are its
 * owner; where campaigns have no owner recorded yet, it is the member who created it,
 * as the audit log has it.
 */
export function campaignCounts(db: DB, workspaceId: string): Map<string, number> {
  const rows = (hasColumn(db, "workflows", "owner_id")
    ? db.prepare(
        `SELECT COALESCE(w.owner_id, (SELECT al.user_id FROM audit_logs al WHERE al.workspace_id = w.workspace_id AND al.action = 'workflow.created' AND al.entity_id = w.id ORDER BY al.created_at LIMIT 1)) AS user_id, COUNT(*) AS c
         FROM workflows w WHERE w.workspace_id = ? AND COALESCE(w.is_archived, 0) = 0 GROUP BY 1`,
      ).all(workspaceId)
    : db.prepare(
        `SELECT (SELECT al.user_id FROM audit_logs al WHERE al.workspace_id = w.workspace_id AND al.action = 'workflow.created' AND al.entity_id = w.id ORDER BY al.created_at LIMIT 1) AS user_id, COUNT(*) AS c
         FROM workflows w WHERE w.workspace_id = ? AND COALESCE(w.is_archived, 0) = 0 GROUP BY 1`,
      ).all(workspaceId)) as Array<{ user_id: string | null; c: number }>;
  return new Map(rows.filter((row): row is { user_id: string; c: number } => Boolean(row.user_id)).map((row) => [row.user_id, row.c]));
}

/** Everyone in the workspace: owners first, then by seniority of role, then by when they joined. */
export function listMembers(db: DB, workspaceId: string): TeamMember[] {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, wm.role, wm.suspended_at, wm.last_active_at, wm.created_at
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ?
     ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'member' THEN 3 ELSE 4 END, wm.created_at, u.email`,
  ).all(workspaceId) as Array<{ id: string; name: string | null; email: string; role: WorkspaceRole; suspended_at: string | null; last_active_at: string | null; created_at: string }>;
  const campaigns = campaignCounts(db, workspaceId);
  return rows.map((row) => ({
    id: row.id, name: row.name?.trim() || nameFromEmail(row.email), email: row.email, role: row.role,
    suspended: Boolean(row.suspended_at), suspended_at: row.suspended_at, last_active_at: row.last_active_at, joined_at: row.created_at,
    campaigns: campaigns.get(row.id) ?? 0,
  }));
}

export interface MemberChange {
  role?: WorkspaceRole;
  suspended?: boolean;
}

export type MemberChangeResult =
  | { ok: true; previous: { role: WorkspaceRole; suspended: boolean }; now: { role: WorkspaceRole; suspended: boolean } }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Change a member's role, or suspend or restore them. The rules:
 *  - nobody changes their own role or suspends themselves;
 *  - only an owner makes someone an owner, or changes an owner;
 *  - a workspace always keeps at least one owner who is not suspended;
 *  - an owner is not suspended: their role is changed first.
 */
export function changeMember(db: DB, workspaceId: string, actor: { userId: string | null; role: WorkspaceRole }, targetUserId: string, change: MemberChange): MemberChangeResult {
  if (ROLE_LEVEL[actor.role] < ROLE_LEVEL.admin) return { ok: false, status: 403, error: "Only an admin or an owner can change a member" };
  if (change.role === undefined && change.suspended === undefined) return { ok: false, status: 400, error: "Send a role, or suspended true or false" };
  if (change.role !== undefined && !isWorkspaceRole(change.role)) return { ok: false, status: 400, error: "The role must be one of owner, admin, manager, member, viewer" };
  if (change.suspended !== undefined && typeof change.suspended !== "boolean") return { ok: false, status: 400, error: "suspended must be true or false" };

  const member = db.prepare("SELECT role, suspended_at FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(workspaceId, targetUserId) as { role: WorkspaceRole; suspended_at: string | null } | undefined;
  if (!member) return { ok: false, status: 404, error: "That person is not a member of this workspace" };
  if (actor.userId && actor.userId === targetUserId) return { ok: false, status: 400, error: "You cannot change your own role or suspend yourself. Ask another admin." };

  const previous = { role: member.role, suspended: Boolean(member.suspended_at) };
  const now = { role: change.role ?? member.role, suspended: change.suspended ?? previous.suspended };
  if ((previous.role === "owner" || now.role === "owner") && actor.role !== "owner") return { ok: false, status: 403, error: "Only an owner can make someone an owner or change an owner" };
  if (now.suspended && now.role === "owner") return { ok: false, status: 400, error: "An owner cannot be suspended. Change their role first." };
  if (previous.role === "owner" && now.role !== "owner") {
    const owners = (db.prepare("SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND suspended_at IS NULL").get(workspaceId) as { c: number }).c;
    if (owners <= 1) return { ok: false, status: 400, error: "A workspace needs at least one owner. Make someone else an owner first." };
  }

  db.prepare(
    `UPDATE workspace_members SET role = ?,
       suspended_at = CASE WHEN ? = 1 THEN COALESCE(suspended_at, datetime('now')) ELSE NULL END,
       suspended_by = CASE WHEN ? = 1 THEN COALESCE(suspended_by, ?) ELSE NULL END
     WHERE workspace_id = ? AND user_id = ?`,
  ).run(now.role, now.suspended ? 1 : 0, now.suspended ? 1 : 0, actor.userId, workspaceId, targetUserId);
  return { ok: true, previous, now };
}

/** Clean a workspace name as typed. Null when nothing usable is left. */
export function cleanWorkspaceName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
  return clean || null;
}
