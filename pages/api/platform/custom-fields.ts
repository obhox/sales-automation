import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

// A workspace's own contact fields, and one contact's values for them.
//
//   GET                       the definitions (an array, as always)
//   GET ?view=manage          the definitions with how many contacts have a value for each
//   GET ?target_id=           { definitions, values } for one contact
//   POST   { name, key, field_type?, options? }      define a field (manager)
//   PATCH  { id, name?, options? }                   rename one or change its choices (manager)
//   DELETE ?id=                                      remove one and every value held for it (manager)
//   PUT    { target_id, field_id, value }            set one contact's value; null or "" clears it (member)
//
// A field's key and type are fixed once it exists: campaign wording names the key
// ({{key}}), and stored values are kept by type.

export const CUSTOM_FIELD_TYPES = ["text", "number", "boolean", "date"] as const;
const TYPES = new Set<string>(CUSTOM_FIELD_TYPES);
const MAX_NAME = 60;

/** A real calendar day written YYYY-MM-DD. 31 February is refused rather than rolled into March. */
function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Defining fields is a manager's job; filling one in on a contact is ordinary contact editing.
  const minimum = req.method === "GET" ? "viewer" : req.method === "PUT" ? "member" : "manager";
  const ctx = requireWorkspace(req, res, minimum);
  if (!ctx) return;
  const db = getDb();
  const owned = (id: unknown) => db.prepare("SELECT * FROM custom_field_definitions WHERE id = ? AND workspace_id = ?").get(String(id ?? ""), ctx.workspaceId) as { id: string; name: string; key: string; field_type: string } | undefined;

  if (req.method === "GET") {
    if (req.query.view === "manage") {
      return res.json({
        fields: db.prepare(
          `SELECT d.*, (SELECT COUNT(*) FROM contact_custom_values v WHERE v.field_id = d.id) AS contacts
           FROM custom_field_definitions d WHERE d.workspace_id = ? ORDER BY d.name COLLATE NOCASE`,
        ).all(ctx.workspaceId),
        types: CUSTOM_FIELD_TYPES,
      });
    }
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
    if (typeof name !== "string" || !name.trim() || typeof key !== "string" || !/^[a-z][a-z0-9_]*$/.test(key)) return res.status(400).json({ error: "Valid name and snake_case key are required" });
    if (name.trim().length > MAX_NAME) return res.status(400).json({ error: `A field name can be up to ${MAX_NAME} characters` });
    if (!TYPES.has(String(field_type))) return res.status(400).json({ error: `field_type must be one of: ${CUSTOM_FIELD_TYPES.join(", ")}` });
    if (db.prepare("SELECT 1 FROM custom_field_definitions WHERE workspace_id = ? AND key = ?").get(ctx.workspaceId, key)) return res.status(409).json({ error: `There is already a field with the key "${key}"` });
    const id = randomUUID();
    db.prepare("INSERT INTO custom_field_definitions (id, workspace_id, name, key, field_type, options_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, ctx.workspaceId, name.trim(), key, String(field_type), JSON.stringify(options ?? null));
    recordAudit(ctx, "custom_field.created", "custom_field", id);
    return res.status(201).json(db.prepare("SELECT * FROM custom_field_definitions WHERE id = ?").get(id));
  }

  if (req.method === "PATCH") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = owned(body.id);
    if (!field) return res.status(404).json({ error: "Field not found" });
    if (body.key !== undefined && body.key !== field.key) return res.status(400).json({ error: "A field's key cannot be changed: campaign wording refers to it" });
    if (body.field_type !== undefined && body.field_type !== field.field_type) return res.status(400).json({ error: "A field's type cannot be changed once it holds values. Make a new field instead." });
    let name = field.name;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) return res.status(400).json({ error: "A field needs a name" });
      if (body.name.trim().length > MAX_NAME) return res.status(400).json({ error: `A field name can be up to ${MAX_NAME} characters` });
      name = body.name.trim();
    }
    if (body.options !== undefined) db.prepare("UPDATE custom_field_definitions SET options_json = ? WHERE id = ?").run(JSON.stringify(body.options ?? null), field.id);
    db.prepare("UPDATE custom_field_definitions SET name = ? WHERE id = ?").run(name, field.id);
    recordAudit(ctx, "custom_field.updated", "custom_field", field.id, { name });
    return res.json(owned(field.id));
  }

  if (req.method === "DELETE") {
    const field = owned(req.query.id);
    if (!field) return res.status(404).json({ error: "Field not found" });
    // Values go with the definition (ON DELETE CASCADE); counted first so the record says how many.
    const values = (db.prepare("SELECT COUNT(*) AS c FROM contact_custom_values WHERE field_id = ?").get(field.id) as { c: number }).c;
    db.transaction(() => {
      db.prepare("DELETE FROM contact_custom_values WHERE field_id = ?").run(field.id);
      db.prepare("DELETE FROM custom_field_definitions WHERE id = ?").run(field.id);
    })();
    recordAudit(ctx, "custom_field.deleted", "custom_field", field.id, { name: field.name, key: field.key, values });
    return res.json({ ok: true, values_removed: values });
  }

  if (req.method === "PUT") {
    const { target_id, field_id, value } = req.body as Record<string, unknown>;
    if (typeof target_id !== "string" || typeof field_id !== "string") return res.status(400).json({ error: "target_id and field_id are required" });
    const field = db.prepare("SELECT field_type FROM custom_field_definitions WHERE id = ? AND workspace_id = ?").get(field_id, ctx.workspaceId) as { field_type: string } | undefined;
    if (!field || !db.prepare("SELECT 1 FROM targets WHERE id = ? AND workspace_id = ?").get(target_id, ctx.workspaceId)) return res.status(404).json({ error: "Contact or field not found" });

    // An empty value takes the field off the contact, so {{key|fallback}} falls back again.
    const empty = value === null || value === undefined || (typeof value === "string" && value.trim() === "");
    if (empty) {
      db.prepare("DELETE FROM contact_custom_values WHERE target_id = ? AND field_id = ?").run(target_id, field_id);
      recordAudit(ctx, "contact.custom_field_updated", "contact", target_id, { field_id, value: null });
      return res.json({ ok: true });
    }
    if (field.field_type === "number" && !Number.isFinite(Number(value))) return res.status(400).json({ error: "This field holds a number" });
    if (field.field_type === "date" && !isDate(String(value))) return res.status(400).json({ error: "This field holds a date, written as YYYY-MM-DD" });

    // Dates are kept as text (YYYY-MM-DD), which sorts and renders as written.
    const asText = field.field_type === "text" || field.field_type === "date";
    db.prepare(`INSERT INTO contact_custom_values (workspace_id, target_id, field_id, value_text, value_number, value_boolean, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(target_id, field_id) DO UPDATE SET
      value_text=excluded.value_text, value_number=excluded.value_number, value_boolean=excluded.value_boolean, updated_at=datetime('now')`)
      .run(ctx.workspaceId, target_id, field_id, asText ? String(value ?? "") : null, field.field_type === "number" ? Number(value) : null, field.field_type === "boolean" ? (value ? 1 : 0) : null);
    recordAudit(ctx, "contact.custom_field_updated", "contact", target_id, { field_id, value });
    return res.json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "POST", "PATCH", "DELETE", "PUT"]);
  return res.status(405).end();
}
