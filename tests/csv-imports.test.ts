// A CSV file on its way into a list: reading it, mapping its columns, the dry run, the
// import, and the record that lets the import be left and picked up again. Real
// (throwaway) database. Nothing reaches LinkedIn, Apollo or a mail server.
import { describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import {
  applyPlan, checkMapping, customFields, detectType, fieldName, headerSignature, linkedinSlug, mappingHasIdentity, parseBoolean, parseDate, parseNumber, planImport, readCsv, suggestMapping, variableKey,
  type ImportColumn, type MatchOptions, type OnDuplicate,
} from "@/lib/csv-imports";
import { checkImport, createImport, listImports, listNameFromFile, readImport, rememberMapping, runImport, updateImport, type ImportView } from "@/lib/csv-import-store";
import { listNotifications } from "@/lib/platform/notifications";
import importsHandler from "@/pages/api/csv-imports/index";
import importHandler from "@/pages/api/csv-imports/[id]/index";
import checkHandler from "@/pages/api/csv-imports/[id]/check";
import runHandler from "@/pages/api/csv-imports/[id]/run";
import legacyHandler from "@/pages/api/lists/[id]/import-csv";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown> };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.send = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as Res;
}
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function workspace() {
  const n = ++seq;
  const ws = `ws-csv-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const insert = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key]));
  };
  const contact = (fields: Record<string, unknown> = {}) => {
    const id = `cperson-${++seq}`;
    insert("targets", { id, workspace_id: ws, ...fields });
    return id;
  };
  const list = (name: string, members: string[] = []) => {
    const id = `clist-${++seq}`;
    insert("lists", { id, workspace_id: ws, name });
    for (const member of members) insert("list_targets", { list_id: id, target_id: member });
    return id;
  };
  const field = (key: string, name: string, type = "text") => insert("custom_field_definitions", { id: `cfield-${++seq}`, workspace_id: ws, key, name, field_type: type });
  const call = async (handler: Handler, method: string, opts: { body?: unknown; query?: Record<string, string>; role?: string } = {}) => {
    const res = mockRes();
    const role = opts.role ?? "member";
    await handler({ method, body: opts.body ?? {}, query: opts.query ?? {}, headers: ctxHeaders(ws, { userId: `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
    return res;
  };
  const person = (id: string) => db().prepare("SELECT * FROM targets WHERE id = ?").get(id) as Record<string, string | null>;
  const people = () => db().prepare("SELECT * FROM targets WHERE workspace_id = ? ORDER BY rowid").all(ws) as Array<Record<string, string | null>>;
  const members = (listId: string) => (db().prepare("SELECT target_id FROM list_targets WHERE list_id = ?").all(listId) as { target_id: string }[]).map((row) => row.target_id);
  const value = (targetId: string, key: string) => db().prepare(`SELECT v.value_text, v.value_number, v.value_boolean FROM contact_custom_values v
    JOIN custom_field_definitions d ON d.id = v.field_id WHERE v.target_id = ? AND d.key = ?`).get(targetId, key) as { value_text: string | null; value_number: number | null; value_boolean: number | null } | undefined;
  return { ws, insert, contact, list, field, call, person, people, members, value };
}

const csv = (...lines: string[]) => `${lines.join("\n")}\n`;
/** Plan a file with its columns mapped by their names. */
function plan(w: ReturnType<typeof workspace>, text: string, options: { listId?: string | null; match?: Partial<MatchOptions>; onDuplicate?: OnDuplicate; mapping?: ImportColumn[] } = {}) {
  const file = readCsv(text);
  const mapping = options.mapping ?? suggestMapping(file, customFields(db(), w.ws));
  const planned = planImport(db(), w.ws, { file, mapping, listId: options.listId ?? null, match: { email: true, name_company: false, ...options.match }, onDuplicate: options.onDuplicate ?? "update" });
  return { file, mapping, planned };
}

describe("reading a file", () => {
  it("takes the first line as column names, whatever separates the columns", () => {
    const file = readCsv("﻿First Name;E-mail Address;  Fleet size \nAda;ada@acme.test;40\n\n;;\nGrace;grace@acme.test;12\n");
    expect(file).toMatchObject({ columns: ["first_name", "e-mail_address", "fleet_size"], delimiter: ";", hasHeader: true });
    // Lines with nothing in them are not rows.
    expect(file.rows).toEqual([["Ada", "ada@acme.test", "40"], ["Grace", "grace@acme.test", "12"]]);
  });

  it("does not take a contact for a header: a first line with an email address or a profile in it is data", () => {
    const file = readCsv(csv("Ada,ada@acme.test,Acme", "Grace,grace@acme.test,Acme"));
    expect(file).toMatchObject({ hasHeader: false, columns: ["column_1", "column_2", "column_3"] });
    expect(file.rows).toHaveLength(2);
    expect(readCsv(csv("https://www.linkedin.com/in/ada/,Ada")).hasHeader).toBe(false);
  });

  it("gives a column with no name one, and every row the same width to be read by", () => {
    const file = readCsv(csv("email,,notes", "ada@acme.test,x", "grace@acme.test,y,z,extra"));
    expect(file.columns).toEqual(["email", "column_2", "notes", "column_4"]);
  });
});

describe("telling what a value is", () => {
  it("reads the person out of a LinkedIn address however it is written", () => {
    expect(linkedinSlug("https://www.linkedin.com/in/Ada-Lovelace/")).toBe("ada-lovelace");
    expect(linkedinSlug("linkedin.com/in/ada-lovelace?utm=x")).toBe("ada-lovelace");
    expect(linkedinSlug("http://uk.linkedin.com/in/ada%2Dlovelace")).toBe("ada-lovelace");
    expect(linkedinSlug("https://www.linkedin.com/company/acme/")).toBeNull();
    expect(linkedinSlug("ada lovelace")).toBeNull();
  });

  it("reads numbers, yes/no and year-first dates, and nothing it would have to guess at", () => {
    expect([parseNumber("640"), parseNumber("-1.5"), parseNumber("1,204"), parseNumber("12,345,678.9"), parseNumber(" 7 ")]).toEqual([640, -1.5, 1204, 12345678.9, 7]);
    expect([parseNumber("1,5"), parseNumber("12 trucks"), parseNumber("1e3"), parseNumber("")]).toEqual([null, null, null, null]);
    expect([parseBoolean("Yes"), parseBoolean("n"), parseBoolean("TRUE"), parseBoolean("0"), parseBoolean("maybe")]).toEqual([true, false, true, false, null]);
    expect([parseDate("2025-08-14"), parseDate("2025/8/4"), parseDate("2025-08-14T10:00:00Z"), parseDate("2025-08-14 10:00")]).toEqual(["2025-08-14", "2025-08-04", "2025-08-14", "2025-08-14"]);
    // 14/08/2025 and 08/14/2025 cannot be told apart, and 31 February is not a day.
    expect([parseDate("14/08/2025"), parseDate("2025-02-31"), parseDate("soon")]).toEqual([null, null, null]);
  });

  it("works out the kind of field a column would make", () => {
    expect(detectType(["2025-08-14", "", "2024-01-02"])).toBe("date");
    expect(detectType(["640", "1,204", ""])).toBe("number");
    expect(detectType(["yes", "no", "Yes"])).toBe("boolean");
    // 0 and 1 alone are numbers; a code with a leading zero is text; one odd value makes it text.
    expect(detectType(["0", "1", "1"])).toBe("number");
    expect(detectType(["02139", "10001"])).toBe("text");
    expect(detectType(["640", "about 700"])).toBe("text");
    expect(detectType(["", " "])).toBe("text");
  });

  it("makes a key and a name for a new field from a column", () => {
    expect([variableKey("Fleet size (trucks)"), variableKey("2024 revenue"), variableKey("ARR_band"), variableKey("!!!")]).toEqual(["fleet_size_trucks", "var_2024_revenue", "arr_band", "var_column"]);
    expect([fieldName("arr_band"), fieldName("last  touch"), fieldName("")]).toEqual(["Arr band", "Last touch", "Column"]);
  });
});

