import type { NextApiRequest, NextApiResponse } from "next";
import { randomBytes, randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { emitDomainEvent, processWebhookDeliveries } from "@/lib/platform/events";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    const endpoints = db.prepare(`SELECT we.id, we.url, we.event_types, we.enabled, we.created_at,
      COUNT(wd.id) delivery_count, SUM(CASE WHEN wd.status='dead_letter' THEN 1 ELSE 0 END) dead_letters
      FROM webhook_endpoints we LEFT JOIN webhook_deliveries wd ON wd.endpoint_id = we.id
      WHERE we.workspace_id = ? GROUP BY we.id ORDER BY we.created_at DESC`).all(ctx.workspaceId);
    return res.json(endpoints);
  }
  if (req.method === "POST") {
    const { url, event_types = "*" } = req.body as { url?: string; event_types?: string | string[] };
    try { if (!url || new URL(url).protocol !== "https:") throw new Error(); } catch { return res.status(400).json({ error: "A valid HTTPS URL is required" }); }
    const id = randomUUID(), secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const types = Array.isArray(event_types) ? event_types.join(",") : event_types;
    db.prepare("INSERT INTO webhook_endpoints (id, workspace_id, url, secret, event_types, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, ctx.workspaceId, url, encryptSecret(secret), types, ctx.userId);
    recordAudit(ctx, "webhook.created", "webhook", id, { url, event_types: types });
    return res.status(201).json({ id, url, event_types: types, secret });
  }
  if (req.method === "PATCH") {
    const { id, enabled, event_types } = req.body as { id?: string; enabled?: boolean; event_types?: string | string[] };
    if (!id) return res.status(400).json({ error: "id is required" });
    db.prepare("UPDATE webhook_endpoints SET enabled = COALESCE(?, enabled), event_types = COALESCE(?, event_types) WHERE id = ? AND workspace_id = ?")
      .run(enabled === undefined ? null : enabled ? 1 : 0, event_types === undefined ? null : Array.isArray(event_types) ? event_types.join(",") : event_types, id, ctx.workspaceId);
    recordAudit(ctx, "webhook.updated", "webhook", id);
    return res.json({ ok: true });
  }
  if (req.method === "DELETE") {
    const id = req.query.id as string;
    db.prepare("DELETE FROM webhook_endpoints WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "webhook.deleted", "webhook", id);
    return res.status(204).end();
  }
  if (req.method === "PUT") {
    const id = emitDomainEvent({ workspaceId: ctx.workspaceId, type: "webhook.test", entityType: "workspace", entityId: ctx.workspaceId, payload: { message: "Linki webhook test" } });
    await processWebhookDeliveries();
    return res.json({ event_id: id });
  }
  return res.status(405).end();
}
