import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { importCsv, importCsvWithMapping, type ColumnMapping } from "@/lib/csv-import";
import { DEFAULT_MATCH, ON_DUPLICATE, applyPlan, checkMapping, customFields, isImportField, mappingHasIdentity, planImport, readCsv, type OnDuplicate } from "@/lib/csv-imports";
import { requireWorkspace } from "@/lib/workspace";

/**
 * POST { csv, mapping?, filename?, dry_run?, on_duplicate?, match? } : import a file's text into a list, in one call.
 *
 * With only `csv` (and `mapping`) it does what it always has: a row that matches a contact by
 * LinkedIn URL or email updates that contact, and nothing is kept of the import itself.
 *
 * Any of the three options turns on the importer the import page uses:
 *   dry_run: true                         change nothing; answer with what the import would do
 *   on_duplicate: skip | update | import  what happens to a row that is already a contact (update is the default)
 *   match: { email?, name_company? }      which details make a row the same person (a LinkedIn profile always does)
 *
 * The import page itself goes through /api/csv-imports, which keeps a record so it can be resumed.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;

  const db = getDb();
  const listId = req.query.id as string;

  const list = db.prepare("SELECT id FROM lists WHERE id = ? AND workspace_id = ?").get(listId, ctx.workspaceId) as { id: string } | undefined;
  if (!list) return res.status(404).json({ error: "List not found" });

  const { csv, mapping, filename } = req.body as { csv?: string; mapping?: unknown; filename?: unknown };
  if (!csv || typeof csv !== "string" || !csv.trim()) {
    return res.status(400).json({ error: "csv content is required" });
  }
  // The list remembers that it came from a file, which file was last, and when.
  const file = typeof filename === "string" && filename.trim() ? filename.trim().slice(0, 200) : null;
  const noteImport = () => db.prepare("UPDATE lists SET source = CASE WHEN COALESCE(source, 'manual') = 'manual' THEN 'csv' ELSE source END, source_detail = COALESCE(?, source_detail), last_synced_at = datetime('now') WHERE id = ?").run(file, listId);

  const { dry_run: dryRun, on_duplicate: onDuplicate, match } = req.body as { dry_run?: unknown; on_duplicate?: unknown; match?: unknown };
  if (dryRun !== undefined || onDuplicate !== undefined || match !== undefined) {
    if (onDuplicate !== undefined && !(ON_DUPLICATE as readonly unknown[]).includes(onDuplicate)) return res.status(400).json({ error: `on_duplicate must be one of ${ON_DUPLICATE.join(", ")}` });
    const wanted = (match ?? {}) as Record<string, unknown>;
    if (typeof wanted !== "object" || [wanted.email, wanted.name_company].some((value) => value !== undefined && typeof value !== "boolean")) return res.status(400).json({ error: "match takes email and name_company, each true or false" });
    const named = mapping === undefined ? null : validateMapping(mapping);
    if (named && "error" in named) return res.status(400).json({ error: named.error });
    const table = readCsv(csv);
    // Columns are named here and numbered there. With no mapping, a column named for a contact field fills it, as ever.
    const left = named ? [...named.mapping] : null;
    const checked = checkMapping(table.columns.map((column, index) => {
      if (!left) return isImportField(column) && column !== "full_name" ? { index, kind: "standard", field: column } : { index, kind: "ignore" };
      const at = left.findIndex((entry) => entry.column === column);
      return at < 0 ? { index, kind: "ignore" } : { index, ...left.splice(at, 1)[0] };
    }), table, customFields(db, ctx.workspaceId));
    if ("error" in checked) return res.status(400).json({ error: checked.error });
    if (!mappingHasIdentity(checked.mapping)) return res.status(400).json({ error: "Map one column to linkedin_url or email, so each row can be told apart." });
    const plan = planImport(db, ctx.workspaceId, {
      file: table, mapping: checked.mapping, listId, onDuplicate: (onDuplicate as OnDuplicate | undefined) ?? "update",
      match: { ...DEFAULT_MATCH, ...(typeof wanted.email === "boolean" ? { email: wanted.email } : {}), ...(typeof wanted.name_company === "boolean" ? { name_company: wanted.name_company } : {}) },
    });
    if (dryRun === true) return res.json({ dry_run: true, summary: plan.summary, issues: plan.issues, duplicates: plan.duplicates });
    const done = applyPlan(db, ctx.workspaceId, listId, plan, checked.mapping);
    noteImport();
    return res.json({
      imported: done.created, updated: done.updated, merged: done.merged, skipped: done.skipped, already_in_list: done.already_in_list,
      errors: done.error_rows.map((row) => `Row ${row.row}: ${row.reason}`), customFieldsCreated: done.custom_fields_created,
    });
  }

  if (mapping !== undefined) {
    const validated = validateMapping(mapping);
    if ("error" in validated) return res.status(400).json({ error: validated.error });
    const result = importCsvWithMapping(db, listId, ctx.workspaceId, csv, validated.mapping);
    noteImport();
    return res.json(result);
  }

  const result = importCsv(db, listId, ctx.workspaceId, csv);
  noteImport();
  res.json(result);
}

// CSV text is posted as JSON — raise the request body limit well above the 1MB default
// so large lists don't get silently rejected with a 413 before reaching the handler.
export const config = {
  api: { bodyParser: { sizeLimit: "25mb" }, responseLimit: false },
};

const STANDARD_FIELDS = new Set([
  "linkedin_url", "sales_nav_url", "email",
  "first_name", "last_name", "title", "company", "location",
  "city", "country", "phone", "headline", "summary", "notes",
  // The importer has always written this field, and the template has always had the column.
  // It was missing here, so a mapping that named it was refused.
  "time_zone",
]);
const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]*$/;

// Defensive shape validation for a user-supplied column mapping.
function validateMapping(input: unknown): { mapping: ColumnMapping[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "mapping must be an array" };
  const out: ColumnMapping[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { error: "each mapping entry must be an object" };
    const m = raw as Record<string, unknown>;
    if (typeof m.column !== "string" || !m.column) return { error: "each mapping entry needs a column name" };
    if (m.kind === "ignore") {
      out.push({ column: m.column, kind: "ignore" });
    } else if (m.kind === "standard") {
      if (typeof m.field !== "string" || !STANDARD_FIELDS.has(m.field)) return { error: `unknown standard field for column "${m.column}"` };
      out.push({ column: m.column, kind: "standard", field: m.field as never });
    } else if (m.kind === "custom") {
      if (typeof m.key !== "string" || !CUSTOM_KEY_RE.test(m.key)) return { error: `invalid variable key for column "${m.column}"` };
      const fieldType = m.fieldType === "number" || m.fieldType === "boolean" ? m.fieldType : "text";
      const name = typeof m.name === "string" && m.name ? m.name : m.key;
      out.push({ column: m.column, kind: "custom", key: m.key, name, fieldType });
    } else {
      return { error: `invalid mapping kind for column "${m.column}"` };
    }
  }
  return { mapping: out };
}