describe("mapping the columns by their names", () => {
  const kinds = (mapping: ImportColumn[]) => mapping.map((column) => (column.kind === "standard" ? column.field : column.kind === "custom" ? `custom:${column.key}:${column.fieldType}` : "ignore"));

  it("knows the fields by what files call them", () => {
    const w = workspace();
    const file = readCsv(csv("First Name,Surname,E-mail,Person Linkedin Url,Job Title,Company Name,Mobile,Country,Timezone", "Ada,Lovelace,ada@acme.test,https://www.linkedin.com/in/ada/,CTO,Acme,+44 20 7946 0000,UK,Europe/London"));
    expect(kinds(suggestMapping(file, customFields(db(), w.ws)))).toEqual(["first_name", "last_name", "email", "linkedin_url", "title", "company", "phone", "country", "time_zone"]);
  });

  it("gives a field to the column named for it outright, and to one column only", () => {
    const w = workspace();
    // "work_email" is another name for email, but a column called "email" is there too.
    const file = readCsv(csv("work_email,email,name,mail", "a@acme.test,b@acme.test,Ada Lovelace,c@acme.test"));
    expect(kinds(suggestMapping(file, customFields(db(), w.ws)))).toEqual(["custom:work_email:text", "email", "full_name", "custom:mail:text"]);
  });

  it("offers an unknown column as a new field of the kind its values are, and leaves an empty one out", () => {
    const w = workspace();
    const file = readCsv(csv("email,arr_band,employees,last_touch,is_customer,utm_source", "a@acme.test,$50M–$100M,640,2025-08-14,yes,", "b@acme.test,$10M,1204,2025-01-02,no,"));
    const mapping = suggestMapping(file, customFields(db(), w.ws));
    expect(kinds(mapping)).toEqual(["email", "custom:arr_band:text", "custom:employees:number", "custom:last_touch:date", "custom:is_customer:boolean", "ignore"]);
    expect(mapping[1]).toMatchObject({ name: "Arr band" });
  });

  it("uses a custom field the workspace already has, by its key or its name, with that field's kind", () => {
    const w = workspace();
    w.field("fleet_size", "Fleet size", "number");
    w.field("tier", "Account tier");
    const file = readCsv(csv("email,Fleet Size,account_tier,Tier", "a@acme.test,forty,A,B"));
    const mapping = suggestMapping(file, customFields(db(), w.ws));
    // The values are not numbers, but the field is: the field decides.
    expect(kinds(mapping)).toEqual(["email", "custom:fleet_size:number", "custom:tier:text", "custom:tier_2:text"]);
    expect(mapping[2]).toMatchObject({ name: "Account tier" });
  });

  it("refuses a mapping that could not work, and tidies one that can", () => {
    const w = workspace();
    w.field("fleet_size", "Fleet size", "number");
    const file = { columns: ["email", "work_email", "fleet"] };
    const fields = customFields(db(), w.ws);
    const check = (mapping: unknown) => checkMapping(mapping, file, fields);
    expect(check("x")).toEqual({ error: "mapping must be a list" });
    expect(check([{ index: 9, kind: "ignore" }])).toEqual({ error: "a mapping entry names a column the file does not have" });
    expect(check([{ index: 0, kind: "standard", field: "password_hash" }])).toEqual({ error: '"email" is mapped to a field Linki does not have' });
    expect(check([{ index: 0, kind: "standard", field: "email" }, { index: 1, kind: "standard", field: "email" }])).toEqual({ error: "Two columns are mapped to Email. Map one of them to something else, or leave it out." });
    expect(check([{ index: 2, kind: "custom", key: "Fleet Size" }])).toMatchObject({ error: expect.stringMatching(/needs a key of lower-case letters/) });
    expect(check([{ index: 1, kind: "custom", key: "tier" }, { index: 2, kind: "custom", key: "tier" }])).toEqual({ error: 'Two columns use the key "tier". Give each its own.' });
    // A column left out of the list is left out of the import, and an existing field keeps its own name and kind.
    expect(check([{ index: 2, kind: "custom", key: "fleet_size", name: "Other", fieldType: "text" }, { index: 0, kind: "standard", field: "time_zone" }])).toEqual({
      mapping: [{ index: 0, column: "email", kind: "standard", field: "time_zone" }, { index: 1, column: "work_email", kind: "ignore" }, { index: 2, column: "fleet", kind: "custom", key: "fleet_size", name: "Fleet size", fieldType: "number" }],
    });
  });

  it("can only be imported once a column says who each row is", () => {
    const of = (...fields: string[]) => fields.map((field, index) => ({ index, column: field, kind: "standard", field }) as ImportColumn);
    expect(mappingHasIdentity(of("first_name", "company"))).toBe(false);
    expect(mappingHasIdentity(of("first_name", "email"))).toBe(true);
    expect(mappingHasIdentity(of("linkedin_url"))).toBe(true);
  });
});

