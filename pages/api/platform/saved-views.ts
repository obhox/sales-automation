import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { roleAtLeast } from "@/lib/roles";
import { requireWorkspace, type WorkspaceContext } from "@/lib/workspace";

// Saved views: a named arrangement of a list screen that a member can come back to.
// A view is personal by default. A manager or above can share one with the workspace,
// and only a manager or above can change or remove a shared one.

/** The list screens that keep views. A screen is added here when it gains them. */
export const SAVED_VIEW_RESOURCES = ["campaigns", "inbox", "contacts", "companies", "lists"] as const;
const RESOURCES = new Set<string>(SAVED_VIEW_RESOURCES);
const MAX_NAME = 60;
const MAX_STATE_BYTES = 8 * 1024;
const MAX_VIEWS_PER_SCOPE = 50;

interface ViewRow {
  id: string;
  user_id: string | null;
  resource: string;
  name: string;
  state_json: string;
  position: number;
  created_by: string | null;
  updated_at: string;
}

const shape = (row: ViewRow, ctx: WorkspaceContext) => ({
  id: row.id,
  resource: row.resource,
  name: row.name,
  shared: row.user_id === null,
  /** Whether this member may rename, change or delete it. */
  editable: row.user_id === null ? roleAtLeast(ctx.role, "manager") : row.user_id === ctx.userId,
  state: safeParse(row.state_json),
  position: row.position,
  updated_at: row.updated_at,
});

function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The view's state as JSON text, or a string saying why it was refused. */
function stateOf(value: unknown): { json: string } | string {
  if (value === undefined) return { json: "{}" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return "state must be an object";
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_STATE_BYTES) return "state is too large";
  return { json };
}

