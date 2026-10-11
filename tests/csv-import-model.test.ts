// How the CSV import page words what it is given, and what it sends when a choice is
// made. Pure functions: no browser and no database.
import { describe, expect, it } from "vitest";
import {
  FIELD_LABEL, FIELD_ORDER, IGNORE, NEW_FIELD, ON_DUPLICATE_HINT, ON_DUPLICATE_OPTIONS, STEPS, afterChoice, afterFrom, afterOptions, checkPath, choiceOf, cleared, columnLetter, columnStatus, continueLabel,
  decodeFile, delimiterLabel, duplicateAction, duplicateNote, encodingLabel, fileFacts, formatBytes, importHref, importPath, issueText, listLine, listingLine, mappedCount, mappingFooter, mappingProblem,
  mappingSummary, matchCount, newImportHref, nextStep, previousStep, resultFigures, resultLine, reviewLines, runPath, stepIndex, stepMeta, stepSubs, validationFigures, withChange, withChoice, withType,
  type DuplicateRow, type ImportCheck, type ImportColumn, type ImportColumnView, type ImportListing, type ImportPlanSummary, type ImportView, type Issue, type StoredResult,
} from "@/components/csv-import/model";
import { IMPORT_FIELDS, ON_DUPLICATE } from "@/lib/csv-imports";

const NOW = new Date("2026-10-10T12:00:00Z");

function column(index: number, name: string, mapping: Omit<ImportColumn, "index" | "column"> | null, over: Partial<ImportColumnView> = {}): ImportColumnView {
  return { index, column: name, sample: "x", filled: 3, detected: "text", mapping: { index, column: name, ...(mapping ?? { kind: "ignore" }) } as ImportColumn, ...over };
}

function view(over: Partial<ImportView> = {}): ImportView {
  return {
    id: "imp-1", status: "draft", step: "map",
    file: { name: "acme_q4_prospects.csv", size_bytes: 1_887_437, encoding: "utf-8", delimiter: ",", has_header: true, rows: 2454, columns: 5 },
    created_at: "2026-10-10 11:58:00", updated_at: "2026-10-10 11:58:00", finished_at: null, created_by: { id: "u1", name: "Dan Okafor" },
    columns: [
      column(0, "first_name", { kind: "standard", field: "first_name" }),
      column(1, "email", { kind: "standard", field: "email" }),
      column(2, "arr_band", { kind: "custom", key: "arr_band", name: "Arr band", fieldType: "text" }),
      column(3, "tier", { kind: "custom", key: "tier", name: "Account tier", fieldType: "text" }),
      column(4, "utm_source", null, { sample: null, filled: 0 }),
    ],
    remembered_from: null, list_mode: "existing", list_id: "l1", new_list_name: "Acme q4 prospects", match: { email: true, name_company: false }, on_duplicate: "update", after: { mode: "none", campaign_id: null }, result: null,
    options: {
      lists: [{ id: "l1", name: "Q4 Outbound", contacts: 1204 }, { id: "l2", name: "Webinar", contacts: 1 }],
      fields: [{ key: "tier", name: "Account tier", field_type: "text" }, { key: "seats", name: "Seats", field_type: "number" }],
      campaigns: [{ id: "c1", name: "Northwind ICP", steps: 4 }, { id: "c2", name: "One step", steps: 1 }],
    },
    ...over,
  };
}

function summary(over: Partial<ImportPlanSummary> = {}): ImportPlanSummary {
  return {
    rows: 2454, ready: 2418, with_warnings: 36, errors: 12, create: 2300, update: 96, merged: 22, skipped: 24, joins: 2418, already_in_list: 0, list_before: 1204, list_after: 3622,
    duplicates: { existing: 96, in_file: 22, by: { linkedin: 41, email: 96, name_company: null }, forced_update: 0 }, new_fields: [{ key: "arr_band", name: "Arr band", type: "text" }],
    ...over,
  };
}
const check = (over: Partial<ImportCheck> = {}): ImportCheck => ({ problem: null, summary: summary(), issues: [], duplicates: [], duplicate_rows: 118, checked_at: "2026-10-10T11:59:48Z", ...over });
const issue = (key: string, count: number, over: Partial<Issue> = {}): Issue => ({ key, level: "warning", count, rows: [], ...over });
const result = (over: Partial<StoredResult> = {}): StoredResult => ({
  created: 2300, updated: 96, merged: 22, skipped: 24, errors: 12, error_rows: [], joined: 2396, already_in_list: 0, custom_fields_created: 1, list: { id: "l1", name: "Q4 Outbound" }, new_list: false, rows: 2454, ...over,
});