describe("the dry run", () => {
  it("counts the rows that become a contact, and leaves out only the ones nothing says who they are", () => {
    const w = workspace();
    const { planned } = plan(w, csv(
      "first_name,email,linkedin_url,company",
      "Ada,ada@acme.test,https://www.linkedin.com/in/ada/,Acme",
      "Grace,not-an-email,linkedin.com/in/grace,Acme",
      "Edsger,edsger@acme.test,not a profile,",
      "Alan,nope,,Acme",
      "Barbara,,linkedin.com/company/acme,Acme",
      "Nobody,,,Acme",
    ));
    expect(planned.summary).toMatchObject({ rows: 6, ready: 3, with_warnings: 2, errors: 3, create: 3, update: 0, merged: 0, skipped: 0, joins: 3, list_before: 0, list_after: 3 });
    const issue = (key: string) => planned.issues.find((found) => found.key === key);
    // A bad email address beside a good profile is left out and the row kept, and the other way round.
    expect(issue("bad_email")).toMatchObject({ level: "warning", count: 1, rows: [{ row: 3, value: "not-an-email" }] });
    expect(issue("bad_linkedin")).toMatchObject({ level: "warning", count: 1, rows: [{ row: 4, value: "not a profile" }] });
    expect(issue("no_company")).toMatchObject({ level: "warning", count: 1, rows: [{ row: 4, value: null }] });
    expect(issue("bad_email_only")).toMatchObject({ level: "error", count: 1, rows: [{ row: 5, value: "nope" }] });
    expect(issue("bad_linkedin_only")).toMatchObject({ level: "error", count: 1, rows: [{ row: 6, value: "linkedin.com/company/acme" }] });
    expect(issue("no_identity")).toMatchObject({ level: "error", count: 1, rows: [{ row: 7, value: null }] });
    // Errors first, then warnings.
    expect(planned.issues.map((found) => found.level)).toEqual(["error", "error", "error", "warning", "warning", "warning"]);
    // A profile written without https:// is kept as an address a browser can open.
    expect(planned.rows[1]).toMatchObject({ action: "create", email: null, linkedin_url: "https://www.linkedin.com/in/grace/" });
    expect(planned.rows[3]).toMatchObject({ action: "error", error: expect.stringMatching(/not a valid one/) });
  });

  it("says so when every profile address in the file is a profile", () => {
    const w = workspace();
    const { planned } = plan(w, csv("email,linkedin_url", "a@acme.test,https://www.linkedin.com/in/a/", "b@acme.test,https://www.linkedin.com/in/b/"));
    expect(planned.issues).toEqual([{ key: "linkedin_ok", level: "good", count: 2, rows: [] }]);
  });

  it("warns about what would read badly or be left out, without leaving the row out", () => {
    const w = workspace();
    w.field("fleet_size", "Fleet size", "number");
    const { planned } = plan(w, csv(
      "name,email,linkedin_url,phone,time_zone,fleet_size,last_touch",
      "Ada Lovelace,ada@acme.test,https://www.linkedin.com/in/ada/,+44 20 7946 0000,Europe/London,40,2025-08-14",
      ",grace@acme.test,,call the office,Berlin time,forty,2025-01-02",
    ));
    expect(planned.summary).toMatchObject({ ready: 2, with_warnings: 1, errors: 0 });
    expect(Object.fromEntries(planned.issues.map((issue) => [issue.key, issue.count]))).toEqual({ no_linkedin: 1, no_first_name: 1, bad_phone: 1, bad_time_zone: 1, "bad_value:fleet_size": 1, linkedin_ok: 1 });
    expect(planned.issues.find((issue) => issue.key === "bad_value:fleet_size")).toMatchObject({ field: "Fleet size", rows: [{ row: 3, value: "forty" }] });
    // A full name fills the two name fields; a phone number is kept as written; a time zone Linki does not know is left out.
    expect(planned.rows[0]).toMatchObject({ full_name: "Ada Lovelace", fields: { first_name: "Ada", last_name: "Lovelace", phone: "+44 20 7946 0000", time_zone: "Europe/London" } });
    expect(planned.rows[0].custom).toEqual([{ key: "fleet_size", text: null, number: 40, boolean: null }, { key: "last_touch", text: "2025-08-14", number: null, boolean: null }]);
    expect(planned.rows[1].fields).toEqual({ phone: "call the office" });
    expect(planned.rows[1].custom).toEqual([{ key: "last_touch", text: "2025-01-02", number: null, boolean: null }]);
    expect(planned.summary.new_fields).toEqual([{ key: "last_touch", name: "Last touch", type: "date" }]);
  });

  it("finds the contacts a row already is, by profile however it is written and by email whatever its case", () => {
    const w = workspace();
    const ada = w.contact({ full_name: "Ada Lovelace", linkedin_url: "https://www.linkedin.com/in/ada-lovelace/", company: "Acme" });
    const grace = w.contact({ full_name: "Grace Hopper", email: "grace@acme.test", company: "Acme" });
    const edsger = w.contact({ first_name: "Edsger", last_name: "Dijkstra", company: "Acme  Research" });
    const list = w.list("Existing", [ada]);
    const text = csv(
      "name,email,linkedin_url,company",
      "Ada L,ada.new@acme.test,linkedin.com/in/Ada-Lovelace,Acme",
      "Grace H,GRACE@acme.test,,Acme",
      "edsger  dijkstra,edsger@acme.test,,acme research",
      "Alan Turing,alan@acme.test,,Acme",
    );
    const { planned } = plan(w, text, { listId: list });
    // Name and company are not matched on unless asked for, so Edsger is a new contact here.
    expect(planned.summary).toMatchObject({ ready: 4, create: 2, update: 2, joins: 3, already_in_list: 1, list_before: 1, list_after: 4 });
    expect(planned.summary.duplicates).toEqual({ existing: 2, in_file: 0, by: { linkedin: 1, email: 1, name_company: null }, forced_update: 0 });
    expect(planned.duplicates).toEqual([
      { row: 2, label: "Ada L", matched_by: "linkedin", contact: { id: ada, name: "Ada Lovelace" }, repeats_row: null, action: "update" },
      { row: 3, label: "Grace H", matched_by: "email", contact: { id: grace, name: "Grace Hopper" }, repeats_row: null, action: "update" },
    ]);

    const byName = plan(w, text, { listId: list, match: { name_company: true } }).planned;
    expect(byName.summary).toMatchObject({ create: 1, update: 3 });
    expect(byName.summary.duplicates.by).toEqual({ linkedin: 1, email: 1, name_company: 1 });
    expect(byName.duplicates[2]).toMatchObject({ row: 4, matched_by: "name_company", contact: { id: edsger, name: "Edsger Dijkstra" } });

    // With email matching off, a row with a contact's address is a new contact. A profile always matches.
    const noEmail = plan(w, text, { listId: list, match: { email: false } }).planned;
    expect(noEmail.summary).toMatchObject({ create: 3, update: 1 });
    expect(noEmail.summary.duplicates.by).toEqual({ linkedin: 1, email: null, name_company: null });
  });

  it("does with a duplicate what it is told: leave it out, update the contact, or import it anyway", () => {
    const w = workspace();
    w.contact({ full_name: "Ada", linkedin_url: "https://www.linkedin.com/in/ada/" });
    w.contact({ full_name: "Grace", email: "grace@acme.test" });
    const text = csv("first_name,email,linkedin_url", "Ada,,https://www.linkedin.com/in/ada/", "Grace,grace@acme.test,", "Alan,alan@acme.test,");
    const of = (onDuplicate: OnDuplicate) => plan(w, text, { onDuplicate }).planned;

    expect(of("skip").summary).toMatchObject({ ready: 1, create: 1, update: 0, skipped: 2, joins: 1 });
    expect(of("skip").duplicates.map((row) => row.action)).toEqual(["skip", "skip"]);
    expect(of("update").summary).toMatchObject({ ready: 3, create: 1, update: 2, skipped: 0, joins: 3 });
    // Two contacts cannot share a LinkedIn profile, so that row updates whatever was asked.
    expect(of("import").summary).toMatchObject({ ready: 3, create: 2, update: 1, skipped: 0 });
    expect(of("import").summary.duplicates.forced_update).toBe(1);
    expect(of("import").duplicates.map((row) => row.action)).toEqual(["update", "create"]);
  });

  it("finds the rows of a file that repeat an earlier row, and treats them the same way", () => {
    const w = workspace();
    const grace = w.contact({ full_name: "Grace", email: "grace@acme.test" });
    const text = csv(
      "first_name,email,linkedin_url,title",
      "Ada,ada@acme.test,,CTO",
      "Ada,ADA@acme.test,https://www.linkedin.com/in/ada/,Chief Technology Officer",
      "Ada,,linkedin.com/in/ada,",
      "Grace,grace@acme.test,https://www.linkedin.com/in/grace/,",
      "Grace,,linkedin.com/in/grace,Admiral",
    );
    const updating = plan(w, text).planned;
    // Ada: one contact made, two rows folded into it. Grace: one contact changed, one row folded into her.
    expect(updating.summary).toMatchObject({ ready: 5, create: 1, update: 1, merged: 3, skipped: 0, joins: 2 });
    expect(updating.summary.duplicates).toMatchObject({ existing: 2, in_file: 2, by: { linkedin: 0, email: 1, name_company: null } });
    expect(updating.duplicates.map((row) => [row.row, row.matched_by, row.repeats_row, row.contact?.id ?? null])).toEqual([
      [3, "email", 2, null], [4, "linkedin", 2, null], [5, "email", null, grace], [6, "linkedin", null, grace],
    ]);

    expect(plan(w, text, { onDuplicate: "skip" }).planned.summary).toMatchObject({ ready: 1, create: 1, skipped: 4 });
    // Imported anyway, a repeated email address makes a second contact; a repeated profile cannot.
    expect(plan(w, text, { onDuplicate: "import" }).planned.summary).toMatchObject({ ready: 5, create: 3, update: 0, merged: 2, skipped: 0 });
  });
});

