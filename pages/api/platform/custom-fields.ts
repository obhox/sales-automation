import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    const definitions = db.prepare("SELECT * FROM custom_field_definitions WHERE workspace_id = ? ORDER BY name").all(ctx.workspaceId) as Array<{ id: string; field_type: string }>;
    const { target_id } = req.query;
    if (typeof target_id === "string" && target_id) {
      if (!db.prepare("SELECT 1 FROM targets WHERE id = ? AND workspace_id = ?").get(target_id, ctx.workspaceId)) return res.status(404).json({ error: "Contact not found" });
      const rows = db.prepare("SELECT field_id, value_text, value_number, value_boolean FROM contact_custom_values WHERE workspace_id = ? AND target_id = ?").all(ctx.workspaceId, target_id) as Array<{ field_id: string; value_text: string | null; value_number: number | null; value_boolean: number | null }>;
      const typeByField = new Map(definitions.map((d) => [d.id, d.field_type]));
      const values: Record<string, string | number | boolean | null> = {};
      for (const r of rows) {
        const t = typeByField.get(r.field_id);
        values[r.field_id] = t === "number" ? r.value_number : t === "boolean" ? r.value_boolean === 1 : r.value_text;
      }
      return res.json({ definitions, values });
    }
    return res.json(definitions);
  }
  if (req.method === "POST") {
    const { name, key, field_type = "text", options } = req.body as Record<string, unknown>;
    if (typeof name !== "string" || typeof key !== "string" || !/^[a-z][a-z0-9_]*$/.test(key)) return res.status(400).json({ error: "Valid name and snake_case key are required" });
    const id = randomUUID();
    db.prepare("INSERT INTO custom_field_definitions (id, workspace_id, name, key, field_type, options_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, ctx.workspaceId, name, key, String(field_type), JSON.stringify(options ?? null));
    recordAudit(ctx, "custom_field.created", "custom_field", id);
    return res.status(201).json(db.prepare("SELECT * FROM custom_field_definitions WHERE id = ?").get(id));
  }
  if (req.method === "PUT") {
    const { target_id, field_id, value } = req.body as Record<string, unknown>;
    if (typeof target_id !== "string" || typeof field_id !== "string") return res.status(400).json({ error: "target_id and field_id are required" });
    const field = db.prepare("SELECT field_type FROM custom_field_definitions WHERE id = ? AND workspace_id = ?").get(field_id, ctx.workspaceId) as { field_type: string } | undefined;
    if (!field || !db.prepare("SELECT 1 FROM targets WHERE id = ? AND workspace_id = ?").get(target_id, ctx.workspaceId)) return res.status(404).json({ error: "Contact or field not found" });
    db.prepare(`INSERT INTO contact_custom_values (workspace_id, target_id, field_id, value_text, value_number, value_boolean, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(target_id, field_id) DO UPDATE SET
      value_text=excluded.value_text, value_number=excluded.value_number, value_boolean=excluded.value_boolean, updated_at=datetime('now')`)
      .run(ctx.workspaceId, target_id, field_id, field.field_type === "text" ? String(value ?? "") : null, field.field_type === "number" ? Number(value) : null, field.field_type === "boolean" ? (value ? 1 : 0) : null);
    recordAudit(ctx, "contact.custom_field_updated", "contact", target_id, { field_id, value });
    return res.json({ ok: true });
  }
  return res.status(405).end();
}
