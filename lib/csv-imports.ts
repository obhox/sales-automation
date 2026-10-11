import Papa from "papaparse";
import { createHash, randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

// A CSV file on its way into a list: reading it, saying what each column is, working out
// what importing it would do, and doing it.
//
// The dry run and the import are the same code (`planImport`); the import then writes what
// the plan says. So the figures on the review step are the figures of the import, unless
// contacts changed in between, in which case the import goes by what is true when it runs.
//
// The older functions in lib/csv-import.ts are left as they are: POST
// /api/lists/{id}/import-csv without options still goes through them.

type DB = DatabaseType.Database;

// ── Fields a column can fill ──────────────────────────────────────────────────

export const CUSTOM_TYPES = ["text", "number", "boolean", "date"] as const;
export type CustomType = (typeof CUSTOM_TYPES)[number];

/** The contact fields a column can be mapped to, with the other things a file tends to call them. */
export const IMPORT_FIELDS = [
  { key: "first_name", label: "First name", aliases: ["firstname", "first", "given_name", "givenname", "forename", "fname"] },
  { key: "last_name", label: "Last name", aliases: ["lastname", "last", "surname", "family_name", "familyname", "lname"] },
  { key: "full_name", label: "Full name", aliases: ["name", "fullname", "contact_name", "person_name", "contact"] },
  { key: "email", label: "Email", aliases: ["email_address", "emailaddress", "e_mail", "work_email", "business_email", "contact_email", "primary_email", "mail"] },
  { key: "linkedin_url", label: "LinkedIn profile", aliases: ["linkedin", "linkedin_profile", "linkedin_profile_url", "profile_url", "person_linkedin_url", "linkedin_link", "li_url", "linkedin_url_person"] },
  { key: "sales_nav_url", label: "Sales Navigator URL", aliases: ["sales_navigator_url", "sales_navigator", "sales_nav", "salesnav_url"] },
  { key: "title", label: "Job title", aliases: ["job_title", "jobtitle", "position", "role", "job", "designation"] },
  { key: "company", label: "Company name", aliases: ["company_name", "organization", "organisation", "organization_name", "employer", "account", "account_name", "current_company"] },
  { key: "phone", label: "Phone", aliases: ["phone_number", "phone_raw", "mobile", "mobile_phone", "telephone", "tel", "work_phone", "direct_phone", "cell"] },
  { key: "city", label: "City", aliases: ["town"] },
  { key: "country", label: "Country", aliases: ["country_name", "nation"] },
  { key: "location", label: "Location", aliases: ["address", "region", "person_location"] },
  { key: "time_zone", label: "Time zone", aliases: ["timezone", "tz", "time_zone_name"] },
  { key: "headline", label: "Headline", aliases: ["linkedin_headline", "tagline"] },
  { key: "summary", label: "Summary", aliases: ["about", "bio", "description"] },
  { key: "notes", label: "Notes", aliases: ["note", "comments", "comment", "remarks"] },
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number]["key"];

const FIELD_KEYS = new Set<string>(IMPORT_FIELDS.map((field) => field.key));
const FIELD_BY_ALIAS = new Map<string, ImportField>(IMPORT_FIELDS.flatMap((field) => [[field.key, field.key], ...field.aliases.map((alias) => [alias, field.key] as [string, ImportField])]));
/** Columns written straight onto the contact. `full_name` is handled apart: it also fills the two name fields when they are empty. */
const PLAIN_FIELDS = ["first_name", "last_name", "title", "company", "location", "city", "country", "phone", "headline", "summary", "notes", "time_zone"] as const;
type PlainField = (typeof PLAIN_FIELDS)[number];

export const isImportField = (value: unknown): value is ImportField => typeof value === "string" && FIELD_KEYS.has(value);
export const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]*$/;

/** What one column of the file becomes. */
export type ImportColumn =
  | { index: number; column: string; kind: "ignore" }
  | { index: number; column: string; kind: "standard"; field: ImportField }
  | { index: number; column: string; kind: "custom"; key: string; name: string; fieldType: CustomType };

export interface MatchOptions {
  /** A row with the email address of a contact is that contact. */
  email: boolean;
  /** A row with the full name and company of a contact is that contact. */
  name_company: boolean;
}
export const DEFAULT_MATCH: MatchOptions = { email: true, name_company: false };

