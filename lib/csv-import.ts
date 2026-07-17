import Papa from "papaparse";
import type DatabaseType from "better-sqlite3";
import { randomUUID } from "crypto";

type DB = DatabaseType.Database;

// User-fillable target fields — everything else on `targets` (URNs, JSON blobs,
// enrichment timestamps, apollo/automation internals) is system-owned and not
// importable. Mirrors the PATCH /api/targets/[id] editable set.
const EDITABLE_FIELDS = [
  "first_name", "last_name", "title", "company", "location",
  "city", "country", "phone", "headline", "summary", "notes",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

// One template covers every case: a pure LinkedIn list, a pure email list (incl.
// generic inboxes like info@company.com), or an export that already has both
// (e.g. a list exported from another tool). Each row just needs linkedin_url
// and/or email filled in — whatever the contact actually has.
const TEMPLATE_COLUMNS = ["linkedin_url", "sales_nav_url", "email", ...EDITABLE_FIELDS] as const;

const SAMPLE_VALUES: Record<EditableField, string> = {
  first_name: "Jane",
  last_name: "Doe",
  title: "Head of Marketing",
  company: "Acme Inc",
  location: "Berlin, Germany",
  city: "Berlin",
  country: "Germany",
  phone: "+49 30 1234567",
  headline: "Head of Marketing @ Acme Inc",
  summary: "10+ years in B2B SaaS marketing.",
  notes: "Met at SaaStr 2026",
};

export function buildCsvTemplate(): string {
  const sample = TEMPLATE_COLUMNS.map((c) =>
    c === "linkedin_url" ? "https://www.linkedin.com/in/example-profile/" :
    c === "sales_nav_url" ? "" :
    c === "email" ? "jane@acme.com" :
    SAMPLE_VALUES[c as EditableField]
  );
  return Papa.unparse({ fields: [...TEMPLATE_COLUMNS], data: [sample] });
}

export interface CsvImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

// The full set of user-mappable standard target fields.
const STANDARD_FIELDS = ["linkedin_url", "sales_nav_url", "email", ...EDITABLE_FIELDS] as const;
export type StandardField = (typeof STANDARD_FIELDS)[number];

// Describes what each normalized CSV column becomes on import.
export type ColumnMapping =
  | { column: string; kind: "ignore" }
  | { column: string; kind: "standard"; field: StandardField }
  | { column: string; kind: "custom"; key: string; name: string; fieldType: "text" | "number" | "boolean" };

export interface CsvImportWithMappingResult extends CsvImportResult {
  customFieldsCreated: number;
}

// Same rule the platform custom-fields endpoint enforces for keys.
const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]*$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeLinkedinUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.includes("linkedin.com/in/")) return null;
  return trimmed;
}

interface ParsedRow {
  linkedin_url: string | null;
  sales_nav_url: string | null;
  email: string | null;
  full_name: string | null;
  fields: Record<EditableField, string | null>;
}

function get(row: Record<string, string>, key: string): string | null {
  const v = row[key];
  const t = typeof v === "string" ? v.trim() : "";
  return t.length > 0 ? t : null;
}

