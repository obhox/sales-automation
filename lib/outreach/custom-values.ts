import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

interface CustomValueRow {
  key: string;
  field_type: string;
  has_value?: number;
  value_text: string | null;
  value_number: number | null;
  value_boolean: number | null;
}

/** Coerce a stored EAV custom value into the string a template variable renders to. */
function coerce(row: CustomValueRow): string {
  if (row.field_type === "number") return row.value_number != null ? String(row.value_number) : "";
  if (row.field_type === "boolean") return row.value_boolean ? "yes" : "no";
  return row.value_text ?? "";
}

/**
 * Load a target's custom-field values as a `{ key: renderedString }` map, keyed
 * by the workspace's `custom_field_definitions.key` — ready to pass as the
 * `custom` argument of `renderOutreachTemplate`.
 *
 * Every field the workspace defines is in the map; one this contact has no value for is
 * the empty string. That is what lets `{{field|fallback}}` fall back, and what keeps a
 * bare `{{field}}` from being sent as written to the contacts who lack it.
 */
export function loadTargetCustomValues(db: DB, workspaceId: string, targetId: string): Record<string, string> {
  const rows = db.prepare(`
    SELECT d.key AS key, d.field_type AS field_type, v.field_id IS NOT NULL AS has_value,
           v.value_text AS value_text, v.value_number AS value_number, v.value_boolean AS value_boolean
    FROM custom_field_definitions d
    LEFT JOIN contact_custom_values v ON v.field_id = d.id AND v.target_id = ?
    WHERE d.workspace_id = ?
  `).all(targetId, workspaceId) as CustomValueRow[];

  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.has_value ? coerce(row) : "";
  return map;
}

/** A custom field's key, as the renderer will look for it: `{{hook_line}}`. */
export const CUSTOM_FIELD_KEY = /^[a-z][a-z0-9_]*$/;

/** The key is not one a template could ever reference, so writing it would be pointless. */
export class UnusableCustomFieldKey extends Error {
  constructor(key: string) {
    super(`"${key}" cannot be a custom field key: use lower-case letters, digits and underscores, starting with a letter.`);
    this.name = "UnusableCustomFieldKey";
  }
}

/** The field exists but holds something other than text, so a written line does not belong in it. */
export class CustomFieldNotText extends Error {
  constructor(key: string, fieldType: string) {
    super(`The custom field "${key}" holds ${fieldType} values, so text cannot be written to it.`);
    this.name = "CustomFieldNotText";
  }
}

/**
 * Find or create the text custom field a key names, and answer with its id.
 *
 * Library code had no way to do this: the HTTP route refuses a key that already exists
 * with a 409, and the only find-or-create lived inside the two CSV importers. Research
 * needs it because the field it writes to (a hook line, say) has to exist before the first
 * contact is researched, and asking a member to create it by hand first is a step they
 * will skip and then wonder why `{{hook_line}}` arrives as written.
 *
 * An existing definition is authoritative for how its values are stored, matching the CSV
 * importers: the type is never changed under a workspace that chose it, and a field that
 * is not text is refused rather than written to wrongly.
 */
export function ensureTextCustomField(db: DB, workspaceId: string, field: { key: string; name: string }): string {
  const key = field.key.trim().toLowerCase();
  if (!CUSTOM_FIELD_KEY.test(key)) throw new UnusableCustomFieldKey(field.key);
  const existing = db.prepare("SELECT id, field_type FROM custom_field_definitions WHERE workspace_id = ? AND key = ?")
    .get(workspaceId, key) as { id: string; field_type: string } | undefined;
  if (existing) {
    if (existing.field_type !== "text") throw new CustomFieldNotText(key, existing.field_type);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO custom_field_definitions (id, workspace_id, name, key, field_type) VALUES (?, ?, ?, ?, 'text')")
    .run(id, workspaceId, field.name.trim() || key, key);
  return id;
}

/**
 * Write one text custom value onto a contact.
 *
 * A blank value deletes the row rather than storing an empty string, which is what the
 * route that a member edits through does too: an absent row is what lets `{{hook_line|…}}`
 * fall back, where a stored "" would render as nothing and silently leave a gap in the
 * sentence around it.
 *
 * `workspace_id` is a real column here and every reader filters on it, so it is written
 * even though (target_id, field_id) is already unique.
 */
export function writeTargetCustomText(db: DB, workspaceId: string, targetId: string, fieldId: string, value: string | null | undefined): void {
  const text = (value ?? "").trim();
  if (!text) {
    db.prepare("DELETE FROM contact_custom_values WHERE target_id = ? AND field_id = ? AND workspace_id = ?").run(targetId, fieldId, workspaceId);
    return;
  }
  db.prepare(`
    INSERT INTO contact_custom_values (workspace_id, target_id, field_id, value_text, value_number, value_boolean, updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL, datetime('now'))
    ON CONFLICT(target_id, field_id) DO UPDATE SET
      value_text = excluded.value_text, value_number = NULL, value_boolean = NULL, updated_at = datetime('now')
  `).run(workspaceId, targetId, fieldId, text);
}
