// CSV exports: what a cell looks like on the page of a file, how a long file is sent, who
// may take one, and that each file holds the rows its screen was showing. Real (throwaway)
// database.
import { describe, expect, it } from "vitest";
import type { ServerResponse } from "http";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { csvCell, csvFilename, csvLine, sendCsv } from "@/lib/export/csv";
import exportRoute from "@/pages/api/export/[resource]";
import contactList from "@/pages/api/targets/index";
import prospectList from "@/pages/api/workflows/[id]/prospects";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

/** A response that keeps what is written to it. `slow` makes every write report a full buffer. */
function response(slow = false) {
  const res = {
    statusCode: 200, destroyed: false, ended: false, body: undefined as unknown, text: "", headers: {} as Record<string, string>, waits: 0,
    setHeader(name: string, value: unknown) { res.headers[name.toLowerCase()] = String(value); return res; },
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
    write(chunk: string) { res.text += chunk; return !slow; },
    end() { res.ended = true; return res; },
    // Asked to wait for the reader: answer on the next turn of the loop.
    once(event: string, listener: () => void) { if (event === "drain") { res.waits++; setImmediate(listener); } return res; },
    off() { return res; },
  };
  return res;
}

/** A CSV file back into rows of cells. */
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  return rows;
}

async function download(resource: string, headers: Record<string, string>, query: Record<string, string> = {}, method = "GET") {
  const res = response();
  await exportRoute({ method, query: { resource, ...query }, headers, body: {} } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  const rows = res.statusCode === 200 ? parse(res.text) : [];
  const [header = [], ...data] = rows;
  /** The file as objects keyed by column heading. */
  const records = data.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i]])));
  return { res, header, data, records };
}

async function json(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, query: Record<string, string>, headers: Record<string, string>) {
  const res = response();
  await handler({ method: "GET", query, headers, body: {} } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res.body as Record<string, unknown>;
}

function workspace() {
  const n = ++seq;
  const ws = `ws-csv-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const w = {
    ws, n, list: `csv-list-${n}`,
    manager: ctxHeaders(ws, { userId: `csv-manager-${n}`, role: "manager" }),
    member: ctxHeaders(ws, { userId: `csv-member-${n}`, role: "member" }),
    contact(name: string, extra: Record<string, unknown> = {}, inList = false) {
      const id = `csv-target-${++seq}`;
      const row: Record<string, unknown> = { id, workspace_id: ws, full_name: name, linkedin_url: `https://www.linkedin.com/in/${id}/`, ...extra };
      const keys = Object.keys(row);
      db().prepare(`INSERT INTO targets (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
      if (inList) db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(w.list, id);
      return id;
    },
  };
  db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'Founders / Q4')").run(w.list, ws);
  return w;
}

describe("a cell", () => {
  it("is quoted only when it has to be", () => {
    expect(csvCell("Lee Lead")).toBe("Lee Lead");
    expect(csvCell("Lead, Lee")).toBe('"Lead, Lee"');
    expect(csvCell('the "best" one')).toBe('"the ""best"" one"');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell(" padded ")).toBe('" padded "');
  });

  it("is empty for nothing, and plain for numbers", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(-12.5)).toBe("-12.5");
  });

  it.each(["=SUM(A1:A9)", "@SUM(1+1)", "+HYPERLINK(\"http://evil.test\",\"x\")", "-2+3+cmd|' /C calc'!A0", "\t=1+1", "\r=1+1", "=1+1"])("is made plain text when a spreadsheet would run it: %j", (value) => {
    const cell = parse(`${csvCell(value)}\r\n`)[0][0];
    expect(cell).toBe(`'${value}`);
  });

  it.each(["+44 20 7946 0958", "+1 (415) 555-0100", "+1-415-555-0100", "-12.5", "+7"])("leaves a phone number or a signed figure as it is: %s", (value) => {
    expect(csvCell(value)).toBe(value);
  });

  it("ends a line the way the format says", () => {
    expect(csvLine(["a", null, 3])).toBe("a,,3\r\n");
  });

  it("gets a file name with nothing in it a header could choke on", () => {
    expect(csvFilename('linki-list-Founders / "Q4"\r\n-2026')).toBe("linki-list-Founders-Q4-2026.csv");
    expect(csvFilename("///")).toBe("export.csv");
  });
});

