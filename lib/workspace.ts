import { randomUUID } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getDb } from "@/lib/db";

export const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const WORKSPACE_HEADER = "x-workspace-id";
export const USER_HEADER = "x-user-id";
export const ROLE_HEADER = "x-workspace-role";

export type WorkspaceRole = "owner" | "admin" | "manager" | "member" | "viewer";
export interface WorkspaceContext { workspaceId: string; userId: string | null; role: WorkspaceRole }

const ROLE_LEVEL: Record<WorkspaceRole, number> = { viewer: 0, member: 1, manager: 2, admin: 3, owner: 4 };

export function getPrimaryMembership(userId: string): { workspaceId: string; role: WorkspaceRole; workspaceName: string } | null {
  const row = getDb().prepare(`
    SELECT wm.workspace_id, wm.role, w.name
    FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = ?
    ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'member' THEN 3 ELSE 4 END,
             wm.created_at ASC LIMIT 1
  `).get(userId) as { workspace_id: string; role: WorkspaceRole; name: string } | undefined;
  return row ? { workspaceId: row.workspace_id, role: row.role, workspaceName: row.name } : null;
}

export function getMembership(userId: string, workspaceId: string): { workspaceId: string; role: WorkspaceRole; workspaceName: string } | null {
  const row = getDb().prepare(`SELECT wm.workspace_id,wm.role,w.name FROM workspace_members wm
    JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.user_id=? AND wm.workspace_id=?`).get(userId, workspaceId) as { workspace_id: string; role: WorkspaceRole; name: string } | undefined;
  return row ? { workspaceId: row.workspace_id, role: row.role, workspaceName: row.name } : null;
}

export function getMemberships(userId: string) {
  return getDb().prepare(`SELECT w.id,w.name,w.slug,wm.role,wm.created_at FROM workspace_members wm
    JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.user_id=? ORDER BY w.name`).all(userId);
}

export function createWorkspaceForUser(userId: string, email: string): { workspaceId: string; role: WorkspaceRole } {
  const db = getDb();
  const existing = getPrimaryMembership(userId);
  if (existing) return { workspaceId: existing.workspaceId, role: existing.role };
  const workspaceId = randomUUID();
  const local = email.split("@")[0].replace(/[^a-z0-9]+/gi, " ").trim() || "My";
  const slug = `${local.toLowerCase().replace(/\s+/g, "-")}-${workspaceId.slice(0, 8)}`;
  db.transaction(() => {
    db.prepare("INSERT INTO workspaces (id, name, slug, created_by) VALUES (?, ?, ?, ?)").run(workspaceId, `${local}'s workspace`, slug, userId);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(workspaceId, userId);
    seedPipeline(db, workspaceId);
  })();
  return { workspaceId, role: "owner" };
}

export function workspaceFromSession(session: Session | null): WorkspaceContext | null {
  const user = session?.user as (Session["user"] & { id?: string; workspaceId?: string; role?: WorkspaceRole }) | undefined;
  if (!user?.workspaceId) return null;
  return { workspaceId: user.workspaceId, userId: user.id ?? null, role: user.role ?? "viewer" };
}

export function workspaceFromRequest(req: NextApiRequest): WorkspaceContext {
  const workspaceId = header(req, WORKSPACE_HEADER) || DEFAULT_WORKSPACE_ID;
  const userId = header(req, USER_HEADER) || null;
  const roleValue = header(req, ROLE_HEADER) as WorkspaceRole;
  const role = ROLE_LEVEL[roleValue] !== undefined ? roleValue : "owner";
  return { workspaceId, userId, role };
}

export function workspaceIdFromHeaders(headers: Record<string, string | string[] | undefined>): string {
  const value=headers[WORKSPACE_HEADER];
  return (Array.isArray(value)?value[0]:value) || DEFAULT_WORKSPACE_ID;
}

export function requireWorkspace(req: NextApiRequest, res: NextApiResponse, minimum: WorkspaceRole = "viewer"): WorkspaceContext | null {
  const ctx = workspaceFromRequest(req);
  if (ROLE_LEVEL[ctx.role] < ROLE_LEVEL[minimum]) {
    res.status(403).json({ error: "Insufficient workspace permission", required_role: minimum });
    return null;
  }
  return ctx;
}

export function recordAudit(ctx: WorkspaceContext, action: string, entityType?: string, entityId?: string, metadata?: unknown, ipAddress?: string) {
  getDb().prepare(`INSERT INTO audit_logs
    (id, workspace_id, user_id, action, entity_type, entity_id, metadata_json, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), ctx.workspaceId, ctx.userId, action, entityType ?? null, entityId ?? null, metadata === undefined ? null : JSON.stringify(metadata), ipAddress ?? null);
}

const WORKSPACE_TABLES = new Set(["accounts", "email_accounts", "targets", "companies", "lists", "templates", "workflows", "runs", "todos", "email_replies"]);

/** Guard a nested API route whose parent id appears in the URL. */
export function requireWorkspaceEntity(res: NextApiResponse, ctx: WorkspaceContext, table: string, id: string): boolean {
  if (!WORKSPACE_TABLES.has(table)) throw new Error(`Unsupported workspace table: ${table}`);
  const found = getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_id = ?`).get(id, ctx.workspaceId);
  if (!found) { res.status(404).json({ error: "Resource not found" }); return false; }
  return true;
}

function header(req: NextApiRequest, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function seedPipeline(db: ReturnType<typeof getDb>, workspaceId: string) {
  const insert = db.prepare("INSERT INTO pipeline_stages (id, workspace_id, name, position, probability, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?, ?)");
  [["New", 0, 10, 0, 0], ["Qualified", 1, 30, 0, 0], ["Meeting", 2, 50, 0, 0], ["Proposal", 3, 75, 0, 0], ["Won", 4, 100, 1, 0], ["Lost", 5, 0, 0, 1]].forEach(([name, position, probability, won, lost]) =>
    insert.run(randomUUID(), workspaceId, name, position, probability, won, lost));
}