export function importCsv(db: DB, listId: string, workspaceId: string, csvText: string): CsvImportResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });

  const errors: string[] = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const rows: ParsedRow[] = [];
  parsed.data.forEach((raw, idx) => {
    const rowNum = idx + 2; // header is row 1
    const fields = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, get(raw, f)])) as Record<EditableField, string | null>;
    const full_name = [fields.first_name, fields.last_name].filter(Boolean).join(" ") || null;

    const rawUrl = get(raw, "linkedin_url");
    const linkedin_url = rawUrl ? normalizeLinkedinUrl(rawUrl) : null;
    if (rawUrl && !linkedin_url) { errors.push(`Row ${rowNum}: "${rawUrl}" is not a valid linkedin.com/in/ URL`); return; }

    const sales_nav_url = get(raw, "sales_nav_url");

    const rawEmail = get(raw, "email");
    let email: string | null = null;
    if (rawEmail) {
      if (!EMAIL_RE.test(rawEmail)) { errors.push(`Row ${rowNum}: "${rawEmail}" is not a valid email`); return; }
      email = rawEmail.toLowerCase();
    }

    if (!linkedin_url && !email) {
      errors.push(`Row ${rowNum}: needs at least a linkedin_url or an email`);
      return;
    }

    rows.push({ linkedin_url, sales_nav_url, email, full_name, fields });
  });

  const editableCols = [...EDITABLE_FIELDS, "full_name", "sales_nav_url"] as const;

  const insertByLinkedin = db.prepare(`
    INSERT INTO targets (id, workspace_id, linkedin_url, email, sales_nav_url, full_name, ${EDITABLE_FIELDS.join(", ")})
    VALUES (?, ?, ?, ?, ?, ?, ${EDITABLE_FIELDS.map(() => "?").join(", ")})
    ON CONFLICT(workspace_id, linkedin_url) WHERE linkedin_url IS NOT NULL DO UPDATE SET
      email = COALESCE(excluded.email, targets.email),
      ${editableCols.map((c) => `${c} = COALESCE(excluded.${c}, targets.${c})`).join(",\n      ")}
  `);
  const findByLinkedin = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND linkedin_url = ?");
  const findByEmail = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND email = ? LIMIT 1");
  const insertByEmail = db.prepare(`
    INSERT INTO targets (id, workspace_id, email, full_name, ${EDITABLE_FIELDS.join(", ")}, sales_nav_url)
    VALUES (?, ?, ?, ?, ${EDITABLE_FIELDS.map(() => "?").join(", ")}, ?)
  `);
  const updateByEmail = db.prepare(`
    UPDATE targets SET
      ${editableCols.map((c) => `${c} = COALESCE(?, ${c})`).join(",\n      ")}
    WHERE id = ?
  `);
  const linkToList = db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)");

  db.transaction(() => {
    for (const row of rows) {
      let targetId: string;
      let isNew: boolean;
      const fieldValues = EDITABLE_FIELDS.map((f) => row.fields[f]);

      if (row.linkedin_url) {
        const existing = findByLinkedin.get(workspaceId, row.linkedin_url) as { id: string } | undefined;
        isNew = !existing;
        targetId = existing?.id ?? randomUUID();
        insertByLinkedin.run(targetId, workspaceId, row.linkedin_url, row.email, row.sales_nav_url, row.full_name, ...fieldValues);
      } else {
        const existing = findByEmail.get(workspaceId, row.email) as { id: string } | undefined;
        isNew = !existing;
        if (existing) {
          targetId = existing.id;
          updateByEmail.run(...fieldValues, row.full_name, row.sales_nav_url, targetId);
        } else {
          targetId = randomUUID();
          insertByEmail.run(targetId, workspaceId, row.email, row.full_name, ...fieldValues, row.sales_nav_url);
        }
      }

      const linkResult = linkToList.run(listId, targetId);
      if (linkResult.changes > 0) {
        if (isNew) imported++; else updated++;
      } else {
        skipped++; // already in this list, no changes
      }
    }
  })();

  return { imported, updated, skipped, errors };
}

function parseBoolCell(raw: string): boolean {
  return /^(true|1|yes|y|t)$/i.test(raw.trim());
}

