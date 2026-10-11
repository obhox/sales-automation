import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getDb } from "@/lib/db";
import { ROLE_LEVEL, type WorkspaceRole } from "@/lib/roles";
import { sessionRevoked } from "@/lib/auth-tokens";
import { pruneAuditLogIfDue, type AuditSource } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";
import {
  CONTEXT_SIGNATURE_HEADER, ROLE_HEADER, SESSION_IAT_HEADER, USER_HEADER, WORKSPACE_HEADER,
  contextSigningInput, type RequestContextClaims,
} from "@/lib/auth";

export const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export { WORKSPACE_HEADER, USER_HEADER, ROLE_HEADER };

export type { WorkspaceRole };
export interface WorkspaceContext {
  workspaceId: string;
  userId: string | null;
  role: WorkspaceRole;
  /** How the request arrived. Written on every audit entry it makes. */
  source?: AuditSource | null;
  /** The address it came from. */
  ip?: string | null;
  /** Through what, when not a person in the app: an API key's or MCP client's name. */
  via?: string | null;
}
/** `code` "workspace_access" tells the app the member can no longer use this workspace, so it can move them to another. */
export type WorkspaceResolution = { ok: true; ctx: WorkspaceContext } | { ok: false; status: 401 | 403; error: string; code?: "workspace_access" };

/** Set by the MCP server on its own calls into the API, which arrive with the internal secret. Ignored on anything else. */
export const SOURCE_HEADER = "x-linki-source";
export const CLIENT_IP_HEADER = "x-linki-client-ip";
export const VIA_HEADER = "x-linki-via";

export interface Membership { workspaceId: string; role: WorkspaceRole; workspaceName: string; suspended: boolean }


/** The workspace a member lands in when none is named: their most senior, oldest membership that is not suspended. */
export function getPrimaryMembership(userId: string): Membership | null {
  const row = getDb().prepare(`
    SELECT wm.workspace_id, wm.role, w.name
    FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = ? AND wm.suspended_at IS NULL
    ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'member' THEN 3 ELSE 4 END,
             wm.created_at ASC LIMIT 1
  `).get(userId) as { workspace_id: string; role: WorkspaceRole; name: string } | undefined;
  return row ? { workspaceId: row.workspace_id, role: row.role, workspaceName: row.name, suspended: false } : null;
}

/**
 * A member's place in one workspace. A suspended membership counts as none, so everything
 * that asks "may this person act here?" gets no for a suspended member without having to
 * know about suspension. Pass `includeSuspended` only to tell the two apart in a message.
 */
export function getMembership(userId: string, workspaceId: string, opts: { includeSuspended?: boolean } = {}): Membership | null {
  const row = getDb().prepare(`SELECT wm.workspace_id,wm.role,w.name,wm.suspended_at FROM workspace_members wm
    JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.user_id=? AND wm.workspace_id=?`).get(userId, workspaceId) as { workspace_id: string; role: WorkspaceRole; name: string; suspended_at: string | null } | undefined;
  if (!row || (row.suspended_at && !opts.includeSuspended)) return null;
  return { workspaceId: row.workspace_id, role: row.role, workspaceName: row.name, suspended: Boolean(row.suspended_at) };
}