describe("sending a file", () => {
  const columns = [{ header: "N", value: (row: { n: number }) => row.n }];
  const numbers = (count: number) => (limit: number, offset: number) => Array.from({ length: Math.max(0, Math.min(limit, count - offset)) }, (_, i) => ({ n: offset + i }));

  it("starts with the mark Excel needs and the headings", async () => {
    const res = response();
    await sendCsv(res as unknown as ServerResponse, "x", columns, numbers(2));
    expect(res.text).toBe("﻿N\r\n0\r\n1\r\n");
    expect(res.headers).toMatchObject({ "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="x.csv"', "cache-control": "no-store" });
    expect(res.ended).toBe(true);
  });

  it("asks for a batch at a time until one comes back short", async () => {
    const asked: number[] = [];
    const page = numbers(2500);
    const res = response();
    const sent = await sendCsv(res as unknown as ServerResponse, "x", columns, (limit, offset) => { asked.push(offset); return page(limit, offset); });
    expect(asked).toEqual([0, 1000, 2000]);
    expect(sent).toBe(2500);
    expect(parse(res.text)).toHaveLength(2501);
  });

  it("asks once more when the last batch was exactly full, and gets nothing", async () => {
    const asked: number[] = [];
    const page = numbers(1000);
    await sendCsv(response() as unknown as ServerResponse, "x", columns, (limit, offset) => { asked.push(offset); return page(limit, offset); });
    expect(asked).toEqual([0, 1000]);
  });

  it("waits for a slow reader instead of piling the file up in memory", async () => {
    const res = response(true);
    await sendCsv(res as unknown as ServerResponse, "x", columns, numbers(1500));
    expect(res.waits).toBe(3);   // the headings and two batches
    expect(parse(res.text)).toHaveLength(1501);
  });

  it("sends nothing, not even headings, when the first batch cannot be read", async () => {
    const res = response();
    await expect(sendCsv(res as unknown as ServerResponse, "x", columns, () => { throw new Error("no such column"); })).rejects.toThrow("no such column");
    expect(res.text).toBe("");
    expect(res.headers).toEqual({});
  });

  it("stops asking once the reader has gone", async () => {
    const res = response();
    let asked = 0;
    await sendCsv(res as unknown as ServerResponse, "x", columns, (limit) => { asked++; res.destroyed = true; return Array.from({ length: limit }, (_, n) => ({ n })); });
    expect(asked).toBe(1);
  });
});

describe("who may export", () => {
  it("is a manager, and the export is written down", async () => {
    const w = workspace();
    w.contact("Lee Lead");
    expect((await download("contacts", w.member)).res.statusCode).toBe(403);
    const { res, data } = await download("contacts", w.manager, { search: "Lee" });
    expect(res.statusCode).toBe(200);
    expect(data).toHaveLength(1);
    const audit = db().prepare("SELECT user_id, metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'export.created'").all(w.ws) as Array<{ user_id: string; metadata_json: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(`csv-manager-${w.n}`);
    expect(JSON.parse(audit[0].metadata_json)).toMatchObject({ resource: "contacts", rows: 1, filters: { search: "Lee" } });
  });

  it("gets nothing for an export that does not exist, or by any way but reading", async () => {
    const w = workspace();
    expect((await download("passwords", w.manager)).res.statusCode).toBe(404);
    expect((await download("contacts", w.manager, {}, "POST")).res.statusCode).toBe(405);
  });
});

describe("contacts", () => {
  it("holds the workspace's contacts and nobody else's", async () => {
    const w = workspace();
    const other = workspace();
    w.contact("Ada Byron", { email: "ada@acme.test", phone: "+44 20 7946 0958", company: "Acme, Inc." });
    other.contact("Someone Else");
    const { records } = await download("contacts", w.manager);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ Name: "Ada Byron", Email: "ada@acme.test", Phone: "+44 20 7946 0958", Company: "Acme, Inc." });
  });

  it.each([
    [{ search: "acme" }],
    [{ "f[0][field]": "seniority", "f[0][op]": "is", "f[0][value]": "Director" }],
    [{ "f[0][field]": "connection_status", "f[0][op]": "is", "f[0][value]": "connected" }],
    [{ "f[0][field]": "email", "f[0][op]": "is_set", "f[1][field]": "country", "f[1][op]": "is_not", "f[1][value]": "France" }],
    [{ list: "yes" }],
    [{ list: "yes", search: "lee" }],
  ] as Array<[Record<string, string>]>)("has the rows the contacts page shows for %j", async (given) => {
    const w = workspace();
    w.contact("Lee Lead", { company: "Acme", seniority: "Director", email: "lee@acme.test", country: "France", degree: 1 }, true);
    w.contact("Mo Mail", { company: "Globex", seniority: "director", email: "mo@globex.test", country: "Spain" }, true);
    w.contact("Ada Byron", { company: "Acme Labs", seniority: "VP", degree: 1 });
    w.contact("Zed Zero", { title: "Head of Acme relations", country: "Spain", email: "zed@zero.test" });
    const { list, ...rest } = given;
    const query: Record<string, string> = list ? { ...rest, list_id: w.list } : rest;

    const onScreen = ((await json(contactList, { ...query, limit: "50" }, w.manager)).contacts as Array<{ full_name: string }>).map((row) => row.full_name);
    const inFile = (await download("contacts", w.manager, query)).records.map((row) => row.Name);
    expect(onScreen.length).toBeGreaterThan(0);
    expect(onScreen.length).toBeLessThan(4);
    expect(inFile).toEqual(onScreen);
  });

  it("carries the workspace's own fields as columns", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    w.contact("Mo Mail");
    db().prepare("INSERT INTO custom_field_definitions (id, workspace_id, name, key, field_type) VALUES (?, ?, 'Pain point', 'pain_point', 'text'), (?, ?, 'Budget', 'budget', 'number'), (?, ?, 'Signed NDA', 'nda', 'boolean')")
      .run(`f1-${w.n}`, w.ws, `f2-${w.n}`, w.ws, `f3-${w.n}`, w.ws);
    db().prepare("INSERT INTO contact_custom_values (workspace_id, target_id, field_id, value_text, value_number, value_boolean) VALUES (?, ?, ?, 'churn', NULL, NULL), (?, ?, ?, NULL, 5000, NULL), (?, ?, ?, NULL, NULL, 1)")
      .run(w.ws, lee, `f1-${w.n}`, w.ws, lee, `f2-${w.n}`, w.ws, lee, `f3-${w.n}`);
    const { records } = await download("contacts", w.manager);
    expect(records[0]).toMatchObject({ Name: "Lee Lead", "Pain point": "churn", Budget: "5000", "Signed NDA": "yes" });
    expect(records[1]).toMatchObject({ Name: "Mo Mail", "Pain point": "", Budget: "", "Signed NDA": "" });
  });

  it("makes a contact's name plain text when it is written like a formula", async () => {
    const w = workspace();
    w.contact('=HYPERLINK("http://evil.test","Lee")');
    const { records } = await download("contacts", w.manager);
    expect(records[0].Name).toBe(`'=HYPERLINK("http://evil.test","Lee")`);
  });

  it("holds every contact once when there are more than a batch of them", async () => {
    const w = workspace();
    const insert = db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, ?, ?)");
    // Many share a name, so only the unique tie-break keeps the batches from overlapping.
    db().transaction(() => { for (let i = 0; i < 2100; i++) insert.run(`csv-bulk-${w.n}-${i}`, w.ws, `Person ${i % 7}`, `https://www.linkedin.com/in/csv-bulk-${w.n}-${i}/`); })();
    const { records } = await download("contacts", w.manager);
    expect(records).toHaveLength(2100);
    expect(new Set(records.map((row) => row["LinkedIn URL"])).size).toBe(2100);
  });
});

