// What the CSV import page knows, and how it words it. No React in here, so the wording
// can be tested.
import type { ImportColumn, ImportPlanSummary, Issue, DuplicateRow, OnDuplicate, CustomType, MatchOptions } from "@/lib/csv-imports";
import type { AfterImport, ImportCheck, ImportColumnView, ImportListing, ImportStep, ImportView, StoredResult } from "@/lib/csv-import-store";
import { formatCount, formatRelative, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";

export type { AfterImport, CustomType, DuplicateRow, ImportCheck, ImportColumn, ImportColumnView, ImportListing, ImportPlanSummary, ImportStep, ImportView, Issue, MatchOptions, OnDuplicate, StoredResult };

export const IMPORTS_PATH = "/api/csv-imports";
export const TEMPLATE_PATH = "/api/csv-imports/template";
export const importPath = (id: string) => `${IMPORTS_PATH}/${id}`;
/** The page of one import. */
export const importHref = (id: string) => `/lists/import/${id}`;
/** The page a new import starts on, with the list it is for when it is for one. */
export const newImportHref = (listId?: string | null) => (listId ? `/lists/import/new?list=${encodeURIComponent(listId)}` : "/lists/import/new");

const contacts = (count: number) => `${formatCount(count)} ${plural(count, "contact", "contacts")}`;
const rows = (count: number) => `${formatCount(count)} ${plural(count, "row", "rows")}`;

// ── Steps ─────────────────────────────────────────────────────────────────────

export type PageStep = "upload" | ImportStep;
export const STEPS: Array<{ key: PageStep; label: string }> = [
  { key: "upload", label: "Upload file" }, { key: "map", label: "Map columns" }, { key: "duplicates", label: "Duplicates" }, { key: "review", label: "Review & import" },
];
export const stepIndex = (step: PageStep) => STEPS.findIndex((item) => item.key === step);
/** "Step 2 of 4 · Map columns" */
export const stepMeta = (step: PageStep) => `Step ${stepIndex(step) + 1} of ${STEPS.length} · ${STEPS[stepIndex(step)].label}`;
export const nextStep = (step: ImportStep): ImportStep | null => (step === "map" ? "duplicates" : step === "duplicates" ? "review" : null);
export const previousStep = (step: ImportStep): ImportStep | null => (step === "review" ? "duplicates" : step === "duplicates" ? "map" : null);

/** What each step says under its name. */
export function stepSubs(view: ImportView | null, check: ImportCheck | null): Record<PageStep, string> {
  if (!view) return { upload: "A CSV file", map: "What each column is", duplicates: "Contacts you already have", review: "Check, then import" };
  if (view.status === "done" && view.result) {
    const { result } = view;
    return {
      upload: view.file.name, map: `${view.file.columns} ${plural(view.file.columns, "column", "columns")}`,
      duplicates: result.skipped ? `${formatCount(result.skipped)} left out` : `${formatCount(result.updated)} updated`, review: `${rows(result.rows - result.skipped - result.errors)} imported`,
    };
  }
  const mapped = view.columns.filter((column) => column.mapping.kind !== "ignore").length;
  const matches = check ? check.duplicate_rows : null;
  return {
    upload: view.file.name,
    map: `${mapped} of ${view.columns.length} columns mapped`,
    duplicates: matches === null ? "Checking" : matches === 0 ? "No duplicates" : `${formatCount(matches)} ${plural(matches, "match", "matches")}`,
    review: check ? `${rows(check.summary.ready)} ready` : "Checking",
  };
}

/** The primary button of each step. */
export function continueLabel(step: ImportStep, check: ImportCheck | null): string {
  if (step === "map") return "Continue to duplicates";
  if (step === "duplicates") return "Continue to review";
  return check ? `Import ${rows(check.summary.ready)}` : "Import";
}

// ── The file ──────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DELIMITERS: Record<string, string> = { ",": "Comma-delimited", ";": "Semicolon-delimited", "\t": "Tab-delimited", "|": "Pipe-delimited" };
export const delimiterLabel = (delimiter: string) => DELIMITERS[delimiter] ?? "Delimited";
export const encodingLabel = (encoding: string | null) => (encoding === "windows-1252" ? "Windows-1252" : encoding ? encoding.toUpperCase() : null);

/** "2,454 rows · 14 columns · 1.8 MB · uploaded by Dan Okafor 2 min ago" */
export function fileFacts(view: ImportView, now: Date = new Date()): string {
  const when = formatRelative(view.created_at, now);
  return `${rows(view.file.rows)} · ${view.file.columns} ${plural(view.file.columns, "column", "columns")} · ${formatBytes(view.file.size_bytes)} · uploaded${view.created_by ? ` by ${view.created_by.name}` : ""} ${when}`;
}

/** Which of a file's bytes it is read as. A file that is not valid UTF-8 was most likely saved by Excel on Windows. */
export function decodeFile(bytes: ArrayBuffer): { text: string; encoding: "utf-8" | "windows-1252" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

/** A, B … Z, AA, AB: the letter a spreadsheet gives a column. */
export function columnLetter(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

// ── Mapping ───────────────────────────────────────────────────────────────────

export const FIELD_LABEL: Record<string, string> = {
  first_name: "First name", last_name: "Last name", full_name: "Full name", email: "Email", linkedin_url: "LinkedIn profile", sales_nav_url: "Sales Navigator URL",
  title: "Job title", company: "Company name", phone: "Phone", city: "City", country: "Country", location: "Location", time_zone: "Time zone",
  headline: "Headline", summary: "Summary", notes: "Notes",
};
export const FIELD_ORDER = Object.keys(FIELD_LABEL);
export const TYPE_LABEL: Record<CustomType, string> = { text: "text", number: "number", boolean: "yes / no", date: "date" };
export const TYPE_OPTIONS: Array<{ value: CustomType; label: string }> = [{ value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "boolean", label: "Yes / no" }, { value: "date", label: "Date" }];

export const IGNORE = "ignore";
export const NEW_FIELD = "new";
/** The value the field picker holds for a mapping: `ignore`, `std:email`, `custom:tier`, or `new` for a field this column would make. */
export function choiceOf(column: ImportColumnView, fields: ImportView["options"]["fields"]): string {
  const { mapping } = column;
  if (mapping.kind === "standard") return `std:${mapping.field}`;
  if (mapping.kind === "custom") return fields.some((field) => field.key === mapping.key) ? `custom:${mapping.key}` : NEW_FIELD;
  return IGNORE;
}

const slug = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
export const keyFor = (column: string) => (/^[a-z]/.test(slug(column)) ? slug(column) : `var_${slug(column) || "column"}`);
export const nameFor = (column: string) => {
  const words = column.trim().replace(/[_\s]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Column";
};

/** What to send for one column when a choice is made in its picker. A field given to this column is taken from the column that had it. */
export function withChoice(view: ImportView, index: number, choice: string): ImportColumn[] {
  const taken = new Set(view.columns.filter((column) => column.index !== index && column.mapping.kind === "custom").map((column) => (column.mapping as { key: string }).key));
  return view.columns.map((column): ImportColumn => {
    const base = { index: column.index, column: column.column };
    if (column.index !== index) {
      const { mapping } = column;
      const clash = (choice.startsWith("std:") && mapping.kind === "standard" && `std:${mapping.field}` === choice) || (choice.startsWith("custom:") && mapping.kind === "custom" && `custom:${mapping.key}` === choice);
      return clash ? { ...base, kind: "ignore" } : mapping;
    }
    if (choice.startsWith("std:")) return { ...base, kind: "standard", field: choice.slice(4) as never };
    if (choice.startsWith("custom:")) {
      const field = view.options.fields.find((candidate) => candidate.key === choice.slice(7));
      return { ...base, kind: "custom", key: choice.slice(7), name: field?.name ?? nameFor(column.column), fieldType: (field?.field_type as CustomType) ?? "text" };
    }
    if (choice === NEW_FIELD) {
      let key = keyFor(column.column);
      for (let n = 2; taken.has(key) || view.options.fields.some((field) => field.key === key); n++) key = `${keyFor(column.column)}_${n}`;
      return { ...base, kind: "custom", key, name: nameFor(column.column), fieldType: column.detected };
    }
    return { ...base, kind: "ignore" };
  });
}

/** The same mapping with one new field's kind changed. */
export const withType = (view: ImportView, index: number, fieldType: CustomType): ImportColumn[] =>
  view.columns.map((column) => (column.index === index && column.mapping.kind === "custom" ? { ...column.mapping, fieldType } : column.mapping));
export const cleared = (view: ImportView): ImportColumn[] => view.columns.map((column) => ({ index: column.index, column: column.column, kind: "ignore" }));

export interface ColumnStatus { tone: Tone; label: string; note: string | null }

/** The badge at the end of a mapping row, and the line under it. */
export function columnStatus(column: ImportColumnView, view: ImportView): ColumnStatus {
  const { mapping } = column;
  if (mapping.kind === "standard") {
    const note = mapping.field === "linkedin_url" ? "finds duplicates" : mapping.field === "email" ? (view.match.email ? "finds duplicates" : null) : null;
    return { tone: "good", label: "Matched", note };
  }
  if (mapping.kind === "custom") {
    const known = view.options.fields.some((field) => field.key === mapping.key);
    return known ? { tone: "good", label: "Custom field", note: `${TYPE_LABEL[mapping.fieldType]} · {{${mapping.key}}}` } : { tone: "brand", label: "New field", note: `custom · ${TYPE_LABEL[mapping.fieldType]}` };
  }
  return column.filled === 0 ? { tone: "neutral", label: "Unmapped", note: "column is empty" } : { tone: "neutral", label: "Skipped", note: null };
}

export const mappedCount = (view: ImportView) => view.columns.filter((column) => column.mapping.kind !== "ignore").length;
export const newFields = (view: ImportView) => view.columns.filter((column) => column.mapping.kind === "custom" && !view.options.fields.some((field) => field.key === (column.mapping as { key: string }).key));

/** "12 of 14 columns mapped · 2 new custom fields will be created" */
export function mappingSummary(view: ImportView): string {
  const made = newFields(view).length;
  return `${mappedCount(view)} of ${view.columns.length} columns mapped${made ? ` · ${made} new custom ${plural(made, "field", "fields")} will be created` : ""}`;
}

/** "2 columns will be left out · Mapped the way acme_q4.csv was" */
export function mappingFooter(view: ImportView): string {
  const left = view.columns.length - mappedCount(view);
  const first = left === 0 ? "Every column is imported" : `${left} ${plural(left, "column", "columns")} will be left out`;
  return `${first} · ${view.remembered_from ? `Mapped the way ${view.remembered_from} was` : "Linki remembers this mapping for the next file with the same columns"}`;
}

/** Why the mapping cannot be imported with, or null when it can. */
export function mappingProblem(view: ImportView): string | null {
  const identified = view.columns.some((column) => column.mapping.kind === "standard" && (column.mapping.field === "email" || column.mapping.field === "linkedin_url"));
  return identified ? null : "Map one column to LinkedIn profile or Email, so each row can be told apart.";
}

/** The import as it will be once a change is kept, to show before the server has answered. */
export function withChange(view: ImportView, change: Record<string, unknown>): ImportView {
  const next: ImportView = { ...view };
  if (Array.isArray(change.mapping)) {
    const mapping = change.mapping as ImportColumn[];
    next.columns = view.columns.map((column) => ({ ...column, mapping: mapping.find((entry) => entry.index === column.index) ?? column.mapping }));
  }
  if (change.list_mode === "existing" || change.list_mode === "new") next.list_mode = change.list_mode;
  if (typeof change.list_id === "string" || change.list_id === null) next.list_id = change.list_id;
  if (typeof change.new_list_name === "string") next.new_list_name = change.new_list_name;
  if (change.on_duplicate !== undefined) next.on_duplicate = change.on_duplicate as OnDuplicate;
  if (change.step !== undefined) next.step = change.step as ImportStep;
  if (change.after !== undefined) next.after = change.after as AfterImport;
  if (change.match !== undefined) next.match = { ...view.match, ...(change.match as Partial<MatchOptions>) };
  return next;
}

// ── Where it goes ─────────────────────────────────────────────────────────────

/** "1,204 contacts today → 3,622 after import" */
export function listLine(view: ImportView, check: ImportCheck | null): string {
  if (view.list_mode === "new") return check ? `A new list with ${contacts(check.summary.joins)}` : "A new list";
  const list = view.options.lists.find((candidate) => candidate.id === view.list_id);
  if (!list) return "Choose the list these contacts go into";
  return check ? `${contacts(check.summary.list_before)} today → ${formatCount(check.summary.list_after)} after import` : `${contacts(list.contacts)} today`;
}

export const AFTER_NONE = "none";
export const AFTER_NEW = "new";
/** The picker's value for what happens after: `none`, `new`, or a draft campaign's id. */
export const afterChoice = (after: AfterImport) => (after.mode === "existing" && after.campaign_id ? after.campaign_id : after.mode === "new" ? AFTER_NEW : AFTER_NONE);
export const afterFrom = (choice: string): AfterImport => (choice === AFTER_NONE ? { mode: "none", campaign_id: null } : choice === AFTER_NEW ? { mode: "new", campaign_id: null } : { mode: "existing", campaign_id: choice });
export function afterOptions(view: ImportView): Array<{ value: string; label: string; hint?: string }> {
  return [
    { value: AFTER_NEW, label: "A new campaign", hint: "Opens the campaign setup with this list chosen" },
    ...view.options.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name, hint: `Not started · ${campaign.steps} ${plural(campaign.steps, "step", "steps")}` })),
  ];
}

// ── Duplicates ────────────────────────────────────────────────────────────────

export const ON_DUPLICATE_OPTIONS: Array<{ value: OnDuplicate; label: string }> = [{ value: "skip", label: "Skip row" }, { value: "update", label: "Update" }, { value: "import", label: "Import anyway" }];
export const ON_DUPLICATE_HINT: Record<OnDuplicate, string> = {
  skip: "The contact stays as it is and is not added to this list.",
  update: "Cells with something in them replace what the contact has, and the contact joins this list. Its campaign history is kept.",
  import: "A second contact is made beside the first.",
};

/** "96 matches", "not checked", or a dash while it is being worked out. */
export function matchCount(count: number | null | undefined, on: boolean): { text: string; tone: "warn" | "muted" } {
  if (!on) return { text: "not checked", tone: "muted" };
  if (count === null || count === undefined) return { text: "—", tone: "muted" };
  return count === 0 ? { text: "no matches", tone: "muted" } : { text: `${formatCount(count)} ${plural(count, "match", "matches")}`, tone: "warn" };
}

/** The note under the duplicate choice: how many there are, where, and what happens to them. */
export function duplicateNote(summary: ImportPlanSummary, onDuplicate: OnDuplicate): string | null {
  const { existing, in_file: inFile, forced_update: forced } = summary.duplicates;
  const total = existing + inFile;
  if (total === 0) return null;
  const where = [existing ? `${formatCount(existing)} already in Linki` : null, inFile ? `${formatCount(inFile)} repeated inside this file` : null].filter(Boolean).join(", ");
  const what = onDuplicate === "skip" ? `${total === 1 ? "It is" : "They are"} left out.`
    : onDuplicate === "update" ? "Existing contacts are updated and keep their campaign history; a repeated row adds to the row above it."
      : forced ? `${total - forced === 0 ? "None" : formatCount(total - forced)} ${total - forced === 1 ? "becomes" : "become"} a second contact. ${formatCount(forced)} with a LinkedIn profile a contact already has ${forced === 1 ? "updates" : "update"} that contact instead: two contacts cannot share a profile.`
        : `${total === 1 ? "It becomes" : "Each becomes"} a second contact.`;
  return `${formatCount(total)} ${plural(total, "duplicate", "duplicates")}: ${where}. ${what}`;
}

export const MATCHED_BY: Record<DuplicateRow["matched_by"], string> = { linkedin: "LinkedIn profile", email: "Email", name_company: "Name and company" };
/** What happens to one duplicate row, in two words. */
export function duplicateAction(row: DuplicateRow): { label: string; tone: Tone } {
  if (row.action === "skip") return { label: "Left out", tone: "neutral" };
  if (row.action === "create") return { label: "Second contact", tone: "warn" };
  return row.contact ? { label: "Updates it", tone: "good" } : { label: "Adds to that row", tone: "good" };
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface IssueText { title: string; detail: string }

/** One line of the validation list, in words. */
export function issueText(issue: Issue): IssueText {
  const n = issue.count;
  const many = n !== 1;
  switch (issue.key) {
    case "no_identity": return { title: `${rows(n)} with neither a LinkedIn profile nor an email address`, detail: `Nothing says who ${many ? "they are" : "it is"}, so ${many ? "these rows are" : "this row is"} left out.` };
    case "bad_email_only": return { title: `${rows(n)} with an email address that is not one`, detail: `There is no LinkedIn profile to go by either, so ${many ? "these rows are" : "this row is"} left out.` };
    case "bad_linkedin_only": return { title: `${rows(n)} with a LinkedIn address that is not a profile`, detail: `There is no email address to go by either, so ${many ? "these rows are" : "this row is"} left out.` };
    case "bad_email": return { title: `${formatCount(n)} email ${plural(n, "address", "addresses")} that ${many ? "are" : "is"} not valid`, detail: `Left out. The ${many ? "rows are" : "row is"} imported with ${many ? "their" : "its"} LinkedIn profile.` };
    case "bad_linkedin": return { title: `${formatCount(n)} LinkedIn ${plural(n, "address", "addresses")} that ${many ? "are" : "is"} not a profile`, detail: `Left out. The ${many ? "rows are" : "row is"} imported with ${many ? "their" : "its"} email address.` };
    case "no_email": return { title: `${rows(n)} missing an email address`, detail: `Imported. Email steps skip ${many ? "them" : "it"} until an address is found.` };
    case "no_linkedin": return { title: `${rows(n)} missing a LinkedIn profile`, detail: `Imported. LinkedIn steps skip ${many ? "them" : "it"}.` };
    case "no_first_name": return { title: `${rows(n)} missing a first name`, detail: "{{first_name}} would be empty in campaign wording." };
    case "no_company": return { title: `${rows(n)} missing a company name`, detail: "{{company}} would be empty in campaign wording." };
    case "bad_phone": return { title: `${formatCount(n)} phone ${plural(n, "number", "numbers")} in an unknown format`, detail: "Imported as written into the Phone field." };
    case "bad_time_zone": return { title: `${formatCount(n)} time ${plural(n, "zone", "zones")} Linki does not know`, detail: "Left out. A time zone is written like Europe/Berlin." };
    case "linkedin_ok": return { title: `All ${formatCount(n)} LinkedIn ${plural(n, "profile", "profiles")} are well formed`, detail: "Ready for connection and message steps." };
    default: {
      if (issue.key.startsWith("bad_value:")) return { title: `${formatCount(n)} ${plural(n, "value", "values")} of ${issue.field ?? issue.key.slice(10)} that ${many ? "do" : "does"} not fit the field`, detail: `Left out. The rest of the row is imported.` };
      return { title: `${rows(n)}: ${issue.key}`, detail: "" };
    }
  }
}

export const ISSUE_TONE: Record<Issue["level"], Tone> = { error: "bad", warning: "warn", good: "good" };

/** The three figures of the validation card. */
export function validationFigures(summary: ImportPlanSummary): Array<{ key: string; label: string; value: string; tone: "good" | "warn" | "bad" | "muted" }> {
  return [
    { key: "ready", label: "Ready to import", value: formatCount(summary.ready), tone: summary.ready > 0 ? "good" : "muted" },
    { key: "warnings", label: "With warnings", value: formatCount(summary.with_warnings), tone: summary.with_warnings > 0 ? "warn" : "muted" },
    { key: "errors", label: "Left out", value: formatCount(summary.errors + summary.skipped), tone: summary.errors > 0 ? "bad" : "muted" },
  ];
}

/** What the import will do, one line for each thing, for the review step. */
export function reviewLines(view: ImportView, summary: ImportPlanSummary): Array<{ key: string; value: string; label: string; note: string | null }> {
  const list = view.list_mode === "new" ? `the new list ${view.new_list_name.trim() || "(not named yet)"}` : view.options.lists.find((candidate) => candidate.id === view.list_id)?.name ?? "a list not chosen yet";
  return [
    { key: "create", value: formatCount(summary.create), label: `new ${plural(summary.create, "contact", "contacts")}`, note: null },
    { key: "update", value: formatCount(summary.update), label: `${plural(summary.update, "contact", "contacts")} updated`, note: summary.merged ? `${rows(summary.merged)} of the file add to a contact another row made or changed` : null },
    { key: "joins", value: formatCount(summary.joins), label: `added to ${list}`, note: summary.already_in_list ? `${contacts(summary.already_in_list)} of this file ${summary.already_in_list === 1 ? "is" : "are"} in it already` : null },
    { key: "left", value: formatCount(summary.skipped + summary.errors), label: `${plural(summary.skipped + summary.errors, "row", "rows")} left out`, note: [summary.skipped ? `${formatCount(summary.skipped)} as duplicates` : null, summary.errors ? `${formatCount(summary.errors)} that cannot be told apart` : null].filter(Boolean).join(", ") || null },
  ];
}

// ── When it has run ───────────────────────────────────────────────────────────

/** "2,418 new, 96 updated, 36 left out" */
export function resultLine(result: StoredResult): string {
  const left = result.skipped + result.errors;
  return [`${formatCount(result.created)} new`, `${formatCount(result.updated)} updated`, left ? `${formatCount(left)} left out` : null, result.custom_fields_created ? `${result.custom_fields_created} new custom ${plural(result.custom_fields_created, "field", "fields")}` : null].filter(Boolean).join(", ");
}

export function resultFigures(result: StoredResult): Array<{ key: string; label: string; value: string }> {
  return [
    { key: "created", label: `New ${plural(result.created, "contact", "contacts")}`, value: formatCount(result.created) },
    { key: "updated", label: "Updated", value: formatCount(result.updated) },
    { key: "joined", label: `Added to ${result.list.name}`, value: formatCount(result.joined) },
    { key: "left", label: "Left out", value: formatCount(result.skipped + result.errors) },
  ];
}

/** The line for an import in the Lists screen's strip: "acme_q4.csv · 2,454 rows · at Map columns · Dan Okafor · 2 h ago" */
export function listingLine(item: ImportListing, now: Date = new Date()): string {
  const into = item.list ? `into ${item.list.name}` : item.new_list_name ? `into a new list, ${item.new_list_name}` : null;
  return [rows(item.rows), into, item.status === "draft" ? `at ${STEPS.find((step) => step.key === item.step)?.label ?? "Map columns"}` : null, item.by, formatRelative(item.updated_at, now)].filter(Boolean).join(" · ");
}
