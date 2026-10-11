import type Database from "better-sqlite3";

export interface TableShape {
  /** One line per column: name, declared type, NOT NULL, primary-key position, default. Sorted by name. */
  columns: string[];
  /** One line per index: uniqueness, columns in order, and the WHERE of a partial index. Sorted. */
  indexes: string[];
}

export type SchemaShape = Record<string, TableShape>;

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
interface IndexInfo { name: string; unique: number; origin: string; partial: number }

const squash = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * Everything about a database's structure that the app depends on, in a form
 * that compares equal for two databases that behave the same. Column order is
 * left out on purpose: a column added by ALTER TABLE lands at the end, while a
 * fresh install declares it in place.
 */
export function describeSchema(db: Database.Database): SchemaShape {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  const shape: SchemaShape = {};
  for (const { name } of tables) {
    const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as ColumnInfo[])
      .map(column => `${column.name} ${column.type || "(untyped)"}${column.notnull ? " NOT NULL" : ""}${column.pk ? ` PK${column.pk}` : ""}${column.dflt_value === null ? "" : ` DEFAULT ${squash(column.dflt_value)}`}`)
      .sort();
    const indexes = (db.prepare(`PRAGMA index_list("${name}")`).all() as IndexInfo[])
      .map(index => {
        const cols = (db.prepare(`PRAGMA index_info("${index.name}")`).all() as { name: string | null }[]).map(c => c.name ?? "(expression)").join(", ");
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index.name) as { sql: string | null } | undefined)?.sql ?? "";
        const where = index.partial ? ` WHERE ${squash(sql.split(/\bWHERE\b/i)[1] ?? "")}` : "";
        // Indexes SQLite makes for PRIMARY KEY and UNIQUE have generated names; everything else keeps its own.
        const label = index.origin === "c" ? index.name : `(${index.origin === "pk" ? "primary key" : "unique constraint"})`;
        return `${label}: ${index.unique ? "UNIQUE " : ""}(${cols})${where}`;
      })
      .sort();
    shape[name] = { columns, indexes };
  }
  return shape;
}

/** The statements that recreate a database's structure, plus its one-time migration flags. */
export function dumpSchemaSql(db: Database.Database): string {
  const objects = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name")
    .all() as { type: string; name: string; sql: string }[];
  const flags = db.prepare("SELECT key FROM _migration_flags ORDER BY key").all() as { key: string }[];
  return [
    ...objects.map(object => `${object.sql.trim()};`),
    ...flags.map(flag => `INSERT INTO _migration_flags (key) VALUES ('${flag.key.replace(/'/g, "''")}');`),
  ].join("\n\n") + "\n";
}