describe("the import", () => {
  it("does what the dry run said, contact by contact", () => {
    const w = workspace();
    const ada = w.contact({ full_name: "Ada Lovelace", first_name: "Ada", linkedin_url: "https://www.linkedin.com/in/ada-lovelace/", title: "Engineer", company: "Acme" });
    const grace = w.contact({ full_name: "Grace Hopper", email: "grace@acme.test", title: "Captain" });
    const list = w.list("Into", [ada]);
    w.field("fleet_size", "Fleet size", "number");
    const { planned, mapping } = plan(w, csv(
      "first_name,last_name,email,linkedin_url,title,fleet_size,last_touch,is_customer",
      "Ada,Lovelace,ada@acme.test,linkedin.com/in/ADA-LOVELACE,,40,2025-08-14,yes",
      "Grace,Hopper,grace@acme.test,https://www.linkedin.com/in/grace/,Rear Admiral,,2025-01-02,no",
      "Alan,Turing,alan@acme.test,,Mathematician,12,,",
      "Alan,Turing,alan@acme.test,,,13,,",
      "Nobody,,,,,,,",
    ), { listId: list });
    const result = applyPlan(db(), w.ws, list, planned, mapping);
    expect(result).toEqual({ created: 1, updated: 2, merged: 1, skipped: 0, errors: 1, error_rows: [{ row: 6, reason: "needs a LinkedIn profile or an email address" }], joined: 2, already_in_list: 1, custom_fields_created: 2 });
    // The same figures the dry run gave.
    expect(planned.summary).toMatchObject({ create: result.created, update: result.updated, merged: result.merged, errors: result.errors, joins: result.joined, already_in_list: result.already_in_list });
    expect(planned.summary.new_fields.map((field) => field.key)).toEqual(["last_touch", "is_customer"]);

    // A cell with something in it replaces what the contact had; an empty one leaves it. The contact keeps its own profile address.
    expect(w.person(ada)).toMatchObject({ email: "ada@acme.test", linkedin_url: "https://www.linkedin.com/in/ada-lovelace/", title: "Engineer", last_name: "Lovelace", full_name: "Ada Lovelace", company: "Acme" });
    expect(w.person(grace)).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/grace/", title: "Rear Admiral", first_name: "Grace" });
    const alan = w.people().find((person) => person.email === "alan@acme.test")!;
    expect(alan).toMatchObject({ full_name: "Alan Turing", title: "Mathematician", linkedin_url: null });
    expect(w.people()).toHaveLength(3);
    expect(w.members(list).sort()).toEqual([ada, grace, alan.id!].sort());

    // Values are kept by the kind of the field; the later row for the same person wins.
    expect(w.value(ada, "fleet_size")).toMatchObject({ value_number: 40 });
    expect(w.value(ada, "last_touch")).toMatchObject({ value_text: "2025-08-14" });
    expect(w.value(ada, "is_customer")).toMatchObject({ value_boolean: 1 });
    expect(w.value(grace, "is_customer")).toMatchObject({ value_boolean: 0 });
    expect(w.value(grace, "fleet_size")).toBeUndefined();
    expect(w.value(alan.id!, "fleet_size")).toMatchObject({ value_number: 13 });
    expect(customFields(db(), w.ws).map((field) => [field.key, field.field_type])).toEqual([["fleet_size", "number"], ["is_customer", "boolean"], ["last_touch", "date"]]);
  });

  it("leaves a skipped duplicate exactly as it was, and out of the list", () => {
    const w = workspace();
    const ada = w.contact({ full_name: "Ada", email: "ada@acme.test", title: "Engineer" });
    const list = w.list("Into");
    const before = w.person(ada);
    const { planned, mapping } = plan(w, csv("first_name,email,title", "Ada,ada@acme.test,CTO", "Alan,alan@acme.test,Mathematician"), { listId: list, onDuplicate: "skip" });
    expect(applyPlan(db(), w.ws, list, planned, mapping)).toMatchObject({ created: 1, updated: 0, skipped: 1, joined: 1 });
    expect(w.person(ada)).toEqual(before);
    expect(w.members(list)).not.toContain(ada);
  });

  it("imports a duplicate anyway as a second contact, and never gives two contacts one profile", () => {
    const w = workspace();
    const ada = w.contact({ full_name: "Ada", email: "ada@acme.test" });
    const other = w.contact({ full_name: "Someone else", linkedin_url: "https://www.linkedin.com/in/shared/" });
    const list = w.list("Into");
    const { planned, mapping } = plan(w, csv("first_name,email,linkedin_url", "Ada,ada@acme.test,", "Ada,ada@acme.test,https://www.linkedin.com/in/shared/"), { listId: list, onDuplicate: "import" });
    // The first row is a second Ada. The second names a profile another contact has, so it changes that contact.
    expect(applyPlan(db(), w.ws, list, planned, mapping)).toMatchObject({ created: 1, updated: 1, errors: 0 });
    expect(w.people().filter((person) => person.email === "ada@acme.test").map((person) => person.id).sort()).toEqual([ada, other, w.people()[2].id].sort());
    expect(w.people().filter((person) => person.linkedin_url === "https://www.linkedin.com/in/shared/")).toHaveLength(1);
  });

  it("does not move a profile from the contact that has it to one matched by email", () => {
    const w = workspace();
    // The file's first row makes a contact with a profile; its second matches Grace by email and names the same profile.
    const grace = w.contact({ full_name: "Grace", email: "grace@acme.test" });
    const list = w.list("Into");
    const { planned, mapping } = plan(w, csv("first_name,email,linkedin_url", "Ada,,https://www.linkedin.com/in/one/", "Grace,grace@acme.test,https://www.linkedin.com/in/one/"), { listId: list });
    expect(applyPlan(db(), w.ws, list, planned, mapping)).toMatchObject({ created: 1, updated: 1, merged: 0 });
    expect(w.person(grace)).toMatchObject({ linkedin_url: null, first_name: "Grace" });
    expect(w.people().filter((person) => person.linkedin_url === "https://www.linkedin.com/in/one/").map((person) => person.first_name)).toEqual(["Ada"]);
  });

  it("changes nothing at all when something goes wrong part-way", () => {
    const w = workspace();
    const list = w.list("Into");
    const { planned, mapping } = plan(w, csv("first_name,email", "Ada,ada@acme.test", "Alan,alan@acme.test"), { listId: list });
    // A second row that cannot be written: the whole import is undone, not half of it kept.
    planned.rows[1].target = { planned: 99 };
    planned.rows[1].action = "update";
    expect(() => applyPlan(db(), w.ws, list, planned, mapping)).toThrow(/Row 3 adds to a row that made no contact/);
    expect(w.people()).toHaveLength(0);
    expect(w.members(list)).toHaveLength(0);
  });
});

