import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { campaignSummaries } from "@/lib/campaigns/summary";
import {
  DEFAULT_MATCH, ON_DUPLICATE, applyPlan, checkMapping, customFields, detectType, headerSignature, mappingHasIdentity, planImport, readCsv, rememberedMapping, suggestMapping,
  type CsvFile, type CustomType, type DuplicateRow, type ImportColumn, type ImportPlanSummary, type ImportResult, type Issue, type MatchOptions, type OnDuplicate,
} from "@/lib/csv-imports";
import { emitDomainEvent } from "@/lib/platform/events";
import { notify } from "@/lib/platform/notifications";

// The record of a CSV import while it is being set up, and after it has run.
//
// The file is kept with the record until the import runs, so the page can be left at any
// step and opened again, by the person who started it or by a colleague. Once it has run
// the file is dropped and what it did is kept. An import nobody finished is dropped after
// thirty days.

type DB = DatabaseType.Database;

export const IMPORT_STEPS = ["map", "duplicates", "review"] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

export const AFTER_MODES = ["none", "new", "existing"] as const;
/** What to open once the import has run: nothing, a new campaign on the list, or a draft campaign given the list. */
export interface AfterImport { mode: (typeof AFTER_MODES)[number]; campaign_id: string | null }

/** The largest file taken, as text. The same limit the older import route has. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const KEEP_DRAFT_DAYS = 30;
const NO_IDENTITY = "Map one column to LinkedIn profile or Email, so each row can be told apart.";

interface ImportRow {
  id: string; workspace_id: string; created_by: string | null; status: string; step: string; filename: string; size_bytes: number; encoding: string | null;
  delimiter: string | null; has_header: number; row_count: number; column_count: number; mapping_json: string | null; mapping_source: string | null;
  list_mode: string; list_id: string | null; new_list_name: string | null; match_json: string | null; on_duplicate: string; after_json: string | null;
  result_json: string | null; created_at: string; updated_at: string; finished_at: string | null;
}

export interface StoredResult extends ImportResult {
  list: { id: string; name: string };
  /** The list was made by this import. */
  new_list: boolean;
  rows: number;
}

export interface ImportColumnView {
  index: number;
  column: string;
  /** A value from the file to recognise the column by: the first row's, or the first there is. Null when the column is empty. */
  sample: string | null;
  /** How many rows have something in this column. */
  filled: number;
  /** The kind of field its values would make. */
  detected: CustomType;
  mapping: ImportColumn;
}

export interface ImportView {
  id: string;
  status: "draft" | "done";
  step: ImportStep;
  file: { name: string; size_bytes: number; encoding: string | null; delimiter: string; has_header: boolean; rows: number; columns: number };
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  created_by: { id: string; name: string } | null;
  /** Empty once the import has run: the file is no longer kept. */
  columns: ImportColumnView[];
  /** The file the mapping was remembered from, when it was. */
  remembered_from: string | null;
  list_mode: "existing" | "new";
  list_id: string | null;
  new_list_name: string;
  match: MatchOptions;
  on_duplicate: OnDuplicate;
  after: AfterImport;
  result: StoredResult | null;
  options: {
    lists: Array<{ id: string; name: string; contacts: number }>;
    fields: Array<{ key: string; name: string; field_type: string }>;
    /** Campaigns not started yet, which can be given the list. */
    campaigns: Array<{ id: string; name: string; steps: number }>;
  };
}

const parse = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

