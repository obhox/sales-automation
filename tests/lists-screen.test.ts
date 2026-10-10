// The Lists screens' server side: the lists table with how complete each list is and
// what is using it, the figures across every list, what a selection of lists adds up to,
// one list in detail, and the list's owner, source, last sync and archive. Real
// (throwaway) database. No import job is run and nothing reaches LinkedIn or Apollo.
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb, migrateDatabase } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { ctxHeaders } from "./helpers/ctx";
import listsHandler from "@/pages/api/lists/index";
import listHandler from "@/pages/api/lists/[id]/index";
import importHandler from "@/pages/api/lists/[id]/import";
import importCsvHandler from "@/pages/api/lists/[id]/import-csv";
import targetsHandler from "@/pages/api/targets/index";
import { listState, type ListDetail, type ListRow, type ListsOverlap, type ListsSummary } from "@/lib/lists/overview";

const db = () => getDb();
let seq = 0;

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown> };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as Res;
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
interface CallOptions { body?: unknown; query?: Record<string, string>; role?: string; user?: string }

function workspace() {
  const n = ++seq;
  const ws = `ws-lists-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const call = async (handler: Handler, method: string, opts: CallOptions = {}) => {
    const res = mockRes();
    const role = opts.role ?? "member";
    await handler({ method, body: opts.body ?? {}, query: opts.query ?? {}, headers: ctxHeaders(ws, { userId: opts.user ?? `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
    return res;
  };
  const insert = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key]));
  };
  const contact = (fields: Record<string, unknown> = {}) => {
    const id = `lperson-${++seq}`;
    insert("targets", { id, workspace_id: ws, full_name: `Person ${seq}`, linkedin_url: `https://www.linkedin.com/in/${id}/`, ...fields });
    return id;
  };
  const list = (name: string, members: string[] = [], fields: Record<string, unknown> = {}) => {
    const id = `llist-${++seq}`;
    insert("lists", { id, workspace_id: ws, name, ...fields });
    for (const member of members) insert("list_targets", { list_id: id, target_id: member });
    return id;
  };
  const user = (name: string, role = "member") => {
    const id = `luser-${++seq}`;
    insert("users", { id, email: `${id}@example.test`, name, password_hash: "x" });
    insert("workspace_members", { workspace_id: ws, user_id: id, role });
    return id;
  };
  /** A campaign run on a list, with the list's contacts enrolled and their channel in the given state. */
  const run = (listId: string, name: string, status: string, members: string[] = [], trackState = "in_progress", createdAt = "2026-10-01 09:00:00") => {
    const workflowId = `lwf-${++seq}`;
    const runId = `lrun-${++seq}`;
    insert("workflows", { id: workflowId, workspace_id: ws, name });
    insert("runs", { id: runId, workspace_id: ws, workflow_id: workflowId, list_id: listId, status, created_at: createdAt });
    for (const member of members) {
      const profile = `lrp-${++seq}`;
      insert("run_profiles", { id: profile, run_id: runId, target_id: member });
      insert("run_profile_tracks", { id: `ltrack-${++seq}`, run_profile_id: profile, track: "email", state: trackState });
    }
    return { workflowId, runId };
  };
  const table = async (query: Record<string, string> = {}, opts: CallOptions = {}) =>
    (await call(listsHandler, "GET", { ...opts, query: { view: "table", ...query } })).body as unknown as { items: ListRow[]; total: number; page: number; limit: number; sort: { key: string; direction: string } };
  const names = async (query: Record<string, string> = {}) => (await table(query)).items.map((row) => row.name);
  const row = async (id: string) => (await table({ limit: "100" })).items.find((item) => item.id === id)!;
  return { ws, call, insert, contact, list, user, run, table, names, row };
}