describe("an import that is kept while it is set up", () => {
  const start = (w: ReturnType<typeof workspace>, text: string, input: Record<string, unknown> = {}) => {
    const made = createImport(db(), w.ws, null, { csv: text, filename: "acme_q4_prospects.csv", encoding: "utf-8", ...input });
    if ("error" in made) throw new Error(made.error);
    return made;
  };
  const FILE = csv("first_name,email,arr_band,utm_source", "Ada,ada@acme.test,$50M,", "Grace,grace@acme.test,$10M,", "Nobody,,$1M,");

  it("starts from a file with its columns mapped, and says what there is to choose from", () => {
    const w = workspace();
    const list = w.list("Existing list", [w.contact({ full_name: "Member" })]);
    w.insert("lists", { id: `clist-${++seq}`, workspace_id: w.ws, name: "Archived list", archived_at: "2026-10-01 09:00:00" });
    w.insert("workflows", { id: `cwf-${++seq}`, workspace_id: w.ws, name: "Not started" });
    const made = start(w, FILE, { list_id: list });
    expect(made).toMatchObject({
      status: "draft", step: "map", file: { name: "acme_q4_prospects.csv", encoding: "utf-8", delimiter: ",", has_header: true, rows: 3, columns: 4 },
      remembered_from: null, list_mode: "existing", list_id: list, new_list_name: "Acme q4 prospects", match: { email: true, name_company: false }, on_duplicate: "update", after: { mode: "none", campaign_id: null }, result: null,
    });
    expect(made.columns.map((column) => [column.column, column.sample, column.filled, column.detected, column.mapping.kind])).toEqual([
      ["first_name", "Ada", 3, "text", "standard"], ["email", "ada@acme.test", 2, "text", "standard"], ["arr_band", "$50M", 3, "text", "custom"], ["utm_source", null, 0, "text", "ignore"],
    ]);
    // An archived list is not offered; a campaign that has not been started is.
    expect(made.options.lists).toEqual([{ id: list, name: "Existing list", contacts: 1 }]);
    expect(made.options.campaigns).toEqual([expect.objectContaining({ name: "Not started" })]);
    expect(listImports(db(), w.ws)).toEqual([expect.objectContaining({ id: made.id, status: "draft", step: "map", filename: "acme_q4_prospects.csv", rows: 3, list: { id: list, name: "Existing list" }, new_list_name: null })]);
  });

  it("starts as a new list named after the file when the workspace has no list", () => {
    const w = workspace();
    expect(start(w, FILE)).toMatchObject({ list_mode: "new", list_id: null, new_list_name: "Acme q4 prospects" });
    expect([listNameFromFile("webinar-sep24.CSV"), listNameFromFile(".csv")]).toEqual(["Webinar sep24", "Imported contacts"]);
  });

  it("refuses a file there is nothing in", () => {
    const w = workspace();
    const refused = (text: unknown) => createImport(db(), w.ws, null, { csv: text, filename: "x.csv" });
    expect(refused("")).toEqual({ error: "Choose a CSV file with something in it." });
    expect(refused(undefined)).toEqual({ error: "Choose a CSV file with something in it." });
    expect(refused("first_name,email\n")).toEqual({ error: "The file has no rows under its header line." });
    expect(listImports(db(), w.ws)).toEqual([]);
  });

  it("keeps every change, so it can be left at any step and picked up where it was", () => {
    const w = workspace();
    const list = w.list("Existing list");
    const other = w.list("Another list");
    const draft = `cwf-${++seq}`;
    w.insert("workflows", { id: draft, workspace_id: w.ws, name: "Not started" });
    const made = start(w, FILE, { list_id: list });
    const change = (input: Record<string, unknown>) => updateImport(db(), w.ws, made.id, input);

    const mapping = made.columns.map((column) => (column.column === "arr_band" ? { index: column.index, kind: "ignore" } : column.mapping));
    expect(change({ mapping, step: "duplicates" })).toMatchObject({ step: "duplicates" });
    expect(change({ list_id: other, match: { name_company: true }, on_duplicate: "skip" })).toMatchObject({ list_id: other, match: { email: true, name_company: true }, on_duplicate: "skip" });
    expect(change({ list_mode: "new", new_list_name: "Q4 outbound", after: { mode: "existing", campaign_id: draft }, step: "review" })).toMatchObject({ list_mode: "new", new_list_name: "Q4 outbound" });

    // Someone opening it later finds all of it as it was left.
    const again = readImport(db(), w.ws, made.id)!;
    expect(again).toMatchObject({ status: "draft", step: "review", list_mode: "new", list_id: other, new_list_name: "Q4 outbound", match: { email: true, name_company: true }, on_duplicate: "skip", after: { mode: "existing", campaign_id: draft } });
    expect(again.columns.map((column) => column.mapping.kind)).toEqual(["standard", "standard", "ignore", "ignore"]);
    expect(listImports(db(), w.ws)[0]).toMatchObject({ step: "review", list: null, new_list_name: "Q4 outbound" });

    // What cannot be kept is refused, and what was there stays.
    expect(change({ list_id: "not-a-list" })).toEqual({ error: "That list is not in this workspace" });
    expect(change({ on_duplicate: "merge" })).toEqual({ error: "on_duplicate must be one of skip, update, import" });
    expect(change({ step: "upload" })).toEqual({ error: "step must be one of map, duplicates, review" });
    expect(change({ match: { email: "yes" } })).toEqual({ error: "match takes email and name_company, each true or false" });
    expect(change({ after: { mode: "existing", campaign_id: "not-a-campaign" } })).toEqual({ error: "Choose a campaign that has not been started yet" });
    expect(change({ mapping: [{ index: 0, kind: "standard", field: "email" }, { index: 1, kind: "standard", field: "email" }] })).toMatchObject({ error: expect.stringMatching(/Two columns are mapped to Email/) });
    expect(readImport(db(), w.ws, made.id)).toMatchObject({ step: "review", on_duplicate: "skip" });
    // Another workspace cannot see or change it.
    const stranger = workspace();
    expect(readImport(db(), stranger.ws, made.id)).toBeNull();
    expect(updateImport(db(), stranger.ws, made.id, { step: "map" })).toBeNull();
    expect(checkImport(db(), stranger.ws, made.id)).toBeNull();
    expect(runImport(db(), stranger.ws, made.id, null)).toBeNull();
  });

  it("maps the columns by their names again when asked, and afresh when the file is replaced", () => {
    const w = workspace();
    const made = start(w, FILE, { list_id: w.list("Existing list") });
    updateImport(db(), w.ws, made.id, { mapping: made.columns.map((column) => ({ index: column.index, kind: "ignore" })), step: "review" });
    expect((updateImport(db(), w.ws, made.id, { automap: true }) as ImportView).columns.map((column) => column.mapping.kind)).toEqual(["standard", "standard", "custom", "ignore"]);

    const replaced = updateImport(db(), w.ws, made.id, { csv: csv("Full Name;Work Email", "Ada Lovelace;ada@acme.test"), filename: "second.csv" }) as ImportView;
    expect(replaced).toMatchObject({ step: "map", file: { name: "second.csv", delimiter: ";", rows: 1, columns: 2 } });
    expect(replaced.columns.map((column) => (column.mapping.kind === "standard" ? column.mapping.field : null))).toEqual(["full_name", "email"]);
    expect(updateImport(db(), w.ws, made.id, { csv: "", filename: "empty.csv" })).toEqual({ error: "Choose a CSV file with something in it." });
    expect(readImport(db(), w.ws, made.id)).toMatchObject({ file: { name: "second.csv" } });
  });

  it("says why it cannot run yet, apart from its rows", () => {
    const w = workspace();
    const made = start(w, FILE);
    const problem = () => (checkImport(db(), w.ws, made.id) as { problem: string | null }).problem;
    updateImport(db(), w.ws, made.id, { mapping: [{ index: 0, kind: "standard", field: "first_name" }] });
    expect(problem()).toBe("Map one column to LinkedIn profile or Email, so each row can be told apart.");
    updateImport(db(), w.ws, made.id, { automap: true, new_list_name: "  " });
    expect(problem()).toBe("Give the new list a name.");
    updateImport(db(), w.ws, made.id, { list_mode: "existing" });
    expect(problem()).toBe("Choose the list to import into.");
    expect(runImport(db(), w.ws, made.id, null)).toEqual({ error: "Choose the list to import into." });
    const list = w.list("Soon gone");
    updateImport(db(), w.ws, made.id, { list_id: list });
    expect(problem()).toBeNull();
    db().prepare("DELETE FROM lists WHERE id = ?").run(list);
    // Deleting the list clears it from the import: it has to be chosen again.
    expect(problem()).toBe("Choose the list to import into.");
    // A file none of whose rows can go in.
    const hopeless = start(w, csv("first_name,email", "Ada,", "Grace,nope"), { list_id: w.list("Kept") });
    expect((checkImport(db(), w.ws, hopeless.id) as { problem: string }).problem).toBe("No row of this file can be imported as it is set up.");
  });

  it("runs once: makes the list, writes the rows, drops the file, and says it is finished", () => {
    const w = workspace();
    const user = `${w.ws}-member`;
    w.insert("users", { id: user, email: `${user}@example.test`, name: "Dan Okafor", password_hash: "x" });
    w.insert("workspace_members", { workspace_id: w.ws, user_id: user, role: "member" });
    const made = createImport(db(), w.ws, user, { csv: FILE, filename: "acme_q4_prospects.csv" }) as ImportView;
    expect(made.created_by).toEqual({ id: user, name: "Dan Okafor" });
    updateImport(db(), w.ws, made.id, { list_mode: "new", new_list_name: " Q4 outbound " });
    const check = checkImport(db(), w.ws, made.id) as { problem: string | null; summary: { create: number; errors: number; list_before: number; list_after: number }; duplicate_rows: number };
    expect(check).toMatchObject({ problem: null, summary: { create: 2, errors: 1, list_before: 0, list_after: 2 }, duplicate_rows: 0 });

    const done = runImport(db(), w.ws, made.id, user) as { import: ImportView; result: { list: { id: string; name: string } } };
    expect(done.result).toMatchObject({ created: 2, updated: 0, errors: 1, joined: 2, custom_fields_created: 1, new_list: true, rows: 3, list: { name: "Q4 outbound" }, error_rows: [{ row: 4, reason: "needs a LinkedIn profile or an email address" }] });
    expect(done.import).toMatchObject({ status: "done", list_mode: "existing", list_id: done.result.list.id, columns: [], result: { created: 2 } });
    expect(done.import.finished_at).toEqual(expect.any(String));
    // The list is its maker's, and knows it came from this file.
    expect(db().prepare("SELECT name, owner_id, source, source_detail FROM lists WHERE id = ?").get(done.result.list.id)).toEqual({ name: "Q4 outbound", owner_id: user, source: "csv", source_detail: "acme_q4_prospects.csv" });
    expect(w.members(done.result.list.id)).toHaveLength(2);
    expect(db().prepare("SELECT COUNT(*) AS c FROM csv_import_files WHERE import_id = ?").get(made.id)).toEqual({ c: 0 });

    // Announced the way a Sales Navigator import is.
    const event = db().prepare("SELECT type, entity_type, entity_id, payload_json FROM domain_events WHERE workspace_id = ? AND type = 'import.finished'").get(w.ws) as { entity_id: string; payload_json: string };
    expect(event).toMatchObject({ entity_type: "list", entity_id: done.result.list.id });
    expect(JSON.parse(event.payload_json)).toMatchObject({ import_id: made.id, source: "csv", imported: 2, updated: 0, skipped: 1 });
    expect(listNotifications(w.ws, user, "member")[0]).toMatchObject({ kind: "import.finished", title: "Import into Q4 outbound finished", body: "2 contacts new, 0 updated, 1 left out.", link: `/lists/${done.result.list.id}` });

    // It cannot be run, checked or changed again.
    expect(runImport(db(), w.ws, made.id, user)).toEqual({ error: "This import has already run." });
    expect(checkImport(db(), w.ws, made.id)).toEqual({ error: "This import has already run." });
    expect(updateImport(db(), w.ws, made.id, { step: "map" })).toEqual({ error: "This import has already run." });
    expect(listImports(db(), w.ws)).toEqual([expect.objectContaining({ id: made.id, status: "done", list: { id: done.result.list.id, name: "Q4 outbound" }, by: "Dan Okafor" })]);
  });

  it("remembers how a file's columns were mapped, for the next file with the same headers in any order", () => {
    const w = workspace();
    const list = w.list("Into");
    const first = start(w, csv("Vorname,E-Mail,arr_band,notes_internal", "Ada,ada@acme.test,$50M,Met at a fair"), { list_id: list });
    // Linki does not know "Vorname"; the person importing says what it is, and leaves a column out.
    updateImport(db(), w.ws, first.id, { mapping: [
      { index: 0, kind: "standard", field: "first_name" }, { index: 1, kind: "standard", field: "email" },
      { index: 2, kind: "custom", key: "arr", name: "ARR band", fieldType: "text" }, { index: 3, kind: "ignore" },
    ] });
    expect(runImport(db(), w.ws, first.id, null)).toMatchObject({ result: { created: 1 } });

    const second = createImport(db(), w.ws, null, { csv: csv("notes_internal,arr_band,E-Mail,Vorname", "Seen in Berlin,$10M,grace@acme.test,Grace"), filename: "acme_q1.csv" }) as ImportView;
    expect(second.remembered_from).toBe("acme_q4_prospects.csv");
    expect(second.columns.map((column) => (column.mapping.kind === "standard" ? column.mapping.field : column.mapping.kind === "custom" ? column.mapping.key : null))).toEqual([null, "arr", "email", "first_name"]);
    // A file with other headers is mapped by their names, as before.
    const third = createImport(db(), w.ws, null, { csv: csv("Vorname,E-Mail", "Alan,alan@acme.test"), filename: "other.csv" }) as ImportView;
    expect(third.remembered_from).toBeNull();
    expect(third.columns[0].mapping).toMatchObject({ kind: "custom", key: "vorname" });
    // Auto-map sets the remembered mapping aside.
    expect((updateImport(db(), w.ws, second.id, { automap: true }) as ImportView).remembered_from).toBeNull();
    // Another workspace has its own memory.
    const stranger = workspace();
    expect((createImport(db(), stranger.ws, null, { csv: csv("Vorname,E-Mail,arr_band,notes_internal", "Ada,ada@acme.test,$50M,x"), filename: "x.csv" }) as ImportView).remembered_from).toBeNull();
  });

  it("does not offer a remembered mapping that names something it cannot map to any more", () => {
    const w = workspace();
    const file = readCsv(csv("a,b", "1,2"));
    rememberMapping(db(), w.ws, null, file, [{ index: 0, column: "a", kind: "standard", field: "email" }, { index: 1, column: "b", kind: "standard", field: "email" }], "broken.csv");
    expect(db().prepare("SELECT COUNT(*) AS c FROM csv_import_mappings WHERE workspace_id = ? AND signature = ?").get(w.ws, headerSignature(file.columns))).toEqual({ c: 1 });
    expect((createImport(db(), w.ws, null, { csv: csv("a,b", "x@acme.test,2"), filename: "next.csv" }) as ImportView).remembered_from).toBeNull();
  });

  it("drops an import nobody finished after thirty days, when the next one is started", () => {
    const w = workspace();
    const old = start(w, FILE);
    const recent = start(w, FILE);
    db().prepare("UPDATE csv_imports SET updated_at = datetime('now', '-31 days') WHERE id = ?").run(old.id);
    expect(listImports(db(), w.ws).map((item) => item.id)).toEqual([recent.id]);
    start(w, FILE);
    expect(readImport(db(), w.ws, old.id)).toBeNull();
    expect(db().prepare("SELECT COUNT(*) AS c FROM csv_import_files WHERE import_id = ?").get(old.id)).toEqual({ c: 0 });
    expect(readImport(db(), w.ws, recent.id)).not.toBeNull();
  });
});