const rowOf = (db: DB, workspaceId: string, id: string) => db.prepare("SELECT * FROM csv_imports WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as ImportRow | undefined;
const fileOf = (db: DB, id: string): CsvFile | null => {
  const stored = db.prepare("SELECT content FROM csv_import_files WHERE import_id = ?").get(id) as { content: string } | undefined;
  return stored ? readCsv(stored.content) : null;
};
const matchOf = (row: ImportRow): MatchOptions => ({ ...DEFAULT_MATCH, ...parse<Partial<MatchOptions>>(row.match_json, {}) });
const afterOf = (row: ImportRow): AfterImport => ({ mode: "none", campaign_id: null, ...parse<Partial<AfterImport>>(row.after_json, {}) });
const mappingOf = (row: ImportRow, file: CsvFile): ImportColumn[] => {
  const stored = parse<ImportColumn[]>(row.mapping_json, []);
  return file.columns.map((column, index) => stored.find((entry) => entry.index === index) ?? { index, column, kind: "ignore" as const });
};

/** "acme_q4_prospects.csv" → "Acme q4 prospects": a name for a list made from a file. */
export function listNameFromFile(filename: string): string {
  const words = filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  return (words ? words[0].toUpperCase() + words.slice(1) : "Imported contacts").slice(0, 120);
}

function listOptions(db: DB, workspaceId: string) {
  return db.prepare(`SELECT l.id, l.name, (SELECT COUNT(*) FROM list_targets lt WHERE lt.list_id = l.id) AS contacts
    FROM lists l WHERE l.workspace_id = ? AND l.archived_at IS NULL ORDER BY l.name COLLATE NOCASE`).all(workspaceId) as Array<{ id: string; name: string; contacts: number }>;
}

/** The import as its page shows it. Null when the workspace has no such import. */
export function readImport(db: DB, workspaceId: string, id: string): ImportView | null {
  const row = rowOf(db, workspaceId, id);
  if (!row) return null;
  const file = row.status === "draft" ? fileOf(db, id) : null;
  const mapping = file ? mappingOf(row, file) : [];
  const author = row.created_by ? (db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(row.created_by) as { id: string; name: string | null; email: string } | undefined) : undefined;
  return {
    id: row.id, status: row.status === "done" ? "done" : "draft", step: (IMPORT_STEPS as readonly string[]).includes(row.step) ? (row.step as ImportStep) : "map",
    file: { name: row.filename, size_bytes: row.size_bytes, encoding: row.encoding, delimiter: row.delimiter ?? ",", has_header: row.has_header === 1, rows: row.row_count, columns: row.column_count },
    created_at: row.created_at, updated_at: row.updated_at, finished_at: row.finished_at,
    created_by: author ? { id: author.id, name: author.name || author.email } : null,
    columns: file ? file.columns.map((column, index) => {
      const values = file.rows.map((line) => (line[index] ?? "").trim());
      return { index, column, sample: values.find(Boolean) ?? null, filled: values.filter(Boolean).length, detected: detectType(values), mapping: mapping[index] };
    }) : [],
    remembered_from: row.mapping_source?.startsWith("remembered:") ? row.mapping_source.slice("remembered:".length) : null,
    list_mode: row.list_mode === "new" ? "new" : "existing", list_id: row.list_id, new_list_name: row.new_list_name ?? "",
    match: matchOf(row), on_duplicate: (ON_DUPLICATE as readonly string[]).includes(row.on_duplicate) ? (row.on_duplicate as OnDuplicate) : "update", after: afterOf(row),
    result: parse<StoredResult | null>(row.result_json, null),
    options: {
      lists: listOptions(db, workspaceId),
      fields: customFields(db, workspaceId).map(({ key, name, field_type }) => ({ key, name, field_type })),
      campaigns: campaignSummaries(db, workspaceId).filter((campaign) => campaign.status === "draft").map(({ id: campaignId, name, steps }) => ({ id: campaignId, name, steps })),
    },
  };
}

/** The first rows of an import's file, as they are in the file. Null when there is no such import, or its file is no longer kept. */
export function previewRows(db: DB, workspaceId: string, id: string, limit = 50): { columns: string[]; rows: string[][]; total: number } | null {
  const row = rowOf(db, workspaceId, id);
  const file = row && row.status === "draft" ? fileOf(db, id) : null;
  return file ? { columns: file.columns, rows: file.rows.slice(0, Math.min(Math.max(limit, 1), 200)), total: file.rows.length } : null;
}

export interface FileInput { csv?: unknown; filename?: unknown; encoding?: unknown }

/** Why a file cannot be taken, or the file read. */
function takeFile(input: FileInput): { text: string; file: CsvFile; filename: string; encoding: string | null } | { error: string } {
  if (typeof input.csv !== "string" || !input.csv.trim()) return { error: "Choose a CSV file with something in it." };
  if (Buffer.byteLength(input.csv, "utf8") > MAX_FILE_BYTES) return { error: "That file is over 25 MB. Split it into smaller files and import them one after another." };
  const file = readCsv(input.csv);
  if (file.rows.length === 0) return { error: file.hasHeader ? "The file has no rows under its header line." : "The file has no rows." };
  if (file.columns.length === 0) return { error: "The file has no columns." };
  const filename = typeof input.filename === "string" && input.filename.trim() ? input.filename.trim().slice(0, 200) : "import.csv";
  const encoding = typeof input.encoding === "string" && /^[a-z0-9-]{3,20}$/i.test(input.encoding) ? input.encoding.toLowerCase() : null;
  return { text: input.csv, file, filename, encoding };
}

function firstMapping(db: DB, workspaceId: string, file: CsvFile): { mapping: ImportColumn[]; source: string } {
  const remembered = rememberedMapping(db, workspaceId, file);
  // A remembered mapping is only as good as the fields it names: one that has since been removed is offered afresh.
  const checked = remembered ? checkMapping(remembered.mapping, file, customFields(db, workspaceId)) : null;
  if (remembered && checked && "mapping" in checked) return { mapping: checked.mapping, source: `remembered:${remembered.filename ?? "an earlier file"}` };
  return { mapping: suggestMapping(file, customFields(db, workspaceId)), source: "auto" };
}

/** Start an import from a file. Its columns are mapped the way the workspace last mapped a file with the same headers, or by their names. */
export function createImport(db: DB, workspaceId: string, userId: string | null, input: FileInput & { list_id?: unknown }): ImportView | { error: string } {
  const taken = takeFile(input);
  if ("error" in taken) return taken;
  const lists = listOptions(db, workspaceId);
  const listId = typeof input.list_id === "string" && lists.some((list) => list.id === input.list_id) ? input.list_id : null;
  const { mapping, source } = firstMapping(db, workspaceId, taken.file);
  const id = randomUUID();
  db.transaction(() => {
    db.prepare(`DELETE FROM csv_imports WHERE workspace_id = ? AND status = 'draft' AND updated_at < datetime('now', ?)`).run(workspaceId, `-${KEEP_DRAFT_DAYS} days`);
    db.prepare(`INSERT INTO csv_imports (id, workspace_id, created_by, filename, size_bytes, encoding, delimiter, has_header, row_count, column_count, mapping_json, mapping_source,
        list_mode, list_id, new_list_name, match_json, on_duplicate, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'update', ?)`).run(
      id, workspaceId, userId, taken.filename, Buffer.byteLength(taken.text, "utf8"), taken.encoding, taken.file.delimiter, taken.file.hasHeader ? 1 : 0, taken.file.rows.length, taken.file.columns.length,
      JSON.stringify(mapping), source, listId || lists.length > 0 ? "existing" : "new", listId, listNameFromFile(taken.filename), JSON.stringify(DEFAULT_MATCH), JSON.stringify({ mode: "none", campaign_id: null }),
    );
    db.prepare("INSERT INTO csv_import_files (import_id, content) VALUES (?, ?)").run(id, taken.text);
  })();
  return readImport(db, workspaceId, id)!;
}

/**
 * Change an import that has not run yet: its mapping, where it goes, how duplicates are
 * matched and treated, what happens after, the step its page is on, or the file itself.
 * What is left out stays as it was. Returns the import, or why the change cannot be kept.
 */
export function updateImport(db: DB, workspaceId: string, id: string, change: Record<string, unknown>): ImportView | { error: string } | null {
  const row = rowOf(db, workspaceId, id);
  if (!row) return null;
  if (row.status !== "draft") return { error: "This import has already run." };
  const set: Record<string, unknown> = {};

  let file = fileOf(db, id);
  if (!file) return { error: "The file for this import is no longer kept. Start again with the file." };
  let content: string | null = null;
  if (change.csv !== undefined) {
    const taken = takeFile(change as FileInput);
    if ("error" in taken) return taken;
    const first = firstMapping(db, workspaceId, taken.file);
    file = taken.file;
    content = taken.text;
    Object.assign(set, {
      filename: taken.filename, size_bytes: Buffer.byteLength(taken.text, "utf8"), encoding: taken.encoding, delimiter: taken.file.delimiter, has_header: taken.file.hasHeader ? 1 : 0,
      row_count: taken.file.rows.length, column_count: taken.file.columns.length, mapping_json: JSON.stringify(first.mapping), mapping_source: first.source, step: "map",
    });
  }
  if (change.automap === true) Object.assign(set, { mapping_json: JSON.stringify(suggestMapping(file, customFields(db, workspaceId))), mapping_source: "auto" });
  if (change.mapping !== undefined) {
    const checked = checkMapping(change.mapping, file, customFields(db, workspaceId));
    if ("error" in checked) return checked;
    set.mapping_json = JSON.stringify(checked.mapping);
  }
  if (change.list_mode !== undefined) {
    if (change.list_mode !== "existing" && change.list_mode !== "new") return { error: "list_mode must be existing or new" };
    set.list_mode = change.list_mode;
  }
  if (change.list_id !== undefined) {
    if (change.list_id !== null && !db.prepare("SELECT 1 FROM lists WHERE id = ? AND workspace_id = ? AND archived_at IS NULL").get(change.list_id, workspaceId)) return { error: "That list is not in this workspace" };
    set.list_id = change.list_id;
  }
  if (change.new_list_name !== undefined) {
    if (typeof change.new_list_name !== "string" || change.new_list_name.length > 120) return { error: "A list's name is text of up to 120 characters" };
    set.new_list_name = change.new_list_name;
  }
  if (change.match !== undefined) {
    const match = change.match as Record<string, unknown> | null;
    if (!match || typeof match !== "object" || [match.email, match.name_company].some((value) => value !== undefined && typeof value !== "boolean")) return { error: "match takes email and name_company, each true or false" };
    set.match_json = JSON.stringify({ ...matchOf(row), ...(typeof match.email === "boolean" ? { email: match.email } : {}), ...(typeof match.name_company === "boolean" ? { name_company: match.name_company } : {}) });
  }
  if (change.on_duplicate !== undefined) {
    if (!(ON_DUPLICATE as readonly unknown[]).includes(change.on_duplicate)) return { error: `on_duplicate must be one of ${ON_DUPLICATE.join(", ")}` };
    set.on_duplicate = change.on_duplicate;
  }
  if (change.after !== undefined) {
    const after = change.after as Record<string, unknown> | null;
    if (!after || typeof after !== "object" || !(AFTER_MODES as readonly unknown[]).includes(after.mode)) return { error: `after.mode must be one of ${AFTER_MODES.join(", ")}` };
    const campaignId = after.mode === "existing" ? after.campaign_id : null;
    if (after.mode === "existing" && !(typeof campaignId === "string" && campaignSummaries(db, workspaceId).some((campaign) => campaign.id === campaignId && campaign.status === "draft"))) {
      return { error: "Choose a campaign that has not been started yet" };
    }
    set.after_json = JSON.stringify({ mode: after.mode, campaign_id: campaignId ?? null });
  }
  if (change.step !== undefined) {
    if (!(IMPORT_STEPS as readonly unknown[]).includes(change.step)) return { error: `step must be one of ${IMPORT_STEPS.join(", ")}` };
    set.step = change.step;
  }

  db.transaction(() => {
    if (content !== null) db.prepare("UPDATE csv_import_files SET content = ? WHERE import_id = ?").run(content, id);
    const keys = Object.keys(set);
    db.prepare(`UPDATE csv_imports SET ${keys.map((key) => `${key} = ?`).join(", ")}${keys.length ? ", " : ""}updated_at = datetime('now') WHERE id = ?`).run(...keys.map((key) => set[key]), id);
  })();
  return readImport(db, workspaceId, id);
}

/** Throw an import away: the record and the file. One that has run keeps what it imported. */
export function discardImport(db: DB, workspaceId: string, id: string): boolean {
  return db.prepare("DELETE FROM csv_imports WHERE id = ? AND workspace_id = ?").run(id, workspaceId).changes > 0;
}

export interface ImportCheck {
  /** Why the import cannot run as it stands. Null when it can. */
  problem: string | null;
  summary: ImportPlanSummary;
  issues: Issue[];
  duplicates: DuplicateRow[];
  /** How many duplicate rows there are in all: `duplicates` holds the first of them. */
  duplicate_rows: number;
  checked_at: string;
}

function planFor(db: DB, workspaceId: string, row: ImportRow, file: CsvFile) {
  const mapping = mappingOf(row, file);
  return { mapping, plan: planImport(db, workspaceId, { file, mapping, listId: row.list_mode === "existing" ? row.list_id : null, match: matchOf(row), onDuplicate: (ON_DUPLICATE as readonly string[]).includes(row.on_duplicate) ? (row.on_duplicate as OnDuplicate) : "update" }) };
}

/** Why the import cannot run yet, apart from its rows. */
function blocker(db: DB, workspaceId: string, row: ImportRow, mapping: ImportColumn[]): string | null {
  if (!mappingHasIdentity(mapping)) return NO_IDENTITY;
  if (row.list_mode === "new") return row.new_list_name?.trim() ? null : "Give the new list a name.";
  if (!row.list_id) return "Choose the list to import into.";
  return db.prepare("SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?").get(row.list_id, workspaceId) ? null : "The list this import was going into has been deleted. Choose another.";
}

/** The dry run: what importing the file as it is set up would do. Nothing is changed. */
export function checkImport(db: DB, workspaceId: string, id: string): ImportCheck | { error: string } | null {
  const row = rowOf(db, workspaceId, id);
  if (!row) return null;
  if (row.status !== "draft") return { error: "This import has already run." };
  const file = fileOf(db, id);
  if (!file) return { error: "The file for this import is no longer kept. Start again with the file." };
  const { mapping, plan } = planFor(db, workspaceId, row, file);
  const { summary } = plan;
  return {
    problem: blocker(db, workspaceId, row, mapping) ?? (summary.ready === 0 ? "No row of this file can be imported as it is set up." : null),
    summary, issues: plan.issues, duplicates: plan.duplicates, duplicate_rows: summary.duplicates.existing + summary.duplicates.in_file, checked_at: new Date().toISOString(),
  };
}

/** Keep how this file's columns were mapped, for the next file with the same headers. */
export function rememberMapping(db: DB, workspaceId: string, userId: string | null, file: { columns: string[] }, mapping: ImportColumn[], filename: string) {
  const kept = mapping.map((entry) => (entry.kind === "standard" ? { column: entry.column, kind: entry.kind, field: entry.field }
    : entry.kind === "custom" ? { column: entry.column, kind: entry.kind, key: entry.key, name: entry.name, fieldType: entry.fieldType } : { column: entry.column, kind: entry.kind }));
  db.prepare(`INSERT INTO csv_import_mappings (id, workspace_id, signature, mapping_json, filename, updated_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, signature) DO UPDATE SET mapping_json = excluded.mapping_json, filename = excluded.filename, updated_by = excluded.updated_by, updated_at = datetime('now')`)
    .run(randomUUID(), workspaceId, headerSignature(file.columns), JSON.stringify(kept), filename, userId);
}

/** Say on the list that it has had a file imported into it: where it came from, which file, and when. */
export function noteCsvImport(db: DB, listId: string, filename: string | null) {
  db.prepare("UPDATE lists SET source = CASE WHEN COALESCE(source, 'manual') = 'manual' THEN 'csv' ELSE source END, source_detail = COALESCE(?, source_detail), last_synced_at = datetime('now') WHERE id = ?").run(filename, listId);
}

const contacts = (count: number) => `${count} ${count === 1 ? "contact" : "contacts"}`;

/**
 * Run the import: make the list if it is to be a new one, write the rows, remember the
 * mapping, and say it is finished (an `import.finished` event and a notification, as a
 * Sales Navigator import does). The file is dropped; what the import did is kept.
 */
export function runImport(db: DB, workspaceId: string, id: string, userId: string | null): { import: ImportView; result: StoredResult } | { error: string } | null {
  const row = rowOf(db, workspaceId, id);
  if (!row) return null;
  if (row.status !== "draft") return { error: "This import has already run." };
  const file = fileOf(db, id);
  if (!file) return { error: "The file for this import is no longer kept. Start again with the file." };
  const mapping = mappingOf(row, file);
  const problem = blocker(db, workspaceId, row, mapping);
  if (problem) return { error: problem };

  let stored!: StoredResult;
  db.transaction(() => {
    const newList = row.list_mode === "new";
    let listId = row.list_id!;
    if (newList) {
      listId = randomUUID();
      // Whoever makes a list looks after it until it is given to someone else.
      db.prepare("INSERT INTO lists (id, workspace_id, name, owner_id) VALUES (?, ?, ?, ?)").run(listId, workspaceId, row.new_list_name!.trim(), userId);
    }
    // Planned here, inside the transaction, so it goes by the contacts there are at this moment.
    const { plan } = planFor(db, workspaceId, { ...row, list_mode: "existing", list_id: listId }, file);
    const result = applyPlan(db, workspaceId, listId, plan, mapping);
    noteCsvImport(db, listId, row.filename);
    rememberMapping(db, workspaceId, userId, file, mapping, row.filename);
    const name = (db.prepare("SELECT name FROM lists WHERE id = ?").get(listId) as { name: string }).name;
    stored = { ...result, list: { id: listId, name }, new_list: newList, rows: file.rows.length };
    db.prepare("UPDATE csv_imports SET status = 'done', list_mode = 'existing', list_id = ?, result_json = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(listId, JSON.stringify(stored), id);
    db.prepare("DELETE FROM csv_import_files WHERE import_id = ?").run(id);
  })();

  try {
    emitDomainEvent({ workspaceId, type: "import.finished", entityType: "list", entityId: stored.list.id, payload: { import_id: id, source: "csv", imported: stored.created, updated: stored.updated, skipped: stored.skipped + stored.errors } });
    notify({
      workspaceId, kind: "import.finished", tone: "good", title: `Import into ${stored.list.name} finished`,
      body: `${contacts(stored.created)} new, ${stored.updated} updated${stored.skipped + stored.errors ? `, ${stored.skipped + stored.errors} left out` : ""}.`,
      link: `/lists/${stored.list.id}`, dedupeKey: `import-finished:${id}`,
    });
  } catch (error) {
    console.warn("[import] could not announce a finished import:", error instanceof Error ? error.message : error);
  }
  return { import: readImport(db, workspaceId, id)!, result: stored };
}

export interface ImportListing {
  id: string;
  status: "draft" | "done";
  step: ImportStep;
  filename: string;
  rows: number;
  list: { id: string; name: string } | null;
  new_list_name: string | null;
  by: string | null;
  updated_at: string;
}

/** Imports still being set up, newest first, and the ones that ran in the last week. */
export function listImports(db: DB, workspaceId: string): ImportListing[] {
  const rows = db.prepare(`SELECT i.id, i.status, i.step, i.filename, i.row_count, i.list_mode, i.list_id, i.new_list_name, i.updated_at, l.name AS list_name, COALESCE(u.name, u.email) AS by
    FROM csv_imports i LEFT JOIN lists l ON l.id = i.list_id LEFT JOIN users u ON u.id = i.created_by
    WHERE i.workspace_id = ? AND ((i.status = 'draft' AND i.updated_at >= datetime('now', ?)) OR (i.status = 'done' AND i.finished_at >= datetime('now', '-7 days')))
    ORDER BY CASE i.status WHEN 'draft' THEN 0 ELSE 1 END, i.updated_at DESC, i.rowid DESC LIMIT 50`).all(workspaceId, `-${KEEP_DRAFT_DAYS} days`) as
    Array<{ id: string; status: string; step: string; filename: string; row_count: number; list_mode: string; list_id: string | null; new_list_name: string | null; updated_at: string; list_name: string | null; by: string | null }>;
  return rows.map((row) => ({
    id: row.id, status: row.status === "done" ? "done" : "draft", step: (IMPORT_STEPS as readonly string[]).includes(row.step) ? (row.step as ImportStep) : "map", filename: row.filename, rows: row.row_count,
    list: row.list_id && row.list_name && (row.list_mode === "existing" || row.status === "done") ? { id: row.list_id, name: row.list_name } : null,
    new_list_name: row.list_mode === "new" ? row.new_list_name : null, by: row.by, updated_at: row.updated_at,
  }));
}
