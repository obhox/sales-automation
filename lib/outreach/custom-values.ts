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