describe("a list's members", () => {
  it("are that list's contacts, in a file named after it", async () => {
    const w = workspace();
    w.contact("In List", {}, true);
    w.contact("Not In List");
    const { res, records } = await download("list_members", w.manager, { list_id: w.list });
    expect(records.map((row) => row.Name)).toEqual(["In List"]);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="linki-list-Founders-Q4-\d{4}-\d\d-\d\d\.csv"$/);
  });

  it("need a list, and one of this workspace's", async () => {
    const w = workspace();
    const other = workspace();
    other.contact("Theirs", {}, true);
    expect((await download("list_members", w.manager)).res.statusCode).toBe(400);
    expect((await download("list_members", w.manager, { list_id: other.list })).res.statusCode).toBe(404);
    expect((await download("contacts", w.manager, { list_id: other.list })).res.statusCode).toBe(404);
  });
});

describe("replies", () => {
  function withReplies() {
    const w = workspace();
    const lee = w.contact("Lee Lead", { company: "Acme" });
    w.contact("Lin Linked", { last_replied_at: "2026-10-02 09:00:00" });
    const reply = (id: string, target: string | null, from: string, at: string, extra: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = { id, workspace_id: w.ws, target_id: target, from_email: from, subject: "Re: Quick question", body_text: "Sounds good,\ncall me.", received_at: at, ...extra };
      const keys = Object.keys(row);
      db().prepare(`INSERT INTO email_replies (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
    };
    reply(`r1-${w.n}`, lee, "lee@acme.test", "2026-10-01 10:00:00", { classification_json: JSON.stringify({ kind: "positive", summary: "Wants a call" }), sentiment: "positive", inbox_status: "resolved" });
    reply(`r2-${w.n}`, lee, "lee@acme.test", "2026-10-03 10:00:00");
    reply(`r3-${w.n}`, null, "gone@nowhere.test", "2026-10-04 10:00:00");   // its contact was deleted
    return w;
  }

  it("are one row each, newest first, including one whose contact is gone and one made on LinkedIn", async () => {
    const w = withReplies();
    const { records } = await download("replies", w.manager);
    expect(records.map((row) => [row.Received, row.Channel, row.From, row.Contact])).toEqual([
      ["2026-10-04 10:00:00", "email", "gone@nowhere.test", ""],
      ["2026-10-03 10:00:00", "email", "lee@acme.test", "Lee Lead"],
      ["2026-10-02 09:00:00", "linkedin", "", "Lin Linked"],
      ["2026-10-01 10:00:00", "email", "lee@acme.test", "Lee Lead"],
    ]);
    expect(records[3]).toMatchObject({ Verdict: "positive", Summary: "Wants a call", Sentiment: "positive", Status: "resolved", Message: "Sounds good,\ncall me." });
    expect(records[1]).toMatchObject({ Verdict: "", Status: "open" });
  });

  it("take the inbox's filters", async () => {
    const w = withReplies();
    expect((await download("replies", w.manager, { status: "resolved" })).records.map((row) => row.Received)).toEqual(["2026-10-01 10:00:00"]);
    expect((await download("replies", w.manager, { channel: "linkedin" })).records.map((row) => row.Contact)).toEqual(["Lin Linked"]);
    expect((await download("replies", w.manager, { channel: "email" })).records).toHaveLength(3);
  });

  it("are only this workspace's", async () => {
    const w = withReplies();
    const other = workspace();
    expect((await download("replies", other.manager)).records).toHaveLength(0);
    expect((await download("replies", w.manager)).records).toHaveLength(4);
  });
});

describe("a campaign's prospects and analytics", () => {
  function campaign() {
    const w = workspace();
    const wf = `csv-wf-${w.n}`, run = `csv-run-${w.n}`;
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Founders outreach', ?)").run(wf, w.ws);
    db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds) VALUES (?, ?, 1, 'linkedin', 'visit', 0)").run(`${wf}-s1`, wf);
    db().prepare("INSERT INTO runs (id, workflow_id, status, workspace_id) VALUES (?, ?, 'running', ?)").run(run, wf, w.ws);
    const enrol = (name: string, state: string, extra: Record<string, unknown> = {}) => {
      const target = w.contact(name, extra);
      db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`rp-${target}`, run, target);
      db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'linkedin', ?, 0)").run(`rt-${target}`, `rp-${target}`, state);
    };
    enrol("Ada Active", "in_progress", { company: "Acme" });
    enrol("Fay Failed", "failed");
    enrol("Cy Complete", "completed", { company: "Acme" });
    return { ...w, wf };
  }

  it.each([[{}], [{ state: "failed" }], [{ state: "in_progress,completed" }], [{ search: "Acme" }], [{ step: "1", track: "linkedin" }]] as Array<[Record<string, string>]>)("has the prospects the table shows for %j", async (query) => {
    const c = campaign();
    const onScreen = ((await json(prospectList, { id: c.wf, ...query }, c.manager)).prospects as Array<{ full_name: string; state: string }>).map((row) => [row.full_name, row.state]);
    const inFile = (await download("prospects", c.manager, { workflow_id: c.wf, ...query })).records.map((row) => [row.Name, row.State]);
    expect(onScreen.length).toBeGreaterThan(0);
    expect(inFile).toEqual(onScreen);
  });

  it("need a campaign, and one of this workspace's", async () => {
    const c = campaign();
    const other = workspace();
    for (const resource of ["prospects", "analytics"]) {
      expect((await download(resource, c.manager)).res.statusCode).toBe(400);
      expect((await download(resource, other.manager, { workflow_id: c.wf })).res.statusCode).toBe(404);
    }
  });

  it("gives the analytics as one figure per row", async () => {
    const c = campaign();
    const { header, records, res } = await download("analytics", c.manager, { workflow_id: c.wf, days: "7" });
    expect(header).toEqual(["Section", "Date", "Item", "Metric", "Value"]);
    expect(records.find((row) => row.Section === "Funnel" && row.Metric === "total")?.Value).toBe("3");
    expect(records.find((row) => row.Section === "Audience" && row.Metric === "enrolled")?.Value).toBe("3");
    const days = records.filter((row) => row.Section === "Daily activity" && row.Metric === "emails");
    expect(days).toHaveLength(7);
    expect(days.every((row) => /^\d{4}-\d\d-\d\d$/.test(row.Date))).toBe(true);
    expect(res.headers["content-disposition"]).toContain("linki-analytics-Founders-outreach-");
  });
});

describe("the do-not-contact list", () => {
  it("is exported with the filters its screen has", async () => {
    const w = workspace();
    const other = workspace();
    const add = (ws: string, kind: string, value: string, reason: string) => db().prepare("INSERT INTO suppressions (id, workspace_id, kind, value, reason, source) VALUES (?, ?, ?, ?, ?, 'manual')").run(`sup-${++seq}`, ws, kind, value, reason);
    add(w.ws, "email", "lee@acme.test", "unsubscribe");
    add(w.ws, "domain", "acme.test", "manual");
    add(w.ws, "email", "mo@globex.test", "bounce");
    add(other.ws, "email", "theirs@acme.test", "manual");

    expect((await download("suppressions", w.manager)).records).toHaveLength(3);
    expect((await download("suppressions", w.manager, { kind: "domain" })).records).toEqual([expect.objectContaining({ Kind: "domain", Value: "acme.test", Reason: "manual" })]);
    expect((await download("suppressions", w.manager, { q: "ACME" })).records.map((row) => row.Value).sort()).toEqual(["acme.test", "lee@acme.test"]);
  });
});