// Mapping-aware importer: standard columns populate target fields (same upsert
// + validation as importCsv), and "custom" columns are turned into
// custom_field_definitions (find-or-create by key) whose per-row cell values are
// written to contact_custom_values — usable as {{key}} merge tags in templates.
export function importCsvWithMapping(
  db: DB,
  listId: string,
  workspaceId: string,
  csvText: string,
  mapping: ColumnMapping[]
): CsvImportWithMappingResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });

  // Reverse the mapping into fast lookups.
  const standardCol: Partial<Record<StandardField, string>> = {};
  const customCols: { column: string; key: string; name: string; fieldType: "text" | "number" | "boolean" }[] = [];
  const seenKeys = new Set<string>();
  for (const m of mapping) {
    if (m.kind === "standard") {
      standardCol[m.field] = m.column;
    } else if (m.kind === "custom") {
      if (!CUSTOM_KEY_RE.test(m.key)) continue; // skip invalid keys silently
      if (seenKeys.has(m.key)) continue; // first column wins for a given key
      seenKeys.add(m.key);
      customCols.push({ column: m.column, key: m.key, name: m.name || m.key, fieldType: m.fieldType });
    }
  }

  const getStd = (raw: Record<string, string>, field: StandardField): string | null => {
    const col = standardCol[field];
    return col ? get(raw, col) : null;
  };

  const errors: string[] = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  interface MappedRow extends ParsedRow {
    custom: Record<string, string | null>;
  }

  const rows: MappedRow[] = [];
  parsed.data.forEach((raw, idx) => {
    const rowNum = idx + 2; // header is row 1
    const fields = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, getStd(raw, f)])) as Record<EditableField, string | null>;
    const full_name = [fields.first_name, fields.last_name].filter(Boolean).join(" ") || null;

    const rawUrl = getStd(raw, "linkedin_url");
    const linkedin_url = rawUrl ? normalizeLinkedinUrl(rawUrl) : null;
    if (rawUrl && !linkedin_url) { errors.push(`Row ${rowNum}: "${rawUrl}" is not a valid linkedin.com/in/ URL`); return; }

    const sales_nav_url = getStd(raw, "sales_nav_url");

    const rawEmail = getStd(raw, "email");
    let email: string | null = null;
    if (rawEmail) {
      if (!EMAIL_RE.test(rawEmail)) { errors.push(`Row ${rowNum}: "${rawEmail}" is not a valid email`); return; }
      email = rawEmail.toLowerCase();
    }

    if (!linkedin_url && !email) {
      errors.push(`Row ${rowNum}: needs at least a linkedin_url or an email`);
      return;
    }

    const custom: Record<string, string | null> = {};
    for (const c of customCols) custom[c.key] = get(raw, c.column);

    rows.push({ linkedin_url, sales_nav_url, email, full_name, fields, custom });
  });

  const editableCols = [...EDITABLE_FIELDS, "full_name", "sales_nav_url"] as const;

  const insertByLinkedin = db.prepare(`
    INSERT INTO targets (id, workspace_id, linkedin_url, email, sales_nav_url, full_name, ${EDITABLE_FIELDS.join(", ")})
    VALUES (?, ?, ?, ?, ?, ?, ${EDITABLE_FIELDS.map(() => "?").join(", ")})
    ON CONFLICT(workspace_id, linkedin_url) WHERE linkedin_url IS NOT NULL DO UPDATE SET
      email = COALESCE(excluded.email, targets.email),
      ${editableCols.map((c) => `${c} = COALESCE(excluded.${c}, targets.${c})`).join(",\n      ")}
  `);
  const findByLinkedin = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND linkedin_url = ?");
  const findByEmail = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND email = ? LIMIT 1");
  const insertByEmail = db.prepare(`
    INSERT INTO targets (id, workspace_id, email, full_name, ${EDITABLE_FIELDS.join(", ")}, sales_nav_url)
    VALUES (?, ?, ?, ?, ${EDITABLE_FIELDS.map(() => "?").join(", ")}, ?)
  `);
  const updateByEmail = db.prepare(`
    UPDATE targets SET
      ${editableCols.map((c) => `${c} = COALESCE(?, ${c})`).join(",\n      ")}
    WHERE id = ?
  `);
  const linkToList = db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)");

  const findDef = db.prepare("SELECT id, field_type FROM custom_field_definitions WHERE workspace_id = ? AND key = ?");
  const insertDef = db.prepare("INSERT INTO custom_field_definitions (id, workspace_id, name, key, field_type, options_json) VALUES (?, ?, ?, ?, ?, ?)");
  const upsertValue = db.prepare(`INSERT INTO contact_custom_values (workspace_id, target_id, field_id, value_text, value_number, value_boolean, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(target_id, field_id) DO UPDATE SET
    value_text=excluded.value_text, value_number=excluded.value_number, value_boolean=excluded.value_boolean, updated_at=datetime('now')`);

  let customFieldsCreated = 0;

  db.transaction(() => {
    // Resolve (find-or-create) a definition per custom column up front.
    const resolved: { key: string; fieldId: string; fieldType: "text" | "number" | "boolean" }[] = [];
    for (const c of customCols) {
      const existing = findDef.get(workspaceId, c.key) as { id: string; field_type: string } | undefined;
      let fieldId: string;
      let fieldType: "text" | "number" | "boolean";
      if (existing) {
        fieldId = existing.id;
        // Existing definition is authoritative for how values are stored.
        fieldType = (["text", "number", "boolean"].includes(existing.field_type) ? existing.field_type : "text") as typeof fieldType;
      } else {
        fieldId = randomUUID();
        fieldType = c.fieldType;
        insertDef.run(fieldId, workspaceId, c.name, c.key, fieldType, JSON.stringify(null));
        customFieldsCreated++;
      }
      resolved.push({ key: c.key, fieldId, fieldType });
    }

    for (const row of rows) {
      let targetId: string;
      let isNew: boolean;
      const fieldValues = EDITABLE_FIELDS.map((f) => row.fields[f]);

      if (row.linkedin_url) {
        const existing = findByLinkedin.get(workspaceId, row.linkedin_url) as { id: string } | undefined;
        isNew = !existing;
        targetId = existing?.id ?? randomUUID();
        insertByLinkedin.run(targetId, workspaceId, row.linkedin_url, row.email, row.sales_nav_url, row.full_name, ...fieldValues);
      } else {
        const existing = findByEmail.get(workspaceId, row.email) as { id: string } | undefined;
        isNew = !existing;
        if (existing) {
          targetId = existing.id;
          updateByEmail.run(...fieldValues, row.full_name, row.sales_nav_url, targetId);
        } else {
          targetId = randomUUID();
          insertByEmail.run(targetId, workspaceId, row.email, row.full_name, ...fieldValues, row.sales_nav_url);
        }
      }

      // Write custom personalization values for this contact.
      for (const r of resolved) {
        const cell = row.custom[r.key];
        if (cell === null || cell === undefined) continue; // skip empty cells
        let value_text: string | null = null;
        let value_number: number | null = null;
        let value_boolean: number | null = null;
        if (r.fieldType === "number") {
          const n = Number(cell);
          if (Number.isNaN(n)) continue; // skip non-numeric cells
          value_number = n;
        } else if (r.fieldType === "boolean") {
          value_boolean = parseBoolCell(cell) ? 1 : 0;
        } else {
          value_text = cell;
        }
        upsertValue.run(workspaceId, targetId, r.fieldId, value_text, value_number, value_boolean);
      }

      const linkResult = linkToList.run(listId, targetId);
      if (linkResult.changes > 0) {
        if (isNew) imported++; else updated++;
      } else {
        skipped++; // already in this list, no changes
      }
    }
  })();

  return { imported, updated, skipped, errors, customFieldsCreated };
}
