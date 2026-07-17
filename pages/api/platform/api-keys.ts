import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/api-keys";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

const ALLOWED = new Set(["contacts:read", "contacts:write", "campaigns:read", "campaigns:write", "events:read", "events:write", "signals:write", "crm:read", "crm:write"]);

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  if (req.method === "GET") return res.json(getDb().prepare(`SELECT id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
    FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC`).all(ctx.workspaceId));
  if (req.method === "POST") {
    const { name, scopes, expires_at } = req.body as { name?: string; scopes?: string[]; expires_at?: string };
    const clean = Array.isArray(scopes) ? scopes.filter((x) => ALLOWED.has(x)) : [];
    if (!name?.trim() || clean.length === 0) return res.status(400).json({ error: "name and at least one valid scope are required" });
    const created = createApiKey({ workspaceId: ctx.workspaceId, name: name.trim(), scopes: clean, createdBy: ctx.userId ?? undefined, expiresAt: expires_at });
    recordAudit(ctx, "api_key.created", "api_key", created.id, { name, scopes: clean });
    return res.status(201).json(created);
  }
  if (req.method === "DELETE") {
    const id = req.query.id as string;
    getDb().prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "api_key.revoked", "api_key", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}
