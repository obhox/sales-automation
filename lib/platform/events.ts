import { createHmac, randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

export const EVENT_TYPES = ["email.sent", "email.delivered", "email.bounced", "reply.received", "reply.classified", "linkedin.connected", "linkedin.message_sent", "meeting.booked", "workflow.completed", "contact.created", "signal.received"] as const;

export function emitDomainEvent(input: { workspaceId: string; type: string; entityType?: string; entityId?: string; payload?: unknown }) {
  const db = getDb();
  const eventId = randomUUID();
  const payload = JSON.stringify(input.payload ?? {});
  db.transaction(() => {
    db.prepare("INSERT INTO domain_events (id, workspace_id, type, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(eventId, input.workspaceId, input.type, input.entityType ?? null, input.entityId ?? null, payload);
    const endpoints = db.prepare("SELECT id, event_types FROM webhook_endpoints WHERE workspace_id = ? AND enabled = 1").all(input.workspaceId) as Array<{ id: string; event_types: string }>;
    const insert = db.prepare("INSERT OR IGNORE INTO webhook_deliveries (id, workspace_id, event_id, endpoint_id) VALUES (?, ?, ?, ?)");
    for (const endpoint of endpoints) {
      const types = endpoint.event_types === "*" ? null : endpoint.event_types.split(",").map((x) => x.trim());
      if (!types || types.includes(input.type)) insert.run(randomUUID(), input.workspaceId, eventId, endpoint.id);
    }
  })();
  return eventId;
}

export async function processWebhookDeliveries(limit = 20): Promise<number> {
  const db = getDb();
  const rows = db.prepare(`SELECT wd.id, wd.attempt, we.url, we.secret, de.id event_id, de.type,
      de.entity_type, de.entity_id, de.payload_json, de.occurred_at
    FROM webhook_deliveries wd
    JOIN webhook_endpoints we ON we.id = wd.endpoint_id
    JOIN domain_events de ON de.id = wd.event_id
    WHERE wd.status IN ('pending','retrying') AND wd.next_attempt_at <= datetime('now') AND we.enabled = 1
    ORDER BY wd.created_at LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const body = JSON.stringify({ id: row.event_id, type: row.type, entity_type: row.entity_type, entity_id: row.entity_id, occurred_at: row.occurred_at, data: JSON.parse(String(row.payload_json)) });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = decryptSecret(String(row.secret)) ?? String(row.secret);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    try {
      const response = await fetch(String(row.url), { method: "POST", headers: { "content-type": "application/json", "user-agent": "Linki-Webhooks/1.0", "x-linki-event": String(row.type), "x-linki-timestamp": timestamp, "x-linki-signature": `sha256=${signature}` }, body, signal: AbortSignal.timeout(10_000) });
      const responseBody = (await response.text()).slice(0, 4000);
      if (response.ok) {
        db.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempt = attempt + 1, response_status = ?, response_body = ?, delivered_at = datetime('now') WHERE id = ?").run(response.status, responseBody, row.id);
      } else throw new Error(`HTTP ${response.status}: ${responseBody}`);
    } catch (error) {
      const attempt = Number(row.attempt) + 1;
      const dead = attempt >= 8;
      const delayMinutes = Math.min(2 ** attempt, 360);
      db.prepare(`UPDATE webhook_deliveries SET status = ?, attempt = ?, last_error = ?,
        next_attempt_at = datetime('now', ?) WHERE id = ?`)
        .run(dead ? "dead_letter" : "retrying", attempt, error instanceof Error ? error.message : String(error), `+${delayMinutes} minutes`, row.id);
    }
  }
  db.prepare(`UPDATE domain_events SET processed_at = datetime('now') WHERE processed_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM webhook_deliveries wd WHERE wd.event_id = domain_events.id AND wd.status IN ('pending','retrying'))`).run();
  return rows.length;
}
