import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getDb } from "@/lib/db";
import { ROLE_LEVEL, type WorkspaceRole } from "@/lib/roles";
import { sessionRevoked } from "@/lib/auth-tokens";
import {
  CONTEXT_SIGNATURE_HEADER, ROLE_HEADER, SESSION_IAT_HEADER, USER_HEADER, WORKSPACE_HEADER,
  contextSigningInput, type RequestContextClaims,
} from "@/lib/auth";

export const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export { WORKSPACE_HEADER, USER_HEADER, ROLE_HEADER };

export type { WorkspaceRole };
export interface WorkspaceContext { workspaceId: string; userId: string | null; role: WorkspaceRole }
export type WorkspaceResolution = { ok: true; ctx: WorkspaceContext } | { ok: false; status: 401 | 403; error: string };


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

/**
 * Resolve who a request acts as. Fails closed: the context headers count only when they
 * carry proxy.ts's signature, so a route reached any other way, or a client that sends the
 * headers itself, gets nothing. There is no default workspace and no default role.
 *
 * For a user, the role is read from workspace_members on every request rather than taken
 * from the session cookie, which keeps its old claims until it is next refreshed. A removed
 * member loses access, and a changed role applies, on the very next request. So does a
 * password change: a browser session issued before it is refused.
 */
export function workspaceFromRequest(req: NextApiRequest): WorkspaceResolution {
  const claims: RequestContextClaims = {
    workspaceId: header(req, WORKSPACE_HEADER), userId: header(req, USER_HEADER),
    role: header(req, ROLE_HEADER), iat: header(req, SESSION_IAT_HEADER),
  };
  if (!claims.workspaceId || !contextSignatureValid(claims, header(req, CONTEXT_SIGNATURE_HEADER))) {
    return { ok: false, status: 401, error: "Not authenticated" };
  }
  if (claims.userId) {
    // Internal calls carry no issue time: they are not browser sessions and have their own tokens.
    if (claims.iat && sessionRevoked(claims.userId, Number(claims.iat))) {
      return { ok: false, status: 401, error: "Your session has ended. Sign in again." };
    }
    const membership = getMembership(claims.userId, claims.workspaceId);
    if (!membership) return { ok: false, status: 403, error: "You do not have access to this workspace" };
    return { ok: true, ctx: { workspaceId: claims.workspaceId, userId: claims.userId, role: membership.role } };
  }
  // An internal service call made on no user's behalf: the signed role is all there is.
  if (ROLE_LEVEL[claims.role as WorkspaceRole] === undefined) return { ok: false, status: 401, error: "Not authenticated" };
  return { ok: true, ctx: { workspaceId: claims.workspaceId, userId: null, role: claims.role as WorkspaceRole } };
}

export function requireWorkspace(req: NextApiRequest, res: NextApiResponse, minimum: WorkspaceRole = "viewer"): WorkspaceContext | null {
  const resolved = workspaceFromRequest(req);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error });
    return null;
  }
  const { ctx } = resolved;
  if (ROLE_LEVEL[ctx.role] < ROLE_LEVEL[minimum]) {
    res.status(403).json({ error: "Insufficient workspace permission", required_role: minimum });
    return null;
  }
  return ctx;
}

function contextSignatureValid(claims: RequestContextClaims, provided: string): boolean {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || !provided) return false;
  const expected = createHmac("sha256", secret).update(contextSigningInput(claims)).digest();
  const given = Buffer.from(provided, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
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