// ─────────────────────────────────────────────────────────────────────
describe("the lists as the API has always given them", () => {
  it("is still an array with each list's count and status", async () => {
    const w = workspace();
    w.list("Tier 1", [w.contact()]);
    w.list("Empty");
    const res = await w.call(listsHandler, "GET", { role: "viewer" });
    expect(Array.isArray(res.body)).toBe(true);
    const lists = res.body as unknown as { name: string; target_count: number; status: string }[];
    expect(lists.map((list) => [list.name, list.target_count, list.status]).sort()).toEqual([["Empty", 0, "empty"], ["Tier 1", 1, "ready"]]);
  });

  it("still returns one list with all its contacts", async () => {
    const w = workspace();
    const id = w.list("Tier 1", [w.contact(), w.contact()]);
    const res = await w.call(listHandler, "GET", { query: { id } });
    expect(res.body.name).toBe("Tier 1");
    expect((res.body.targets as unknown[]).length).toBe(2);
    expect(res.body.list).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the lists table", () => {
  it("counts how complete each list is", async () => {
    const w = workspace();
    const id = w.list("Mixed", [
      w.contact({ email: "a@x.test", email_status: "verified" }),
      w.contact({ email: "b@x.test", email_status: "checked" }),
      w.contact({ email: "c@x.test", email_status: "catchall" }),
      w.contact({ email: "d@x.test", email_status: "invalid" }),
      w.contact({ email: "e@x.test" }),
      w.contact({ apollo_enriched_at: "2026-09-01 10:00:00" }),
      w.contact(),
      w.contact({ linkedin_url: null }),
    ]);
    expect(await w.row(id)).toMatchObject({
      contacts: 8, with_email: 5, valid: 2, risky: 1, invalid: 1,
      // An address counts as enriched however it arrived, and so does a contact Apollo was asked about.
      enriched: 6,
      // Worth a look-up: no email, never asked, and an address to ask about.
      enrichable: 1,
      // Worth a check: an address nobody has checked.
      verifiable: 1,
      state: "ready",
    });
  });

  it("says who looks after a list, where it came from and when it was last filled", async () => {
    const w = workspace();
    const priya = w.user("Priya Raghavan");
    const made = (await w.call(listsHandler, "POST", { body: { name: "Made by Priya" }, user: priya })).body.id as string;
    expect(await w.row(made)).toMatchObject({ owner: { id: priya, name: "Priya Raghavan" }, source: "manual", source_detail: null, last_synced_at: null });

    // A CSV import makes it a CSV list and remembers the file.
    const res = await w.call(importCsvHandler, "POST", { query: { id: made }, body: { csv: "linkedin_url,first_name\nhttps://www.linkedin.com/in/from-a-file/,Ada\n", filename: "webinar_sep24.csv" } });
    expect(res.body).toMatchObject({ imported: 1 });
    const afterCsv = await w.row(made);
    expect(afterCsv).toMatchObject({ source: "csv", source_detail: "webinar_sep24.csv", contacts: 1 });
    expect(afterCsv.last_synced_at).toEqual(expect.any(String));

    // A Sales Navigator list is dated by its last finished import.
    const nav = w.list("From Sales Navigator", [], { source: "sales_navigator", sales_nav_url: "https://www.linkedin.com/sales/search/people?x=1" });
    w.insert("list_imports", { id: `limp-${++seq}`, list_id: nav, status: "done", imported: 40, finished_at: "2026-10-08 09:30:00", started_at: "2026-10-08 09:00:00" });
    w.insert("list_imports", { id: `limp-${++seq}`, list_id: nav, status: "canceled", finished_at: "2026-10-09 09:30:00", started_at: "2026-10-09 09:00:00" });
    expect(await w.row(nav)).toMatchObject({ source: "sales_navigator", last_synced_at: "2026-10-08 09:30:00" });
  });

  it("keeps a list's first source when a file is added to it later", async () => {
    const w = workspace();
    const nav = w.list("Sales Navigator first", [], { source: "sales_navigator" });
    await w.call(importCsvHandler, "POST", { query: { id: nav }, body: { csv: "linkedin_url\nhttps://www.linkedin.com/in/later/\n", filename: "extra.csv" } });
    expect(await w.row(nav)).toMatchObject({ source: "sales_navigator", source_detail: "extra.csv" });
  });

  it("names the campaign using a list and counts the ones that have", async () => {
    const w = workspace();
    const person = w.contact();
    const id = w.list("Tier 1", [person]);
    w.run(id, "Finished push", "completed", [person], "completed", "2026-09-01 09:00:00");
    w.run(id, "Older push", "completed", [person], "completed", "2026-08-01 09:00:00");
    const live = w.run(id, "Q4 push", "running", [person], "in_progress", "2026-10-01 09:00:00");
    expect(await w.row(id)).toMatchObject({ campaign: { id: live.workflowId, name: "Q4 push", status: "running" }, past_campaigns: 2, state: "active" });
    const idle = w.list("Never used", [w.contact({ email: "x@x.test" })]);
    expect(await w.row(idle)).toMatchObject({ campaign: null, past_campaigns: 0, state: "ready" });
  });

  it("gives each list one state, the most pressing first", async () => {
    const w = workspace();
    const person = () => w.contact({ email: `${++seq}@x.test`, email_status: "verified" });
    const archived = w.list("Archived", [person()], { archived_at: "2026-10-01 09:00:00" });
    const importing = w.list("Importing", [person()]);
    w.insert("list_imports", { id: `limp-${++seq}`, list_id: importing, status: "running", imported: 25, total: 400 });
    const verifying = w.list("Verifying", [w.contact({ email: "v@x.test", email_verify_requested_at: "2026-10-10 09:00:00" })]);
    const paused = w.list("Paused", [person()]);
    w.run(paused, "Paused push", "paused");
    const needs = w.list("Needs enrichment", [w.contact(), w.contact(), person()]);
    const empty = w.list("Empty");
    const states = Object.fromEntries((await w.table({ limit: "100" })).items.map((row) => [row.name, row.state]));
    expect(states).toEqual({ Archived: "archived", Importing: "importing", Verifying: "verifying", Paused: "paused", "Needs enrichment": "needs_enrichment", Empty: "empty" });
    expect((await w.row(importing)).import).toMatchObject({ status: "running", imported: 25, total: 400 });
    expect([archived, needs, empty].length).toBe(3);
    // An archived list being imported is still archived; a list in a campaign whose emails are being checked says so.
    expect(listState({ archived: true, importing: true, campaign: "running", contacts: 1, with_email: 0, enriched: 0, valid: 0, risky: 0, invalid: 0, enrichable: 1, verifiable: 0, verifying: 1 })).toBe("archived");
    expect(listState({ archived: false, importing: false, campaign: "running", contacts: 1, with_email: 1, enriched: 1, valid: 0, risky: 0, invalid: 0, enrichable: 0, verifiable: 0, verifying: 1 })).toBe("verifying");
    // Exactly half without an email is not yet "mostly".
    expect(listState({ archived: false, importing: false, campaign: null, contacts: 2, with_email: 1, enriched: 1, valid: 0, risky: 0, invalid: 0, enrichable: 1, verifiable: 0, verifying: 0 })).toBe("ready");
  });

  it("sorts by the last update unless told otherwise, with archived lists last, and only by a key on its list", async () => {
    const w = workspace();
    w.list("Bravo", [w.contact(), w.contact()], { created_at: "2026-09-01 09:00:00" });
    w.list("alpha", [w.contact()], { created_at: "2026-09-03 09:00:00" });
    w.list("Charlie", [], { created_at: "2026-09-02 09:00:00", last_synced_at: "2026-10-05 09:00:00" });
    w.list("Aardvark, archived", [], { created_at: "2026-10-09 09:00:00", archived_at: "2026-10-09 10:00:00" });
    const first = await w.table();
    expect(first.sort).toEqual({ key: "updated", direction: "desc" });
    expect(first.items.map((row) => row.name)).toEqual(["Charlie", "alpha", "Bravo", "Aardvark, archived"]);
    expect(await w.names({ sort: "name:asc" })).toEqual(["alpha", "Bravo", "Charlie", "Aardvark, archived"]);
    expect(await w.names({ sort: "name" })).toEqual(["alpha", "Bravo", "Charlie", "Aardvark, archived"]);
    expect(await w.names({ sort: "contacts:desc" })).toEqual(["Bravo", "alpha", "Charlie", "Aardvark, archived"]);
    expect(await w.names({ sort: "created:asc" })).toEqual(["Bravo", "Charlie", "alpha", "Aardvark, archived"]);
    expect((await w.table({ sort: "name; DROP TABLE lists:asc" })).sort.key).toBe("updated");
  });

  it("filters by search, source, owner and state, and pages", async () => {
    const w = workspace();
    const priya = w.user("Priya Raghavan");
    w.list("Webinar attendees", [w.contact({ email: "a@x.test" })], { source: "csv", source_detail: "webinar_sep24.csv", owner_id: priya });
    w.list("Fintech Ops", [w.contact({ email: "b@x.test" })], { source: "sales_navigator" });
    w.list("Hand picked", [], { description: "Referrals from the board" });
    expect(await w.names({ q: "webinar" })).toEqual(["Webinar attendees"]);
    expect(await w.names({ q: "sep24" })).toEqual(["Webinar attendees"]);
    expect(await w.names({ q: "raghavan" })).toEqual(["Webinar attendees"]);
    expect(await w.names({ q: "board" })).toEqual(["Hand picked"]);
    expect(await w.names({ source: "csv" })).toEqual(["Webinar attendees"]);
    expect(await w.names({ source: "sales_navigator" })).toEqual(["Fintech Ops"]);
    expect(await w.names({ source: "manual" })).toEqual(["Hand picked"]);
    expect(await w.names({ owner: priya })).toEqual(["Webinar attendees"]);
    expect((await w.names({ owner: "none", sort: "name:asc" }))).toEqual(["Fintech Ops", "Hand picked"]);
    expect(await w.names({ state: "empty" })).toEqual(["Hand picked"]);
    expect((await w.table({ state: "ready" })).total).toBe(2);
    expect((await w.table({ state: "nonsense" })).total).toBe(3);
    const page = await w.table({ sort: "name:asc", limit: "2", page: "2" });
    expect({ total: page.total, page: page.page, limit: page.limit, names: page.items.map((row) => row.name) }).toEqual({ total: 3, page: 2, limit: 2, names: ["Webinar attendees"] });
  });

  it("stays inside its workspace and can be read by a viewer", async () => {
    const mine = workspace();
    const theirs = workspace();
    theirs.list("Theirs", [theirs.contact()]);
    mine.list("Mine");
    expect((await mine.table({}, { role: "viewer" })).items.map((row) => row.name)).toEqual(["Mine"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the figures across every list", () => {
  it("count each contact once, however many lists it is in", async () => {
    const w = workspace();
    const priya = w.user("Priya Raghavan");
    const both = w.contact({ email: "both@x.test", email_status: "verified" });
    const one = w.contact({ email: "one@x.test", email_status: "catchall", apollo_enriched_at: new Date().toISOString() });
    const bare = w.contact();
    w.contact({ email: "loose@x.test", email_status: "verified" }); // in no list: not counted
    const a = w.list("A", [both, one]);
    w.list("B", [both, bare]);
    w.run(a, "Live", "running", [both], "in_progress");
    w.run(a, "Done", "running", [one], "completed");
    const summary = (await w.call(listsHandler, "GET", { query: { view: "summary" }, role: "viewer" })).body as unknown as ListsSummary;
    expect(summary).toMatchObject({ lists: 2, contacts: 3, with_email: 2, enriched: 2, valid: 1, risky: 1, enrichable: 1, in_campaigns: 1, apollo_lookups: 1, apollo_connected: false });
    expect(summary.members.find((member) => member.id === priya)).toEqual({ id: priya, name: "Priya Raghavan" });
    expect(summary.imports).toMatchObject({ active: 0, today: 0, daily_cap: 1500 });
  });

  it("says whether Apollo is connected", async () => {
    const w = workspace();
    w.insert("integrations", { key: "apollo", workspace_id: w.ws, api_key: encryptSecret("apollo-test-key") });
    expect(((await w.call(listsHandler, "GET", { query: { view: "summary" } })).body as unknown as ListsSummary).apollo_connected).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a selection of lists", () => {
  it("adds up with each contact counted once, and says how far the lists overlap", async () => {
    const w = workspace();
    const inAll = w.contact({ email: "all@x.test" });
    const inTwo = w.contact();
    const inOne = w.contact({ email: "one@x.test", email_status: "verified" });
    const a = w.list("A", [inAll, inTwo, inOne]);
    const b = w.list("B", [inAll, inTwo]);
    const c = w.list("C", [inAll]);
    const overlap = (await w.call(listsHandler, "GET", { query: { view: "overlap", ids: `${a},${b},${c}` } })).body as unknown as ListsOverlap;
    expect(overlap).toMatchObject({ lists: 3, memberships: 6, contacts: 3, in_several: 2, with_email: 2, enrichable: 1, verifiable: 1, valid: 1 });
    // One list overlaps with nothing.
    expect((await w.call(listsHandler, "GET", { query: { view: "overlap", ids: c } })).body).toMatchObject({ lists: 1, memberships: 1, contacts: 1, in_several: 0 });
  });

  it("leaves out lists of another workspace, and is nothing for no lists", async () => {
    const mine = workspace();
    const theirs = workspace();
    const theirList = theirs.list("Theirs", [theirs.contact()]);
    const myList = mine.list("Mine", [mine.contact()]);
    expect((await mine.call(listsHandler, "GET", { query: { view: "overlap", ids: `${myList},${theirList}` } })).body).toMatchObject({ lists: 1, contacts: 1 });
    expect((await mine.call(listsHandler, "GET", { query: { view: "overlap", ids: "" } })).body).toMatchObject({ lists: 0, contacts: 0, memberships: 0 });
  });

  it("can be turned into its contacts, for an action on all of them", async () => {
    const w = workspace();
    const shared = w.contact({ intent_score: 90 });
    const other = w.contact({ intent_score: 10 });
    w.contact();
    const a = w.list("A", [shared]);
    const b = w.list("B", [shared, other]);
    const res = await w.call(targetsHandler, "GET", { query: { view: "ids", list_ids: `${a},${b}` } });
    expect(res.body).toEqual({ ids: [shared, other], total: 2, capped: false });
    expect((await w.call(targetsHandler, "GET", { query: { view: "ids", list_ids: "no-such-list" } })).body).toMatchObject({ total: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("one list in detail", () => {
  it("gathers its figures, the campaigns that used it, and what an import or a move can choose from", async () => {
    const w = workspace();
    const connected = w.contact({ degree: 1, email: "c@x.test", email_status: "verified", last_replied_at: "2026-10-05 10:00:00" });
    const cold = w.contact();
    const id = w.list("Tier 1", [connected, cold], { description: "Decision makers" });
    w.list("Other list");
    w.list("Archived list", [], { archived_at: "2026-10-01 09:00:00" });
    w.insert("accounts", { id: `lacct-${++seq}`, workspace_id: w.ws, name: "Priya", email: `lacct${seq}@example.test`, is_authenticated: 1 });
    w.insert("accounts", { id: `lacct-${++seq}`, workspace_id: w.ws, name: "Daniel", email: `lacct${seq}@example.test`, is_authenticated: 0 });
    w.run(id, "Finished push", "completed", [connected, cold], "completed", "2026-09-01 09:00:00");
    const live = w.run(id, "Q4 push", "running", [connected], "in_progress", "2026-10-01 09:00:00");

    const detail = (await w.call(listHandler, "GET", { query: { id, view: "detail" }, role: "viewer" })).body as unknown as ListDetail;
    expect(detail.list).toMatchObject({ id, name: "Tier 1", description: "Decision makers", contacts: 2, with_email: 1, valid: 1, enrichable: 1, state: "active" });
    expect(detail).toMatchObject({ connected: 1, replied: 1, in_campaign: 1, apollo_connected: false, imports: { today: 0, daily_cap: 1500 } });
    expect(detail.runs.map((run) => [run.workflow_name, run.status, run.total, run.finished])).toEqual([["Q4 push", "running", 1, 0], ["Finished push", "completed", 2, 2]]);
    expect(detail.runs[0].workflow_id).toBe(live.workflowId);
    expect(detail.accounts.map((account) => [account.name, account.signed_in])).toEqual([["Daniel", false], ["Priya", true]]);
    // A contact is moved to a list in use, not to an archived one.
    expect(detail.other_lists.map((list) => list.name)).toEqual(["Other list"]);
  });

  it("is not found across workspaces", async () => {
    const mine = workspace();
    const theirs = workspace();
    expect((await mine.call(listHandler, "GET", { query: { id: theirs.list("Theirs"), view: "detail" } })).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("changing a list", () => {
  const row = (id: string) => db().prepare("SELECT name, description, owner_id, archived_at, source, sales_nav_url FROM lists WHERE id = ?").get(id) as Record<string, string | null>;

  it("gives it to a member of the workspace, or to nobody", async () => {
    const w = workspace();
    const priya = w.user("Priya");
    const outsider = workspace().user("Outsider");
    const id = w.list("Tier 1");
    expect((await w.call(listHandler, "PUT", { query: { id }, body: { owner_id: priya } })).statusCode).toBe(200);
    expect(row(id).owner_id).toBe(priya);
    expect((await w.call(listHandler, "PUT", { query: { id }, body: { owner_id: outsider } })).statusCode).toBe(400);
    await w.call(listHandler, "PUT", { query: { id }, body: { owner_id: null } });
    expect(row(id).owner_id).toBeNull();
  });

  it("archives it and brings it back, keeping its contacts", async () => {
    const w = workspace();
    const id = w.list("Old list", [w.contact()]);
    await w.call(listHandler, "PUT", { query: { id }, body: { archived: true } });
    expect(row(id).archived_at).not.toBeNull();
    expect(await w.row(id)).toMatchObject({ archived: true, state: "archived", contacts: 1 });
    await w.call(listHandler, "PUT", { query: { id }, body: { archived: false } });
    expect(row(id).archived_at).toBeNull();
    expect((await w.call(listHandler, "PUT", { query: { id }, body: { archived: "yes" } })).statusCode).toBe(400);
  });

  it("still renames it, and leaves alone what was not sent", async () => {
    const w = workspace();
    const priya = w.user("Priya");
    const id = w.list("Old name", [], { description: "Kept", owner_id: priya });
    await w.call(listHandler, "PUT", { query: { id }, body: { name: "  New name  " } });
    expect(row(id)).toMatchObject({ name: "New name", description: "Kept", owner_id: priya });
    expect((await w.call(listHandler, "PUT", { query: { id }, body: { name: "   " } })).statusCode).toBe(400);
    expect((await w.call(listHandler, "PUT", { query: { id: "no-such-list" }, body: { name: "X" } })).statusCode).toBe(404);
    expect((await w.call(listHandler, "PUT", { query: { id }, body: { name: "By a viewer" }, role: "viewer" })).statusCode).toBe(403);
  });

  it("marks a list as a Sales Navigator list when an import is queued for it", async () => {
    const w = workspace();
    const id = w.list("To import");
    const account = `lacct-${++seq}`;
    w.insert("accounts", { id: account, workspace_id: w.ws, name: "Priya", email: `${account}@example.test`, is_authenticated: 1, cookies_json: encryptSecret("{}") });
    const res = await w.call(importHandler, "POST", { query: { id }, body: { sales_nav_url: "https://www.linkedin.com/sales/search/people?x=1", account_id: account }, role: "manager" });
    expect(res.body).toMatchObject({ started: true });
    expect(row(id)).toMatchObject({ source: "sales_navigator", sales_nav_url: "https://www.linkedin.com/sales/search/people?x=1" });
    // Queued only: the import itself is run by the scheduler, which is not running here.
    expect(db().prepare("SELECT status FROM list_imports WHERE list_id = ?").get(id)).toEqual({ status: "scheduled" });
    expect((await w.row(id)).state).toBe("importing");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("lists made before this release", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linki-lists-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("are given a source once, where it can be told, and nothing else about them changes", () => {
    const old = new Database(path.join(dir, "old.db"));
    old.pragma("foreign_keys = ON");
    old.exec(fs.readFileSync(path.join(__dirname, "fixtures", "schema", "release-2026-10-10.sql"), "utf8"));
    old.exec(`
      INSERT INTO workspaces (id, name, slug) VALUES ('ws-old', 'Old', 'old');
      INSERT INTO lists (id, workspace_id, name, sales_nav_url) VALUES ('with-url', 'ws-old', 'Has an address', 'https://www.linkedin.com/sales/search/people?x=1');
      INSERT INTO lists (id, workspace_id, name) VALUES ('with-import', 'ws-old', 'Has an import');
      INSERT INTO list_imports (id, list_id, status) VALUES ('old-import', 'with-import', 'done');
      INSERT INTO lists (id, workspace_id, name, description) VALUES ('by-hand', 'ws-old', 'Made by hand', 'Kept');
    `);
    migrateDatabase(old);
    const sources = () => Object.fromEntries((old.prepare("SELECT id, source, owner_id, archived_at, description FROM lists ORDER BY id").all() as { id: string; source: string | null; owner_id: string | null; archived_at: string | null; description: string | null }[]).map((row) => [row.id, row]));
    expect(sources()).toMatchObject({
      "with-url": { source: "sales_navigator", owner_id: null, archived_at: null },
      "with-import": { source: "sales_navigator" },
      "by-hand": { source: null, description: "Kept" },
    });
    // It runs once: a list changed by hand afterwards is not changed back on the next start.
    old.prepare("UPDATE lists SET source = NULL WHERE id = 'with-url'").run();
    migrateDatabase(old);
    expect(sources()["with-url"].source).toBeNull();
    old.close();
  });
});
