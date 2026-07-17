import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

interface CustomValueRow {
  key: string;
  field_type: string;
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
 */
export function loadTargetCustomValues(db: DB, workspaceId: string, targetId: string): Record<string, string> {
  const rows = db.prepare(`
    SELECT d.key AS key, d.field_type AS field_type,
           v.value_text AS value_text, v.value_number AS value_number, v.value_boolean AS value_boolean
    FROM contact_custom_values v
    JOIN custom_field_definitions d ON d.id = v.field_id
    WHERE v.workspace_id = ? AND v.target_id = ?
  `).all(workspaceId, targetId) as CustomValueRow[];

  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = coerce(row);
  return map;
}