describe("the import routes", () => {
  const FILE = csv("first_name,email", "Ada,ada@acme.test", "Grace,grace@acme.test");

  it("take an import from a file to a list, for a member", async () => {
    const w = workspace();
    const list = w.list("Into");
    const started = await w.call(importsHandler, "POST", { body: { csv: FILE, filename: "people.csv", list_id: list } });
    expect(started.statusCode).toBe(201);
    const id = (started.body.import as ImportView).id;
    expect((await w.call(importsHandler, "GET")).body.imports).toEqual([expect.objectContaining({ id, status: "draft" })]);
    expect((await w.call(importHandler, "GET", { query: { id } })).body.import).toMatchObject({ id, file: { name: "people.csv", rows: 2 } });
    expect((await w.call(importHandler, "PATCH", { query: { id }, body: { step: "review", on_duplicate: "skip" } })).body.import).toMatchObject({ step: "review", on_duplicate: "skip" });
    expect((await w.call(checkHandler, "GET", { query: { id } })).body).toMatchObject({ problem: null, summary: { ready: 2, create: 2 } });
    const ran = await w.call(runHandler, "POST", { query: { id } });
    expect(ran.body).toMatchObject({ result: { created: 2, list: { id: list } }, import: { status: "done" } });
    expect(w.members(list)).toHaveLength(2);
    // Once only.
    expect((await w.call(runHandler, "POST", { query: { id } })).statusCode).toBe(400);
    expect((await w.call(checkHandler, "GET", { query: { id } })).statusCode).toBe(409);
    expect((db().prepare("SELECT action FROM audit_logs WHERE workspace_id = ? ORDER BY rowid").all(w.ws) as { action: string }[]).map((row) => row.action)).toEqual(["csv_import.started", "csv_import.finished"]);
  });

  it("say what is wrong with a request, and do not find what is not there", async () => {
    const w = workspace();
    expect((await w.call(importsHandler, "POST", { body: { csv: "   " } }))).toMatchObject({ statusCode: 400, body: { error: "Choose a CSV file with something in it." } });
    for (const handler of [importHandler, checkHandler]) expect((await w.call(handler, "GET", { query: { id: "nothing" } })).statusCode).toBe(404);
    expect((await w.call(runHandler, "POST", { query: { id: "nothing" } })).statusCode).toBe(404);
    expect((await w.call(importHandler, "DELETE", { query: { id: "nothing" } })).statusCode).toBe(404);
    const id = ((await w.call(importsHandler, "POST", { body: { csv: FILE, filename: "people.csv" } })).body.import as ImportView).id;
    expect(await w.call(importHandler, "PATCH", { query: { id }, body: { on_duplicate: "merge" } })).toMatchObject({ statusCode: 400 });
    expect(await w.call(runHandler, "POST", { query: { id }, body: {} })).toMatchObject({ statusCode: 200 });
    for (const [handler, method] of [[importsHandler, "PUT"], [importHandler, "POST"], [checkHandler, "POST"], [runHandler, "GET"]] as const) expect((await w.call(handler, method, { query: { id } })).statusCode).toBe(405);
  });

  it("throw an import away, file and all", async () => {
    const w = workspace();
    const id = ((await w.call(importsHandler, "POST", { body: { csv: FILE, filename: "people.csv" } })).body.import as ImportView).id;
    expect((await w.call(importHandler, "DELETE", { query: { id } })).statusCode).toBe(204);
    expect((await w.call(importHandler, "GET", { query: { id } })).statusCode).toBe(404);
    expect(db().prepare("SELECT COUNT(*) AS c FROM csv_import_files WHERE import_id = ?").get(id)).toEqual({ c: 0 });
    expect(w.people()).toHaveLength(0);
  });

  it("refuse a viewer everything: importing is a member's job", async () => {
    const w = workspace();
    const id = ((await w.call(importsHandler, "POST", { body: { csv: FILE, filename: "people.csv" } })).body.import as ImportView).id;
    const viewer = { role: "viewer", query: { id } };
    expect((await w.call(importsHandler, "GET", viewer)).statusCode).toBe(403);
    expect((await w.call(importsHandler, "POST", { ...viewer, body: { csv: FILE } })).statusCode).toBe(403);
    expect((await w.call(importHandler, "GET", viewer)).statusCode).toBe(403);
    expect((await w.call(importHandler, "PATCH", { ...viewer, body: { step: "review" } })).statusCode).toBe(403);
    expect((await w.call(importHandler, "DELETE", viewer)).statusCode).toBe(403);
    expect((await w.call(checkHandler, "GET", viewer)).statusCode).toBe(403);
    expect((await w.call(runHandler, "POST", viewer)).statusCode).toBe(403);
    expect(readImport(db(), w.ws, id)).toMatchObject({ status: "draft", step: "map" });
  });
});