describe("where an import lives", () => {
  it("has a page, and a page it starts on that can carry the list it is for", () => {
    expect(importHref("abc")).toBe("/lists/import/abc");
    expect(newImportHref()).toBe("/lists/import/new");
    expect(newImportHref(null)).toBe("/lists/import/new");
    expect(newImportHref("list 1")).toBe("/lists/import/new?list=list%201");
    expect([importPath("abc"), checkPath("abc"), runPath("abc")]).toEqual(["/api/csv-imports/abc", "/api/csv-imports/abc/check", "/api/csv-imports/abc/run"]);
  });
});

describe("the four steps", () => {
  it("are named and numbered as the design has them", () => {
    expect(STEPS.map((step) => step.label)).toEqual(["Upload file", "Map columns", "Duplicates", "Review & import"]);
    expect(stepMeta("upload")).toBe("Step 1 of 4 · Upload file");
    expect(stepMeta("map")).toBe("Step 2 of 4 · Map columns");
    expect(stepMeta("review")).toBe("Step 4 of 4 · Review & import");
    expect([stepIndex("upload"), stepIndex("duplicates")]).toEqual([0, 2]);
  });

  it("lead from one to the next and back", () => {
    expect([nextStep("map"), nextStep("duplicates"), nextStep("review")]).toEqual(["duplicates", "review", null]);
    expect([previousStep("map"), previousStep("duplicates"), previousStep("review")]).toEqual([null, "map", "duplicates"]);
    expect(continueLabel("map", null)).toBe("Continue to duplicates");
    expect(continueLabel("duplicates", check())).toBe("Continue to review");
    expect(continueLabel("review", check())).toBe("Import 2,418 rows");
    expect(continueLabel("review", check({ summary: summary({ ready: 1 }) }))).toBe("Import 1 row");
    expect(continueLabel("review", null)).toBe("Import");
  });

  it("say under each what it holds, before there is a file, while it is set up, and once it has run", () => {
    expect(stepSubs(null, null)).toEqual({ upload: "A CSV file", map: "What each column is", duplicates: "Contacts you already have", review: "Check, then import" });
    expect(stepSubs(view(), check())).toEqual({ upload: "acme_q4_prospects.csv", map: "4 of 5 columns mapped", duplicates: "118 matches", review: "2,418 rows ready" });
    expect(stepSubs(view(), null)).toMatchObject({ duplicates: "Checking", review: "Checking" });
    expect(stepSubs(view(), check({ duplicate_rows: 0 })).duplicates).toBe("No duplicates");
    expect(stepSubs(view(), check({ duplicate_rows: 1 })).duplicates).toBe("1 match");
    expect(stepSubs(view({ status: "done", result: result() }), null)).toEqual({ upload: "acme_q4_prospects.csv", map: "5 columns", duplicates: "24 left out", review: "2,418 rows imported" });
    expect(stepSubs(view({ status: "done", result: result({ skipped: 0 }) }), null).duplicates).toBe("96 updated");
  });
});

