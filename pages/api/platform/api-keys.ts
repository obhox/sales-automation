import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/api-keys";
import { MAX_RATE_LIMIT, parseRateLimit } from "@/lib/api/key-rate-limit";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export const API_KEY_SCOPES = ["contacts:read", "contacts:write", "campaigns:read", "campaigns:write", "events:read", "events:write", "signals:write", "crm:read", "crm:write", "email:send"] as const;
const ALLOWED = new Set<string>(API_KEY_SCOPES);
const RATE_PROBLEM = `rate_limit_per_minute must be a whole number from 1 to ${MAX_RATE_LIMIT.toLocaleString("en-US")}, or empty for no limit`;

export interface ApiKeyRow {
  id: string;
  name: string;
  /** The first twelve characters. The rest of a key is never stored. */
  key_prefix: string;
  scopes: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  /** Requests a minute this key may make. Null: no limit. */
  rate_limit_per_minute: number | null;
  /** Who created it, when they are still a user. */
  created_by_name: string | null;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    return res.json(db.prepare(`SELECT k.id, k.name, k.key_prefix, k.scopes, k.last_used_at, k.expires_at, k.revoked_at, k.created_at, k.rate_limit_per_minute,
        COALESCE(NULLIF(u.name, ''), u.email) AS created_by_name
      FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.workspace_id = ? ORDER BY k.created_at DESC, k.rowid DESC`).all(ctx.workspaceId) as ApiKeyRow[]);
  }
  if (req.method === "POST") {
    const { name, scopes, expires_at, rate_limit_per_minute } = req.body as { name?: string; scopes?: string[]; expires_at?: string; rate_limit_per_minute?: unknown };
    const clean = Array.isArray(scopes) ? scopes.filter((x) => ALLOWED.has(x)) : [];
    if (!name?.trim() || clean.length === 0) return res.status(400).json({ error: "name and at least one valid scope are required" });
    const limit = parseRateLimit(rate_limit_per_minute);
    if (limit === undefined) return res.status(400).json({ error: RATE_PROBLEM });
    const created = createApiKey({ workspaceId: ctx.workspaceId, name: name.trim(), scopes: clean, createdBy: ctx.userId ?? undefined, expiresAt: expires_at, rateLimitPerMinute: limit });
    recordAudit(ctx, "api_key.created", "api_key", created.id, { name, scopes: clean, ...(limit ? { rate_limit_per_minute: limit } : {}) });
    // The key itself is returned here and nowhere else.
    return res.status(201).json(created);
  }
  // A key's name and its rate limit can be changed. Its scopes cannot: make a new key.
  if (req.method === "PATCH") {
    const body = (req.body ?? {}) as { id?: string; name?: unknown; rate_limit_per_minute?: unknown };
    if (!body.id || typeof body.id !== "string") return res.status(400).json({ error: "id is required" });
    const key = db.prepare("SELECT name, rate_limit_per_minute, revoked_at FROM api_keys WHERE id = ? AND workspace_id = ?").get(body.id, ctx.workspaceId) as { name: string; rate_limit_per_minute: number | null; revoked_at: string | null } | undefined;
    if (!key) return res.status(404).json({ error: "API key not found" });
    if (key.revoked_at) return res.status(400).json({ error: "A revoked key cannot be changed" });
    let name = key.name;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) return res.status(400).json({ error: "A key needs a name" });
      name = body.name.trim().slice(0, 80);
    }
    let limit = key.rate_limit_per_minute;
    if (Object.prototype.hasOwnProperty.call(body, "rate_limit_per_minute")) {
      const parsed = parseRateLimit(body.rate_limit_per_minute);
      if (parsed === undefined) return res.status(400).json({ error: RATE_PROBLEM });
      limit = parsed;
    }
    db.prepare("UPDATE api_keys SET name = ?, rate_limit_per_minute = ? WHERE id = ? AND workspace_id = ?").run(name, limit, body.id, ctx.workspaceId);
    recordAudit(ctx, "api_key.updated", "api_key", body.id, { name, rate_limit_per_minute: limit });
    return res.json({ ok: true, name, rate_limit_per_minute: limit });
  }
  if (req.method === "DELETE") {
    const id = req.query.id as string;
    db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "api_key.revoked", "api_key", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}