describe("the older one-call import route", () => {
  const FILE = csv("first_name,email,time_zone", "Ada,ada@acme.test,Europe/London", "Grace,grace@acme.test,Europe/Berlin");

  it("imports as it always has when given no options, and keeps no record", async () => {
    const w = workspace();
    const ada = w.contact({ full_name: "Ada", email: "ada@acme.test", title: "Engineer" });
    const list = w.list("Into", [ada]);
    const res = await w.call(legacyHandler, "POST", { query: { id: list }, body: { csv: FILE, filename: "people.csv" } });
    expect(res.body).toEqual({ imported: 1, updated: 0, skipped: 1, errors: [] });
    expect(w.person(ada)).toMatchObject({ time_zone: "Europe/London", title: "Engineer" });
    expect(listImports(db(), w.ws)).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) AS c FROM csv_import_mappings WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
  });

  it("takes a mapping to the time zone field, which it used to refuse", async () => {
    const w = workspace();
    const list = w.list("Into");
    const mapping = [{ column: "email", kind: "standard", field: "email" }, { column: "tz", kind: "standard", field: "time_zone" }];
    const res = await w.call(legacyHandler, "POST", { query: { id: list }, body: { csv: csv("email,tz", "ada@acme.test,Europe/London"), mapping } });
    expect(res).toMatchObject({ statusCode: 200, body: { imported: 1 } });
    expect(w.people()[0]).toMatchObject({ time_zone: "Europe/London" });
    expect(await w.call(legacyHandler, "POST", { query: { id: list }, body: { csv: FILE, mapping: [{ column: "email", kind: "standard", field: "password_hash" }] } })).toMatchObject({ statusCode: 400 });
  });

  it("can say what an import would do without doing it, and treat duplicates as asked", async () => {
    const w = workspace();
    const ada = w.contact({ full_name: "Ada", email: "ada@acme.test", title: "Engineer" });
    const list = w.list("Into");
    const body = { csv: csv("first_name,email,title", "Ada,ada@acme.test,CTO", "Grace,grace@acme.test,Admiral", "Nobody,,"), filename: "people.csv" };

    const dry = await w.call(legacyHandler, "POST", { query: { id: list }, body: { ...body, dry_run: true } });
    expect(dry.body).toMatchObject({ dry_run: true, summary: { rows: 3, ready: 2, create: 1, update: 1, errors: 1, duplicates: { existing: 1 } } });
    expect(w.people()).toHaveLength(1);
    expect(w.members(list)).toHaveLength(0);

    const skipped = await w.call(legacyHandler, "POST", { query: { id: list }, body: { ...body, on_duplicate: "skip" } });
    expect(skipped.body).toEqual({ imported: 1, updated: 0, merged: 0, skipped: 1, already_in_list: 0, errors: ["Row 4: needs a LinkedIn profile or an email address"], customFieldsCreated: 0 });
    expect(w.person(ada)).toMatchObject({ title: "Engineer" });
    expect(w.members(list)).not.toContain(ada);
    // A named mapping works with the options too; a file that says nothing about who a row is does not.
    const mapped = await w.call(legacyHandler, "POST", { query: { id: list }, body: { csv: csv("Mail,Role", "ada@acme.test,CTO"), mapping: [{ column: "mail", kind: "standard", field: "email" }, { column: "role", kind: "standard", field: "title" }], match: { email: true }, dry_run: true } });
    expect(mapped.body).toMatchObject({ summary: { update: 1 } });
    expect(await w.call(legacyHandler, "POST", { query: { id: list }, body: { csv: csv("first_name", "Ada"), dry_run: true } })).toMatchObject({ statusCode: 400 });
    expect(await w.call(legacyHandler, "POST", { query: { id: list }, body: { ...body, on_duplicate: "merge" } })).toMatchObject({ statusCode: 400 });
    expect(await w.call(legacyHandler, "POST", { query: { id: list }, body: { ...body, match: { email: "yes" } } })).toMatchObject({ statusCode: 400 });
  });
});
