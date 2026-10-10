import type { NextApiRequest, NextApiResponse } from "next";
import { randomBytes, randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { processWebhookDeliveries, queueTestDelivery } from "@/lib/platform/events";
import { EVENT_TYPES } from "@/lib/platform/event-types";
import { webhookUrlProblem } from "@/lib/platform/safe-fetch";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/** "*" or a comma-separated list of known events, as stored; null when the input names an event that does not exist. */
function eventTypesValue(input: string | string[] | undefined): string | null {
  const list = (Array.isArray(input) ? input : String(input ?? "*").split(",")).map((type) => type.trim()).filter(Boolean);
  if (list.length === 0 || list.includes("*")) return "*";
  return list.every((type) => (EVENT_TYPES as readonly string[]).includes(type)) ? [...new Set(list)].join(",") : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    // ?deliveries=<endpoint id>: what was sent to one endpoint and how it answered, newest first.
    if (typeof req.query.deliveries === "string") {
      const deliveries = db.prepare(`SELECT wd.id, de.type AS event_type, wd.status, wd.attempt, wd.response_status, wd.last_error,
          substr(wd.response_body, 1, 300) AS response_body, wd.created_at, wd.delivered_at, wd.next_attempt_at
        FROM webhook_deliveries wd JOIN domain_events de ON de.id = wd.event_id
        WHERE wd.endpoint_id = ? AND wd.workspace_id = ? ORDER BY wd.created_at DESC, wd.rowid DESC LIMIT 50`).all(req.query.deliveries, ctx.workspaceId);
      return res.json(deliveries);
    }
    const endpoints = db.prepare(`SELECT we.id, we.url, we.event_types, we.enabled, we.created_at,
      COUNT(wd.id) delivery_count, SUM(CASE WHEN wd.status='dead_letter' THEN 1 ELSE 0 END) dead_letters
      FROM webhook_endpoints we LEFT JOIN webhook_deliveries wd ON wd.endpoint_id = we.id
      WHERE we.workspace_id = ? GROUP BY we.id ORDER BY we.created_at DESC`).all(ctx.workspaceId);
    return res.json(endpoints);
  }
  if (req.method === "POST") {
    const { url, event_types } = req.body as { url?: string; event_types?: string | string[] };
    const problem = await webhookUrlProblem(String(url ?? ""));
    if (problem) return res.status(400).json({ error: problem });
    const types = eventTypesValue(event_types);
    if (types === null) return res.status(400).json({ error: `event_types must be * or a list of: ${EVENT_TYPES.join(", ")}` });
    const id = randomUUID(), secret = `whsec_${randomBytes(24).toString("base64url")}`;
    db.prepare("INSERT INTO webhook_endpoints (id, workspace_id, url, secret, event_types, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, ctx.workspaceId, url, encryptSecret(secret), types, ctx.userId);
    recordAudit(ctx, "webhook.created", "webhook", id, { url, event_types: types });
    // The signing secret is returned here and nowhere else.
    return res.status(201).json({ id, url, event_types: types, secret });
  }
  if (req.method === "PATCH") {
    const { id, enabled, event_types } = req.body as { id?: string; enabled?: boolean; event_types?: string | string[] };
    if (!id) return res.status(400).json({ error: "id is required" });
    const types = event_types === undefined ? undefined : eventTypesValue(event_types);
    if (types === null) return res.status(400).json({ error: `event_types must be * or a list of: ${EVENT_TYPES.join(", ")}` });
    db.prepare("UPDATE webhook_endpoints SET enabled = COALESCE(?, enabled), event_types = COALESCE(?, event_types) WHERE id = ? AND workspace_id = ?")
      .run(enabled === undefined ? null : enabled ? 1 : 0, types ?? null, id, ctx.workspaceId);
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
    // Deliver something now: a past delivery again, a test to one endpoint, or a test to all.
    const { id, delivery_id } = (req.body ?? {}) as { id?: string; delivery_id?: string };
    if (delivery_id) {
      const again = db.prepare(`UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = datetime('now'), last_error = NULL
        WHERE id = ? AND workspace_id = ? AND status != 'pending'`).run(delivery_id, ctx.workspaceId);
      if (!again.changes) return res.status(404).json({ error: "Delivery not found" });
      recordAudit(ctx, "webhook.redelivered", "webhook_delivery", delivery_id);
      await processWebhookDeliveries();
      return res.json(db.prepare("SELECT id, status, response_status, last_error FROM webhook_deliveries WHERE id = ?").get(delivery_id));
    }
    const endpoints = (id
      ? db.prepare("SELECT id, enabled FROM webhook_endpoints WHERE id = ? AND workspace_id = ?").all(id, ctx.workspaceId)
      : db.prepare("SELECT id, enabled FROM webhook_endpoints WHERE workspace_id = ? AND enabled = 1").all(ctx.workspaceId)) as Array<{ id: string; enabled: number }>;
    if (id && endpoints.length === 0) return res.status(404).json({ error: "Webhook not found" });
    if (id && !endpoints[0].enabled) return res.status(400).json({ error: "Turn the webhook on before testing it" });
    const deliveries = endpoints.map((endpoint) => queueTestDelivery(ctx.workspaceId, endpoint.id));
    await processWebhookDeliveries();
    const results = deliveries.map((deliveryId) => db.prepare("SELECT id, endpoint_id, status, response_status, last_error FROM webhook_deliveries WHERE id = ?").get(deliveryId));
    return res.json({ deliveries: results });
  }
  return res.status(405).end();
}
