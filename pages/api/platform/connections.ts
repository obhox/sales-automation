import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { syncConnection } from "@/lib/platform/connectors";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

const PROVIDERS = new Set(["hubspot", "salesforce", "ical", "google_calendar", "microsoft_calendar"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    const rows = db.prepare(`SELECT ec.id, ec.provider, ec.name, ec.config_json, ec.enabled, ec.last_synced_at, ec.sync_error, ec.created_at,
      COUNT(esr.id) sync_record_count FROM external_connections ec LEFT JOIN external_sync_records esr ON esr.connection_id = ec.id
      WHERE ec.workspace_id = ? GROUP BY ec.id ORDER BY ec.created_at DESC`).all(ctx.workspaceId);
    return res.json(rows);
  }
  if (req.method === "POST") {
    const { provider, name, config = {}, secret } = req.body as { provider?: string; name?: string; config?: unknown; secret?: string };
    if (!provider || !PROVIDERS.has(provider) || !name) return res.status(400).json({ error: "Valid provider and name are required" });
    if (provider !== "ical" && !secret) return res.status(400).json({ error: "An access token or private app token is required" });
    const id = randomUUID();
    db.prepare("INSERT INTO external_connections (id, workspace_id, provider, name, config_json, secret_value) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, ctx.workspaceId, provider, name, JSON.stringify(config), secret ? encryptSecret(secret) : null);
    recordAudit(ctx, "connection.created", "external_connection", id, { provider, name });
    return res.status(201).json({ id, provider, name });
  }
  if (req.method === "PUT") {
    const id = String(req.body?.id ?? "");
    if (!id) return res.status(400).json({ error: "id is required" });
    try {
      const result = await syncConnection(id, ctx.workspaceId);
      recordAudit(ctx, "connection.synced", "external_connection", id, result);
      return res.json(result);
    } catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
  }
  if (req.method === "PATCH") {
    const { id, enabled, name, config, secret } = req.body as { id?: string; enabled?: boolean; name?: string; config?: unknown; secret?: string };
    if (!id) return res.status(400).json({ error: "id is required" });
    db.prepare(`UPDATE external_connections SET name=COALESCE(?,name), config_json=COALESCE(?,config_json),
      secret_value=COALESCE(?,secret_value), enabled=COALESCE(?,enabled) WHERE id=? AND workspace_id=?`)
      .run(name ?? null, config === undefined ? null : JSON.stringify(config), secret ? encryptSecret(secret) : null, enabled === undefined ? null : enabled ? 1 : 0, id, ctx.workspaceId);
    recordAudit(ctx, "connection.updated", "external_connection", id);
    return res.json({ ok: true });
  }
  if (req.method === "DELETE") {
    const id = String(req.query.id ?? "");
    db.prepare("DELETE FROM external_connections WHERE id=? AND workspace_id=?").run(id, ctx.workspaceId);
    recordAudit(ctx, "connection.deleted", "external_connection", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}