export const ON_DUPLICATE = ["skip", "update", "import"] as const;
export type OnDuplicate = (typeof ON_DUPLICATE)[number];

// ── Reading the file ──────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The header as the import has always read it: trimmed, lower case, spaces to underscores. */
export const normalizeHeader = (header: string) => header.trim().toLowerCase().replace(/\s+/g, "_");
/** A header reduced to letters, digits and underscores, to look it up by: "E-mail Address" → "e_mail_address". */
const headerSlug = (header: string) => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** A key campaign wording can use for a column: "Fleet size (trucks)" → "fleet_size_trucks". */
export function variableKey(column: string): string {
  const key = headerSlug(column);
  return /^[a-z]/.test(key) ? key : `var_${key || "column"}`;
}

/** "arr_band" → "Arr band": a name for a field made from a column. */
export function fieldName(column: string): string {
  const words = column.trim().replace(/[_\s]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Column";
}

export interface CsvFile {
  /** Each column's name, as the import reads it. A file with no header line has column_1, column_2 and so on. */
  columns: string[];
  rows: string[][];
  delimiter: string;
  hasHeader: boolean;
}

/** Read a file's text into columns and rows. A first line that holds a contact (an email address or a LinkedIn profile) is taken as data, not as column names. */
export function readCsv(text: string): CsvFile {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  const lines = (parsed.data as unknown[]).filter((line): line is string[] => Array.isArray(line)).map((line) => line.map((cell) => String(cell ?? "")));
  const [first = [], ...rest] = lines;
  const hasHeader = !first.some((cell) => EMAIL_RE.test(cell.trim()) || /linkedin\.com\/in\//i.test(cell));
  const width = lines.reduce((most, line) => Math.max(most, line.length), 0);
  const columns = Array.from({ length: width }, (_, index) => (hasHeader ? normalizeHeader(first[index] ?? "") : "") || `column_${index + 1}`);
  return { columns, rows: hasHeader ? rest : lines, delimiter: parsed.meta.delimiter || ",", hasHeader };
}

const cell = (row: string[], index: number): string | null => {
  const value = (row[index] ?? "").trim();
  return value.length > 0 ? value : null;
};

// ── Telling what a value is ───────────────────────────────────────────────────

/** The part of a LinkedIn profile address that names the person, lower case. Null for anything that is not a profile address. */
export function linkedinSlug(raw: string): string | null {
  const found = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(raw.trim());
  if (!found) return null;
  try { return decodeURIComponent(found[1]).toLowerCase(); } catch { return found[1].toLowerCase(); }
}
/** The address to keep: as written when it is a full address, and made into one when the file left the https:// off. */
const linkedinAddress = (raw: string, slug: string) => (/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://www.linkedin.com/in/${slug}/`);

export function parseNumber(raw: string): number | null {
  const text = raw.trim().replace(/[\s ]/g, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return Number(text.replace(/,/g, ""));
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

export function parseBoolean(raw: string): boolean | null {
  const text = raw.trim();
  if (/^(true|yes|y|t|1)$/i.test(text)) return true;
  return /^(false|no|n|f|0)$/i.test(text) ? false : null;
}

/** A day written year first (2025-08-14, 2025/08/14, with or without a time after it), as YYYY-MM-DD. Day-first and month-first dates cannot be told apart, so they are not guessed at. */
export function parseDate(raw: string): string | null {
  const found = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(raw.trim());
  if (!found) return null;
  const day = `${found[1]}-${found[2].padStart(2, "0")}-${found[3].padStart(2, "0")}`;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

const isTimeZone = (value: string) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
};

/** A phone number as people write them: digits with spaces, brackets, dots, dashes, a leading plus, an extension. */
const isPhone = (value: string) => /^[+(]?[\d\s().\-/]+(?:\s*(?:x|ext\.?)\s*\d+)?$/i.test(value) && ((value.match(/\d/g) ?? []).length >= 7) && ((value.match(/\d/g) ?? []).length <= 15);

/** What kind of field a column's values would make. Text unless every value is a number, a date or a yes/no. */
export function detectType(values: string[]): CustomType {
  const filled = values.map((value) => value.trim()).filter(Boolean).slice(0, 2000);
  if (filled.length === 0) return "text";
  if (filled.every((value) => parseDate(value) !== null)) return "date";
  // 0 and 1 alone are numbers; a yes/no column says so in words somewhere.
  if (filled.every((value) => parseBoolean(value) !== null) && filled.some((value) => !/^[01]$/.test(value))) return "boolean";
  // A leading zero means a code (a postcode, an id), which a number would lose.
  if (filled.every((value) => parseNumber(value) !== null) && !filled.some((value) => /^-?0\d/.test(value))) return "number";
  return "text";
}

// ── Mapping the columns ───────────────────────────────────────────────────────

export interface FieldDefinition { id: string; key: string; name: string; field_type: string }

export function customFields(db: DB, workspaceId: string): FieldDefinition[] {
  return db.prepare("SELECT id, key, name, field_type FROM custom_field_definitions WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(workspaceId) as FieldDefinition[];
}

const asCustomType = (value: string): CustomType => ((CUSTOM_TYPES as readonly string[]).includes(value) ? (value as CustomType) : "text");

/** What identifies a set of headers, whatever order they come in. */
export function headerSignature(columns: string[]): string {
  return createHash("sha1").update([...columns].sort().join("\n")).digest("hex");
}

interface RememberedEntry { column: string; kind: "ignore" | "standard" | "custom"; field?: string; key?: string; name?: string; fieldType?: string }

/**
 * The starting mapping for a file. A column Linki knows (by its name, or one of the other
 * things files call it) goes to that field; one named like a custom field goes to it; a
 * column with nothing in it is left out; anything else is offered as a new custom field
 * of the kind its values look like. No contact field is filled by two columns.
 */
export function suggestMapping(file: CsvFile, fields: FieldDefinition[]): ImportColumn[] {
  const taken = new Set<string>();
  const keys = new Set<string>();
  // A field named outright wins over another spelling of it.
  const exact = file.columns.map((column) => (FIELD_KEYS.has(column) ? (column as ImportField) : null));
  for (const field of exact) if (field) taken.add(field);
  const claimed = new Set<ImportField>();
  return file.columns.map((column, index) => {
    const slug = headerSlug(column);
    let field: ImportField | null = exact[index] && !claimed.has(exact[index]!) ? exact[index] : null;
    const alias = FIELD_BY_ALIAS.get(slug);
    if (!field && alias && !taken.has(alias)) { field = alias; taken.add(alias); }
    if (field) { claimed.add(field); return { index, column, kind: "standard", field }; }

    const values = file.rows.map((row) => row[index] ?? "");
    if (!values.some((value) => value.trim())) return { index, column, kind: "ignore" };
    const known = fields.find((definition) => definition.key === slug || headerSlug(definition.name) === slug);
    let key = known?.key ?? variableKey(column);
    // Two columns that would make the same key: the later one gets a number.
    for (let n = 2; keys.has(key); n++) key = `${known?.key ?? variableKey(column)}_${n}`;
    keys.add(key);
    return { index, column, kind: "custom", key, name: known?.name ?? fieldName(column), fieldType: known ? asCustomType(known.field_type) : detectType(values) };
  });
}

/** The mapping a workspace last imported a file with these headers with, laid over this file's columns. Null when there is none. */
export function rememberedMapping(db: DB, workspaceId: string, file: CsvFile): { mapping: ImportColumn[]; filename: string | null } | null {
  const row = db.prepare("SELECT mapping_json, filename FROM csv_import_mappings WHERE workspace_id = ? AND signature = ?").get(workspaceId, headerSignature(file.columns)) as { mapping_json: string; filename: string | null } | undefined;
  if (!row) return null;
  let entries: RememberedEntry[];
  try { entries = JSON.parse(row.mapping_json) as RememberedEntry[]; } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const left = [...entries];
  const mapping = file.columns.map((column, index): ImportColumn => {
    const at = left.findIndex((entry) => entry.column === column);
    const entry = at >= 0 ? left.splice(at, 1)[0] : null;
    if (entry?.kind === "standard" && isImportField(entry.field)) return { index, column, kind: "standard", field: entry.field };
    if (entry?.kind === "custom" && typeof entry.key === "string" && CUSTOM_KEY_RE.test(entry.key)) {
      return { index, column, kind: "custom", key: entry.key, name: entry.name || fieldName(column), fieldType: asCustomType(entry.fieldType ?? "text") };
    }
    return { index, column, kind: "ignore" };
  });
  return { mapping, filename: row.filename };
}

/** Why a mapping cannot be kept, or the mapping tidied. A custom column that names an existing field takes that field's type. */
export function checkMapping(input: unknown, file: { columns: string[] }, fields: FieldDefinition[]): { mapping: ImportColumn[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "mapping must be a list" };
  const byIndex = new Map<number, ImportColumn>();
  const usedFields = new Set<string>();
  const usedKeys = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { error: "each mapping entry must be an object" };
    const entry = raw as Record<string, unknown>;
    const index = Number(entry.index);
    if (!Number.isInteger(index) || index < 0 || index >= file.columns.length) return { error: "a mapping entry names a column the file does not have" };
    if (byIndex.has(index)) return { error: `column ${index + 1} is mapped twice` };
    const column = file.columns[index];
    if (entry.kind === "ignore") {
      byIndex.set(index, { index, column, kind: "ignore" });
    } else if (entry.kind === "standard") {
      if (!isImportField(entry.field)) return { error: `"${column}" is mapped to a field Linki does not have` };
      if (usedFields.has(entry.field)) return { error: `Two columns are mapped to ${IMPORT_FIELDS.find((field) => field.key === entry.field)!.label}. Map one of them to something else, or leave it out.` };
      usedFields.add(entry.field);
      byIndex.set(index, { index, column, kind: "standard", field: entry.field });
    } else if (entry.kind === "custom") {
      const key = typeof entry.key === "string" ? entry.key : "";
      if (!CUSTOM_KEY_RE.test(key)) return { error: `"${column}" needs a key of lower-case letters, digits and underscores, starting with a letter.` };
      if (usedKeys.has(key)) return { error: `Two columns use the key "${key}". Give each its own.` };
      usedKeys.add(key);
      const known = fields.find((definition) => definition.key === key);
      const fieldType = known ? asCustomType(known.field_type) : (CUSTOM_TYPES as readonly unknown[]).includes(entry.fieldType) ? (entry.fieldType as CustomType) : "text";
      const name = known?.name ?? (typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 60) : fieldName(column));
      byIndex.set(index, { index, column, kind: "custom", key, name, fieldType });
    } else {
      return { error: `"${column}" has a mapping kind Linki does not know` };
    }
  }
  return { mapping: file.columns.map((column, index) => byIndex.get(index) ?? { index, column, kind: "ignore" }) };
}

/** A file can be imported once a column says who each row is. */
export const mappingHasIdentity = (mapping: ImportColumn[]) => mapping.some((column) => column.kind === "standard" && (column.field === "linkedin_url" || column.field === "email"));

// ── Working out what an import would do ───────────────────────────────────────

export type IssueLevel = "error" | "warning" | "good";

export interface Issue {
  key: string;
  level: IssueLevel;
  /** How many rows (or values) it is about. */
  count: number;
  /** The field it is about, where it is about one. */
  field?: string;
  /** The first rows it is about, with the value that caused it. */
  rows: Array<{ row: number; value: string | null }>;
}

export interface DuplicateRow {
  row: number;
  /** Who the row is, as the file says it. */
  label: string;
  matched_by: "linkedin" | "email" | "name_company";
  /** The contact it matches, when it matches one that is already in Linki. */
  contact: { id: string; name: string } | null;
  /** The earlier row of the file it repeats, when it matches one of those instead. */
  repeats_row: number | null;
  action: "skip" | "update" | "create";
}

export interface ImportPlanSummary {
  rows: number;
  /** Rows that go in: each becomes a contact, changes one, or is folded into another row's contact. */
  ready: number;
  /** Of those, rows with something to know about. */
  with_warnings: number;
  /** Rows left out because nothing can be made of them. */
  errors: number;
  /** Contacts made, and contacts already in Linki that are changed. */
  create: number;
  update: number;
  /** Rows that add to a contact another row of the file already made or changed. */
  merged: number;
  /** Rows left out because they are duplicates and duplicates are skipped. */
  skipped: number;
  /** Contacts the list gains, and contacts of this file it already holds. */
  joins: number;
  already_in_list: number;
  list_before: number;
  list_after: number;
  duplicates: {
    /** Rows that match a contact already in Linki, and rows that repeat an earlier row of the file. */
    existing: number;
    in_file: number;
    /** Rows matched by each detail. Null: that detail is not being matched on. */
    by: { linkedin: number; email: number | null; name_company: number | null };
    /** Duplicates by a LinkedIn profile that "import anyway" updates instead, because two contacts cannot share a profile. */
    forced_update: number;
  };
  new_fields: Array<{ key: string; name: string; type: CustomType }>;
}

interface PlannedRow {
  row: number;
  action: "create" | "update" | "skip" | "error";
  /** The contact to update, or the index in `rows` of the earlier row whose contact it is. */
  target: { id: string } | { planned: number } | null;
  linkedin_url: string | null;
  sales_nav_url: string | null;
  email: string | null;
  full_name: string | null;
  fields: Partial<Record<PlainField, string>>;
  custom: Array<{ key: string; text: string | null; number: number | null; boolean: number | null }>;
  joins: boolean;
  error: string | null;
}

export interface ImportPlan {
  summary: ImportPlanSummary;
  issues: Issue[];
  duplicates: DuplicateRow[];
  rows: PlannedRow[];
}

export interface PlanInput {
  file: CsvFile;
  mapping: ImportColumn[];
  /** The list the rows go into. Null: a list that does not exist yet. */
  listId: string | null;
  match: MatchOptions;
  onDuplicate: OnDuplicate;
}

const ISSUE_ROWS = 200;
const DUPLICATE_ROWS = 300;
const squash = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

const ROW_ERRORS: Record<string, string> = {
  no_identity: "needs a LinkedIn profile or an email address",
  bad_email: "the email address is not a valid one, and the row has no LinkedIn profile",
  bad_linkedin: "the LinkedIn address is not a profile (linkedin.com/in/…), and the row has no email address",
};

/**
 * Go through the file as the import would, changing nothing: which rows become a contact,
 * which change one, which are duplicates and what happens to them, and what is wrong or
 * worth knowing about the rest.
 */
export function planImport(db: DB, workspaceId: string, input: PlanInput): ImportPlan {
  const { file, mapping, match, onDuplicate } = input;
  const standard = new Map<ImportField, number>();
  const custom: Array<{ index: number; key: string; name: string; type: CustomType }> = [];
  const definitions = customFields(db, workspaceId);
  for (const column of mapping) {
    if (column.kind === "standard") standard.set(column.field, column.index);
    else if (column.kind === "custom") custom.push({ index: column.index, key: column.key, name: column.name, type: asCustomType(definitions.find((definition) => definition.key === column.key)?.field_type ?? column.fieldType) });
  }
  const value = (row: string[], field: ImportField) => (standard.has(field) ? cell(row, standard.get(field)!) : null);

  // Everyone the workspace already has, by each detail a row can be matched on.
  const bySlug = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string>();
  const names = new Map<string, string>();
  const contacts = db.prepare("SELECT id, linkedin_url, email, full_name, first_name, last_name, company FROM targets WHERE workspace_id = ?").all(workspaceId) as
    Array<{ id: string; linkedin_url: string | null; email: string | null; full_name: string | null; first_name: string | null; last_name: string | null; company: string | null }>;
  for (const contact of contacts) {
    const slug = contact.linkedin_url ? linkedinSlug(contact.linkedin_url) : null;
    if (slug && !bySlug.has(slug)) bySlug.set(slug, contact.id);
    if (contact.email && !byEmail.has(contact.email.toLowerCase())) byEmail.set(contact.email.toLowerCase(), contact.id);
    const name = contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(" ");
    if (match.name_company && name && contact.company && !byName.has(`${squash(name)}|${squash(contact.company)}`)) byName.set(`${squash(name)}|${squash(contact.company)}`, contact.id);
    names.set(contact.id, name || contact.email || "A contact");
  }
  const members = new Set<string>(input.listId ? (db.prepare("SELECT target_id FROM list_targets WHERE list_id = ?").all(input.listId) as { target_id: string }[]).map((row) => row.target_id) : []);

  const issues = new Map<string, Issue>();
  const note = (key: string, level: IssueLevel, row: number, shown: string | null, field?: string) => {
    const issue = issues.get(key) ?? { key, level, count: 0, field, rows: [] };
    issue.count += 1;
    if (issue.rows.length < ISSUE_ROWS) issue.rows.push({ row, value: shown });
    issues.set(key, issue);
  };

  // Rows of this file that have been kept so far, by the same details.
  type Ref = { id: string } | { planned: number };
  const seenSlug = new Map<string, Ref>();
  const seenEmail = new Map<string, Ref>();
  const seenName = new Map<string, Ref>();
  const joined = new Set<string>();

  const rows: PlannedRow[] = [];
  const duplicates: DuplicateRow[] = [];
  const summary: ImportPlanSummary = {
    rows: file.rows.length, ready: 0, with_warnings: 0, errors: 0, create: 0, update: 0, merged: 0, skipped: 0, joins: 0, already_in_list: 0, list_before: members.size, list_after: members.size,
    duplicates: { existing: 0, in_file: 0, by: { linkedin: 0, email: match.email ? 0 : null, name_company: match.name_company ? 0 : null }, forced_update: 0 },
    new_fields: custom.filter((column) => !definitions.some((definition) => definition.key === column.key)).map((column) => ({ key: column.key, name: column.name, type: column.type })),
  };

  file.rows.forEach((raw, at) => {
    const line = at + (file.hasHeader ? 2 : 1);
    const planned: PlannedRow = { row: line, action: "create", target: null, linkedin_url: null, sales_nav_url: value(raw, "sales_nav_url"), email: null, full_name: null, fields: {}, custom: [], joins: false, error: null };
    let warned = false;
    const warn = (key: string, shown: string | null, field?: string) => { warned = true; note(key, "warning", line, shown, field); };

    const rawUrl = value(raw, "linkedin_url");
    const slug = rawUrl ? linkedinSlug(rawUrl) : null;
    const rawEmail = value(raw, "email");
    const email = rawEmail && EMAIL_RE.test(rawEmail) ? rawEmail.toLowerCase() : null;

    // A row is only left out when nothing in it says who it is.
    const reason = !slug && !email ? (rawEmail ? "bad_email" : rawUrl ? "bad_linkedin" : "no_identity") : null;
    if (reason) {
      planned.action = "error";
      planned.error = ROW_ERRORS[reason];
      note(reason === "no_identity" ? "no_identity" : `${reason}_only`, "error", line, reason === "bad_email" ? rawEmail : reason === "bad_linkedin" ? rawUrl : null);
      summary.errors += 1;
      rows.push(planned);
      return;
    }
    if (rawEmail && !email) warn("bad_email", rawEmail);
    if (rawUrl && !slug) warn("bad_linkedin", rawUrl);
    if (standard.has("email") && !rawEmail) warn("no_email", null);
    if (standard.has("linkedin_url") && !rawUrl) warn("no_linkedin", null);
    planned.linkedin_url = slug ? linkedinAddress(rawUrl!, slug) : null;
    planned.email = email;

    for (const field of PLAIN_FIELDS) {
      const text = value(raw, field);
      if (text) planned.fields[field] = text;
    }
    const given = value(raw, "full_name");
    if (given && !planned.fields.first_name && !planned.fields.last_name) {
      const [first, ...rest] = given.split(/\s+/);
      planned.fields.first_name = first;
      if (rest.length) planned.fields.last_name = rest.join(" ");
    }
    planned.full_name = [planned.fields.first_name, planned.fields.last_name].filter(Boolean).join(" ") || given || null;
    if ((standard.has("first_name") || standard.has("full_name")) && !planned.fields.first_name) warn("no_first_name", null);
    if (standard.has("company") && !planned.fields.company) warn("no_company", null);
    if (planned.fields.phone && !isPhone(planned.fields.phone)) warn("bad_phone", planned.fields.phone);
    if (planned.fields.time_zone && !isTimeZone(planned.fields.time_zone)) {
      warn("bad_time_zone", planned.fields.time_zone);
      delete planned.fields.time_zone;
    }

    for (const column of custom) {
      const text = cell(raw, column.index);
      if (text === null) continue;
      const number = column.type === "number" ? parseNumber(text) : null;
      const boolean = column.type === "boolean" ? parseBoolean(text) : null;
      const date = column.type === "date" ? parseDate(text) : null;
      if ((column.type === "number" && number === null) || (column.type === "boolean" && boolean === null) || (column.type === "date" && date === null)) {
        warn(`bad_value:${column.key}`, text, column.name);
        continue;
      }
      planned.custom.push({ key: column.key, text: column.type === "text" ? text : column.type === "date" ? date : null, number, boolean: boolean === null ? null : boolean ? 1 : 0 });
    }

    // Who is this row already? A contact in Linki first, then an earlier row of the file.
    const nameKey = match.name_company && planned.full_name && planned.fields.company ? `${squash(planned.full_name)}|${squash(planned.fields.company)}` : null;
    let by: DuplicateRow["matched_by"] | null = null;
    let found: Ref | null = null;
    const look = (how: DuplicateRow["matched_by"], ref: Ref | undefined) => { if (!found && ref) { found = ref; by = how; } };
    look("linkedin", slug ? (bySlug.has(slug) ? { id: bySlug.get(slug)! } : undefined) : undefined);
    look("email", match.email && email ? (byEmail.has(email) ? { id: byEmail.get(email)! } : undefined) : undefined);
    look("name_company", nameKey ? (byName.has(nameKey) ? { id: byName.get(nameKey)! } : undefined) : undefined);
    const existing = found !== null;
    look("linkedin", slug ? seenSlug.get(slug) : undefined);
    look("email", match.email && email ? seenEmail.get(email) : undefined);
    look("name_company", nameKey ? seenName.get(nameKey) : undefined);
    const ref = found as Ref | null;
    const how = by as DuplicateRow["matched_by"] | null;

    if (ref && how) {
      // A row that repeats an earlier row which matched a contact is a duplicate of that contact too.
      const inLinki = existing || "id" in ref;
      if (inLinki) summary.duplicates.existing += 1; else summary.duplicates.in_file += 1;
      if (existing) summary.duplicates.by[how] = (summary.duplicates.by[how] ?? 0) + 1;
      // Two contacts cannot have the same LinkedIn profile, so "import anyway" can only update there.
      const forced = onDuplicate === "import" && how === "linkedin";
      if (forced) summary.duplicates.forced_update += 1;
      planned.action = onDuplicate === "skip" ? "skip" : onDuplicate === "update" || forced ? "update" : "create";
      if (planned.action === "update") planned.target = ref;
      if (duplicates.length < DUPLICATE_ROWS) {
        duplicates.push({
          row: line, label: planned.full_name || email || rawUrl || `Row ${line}`, matched_by: how,
          contact: "id" in ref ? { id: ref.id, name: names.get(ref.id) ?? "A contact" } : null,
          repeats_row: "planned" in ref ? rows[ref.planned].row : null,
          action: planned.action === "skip" ? "skip" : planned.action === "update" ? "update" : "create",
        });
      }
    }

    // What later rows are compared with: the contact this row is, or this row itself. A row
    // that is left out still says who it was, so a later row for the same person is known.
    const self: Ref = planned.action === "create" ? { planned: rows.length } : ref!;
    if (slug && !seenSlug.has(slug)) seenSlug.set(slug, self);
    if (email && !seenEmail.has(email)) seenEmail.set(email, self);
    if (nameKey && !seenName.has(nameKey)) seenName.set(nameKey, self);

    if (planned.action === "skip") {
      summary.skipped += 1;
      rows.push(planned);
      return;
    }

    const who = "id" in self ? self.id : `row:${self.planned}`;
    const first = !joined.has(who);
    if ("id" in self && members.has(self.id)) summary.already_in_list += first ? 1 : 0;
    else if (first) { planned.joins = true; summary.joins += 1; }
    joined.add(who);

    if (planned.action === "create") summary.create += 1;
    else if ("id" in self && first) summary.update += 1;
    else summary.merged += 1;
    summary.ready += 1;
    if (warned) summary.with_warnings += 1;
    rows.push(planned);
  });

  summary.list_after = summary.list_before + summary.joins;
  if (standard.has("linkedin_url") && summary.rows > 0 && !issues.has("bad_linkedin") && !issues.has("bad_linkedin_only")) {
    const withProfile = rows.filter((row) => row.linkedin_url).length;
    if (withProfile > 0) issues.set("linkedin_ok", { key: "linkedin_ok", level: "good", count: withProfile, rows: [] });
  }
  const order: Record<IssueLevel, number> = { error: 0, warning: 1, good: 2 };
  return { summary, issues: [...issues.values()].sort((a, b) => order[a.level] - order[b.level] || b.count - a.count), duplicates, rows };
}

// ── Doing it ──────────────────────────────────────────────────────────────────

export interface ImportResult {
  created: number;
  updated: number;
  /** Rows folded into a contact another row of the file made or changed. */
  merged: number;
  /** Rows left out as duplicates, and rows left out because nothing could be made of them. */
  skipped: number;
  errors: number;
  /** The rows left out, with why (the first few hundred). */
  error_rows: Array<{ row: number; reason: string }>;
  joined: number;
  already_in_list: number;
  custom_fields_created: number;
}

const ERROR_ROWS = 300;

/** Write what a plan says into a list. One transaction: it all happens or none of it does. */
export function applyPlan(db: DB, workspaceId: string, listId: string, plan: ImportPlan, mapping: ImportColumn[]): ImportResult {
  const insert = db.prepare(`INSERT INTO targets (id, workspace_id, linkedin_url, email, sales_nav_url, full_name, ${PLAIN_FIELDS.join(", ")})
    VALUES (?, ?, ?, ?, ?, ?, ${PLAIN_FIELDS.map(() => "?").join(", ")})`);
  // A cell with something in it replaces what the contact has; an empty one leaves it alone.
  const update = db.prepare(`UPDATE targets SET linkedin_url = COALESCE(linkedin_url, ?), email = COALESCE(?, email), sales_nav_url = COALESCE(?, sales_nav_url), full_name = COALESCE(?, full_name),
    ${PLAIN_FIELDS.map((field) => `${field} = COALESCE(?, ${field})`).join(", ")} WHERE id = ? AND workspace_id = ?`);
  const link = db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)");
  const holder = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND linkedin_url = ?");
  const findDefinition = db.prepare("SELECT id FROM custom_field_definitions WHERE workspace_id = ? AND key = ?");
  const insertDefinition = db.prepare("INSERT INTO custom_field_definitions (id, workspace_id, name, key, field_type, options_json) VALUES (?, ?, ?, ?, ?, ?)");
  const setValue = db.prepare(`INSERT INTO contact_custom_values (workspace_id, target_id, field_id, value_text, value_number, value_boolean, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(target_id, field_id) DO UPDATE SET
    value_text = excluded.value_text, value_number = excluded.value_number, value_boolean = excluded.value_boolean, updated_at = datetime('now')`);

  const result: ImportResult = { created: 0, updated: 0, merged: 0, skipped: 0, errors: 0, error_rows: [], joined: 0, already_in_list: 0, custom_fields_created: 0 };
  db.transaction(() => {
    const fieldIds = new Map<string, string>();
    for (const column of mapping) {
      if (column.kind !== "custom") continue;
      const existing = findDefinition.get(workspaceId, column.key) as { id: string } | undefined;
      if (existing) { fieldIds.set(column.key, existing.id); continue; }
      const id = randomUUID();
      insertDefinition.run(id, workspaceId, column.name, column.key, column.fieldType, JSON.stringify(null));
      fieldIds.set(column.key, id);
      result.custom_fields_created += 1;
    }

    const made: Array<string | null> = [];
    const counted = new Set<string>();
    for (const row of plan.rows) {
      if (row.action === "error") {
        result.errors += 1;
        if (result.error_rows.length < ERROR_ROWS) result.error_rows.push({ row: row.row, reason: row.error ?? "could not be read" });
        made.push(null);
        continue;
      }
      if (row.action === "skip") { result.skipped += 1; made.push(null); continue; }
      const fields = PLAIN_FIELDS.map((field) => row.fields[field] ?? null);
      let id: string;
      if (row.action === "update" && row.target) {
        const known = "id" in row.target ? row.target.id : made[row.target.planned];
        if (!known) throw new Error(`Row ${row.row} adds to a row that made no contact`);
        id = known;
        // A profile address another contact already has stays with that contact.
        const taken = row.linkedin_url ? (holder.get(workspaceId, row.linkedin_url) as { id: string } | undefined) : undefined;
        update.run(taken && taken.id !== id ? null : row.linkedin_url, row.email, row.sales_nav_url, row.full_name, ...fields, id, workspaceId);
        // A second row for the same contact adds to it; it is not another contact changed.
        if ("id" in row.target && !counted.has(id)) result.updated += 1; else result.merged += 1;
      } else {
        id = randomUUID();
        insert.run(id, workspaceId, row.linkedin_url, row.email, row.sales_nav_url, row.full_name, ...fields);
        result.created += 1;
      }
      counted.add(id);
      made.push(id);
      for (const value of row.custom) setValue.run(workspaceId, id, fieldIds.get(value.key), value.text, value.number, value.boolean);
      if (link.run(listId, id).changes > 0) result.joined += 1;
    }
    result.already_in_list = counted.size - result.joined;
  })();
  return result;
}