function nameOf(value: unknown): { name: string } | string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return "name is required";
  if (name.length > MAX_NAME) return `name must be ${MAX_NAME} characters or fewer`;
  return { name };
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Views are a member's own working state: a viewer reads the workspace and keeps none.
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  // Views belong to a person. An internal service call has no person to keep them for.
  if (!ctx.userId) return res.status(403).json({ error: "Saved views need a signed-in member" });
  const db = getDb();
  const userId = ctx.userId;

  /** A view in this workspace that this member can at least see: their own, or a shared one. */
  const visible = (id: unknown): ViewRow | undefined =>
    db.prepare("SELECT * FROM saved_views WHERE id = ? AND workspace_id = ? AND (user_id IS NULL OR user_id = ?)").get(String(id ?? ""), ctx.workspaceId, userId) as ViewRow | undefined;
  const mayChange = (row: ViewRow) => (row.user_id === null ? roleAtLeast(ctx.role, "manager") : row.user_id === userId);
  const nameTaken = (resource: string, name: string, shared: boolean, exceptId?: string) =>
    Boolean(
      db
        .prepare(`SELECT 1 FROM saved_views WHERE workspace_id = ? AND resource = ? AND name = ? COLLATE NOCASE AND id != ? AND ${shared ? "user_id IS NULL" : "user_id = ?"}`)
        .get(...(shared ? [ctx.workspaceId, resource, name, exceptId ?? ""] : [ctx.workspaceId, resource, name, exceptId ?? "", userId])),
    );

  if (req.method === "GET") {
    const resource = String(req.query.resource ?? "");
    if (!RESOURCES.has(resource)) return res.status(400).json({ error: `resource must be one of: ${SAVED_VIEW_RESOURCES.join(", ")}` });
    const rows = db
      .prepare(
        `SELECT * FROM saved_views WHERE workspace_id = ? AND resource = ? AND (user_id IS NULL OR user_id = ?)
         ORDER BY (user_id IS NULL) DESC, position ASC, created_at ASC`,
      )
      .all(ctx.workspaceId, resource, userId) as ViewRow[];
    return res.json({ views: rows.map(row => shape(row, ctx)) });
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const resource = String(body.resource ?? "");
    if (!RESOURCES.has(resource)) return res.status(400).json({ error: `resource must be one of: ${SAVED_VIEW_RESOURCES.join(", ")}` });
    const named = nameOf(body.name);
    if (typeof named === "string") return res.status(400).json({ error: named });
    const state = stateOf(body.state);
    if (typeof state === "string") return res.status(400).json({ error: state });
    const shared = body.shared === true;
    if (shared && !roleAtLeast(ctx.role, "manager")) return res.status(403).json({ error: "Only a manager or above can share a view with the workspace", required_role: "manager" });
    if (nameTaken(resource, named.name, shared)) return res.status(409).json({ error: `There is already a ${shared ? "shared" : "personal"} view called "${named.name}"` });
    const inScope = db
      .prepare(`SELECT COUNT(*) AS c, COALESCE(MAX(position), -1) AS last FROM saved_views WHERE workspace_id = ? AND resource = ? AND ${shared ? "user_id IS NULL" : "user_id = ?"}`)
      .get(...(shared ? [ctx.workspaceId, resource] : [ctx.workspaceId, resource, userId])) as { c: number; last: number };
    if (inScope.c >= MAX_VIEWS_PER_SCOPE) return res.status(400).json({ error: `A screen can keep up to ${MAX_VIEWS_PER_SCOPE} ${shared ? "shared" : "personal"} views` });

    const id = randomUUID();
    db.prepare("INSERT INTO saved_views (id, workspace_id, user_id, resource, name, state_json, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, ctx.workspaceId, shared ? null : userId, resource, named.name, state.json, inScope.last + 1, userId,
    );
    return res.status(201).json(shape(visible(id)!, ctx));
  }

  if (req.method === "PATCH") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row = visible(body.id);
    if (!row) return res.status(404).json({ error: "View not found" });
    if (!mayChange(row)) return res.status(403).json({ error: "Only a manager or above can change a shared view", required_role: "manager" });

    let shared = row.user_id === null;
    if (body.shared !== undefined) {
      if (typeof body.shared !== "boolean") return res.status(400).json({ error: "shared must be true or false" });
      if (body.shared !== shared && !roleAtLeast(ctx.role, "manager")) return res.status(403).json({ error: "Only a manager or above can share a view with the workspace", required_role: "manager" });
      shared = body.shared;
    }
    let name = row.name;
    if (body.name !== undefined) {
      const named = nameOf(body.name);
      if (typeof named === "string") return res.status(400).json({ error: named });
      name = named.name;
    }
    if (nameTaken(row.resource, name, shared, row.id)) return res.status(409).json({ error: `There is already a ${shared ? "shared" : "personal"} view called "${name}"` });
    let stateJson = row.state_json;
    if (body.state !== undefined) {
      const state = stateOf(body.state);
      if (typeof state === "string") return res.status(400).json({ error: state });
      stateJson = state.json;
    }
    let position = row.position;
    if (body.position !== undefined) {
      if (!Number.isInteger(body.position) || (body.position as number) < 0) return res.status(400).json({ error: "position must be a whole number, zero or more" });
      position = body.position as number;
    }

    // Un-sharing hands the view to whoever does it, so it never ends up owned by no one.
    db.prepare("UPDATE saved_views SET name = ?, state_json = ?, position = ?, user_id = ?, updated_at = datetime('now') WHERE id = ?").run(name, stateJson, position, shared ? null : userId, row.id);
    return res.json(shape(visible(row.id)!, ctx));
  }

  if (req.method === "DELETE") {
    const row = visible(req.query.id);
    if (!row) return res.status(404).json({ error: "View not found" });
    if (!mayChange(row)) return res.status(403).json({ error: "Only a manager or above can delete a shared view", required_role: "manager" });
    db.prepare("DELETE FROM saved_views WHERE id = ?").run(row.id);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "POST", "PATCH", "DELETE"]);
  return res.status(405).end();
}