/** Every workspace a person belongs to, for the lists they switch from. `suspended` is 1 where their access is suspended: listed, not usable. */
export function getMemberships(userId: string) {
  return getDb().prepare(`SELECT w.id,w.name,w.slug,wm.role,wm.created_at,(wm.suspended_at IS NOT NULL) AS suspended FROM workspace_members wm
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

/** How many workspaces one person may own. A guard against runaway creation, not a product limit. */
export const MAX_OWNED_WORKSPACES = 20;

/**
 * Make another workspace owned by this user, with the default pipeline stages. Each
 * workspace keeps its own contacts, campaigns, mailboxes and LinkedIn accounts.
 */
export function createAdditionalWorkspace(userId: string, name: string): { workspaceId: string; name: string } {
  const db = getDb();
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!clean) throw new Error("A workspace needs a name");
  const owned = (db.prepare("SELECT COUNT(*) AS c FROM workspace_members WHERE user_id = ? AND role = 'owner'").get(userId) as { c: number }).c;
  if (owned >= MAX_OWNED_WORKSPACES) throw new Error(`You already own ${MAX_OWNED_WORKSPACES} workspaces`);
  const workspaceId = randomUUID();
  const slug = `${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"}-${workspaceId.slice(0, 8)}`;
  db.transaction(() => {
    db.prepare("INSERT INTO workspaces (id, name, slug, created_by) VALUES (?, ?, ?, ?)").run(workspaceId, clean, slug, userId);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(workspaceId, userId);
    seedPipeline(db, workspaceId);
  })();
  return { workspaceId, name: clean };
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
    const membership = getMembership(claims.userId, claims.workspaceId, { includeSuspended: true });
    if (!membership) return { ok: false, status: 403, error: "You do not have access to this workspace", code: "workspace_access" };
    if (membership.suspended) return { ok: false, status: 403, error: "Your access to this workspace is suspended. An admin of the workspace can restore it.", code: "workspace_access" };
    noteActive(claims.workspaceId, claims.userId);
    return { ok: true, ctx: { workspaceId: claims.workspaceId, userId: claims.userId, role: membership.role, ...arrival(req, claims) } };
  }
  // An internal service call made on no user's behalf: the signed role is all there is.
  if (ROLE_LEVEL[claims.role as WorkspaceRole] === undefined) return { ok: false, status: 401, error: "Not authenticated" };
  return { ok: true, ctx: { workspaceId: claims.workspaceId, userId: null, role: claims.role as WorkspaceRole, ...arrival(req, claims) } };
}

/**
 * How a request arrived, for the audit log. A browser's request carries its session's
 * issue time (proxy.ts signs it in); a call made with the internal secret does not, and
 * only such a call may say for itself where it came from.
 */
function arrival(req: NextApiRequest, claims: RequestContextClaims): Pick<WorkspaceContext, "source" | "ip" | "via"> {
  if (claims.iat) return { source: "web", ip: knownIp(clientIp(req)), via: null };
  return {
    source: header(req, SOURCE_HEADER) === "mcp" ? "mcp" : null,
    ip: knownIp(header(req, CLIENT_IP_HEADER)),
    via: header(req, VIA_HEADER).trim().slice(0, 80) || null,
  };
}

const knownIp = (value: string): string | null => (value && value !== "unknown" ? value.slice(0, 64) : null);

// When each member was last seen, so the write below happens once a minute, not on every request.
const lastNoted = new Map<string, number>();
const NOTE_EVERY_MS = 60_000;

/** Record that a member is using a workspace. Never lets a failed write stop the request. */
function noteActive(workspaceId: string, userId: string, now: number = Date.now()) {
  const key = `${workspaceId}:${userId}`;
  if (now - (lastNoted.get(key) ?? 0) < NOTE_EVERY_MS) return;
  lastNoted.set(key, now);
  try {
    getDb().prepare("UPDATE workspace_members SET last_active_at = datetime('now') WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
  } catch {
    // Last active is a courtesy.
  }
}

export function requireWorkspace(req: NextApiRequest, res: NextApiResponse, minimum: WorkspaceRole = "viewer"): WorkspaceContext | null {
  const resolved = workspaceFromRequest(req);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error, ...(resolved.code ? { code: resolved.code } : {}) });
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

/** Add an entry to the workspace's audit log. Where the request came from is taken from the context. */
export function recordAudit(ctx: WorkspaceContext, action: string, entityType?: string, entityId?: string, metadata?: unknown, ipAddress?: string) {
  const db = getDb();
  db.prepare(`INSERT INTO audit_logs
    (id, workspace_id, user_id, action, entity_type, entity_id, metadata_json, ip_address, source, via)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), ctx.workspaceId, ctx.userId, action, entityType ?? null, entityId ?? null, metadata === undefined ? null : JSON.stringify(metadata), ipAddress ?? ctx.ip ?? null, ctx.source ?? null, ctx.via ?? null);
  pruneAuditLogIfDue(db);
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
  // A new workspace opens an opportunity when a contact replies positively. Workspaces
  // that existed before this have no such row and so keep it off until someone turns it on.
  db.prepare("INSERT OR IGNORE INTO workspace_settings (workspace_id, key, value) VALUES (?, 'auto_opportunity_on_reply', '1')").run(workspaceId);
}