describe("the file", () => {
  it("is described in one line", () => {
    expect(fileFacts(view(), NOW)).toBe("2,454 rows · 5 columns · 1.8 MB · uploaded by Dan Okafor 2 min ago");
    expect(fileFacts(view({ created_by: null, file: { ...view().file, rows: 1, columns: 1, size_bytes: 113 } }), NOW)).toBe("1 row · 1 column · 113 B · uploaded 2 min ago");
    expect([formatBytes(0), formatBytes(1023), formatBytes(2048), formatBytes(25 * 1024 * 1024)]).toEqual(["0 B", "1023 B", "2 KB", "25.0 MB"]);
  });

  it("says how it is separated and what it was read as", () => {
    expect([delimiterLabel(","), delimiterLabel(";"), delimiterLabel("\t"), delimiterLabel("|"), delimiterLabel("~")]).toEqual(["Comma-delimited", "Semicolon-delimited", "Tab-delimited", "Pipe-delimited", "Delimited"]);
    expect([encodingLabel("utf-8"), encodingLabel("windows-1252"), encodingLabel(null)]).toEqual(["UTF-8", "Windows-1252", null]);
  });

  it("is read as UTF-8, or as Windows-1252 when it is not valid UTF-8", () => {
    expect(decodeFile(new TextEncoder().encode("Zoë,Müller").buffer as ArrayBuffer)).toEqual({ text: "Zoë,Müller", encoding: "utf-8" });
    // The bytes an old Excel on Windows writes for the same text.
    expect(decodeFile(new Uint8Array([0x5a, 0x6f, 0xeb, 0x2c, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]).buffer)).toEqual({ text: "Zoë,Müller", encoding: "windows-1252" });
  });

  it("letters its columns as a spreadsheet does", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
});

describe("the mapping table", () => {
  it("offers every field the importer has, each with a name", () => {
    expect([...FIELD_ORDER].sort()).toEqual(IMPORT_FIELDS.map((field) => field.key).sort());
    for (const field of IMPORT_FIELDS) expect(FIELD_LABEL[field.key]).toBe(field.label);
  });

  it("knows what each column's picker holds", () => {
    const v = view();
    expect(v.columns.map((item) => choiceOf(item, v.options.fields))).toEqual(["std:first_name", "std:email", NEW_FIELD, "custom:tier", IGNORE]);
  });

  it("sends the whole mapping with one column changed", () => {
    const v = view();
    expect(withChoice(v, 4, "std:company")[4]).toEqual({ index: 4, column: "utm_source", kind: "standard", field: "company" });
    expect(withChoice(v, 0, IGNORE)[0]).toEqual({ index: 0, column: "first_name", kind: "ignore" });
    // An existing custom field brings its own name and kind.
    expect(withChoice(v, 4, "custom:seats")[4]).toEqual({ index: 4, column: "utm_source", kind: "custom", key: "seats", name: "Seats", fieldType: "number" });
    // The other columns are sent as they are.
    expect(withChoice(v, 4, "std:company").slice(0, 4)).toEqual(v.columns.slice(0, 4).map((item) => item.mapping));
  });

  it("takes a field from the column that had it, so no field is filled twice", () => {
    const v = view();
    const moved = withChoice(v, 4, "std:email");
    expect(moved[1]).toEqual({ index: 1, column: "email", kind: "ignore" });
    expect(moved[4]).toMatchObject({ kind: "standard", field: "email" });
    const custom = withChoice(v, 0, "custom:tier");
    expect(custom[3]).toEqual({ index: 3, column: "tier", kind: "ignore" });
    expect(custom[0]).toMatchObject({ kind: "custom", key: "tier" });
  });

  it("makes a new field from the column, with a key nothing else has and the kind its values look like", () => {
    const v = view({ columns: [column(0, "Fleet size (trucks)", null, { detected: "number" }), column(1, "arr_band", { kind: "custom", key: "arr_band", name: "Arr band", fieldType: "text" }), column(2, "ARR band", null), column(3, "Tier", null), column(4, "2024 revenue", null)] });
    expect(withChoice(v, 0, NEW_FIELD)[0]).toEqual({ index: 0, column: "Fleet size (trucks)", kind: "custom", key: "fleet_size_trucks", name: "Fleet size (trucks)", fieldType: "number" });
    // Another column already makes arr_band, and the workspace already has tier.
    expect(withChoice(v, 2, NEW_FIELD)[2]).toMatchObject({ key: "arr_band_2", name: "ARR band" });
    expect(withChoice(v, 3, NEW_FIELD)[3]).toMatchObject({ key: "tier_2" });
    expect(withChoice(v, 4, NEW_FIELD)[4]).toMatchObject({ key: "var_2024_revenue" });
  });

  it("changes a new field's kind, and clears everything", () => {
    const v = view();
    expect(withType(v, 2, "date")[2]).toMatchObject({ kind: "custom", key: "arr_band", fieldType: "date" });
    expect(withType(v, 0, "date")[0]).toEqual(v.columns[0].mapping);
    expect(cleared(v)).toEqual(v.columns.map((item) => ({ index: item.index, column: item.column, kind: "ignore" })));
  });

  it("says where each column stands", () => {
    const v = view();
    expect(v.columns.map((item) => columnStatus(item, v))).toEqual([
      { tone: "good", label: "Matched", note: null },
      { tone: "good", label: "Matched", note: "finds duplicates" },
      { tone: "brand", label: "New field", note: "custom · text" },
      { tone: "good", label: "Custom field", note: "text · {{tier}}" },
      { tone: "neutral", label: "Unmapped", note: "column is empty" },
    ]);
    // Email only finds duplicates while it is matched on; a column left out that has values is "skipped".
    expect(columnStatus(v.columns[1], view({ match: { email: false, name_company: false } })).note).toBeNull();
    expect(columnStatus(column(0, "linkedin", { kind: "standard", field: "linkedin_url" }), v).note).toBe("finds duplicates");
    expect(columnStatus(column(0, "notes_internal", null), v)).toEqual({ tone: "neutral", label: "Skipped", note: null });
  });

  it("sums the mapping up above the table and under it", () => {
    expect(mappedCount(view())).toBe(4);
    expect(mappingSummary(view())).toBe("4 of 5 columns mapped · 1 new custom field will be created");
    const two = view({ columns: [...view().columns.slice(0, 3), column(3, "last_touch", { kind: "custom", key: "last_touch", name: "Last touch", fieldType: "date" }), view().columns[4]] });
    expect(mappingSummary(two)).toBe("4 of 5 columns mapped · 2 new custom fields will be created");
    expect(mappingSummary(view({ columns: view().columns.slice(0, 2) }))).toBe("2 of 2 columns mapped");
    expect(mappingFooter(view())).toBe("1 column will be left out · Linki remembers this mapping for the next file with the same columns");
    expect(mappingFooter(view({ remembered_from: "acme_q3.csv", columns: view().columns.slice(0, 2) }))).toBe("Every column is imported · Mapped the way acme_q3.csv was");
    expect(mappingFooter({ ...view(), columns: cleared(view()).map((mapping, index) => ({ ...view().columns[index], mapping })) })).toMatch(/^5 columns will be left out/);
  });

  it("cannot be imported with until a column says who each row is", () => {
    expect(mappingProblem(view())).toBeNull();
    expect(mappingProblem(view({ columns: [view().columns[0], column(1, "linkedin", { kind: "standard", field: "linkedin_url" })] }))).toBeNull();
    expect(mappingProblem(view({ columns: [view().columns[0], view().columns[2]] }))).toBe("Map one column to LinkedIn profile or Email, so each row can be told apart.");
  });

  it("shows a change before the server has answered", () => {
    const v = view();
    const next = withChange(v, { mapping: withChoice(v, 4, "std:company"), list_mode: "new", new_list_name: "Q4", on_duplicate: "skip", step: "review", after: { mode: "new", campaign_id: null }, match: { name_company: true } });
    expect(next.columns[4].mapping).toMatchObject({ kind: "standard", field: "company" });
    expect(next).toMatchObject({ list_mode: "new", new_list_name: "Q4", on_duplicate: "skip", step: "review", after: { mode: "new" }, match: { email: true, name_company: true } });
    // What a change does not name stays, and the import it was made from is not touched.
    expect(withChange(v, { list_id: "l2" })).toMatchObject({ list_id: "l2", list_mode: "existing", on_duplicate: "update" });
    expect(withChange(v, { list_id: null }).list_id).toBeNull();
    expect(v).toMatchObject({ list_mode: "existing", step: "map" });
    // A file or a request to map again is for the server to answer.
    expect(withChange(v, { automap: true, csv: "a,b" })).toEqual(v);
  });
});

describe("where the rows go", () => {
  it("says what the list holds now and will hold", () => {
    expect(listLine(view(), check())).toBe("1,204 contacts today → 3,622 after import");
    expect(listLine(view(), null)).toBe("1,204 contacts today");
    expect(listLine(view({ list_id: "l2" }), null)).toBe("1 contact today");
    expect(listLine(view({ list_id: null }), check())).toBe("Choose the list these contacts go into");
    expect(listLine(view({ list_mode: "new" }), check())).toBe("A new list with 2,418 contacts");
    expect(listLine(view({ list_mode: "new" }), null)).toBe("A new list");
  });

  it("offers a new campaign or one that has not been started, for afterwards", () => {
    expect(afterOptions(view())).toEqual([
      { value: "new", label: "A new campaign", hint: "Opens the campaign setup with this list chosen" },
      { value: "c1", label: "Northwind ICP", hint: "Not started · 4 steps" },
      { value: "c2", label: "One step", hint: "Not started · 1 step" },
    ]);
    expect([afterChoice({ mode: "none", campaign_id: null }), afterChoice({ mode: "new", campaign_id: null }), afterChoice({ mode: "existing", campaign_id: "c1" })]).toEqual(["none", "new", "c1"]);
    expect([afterFrom("none"), afterFrom("new"), afterFrom("c1")]).toEqual([{ mode: "none", campaign_id: null }, { mode: "new", campaign_id: null }, { mode: "existing", campaign_id: "c1" }]);
  });
});

describe("duplicates", () => {
  it("has the three things that can happen to one, each explained", () => {
    expect(ON_DUPLICATE_OPTIONS.map((option) => option.value)).toEqual([...ON_DUPLICATE]);
    expect(ON_DUPLICATE_OPTIONS.map((option) => option.label)).toEqual(["Skip row", "Update", "Import anyway"]);
    for (const option of ON_DUPLICATE) expect(ON_DUPLICATE_HINT[option]).toMatch(/\.$/);
    expect(ON_DUPLICATE_HINT.skip).toMatch(/not added to this list/);
  });

  it("counts the matches by each detail, and says when one is not looked at", () => {
    expect(matchCount(96, true)).toEqual({ text: "96 matches", tone: "warn" });
    expect(matchCount(1, true)).toEqual({ text: "1 match", tone: "warn" });
    expect(matchCount(0, true)).toEqual({ text: "no matches", tone: "muted" });
    expect(matchCount(null, false)).toEqual({ text: "not checked", tone: "muted" });
    expect(matchCount(12, false)).toEqual({ text: "not checked", tone: "muted" });
    expect(matchCount(undefined, true)).toEqual({ text: "—", tone: "muted" });
  });

  it("says how many there are, where, and what becomes of them", () => {
    expect(duplicateNote(summary(), "update")).toBe("118 duplicates: 96 already in Linki, 22 repeated inside this file. Existing contacts are updated and keep their campaign history; a repeated row adds to the row above it.");
    expect(duplicateNote(summary(), "skip")).toBe("118 duplicates: 96 already in Linki, 22 repeated inside this file. They are left out.");
    expect(duplicateNote(summary(), "import")).toBe("118 duplicates: 96 already in Linki, 22 repeated inside this file. Each becomes a second contact.");
    const one = summary({ duplicates: { existing: 1, in_file: 0, by: { linkedin: 0, email: 1, name_company: null }, forced_update: 0 } });
    expect(duplicateNote(one, "skip")).toBe("1 duplicate: 1 already in Linki. It is left out.");
    expect(duplicateNote(one, "import")).toBe("1 duplicate: 1 already in Linki. It becomes a second contact.");
    // Two contacts cannot share a LinkedIn profile, and the note says what happens instead.
    const forced = summary({ duplicates: { existing: 5, in_file: 0, by: { linkedin: 2, email: 3, name_company: null }, forced_update: 2 } });
    expect(duplicateNote(forced, "import")).toBe("5 duplicates: 5 already in Linki. 3 become a second contact. 2 with a LinkedIn profile a contact already has update that contact instead: two contacts cannot share a profile.");
    const allForced = summary({ duplicates: { existing: 1, in_file: 0, by: { linkedin: 1, email: 0, name_company: null }, forced_update: 1 } });
    expect(duplicateNote(allForced, "import")).toMatch(/None become a second contact\. 1 with a LinkedIn profile a contact already has updates that contact instead/);
    expect(duplicateNote(summary({ duplicates: { existing: 0, in_file: 0, by: { linkedin: 0, email: 0, name_company: null }, forced_update: 0 } }), "update")).toBeNull();
  });

  it("says in two words what happens to one row", () => {
    const row = (over: Partial<DuplicateRow>): DuplicateRow => ({ row: 2, label: "Ada", matched_by: "email", contact: { id: "t1", name: "Ada" }, repeats_row: null, action: "update", ...over });
    expect(duplicateAction(row({}))).toEqual({ label: "Updates it", tone: "good" });
    expect(duplicateAction(row({ contact: null, repeats_row: 2 }))).toEqual({ label: "Adds to that row", tone: "good" });
    expect(duplicateAction(row({ action: "skip" }))).toEqual({ label: "Left out", tone: "neutral" });
    expect(duplicateAction(row({ action: "create" }))).toEqual({ label: "Second contact", tone: "warn" });
  });
});

describe("validation", () => {
  it("puts each thing it found into words, one row or many", () => {
    const said = (key: string, count: number, over: Partial<Issue> = {}) => issueText(issue(key, count, over));
    expect(said("no_identity", 12)).toEqual({ title: "12 rows with neither a LinkedIn profile nor an email address", detail: "Nothing says who they are, so these rows are left out." });
    expect(said("no_identity", 1)).toEqual({ title: "1 row with neither a LinkedIn profile nor an email address", detail: "Nothing says who it is, so this row is left out." });
    expect(said("bad_email_only", 1).detail).toBe("There is no LinkedIn profile to go by either, so this row is left out.");
    expect(said("bad_linkedin_only", 2).title).toBe("2 rows with a LinkedIn address that is not a profile");
    expect(said("bad_email", 3)).toEqual({ title: "3 email addresses that are not valid", detail: "Left out. The rows are imported with their LinkedIn profile." });
    expect(said("bad_email", 1)).toEqual({ title: "1 email address that is not valid", detail: "Left out. The row is imported with its LinkedIn profile." });
    expect(said("bad_linkedin", 1).detail).toBe("Left out. The row is imported with its email address.");
    expect(said("no_email", 12)).toEqual({ title: "12 rows missing an email address", detail: "Imported. Email steps skip them until an address is found." });
    expect(said("no_linkedin", 1).detail).toBe("Imported. LinkedIn steps skip it.");
    expect(said("no_first_name", 4).detail).toBe("{{first_name}} would be empty in campaign wording.");
    expect(said("no_company", 12)).toEqual({ title: "12 rows missing a company name", detail: "{{company}} would be empty in campaign wording." });
    expect(said("bad_phone", 24)).toEqual({ title: "24 phone numbers in an unknown format", detail: "Imported as written into the Phone field." });
    expect(said("bad_time_zone", 1).title).toBe("1 time zone Linki does not know");
    expect(said("bad_value:fleet_size", 2, { field: "Fleet size" })).toEqual({ title: "2 values of Fleet size that do not fit the field", detail: "Left out. The rest of the row is imported." });
    expect(said("bad_value:seats", 1).title).toBe("1 value of seats that does not fit the field");
    expect(said("linkedin_ok", 2454, { level: "good" })).toEqual({ title: "All 2,454 LinkedIn profiles are well formed", detail: "Ready for connection and message steps." });
    // Something the page has no words for yet is still shown, by its key.
    expect(said("something_new", 3).title).toBe("3 rows: something_new");
  });

  it("gives the three figures: ready, with warnings, left out", () => {
    expect(validationFigures(summary())).toEqual([
      { key: "ready", label: "Ready to import", value: "2,418", tone: "good" },
      { key: "warnings", label: "With warnings", value: "36", tone: "warn" },
      { key: "errors", label: "Left out", value: "36", tone: "bad" },
    ]);
    // Rows left out as duplicates were asked for, so they do not turn the figure red.
    expect(validationFigures(summary({ ready: 0, with_warnings: 0, errors: 0, skipped: 3 })).map((figure) => [figure.value, figure.tone])).toEqual([["0", "muted"], ["0", "muted"], ["3", "muted"]]);
  });

  it("lays out what the import will do, for the review", () => {
    expect(reviewLines(view(), summary())).toEqual([
      { key: "create", value: "2,300", label: "new contacts", note: null },
      { key: "update", value: "96", label: "contacts updated", note: "22 rows of the file add to a contact another row made or changed" },
      { key: "joins", value: "2,418", label: "added to Q4 Outbound", note: null },
      { key: "left", value: "36", label: "rows left out", note: "24 as duplicates, 12 that cannot be told apart" },
    ]);
    const small = reviewLines(view({ list_mode: "new", new_list_name: " Q4 outbound " }), summary({ create: 1, update: 1, merged: 0, joins: 1, already_in_list: 1, skipped: 0, errors: 1 }));
    expect(small.map((line) => [line.label, line.note])).toEqual([["new contact", null], ["contact updated", null], ["added to the new list Q4 outbound", "1 contact of this file is in it already"], ["row left out", "1 that cannot be told apart"]]);
    expect(reviewLines(view({ list_mode: "new", new_list_name: "" }), summary())[2].label).toBe("added to the new list (not named yet)");
    expect(reviewLines(view({ list_id: null }), summary())[2].label).toBe("added to a list not chosen yet");
    expect(reviewLines(view(), summary({ skipped: 0, errors: 0 }))[3]).toMatchObject({ value: "0", note: null });
  });
});

describe("an import that has run", () => {
  it("is summed up in a line and in four figures", () => {
    expect(resultLine(result())).toBe("2,300 new, 96 updated, 36 left out, 1 new custom field");
    expect(resultLine(result({ skipped: 0, errors: 0, custom_fields_created: 0 }))).toBe("2,300 new, 96 updated");
    expect(resultFigures(result())).toEqual([
      { key: "created", label: "New contacts", value: "2,300" }, { key: "updated", label: "Updated", value: "96" },
      { key: "joined", label: "Added to Q4 Outbound", value: "2,396" }, { key: "left", label: "Left out", value: "36" },
    ]);
    expect(resultFigures(result({ created: 1 }))[0].label).toBe("New contact");
  });
});

describe("the list of imports not finished", () => {
  const item = (over: Partial<ImportListing> = {}): ImportListing => ({ id: "imp-1", status: "draft", step: "duplicates", filename: "acme_q4.csv", rows: 2454, list: { id: "l1", name: "Q4 Outbound" }, new_list_name: null, by: "Dan Okafor", updated_at: "2026-10-10 10:00:00", ...over });

  it("says of each how big it is, where it is going, where it was left, by whom and when", () => {
    expect(listingLine(item(), NOW)).toBe("2,454 rows · into Q4 Outbound · at Duplicates · Dan Okafor · 2 h ago");
    expect(listingLine(item({ list: null, new_list_name: "Q4 outbound", step: "map", by: null, rows: 1 }), NOW)).toBe("1 row · into a new list, Q4 outbound · at Map columns · 2 h ago");
    expect(listingLine(item({ list: null, step: "review" }), NOW)).toBe("2,454 rows · at Review & import · Dan Okafor · 2 h ago");
    expect(listingLine(item({ status: "done" }), NOW)).toBe("2,454 rows · into Q4 Outbound · Dan Okafor · 2 h ago");
  });
});
