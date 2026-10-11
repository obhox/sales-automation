import type { NextApiRequest, NextApiResponse } from "next";
import { randomBytes, randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { processWebhookDeliveries, queueTestDelivery } from "@/lib/platform/events";
import { EVENT_TYPES } from "@/lib/platform/event-types";
import { webhookUrlProblem } from "@/lib/platform/safe-fetch";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export type WebhookHealth = "healthy" | "retrying" | "failing" | "paused" | "idle";

export interface WebhookRow {
  id: string;
  /** What the workspace calls it. Null: it is known by its address. */
  name: string | null;
  url: string;
  event_types: string;
  enabled: number;
  created_at: string;
  delivery_count: number;
  delivered: number;
  retrying: number;
  /** Given up on after eight attempts. They can be sent again by hand. */
  dead_letters: number;
  /** Delivered as a share of those that have been delivered or are failing, 0 to 1. Null before the first. */
  success_rate: number | null;
  last_delivery_at: string | null;
  /** How the newest delivery stands: delivered, retrying, dead_letter or pending. */
  last_status: string | null;
  health: WebhookHealth;
}

export interface DeadLetter {
  id: string;
  endpoint_id: string;
  endpoint: string;
  event_type: string;
  attempt: number;
  response_status: number | null;
  last_error: string | null;
  created_at: string;
}

/** A name for a webhook as typed: trimmed, at most 80 characters, or null for none. `undefined` when it is not text. */
function webhookName(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || null;
}

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
    // ?dead_letters=1: every delivery that was given up on, across endpoints, newest first.
    if (req.query.dead_letters !== undefined) {
      return res.json(db.prepare(`SELECT wd.id, wd.endpoint_id, COALESCE(NULLIF(we.name, ''), we.url) AS endpoint, de.type AS event_type, wd.attempt, wd.response_status, wd.last_error, wd.created_at
        FROM webhook_deliveries wd JOIN webhook_endpoints we ON we.id = wd.endpoint_id JOIN domain_events de ON de.id = wd.event_id
        WHERE wd.workspace_id = ? AND wd.status = 'dead_letter' ORDER BY wd.created_at DESC, wd.rowid DESC LIMIT 100`).all(ctx.workspaceId) as DeadLetter[]);
    }
    const endpoints = db.prepare(`SELECT we.id, we.name, we.url, we.event_types, we.enabled, we.created_at,
      COUNT(wd.id) delivery_count,
      COALESCE(SUM(CASE WHEN wd.status='delivered' THEN 1 ELSE 0 END), 0) delivered,
      COALESCE(SUM(CASE WHEN wd.status='retrying' THEN 1 ELSE 0 END), 0) retrying,
      COALESCE(SUM(CASE WHEN wd.status='dead_letter' THEN 1 ELSE 0 END), 0) dead_letters,
      (SELECT MAX(COALESCE(x.delivered_at, x.created_at)) FROM webhook_deliveries x WHERE x.endpoint_id = we.id) last_delivery_at,
      (SELECT x.status FROM webhook_deliveries x WHERE x.endpoint_id = we.id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1) last_status
      FROM webhook_endpoints we LEFT JOIN webhook_deliveries wd ON wd.endpoint_id = we.id
      WHERE we.workspace_id = ? GROUP BY we.id ORDER BY we.created_at DESC, we.rowid DESC`).all(ctx.workspaceId) as Array<Omit<WebhookRow, "success_rate" | "health">>;
    const rows: WebhookRow[] = endpoints.map((endpoint) => {
      const settled = endpoint.delivered + endpoint.retrying + endpoint.dead_letters;
      const health: WebhookHealth = !endpoint.enabled ? "paused"
        : endpoint.retrying > 0 ? "retrying"
        : endpoint.last_status === "dead_letter" ? "failing"
        : endpoint.delivery_count === 0 ? "idle" : "healthy";
      return { ...endpoint, success_rate: settled > 0 ? endpoint.delivered / settled : null, health };
    });
    return res.json(rows);
  }
  if (req.method === "POST") {
    const { url, event_types, name: rawName } = req.body as { url?: string; event_types?: string | string[]; name?: unknown };
    const problem = await webhookUrlProblem(String(url ?? ""));
    if (problem) return res.status(400).json({ error: problem });
    const types = eventTypesValue(event_types);
    if (types === null) return res.status(400).json({ error: `event_types must be * or a list of: ${EVENT_TYPES.join(", ")}` });
    const name = webhookName(rawName);
    if (name === undefined) return res.status(400).json({ error: "name must be text" });
    const id = randomUUID(), secret = `whsec_${randomBytes(24).toString("base64url")}`;
    db.prepare("INSERT INTO webhook_endpoints (id, workspace_id, name, url, secret, event_types, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, ctx.workspaceId, name, url, encryptSecret(secret), types, ctx.userId);
    recordAudit(ctx, "webhook.created", "webhook", id, { url, event_types: types, ...(name ? { name } : {}) });
    // The signing secret is returned here and nowhere else.
    return res.status(201).json({ id, name, url, event_types: types, secret });
  }
  if (req.method === "PATCH") {
    const body = (req.body ?? {}) as { id?: string; enabled?: boolean; event_types?: string | string[]; name?: unknown };
    const { id, enabled, event_types } = body;
    if (!id) return res.status(400).json({ error: "id is required" });
    const types = event_types === undefined ? undefined : eventTypesValue(event_types);
    if (types === null) return res.status(400).json({ error: `event_types must be * or a list of: ${EVENT_TYPES.join(", ")}` });
    db.prepare("UPDATE webhook_endpoints SET enabled = COALESCE(?, enabled), event_types = COALESCE(?, event_types) WHERE id = ? AND workspace_id = ?")
      .run(enabled === undefined ? null : enabled ? 1 : 0, types ?? null, id, ctx.workspaceId);
    // A name is only touched when one is sent; sent empty, it is cleared.
    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const name = webhookName(body.name);
      if (name === undefined) return res.status(400).json({ error: "name must be text" });
      db.prepare("UPDATE webhook_endpoints SET name = ? WHERE id = ? AND workspace_id = ?").run(name, id, ctx.workspaceId);
    }
    recordAudit(ctx, "webhook.updated", "webhook", id, enabled === undefined ? undefined : { enabled });
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
