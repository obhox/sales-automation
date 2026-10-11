// The Contacts screen's server side: the paged table with its filters and sort, the ids
// behind "select all matching", the choices its filters offer, contact tags, enriching a
// selection, custom field definitions, and the export of what is on screen. Real
// (throwaway) database. Apollo is never called: its client is replaced by a stand-in.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { ctxHeaders } from "./helpers/ctx";

vi.mock("@/lib/apollo", () => ({ matchPerson: vi.fn() }));

import { matchPerson, type ApolloMatchResult } from "@/lib/apollo";
import targetsHandler from "@/pages/api/targets/index";
import tagsHandler from "@/pages/api/targets/tags";
import enrichHandler, { ENRICH_BATCH } from "@/pages/api/targets/enrich";
import listEnrichHandler from "@/pages/api/lists/[id]/apollo-enrich";
import customFieldsHandler from "@/pages/api/platform/custom-fields";
import exportHandler from "@/pages/api/export/[resource]";
import { MAX_SELECTION } from "@/lib/contacts/filters";
import type { ContactFacets, ContactRow } from "@/lib/contacts/table";
import { loadTargetCustomValues } from "@/lib/outreach/custom-values";

const apollo = vi.mocked(matchPerson);
const db = () => getDb();
let seq = 0;

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown>; text: string };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined, text: "", destroyed: false };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  res.write = (chunk: string) => { res.text = String(res.text) + chunk; return true; };
  res.once = () => res;
  res.off = () => res;
  return res as unknown as Res;
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
interface CallOptions { body?: unknown; query?: Record<string, string>; role?: string; user?: string }

/** A workspace with its people, and ways to put contacts, lists, campaigns and tags in it. */
function workspace() {
  const n = ++seq;
  const ws = `ws-contacts-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const call = async (handler: Handler, method: string, opts: CallOptions = {}) => {
    const res = mockRes();
    const role = opts.role ?? "manager";
    await handler({ method, body: opts.body ?? {}, query: opts.query ?? {}, headers: ctxHeaders(ws, { userId: opts.user ?? `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
    return res;
  };
  const contact = (name: string, fields: Record<string, unknown> = {}) => {
    const id = `contact-${++seq}`;
    const row: Record<string, unknown> = { id, workspace_id: ws, full_name: name, linkedin_url: `https://www.linkedin.com/in/${id}/`, ...fields };
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO targets (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key]));
    return id;
  };
  const list = (name: string, members: string[] = []) => {
    const id = `list-${++seq}`;
    db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, ?)").run(id, ws, name);
    for (const member of members) db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(id, member);
    return id;
  };
  /** A campaign with one run in the given state, and the contacts enrolled in it. */
  const campaign = (name: string, status: string, members: string[] = [], createdAt = "2026-10-01 09:00:00") => {
    const workflowId = `workflow-${++seq}`;
    const runId = `run-${++seq}`;
    db().prepare("INSERT INTO workflows (id, workspace_id, name) VALUES (?, ?, ?)").run(workflowId, ws, name);
    db().prepare("INSERT INTO runs (id, workspace_id, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, ws, workflowId, status, createdAt);
    for (const member of members) db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`rp-${++seq}`, runId, member);
    return { workflowId, runId };
  };
  const user = (name: string, role = "member") => {
    const id = `user-${++seq}`;
    db().prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'x')").run(id, `${id}@example.test`, name);
    db().prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(ws, id, role);
    return id;
  };
  const table = async (query: Record<string, string> = {}, opts: CallOptions = {}) => {
    const res = await call(targetsHandler, "GET", { ...opts, query: { view: "table", ...query } });
    return res.body as unknown as { items: ContactRow[]; total: number; page: number; limit: number; sort: { key: string; direction: string } };
  };
  const names = async (query: Record<string, string> = {}) => (await table(query)).items.map((row) => row.full_name);
  const connectApollo = () => db().prepare("INSERT INTO integrations (key, workspace_id, api_key) VALUES ('apollo', ?, ?)").run(ws, encryptSecret("apollo-test-key"));
  return { ws, call, contact, list, campaign, user, table, names, connectApollo };
}

const person = (fields: Partial<ApolloMatchResult> = {}): ApolloMatchResult => ({
  apollo_id: "apollo-1", linkedin_url: null, headline: null, seniority: "vp", functions: null, departments: null, email: "found@example.test", email_status: "verified",
  email_domain_catchall: false, city: "Berlin", country: "Germany", time_zone: "Europe/Berlin", positions_json: null, organization: null, ...fields,
});

beforeEach(() => {
  apollo.mockReset();
});

// ─────────────────────────────────────────────────────────────────────
describe("the contacts list as the API and the MCP tool have always been given it", () => {
  it("keeps its shape: pages from 0, { contacts, total }, sorted by name", async () => {
    const w = workspace();
    w.contact("Zed Last");
    w.contact("Amy First");
    const res = await w.call(targetsHandler, "GET", { query: { page: "0", limit: "1" } });
    expect(Object.keys(res.body).sort()).toEqual(["contacts", "total"]);
    expect(res.body.total).toBe(2);
    expect((res.body.contacts as { full_name: string }[]).map((row) => row.full_name)).toEqual(["Amy First"]);
    const second = await w.call(targetsHandler, "GET", { query: { page: "1", limit: "1" } });
    expect((second.body.contacts as { full_name: string }[]).map((row) => row.full_name)).toEqual(["Zed Last"]);
  });

  it("still takes search and list_id", async () => {
    const w = workspace();
    const amy = w.contact("Amy First", { company: "Northwind" });
    w.contact("Zed Last", { company: "Lumen" });
    const list = w.list("Tier 1", [amy]);
    expect(((await w.call(targetsHandler, "GET", { query: { search: "lumen" } })).body.contacts as unknown[]).length).toBe(1);
    expect(((await w.call(targetsHandler, "GET", { query: { list_id: list } })).body.contacts as { id: string }[]).map((row) => row.id)).toEqual([amy]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the contacts table", () => {
  it("answers one page in the paging shape, pages from 1", async () => {
    const w = workspace();
    for (const name of ["Ada", "Bea", "Cy", "Dee", "Eli"]) w.contact(name);
    const first = await w.table({ sort: "name:asc", limit: "2" });
    expect({ total: first.total, page: first.page, limit: first.limit }).toEqual({ total: 5, page: 1, limit: 2 });
    expect(first.items.map((row) => row.full_name)).toEqual(["Ada", "Bea"]);
    expect((await w.table({ sort: "name:asc", limit: "2", page: "3" })).items.map((row) => row.full_name)).toEqual(["Eli"]);
  });

  it("caps the page size and ignores a malformed page", async () => {
    const w = workspace();
    w.contact("Ada");
    const page = await w.table({ limit: "100000", page: "minus-one" });
    expect(page.limit).toBe(200);
    expect(page.page).toBe(1);
  });

  it("sorts by intent, highest first, unless told otherwise", async () => {
    const w = workspace();
    w.contact("Low", { intent_score: 12 });
    w.contact("High", { intent_score: 86 });
    w.contact("Mid", { intent_score: 55 });
    const page = await w.table();
    expect(page.sort).toEqual({ key: "intent", direction: "desc" });
    expect(page.items.map((row) => row.full_name)).toEqual(["High", "Mid", "Low"]);
    expect(await w.names({ sort: "intent:asc" })).toEqual(["Low", "Mid", "High"]);
  });

  it("only sorts by a key on its list: anything else falls back, and never reaches the SQL", async () => {
    const w = workspace();
    w.contact("B", { intent_score: 1 });
    w.contact("A", { intent_score: 2 });
    const page = await w.table({ sort: "full_name; DROP TABLE targets:asc" });
    expect(page.sort.key).toBe("intent");
    expect(page.items.map((row) => row.full_name)).toEqual(["A", "B"]);
    expect(db().prepare("SELECT COUNT(*) AS c FROM targets WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 2 });
  });

  it("puts contacts with no value last whichever way the column is sorted", async () => {
    const w = workspace();
    w.contact("No company");
    w.contact("Zeta person", { company: "Zeta" });
    w.contact("Alpha person", { company: "Alpha" });
    expect(await w.names({ sort: "company:asc" })).toEqual(["Alpha person", "Zeta person", "No company"]);
    expect(await w.names({ sort: "company:desc" })).toEqual(["Zeta person", "Alpha person", "No company"]);
  });

  it("gives each contact its lists, campaign, owner and tags", async () => {
    const w = workspace();
    const owner = w.user("Priya Raghavan");
    const id = w.contact("Marcus Oyelaran", { owner_id: owner, intent_score: 86.4 });
    w.list("Zebra list", [id]);
    w.list("Alpha list", [id]);
    const old = w.campaign("Finished campaign", "completed", [id], "2026-10-05 09:00:00");
    const live = w.campaign("Live campaign", "running", [id], "2026-09-01 09:00:00");
    const tag = (await w.call(tagsHandler, "POST", { body: { name: "Champion", color: "good" } })).body.id as string;
    await w.call(tagsHandler, "PUT", { body: { target_ids: [id], add: [tag] } });

    const [row] = (await w.table()).items;
    expect(row.owner).toEqual({ id: owner, name: "Priya Raghavan" });
    expect(row.lists.map((list) => list.name)).toEqual(["Alpha list", "Zebra list"]);
    // The campaign still running is shown, though a finished one started later.
    expect(row.campaign).toEqual({ id: live.workflowId, name: "Live campaign", status: "running" });
    expect(row.campaign_count).toBe(2);
    expect(row.tags).toEqual([{ id: tag, name: "Champion", color: "good" }]);
    expect(row.intent_score).toBe(86);
    expect(old.workflowId).not.toBe(live.workflowId);
  });

  it("works out where a contact stands on LinkedIn", async () => {
    const w = workspace();
    w.contact("Connected", { degree: 1 });
    w.contact("Accepted", { connected_at: "2026-10-01 10:00:00", degree: 2 });
    w.contact("Invited", { connection_requested_at: "2026-10-01 10:00:00" });
    w.contact("Withdrawn", { connection_requested_at: "2026-09-01 10:00:00", invite_withdrawn_at: "2026-10-01 10:00:00" });
    w.contact("InMailed", { inmail_sent_at: "2026-10-01 10:00:00" });
    w.contact("Untouched");
    const byName = Object.fromEntries((await w.table({ limit: "50" })).items.map((row) => [row.full_name, row.linkedin_status]));
    expect(byName).toEqual({ Connected: "connected", Accepted: "connected", Invited: "invite_sent", Withdrawn: "withdrawn", InMailed: "inmail_sent", Untouched: "not_connected" });
    expect(await w.names({ linkedin: "invite_sent" })).toEqual(["Invited"]);
    expect((await w.names({ linkedin: "connected", sort: "name:asc" }))).toEqual(["Accepted", "Connected"]);
    // A value that is not a status filters nothing.
    expect((await w.table({ linkedin: "nonsense" })).total).toBe(6);
  });

  it("takes the latest of sends, acceptances and replies as the last activity, whichever way the time is written", async () => {
    const w = workspace();
    const sent = w.contact("Sent to", { connection_requested_at: "2026-10-01 09:00:00" });
    db().prepare("INSERT INTO step_sends (id, workspace_id, channel, action, target_id, sent_at) VALUES (?, ?, 'email', 'email', ?, ?)").run(`send-${++seq}`, w.ws, sent, "2026-10-08T14:30:00.000Z");
    w.contact("Replied", { message_sent_at: "2026-10-02 09:00:00", last_replied_at: "2026-10-09T08:00:00.000Z" });
    w.contact("Quiet");
    const page = await w.table({ sort: "last_activity:desc" });
    expect(page.items.map((row) => [row.full_name, row.last_activity_at])).toEqual([
      ["Replied", "2026-10-09 08:00:00"], ["Sent to", "2026-10-08 14:30:00"], ["Quiet", null],
    ]);
  });

  it("filters by email state", async () => {
    const w = workspace();
    w.contact("Verified", { email: "v@example.test", email_status: "verified" });
    w.contact("Catch-all", { email: "c@example.test", email_status: "catchall" });
    w.contact("Unchecked", { email: "u@example.test" });
    w.contact("No email");
    expect(await w.names({ email: "verified" })).toEqual(["Verified"]);
    expect(await w.names({ email: "catchall" })).toEqual(["Catch-all"]);
    expect(await w.names({ email: "unchecked" })).toEqual(["Unchecked"]);
    expect(await w.names({ email: "none" })).toEqual(["No email"]);
    expect((await w.table({ email: "any" })).total).toBe(3);
  });

  it("filters by campaign, by being in none, and by being in any", async () => {
    const w = workspace();
    const a = w.contact("In A");
    const b = w.contact("In B");
    w.contact("In nothing");
    const campaignA = w.campaign("A", "running", [a]);
    w.campaign("B", "completed", [b]);
    expect(await w.names({ campaign: campaignA.workflowId })).toEqual(["In A"]);
    expect(await w.names({ campaign: "none" })).toEqual(["In nothing"]);
    expect((await w.table({ campaign: "any" })).total).toBe(2);
  });

  it("filters by intent, owner, tag, list, seniority, country, replies and enrichment", async () => {
    const w = workspace();
    const priya = w.user("Priya");
    const hot = w.contact("Hot", { intent_score: 80, owner_id: priya, seniority: "vp", country: "Germany", last_replied_at: "2026-10-01 10:00:00", apollo_enriched_at: "2026-09-01 10:00:00" });
    const warm = w.contact("Warm", { intent_score: 60, seniority: "director", country: "Spain", email_replied_at: "2026-10-01 10:00:00" });
    w.contact("Cold", { intent_score: 10, country: "germany" });
    const list = w.list("Tier 1", [hot]);
    const tag = (await w.call(tagsHandler, "POST", { body: { name: "Champion" } })).body.id as string;
    await w.call(tagsHandler, "PUT", { body: { target_ids: [warm], add: [tag] } });

    expect(await w.names({ intent: "60" })).toEqual(["Hot", "Warm"]);
    expect(await w.names({ owner: priya })).toEqual(["Hot"]);
    expect(await w.names({ owner: "none", sort: "name:asc" })).toEqual(["Cold", "Warm"]);
    expect(await w.names({ tag })).toEqual(["Warm"]);
    expect(await w.names({ tag: "none", sort: "name:asc" })).toEqual(["Cold", "Hot"]);
    expect(await w.names({ list_id: list })).toEqual(["Hot"]);
    expect(await w.names({ list_id: "none", sort: "name:asc" })).toEqual(["Cold", "Warm"]);
    expect(await w.names({ seniority: "VP" })).toEqual(["Hot"]);
    expect(await w.names({ country: "Germany", sort: "name:asc" })).toEqual(["Cold", "Hot"]);
    expect(await w.names({ replied: "yes" })).toEqual(["Hot", "Warm"]);
    expect(await w.names({ replied: "no" })).toEqual(["Cold"]);
    expect(await w.names({ enriched: "yes" })).toEqual(["Hot"]);
    expect(await w.names({ enriched: "no", sort: "name:asc" })).toEqual(["Cold", "Warm"]);
    // Filters combine.
    expect(await w.names({ intent: "60", country: "Germany" })).toEqual(["Hot"]);
  });

  it("searches name, company, title and email", async () => {
    const w = workspace();
    w.contact("Marcus Oyelaran", { company: "Northwind", title: "VP Revenue Ops", email: "m.oyelaran@northwind.example" });
    w.contact("Elena Vasquez", { company: "Brightpath", title: "Head of Demand Gen" });
    expect(await w.names({ q: "revenue" })).toEqual(["Marcus Oyelaran"]);
    expect(await w.names({ q: "brightpath" })).toEqual(["Elena Vasquez"]);
    expect(await w.names({ q: "oyelaran@north" })).toEqual(["Marcus Oyelaran"]);
    expect((await w.table({ q: "nobody" })).total).toBe(0);
  });

  it("never shows another workspace's contacts, campaigns, lists or tags", async () => {
    const mine = workspace();
    const theirs = workspace();
    const theirContact = theirs.contact("Theirs");
    const theirCampaign = theirs.campaign("Their campaign", "running", [theirContact]);
    const theirList = theirs.list("Their list", [theirContact]);
    const theirTag = (await theirs.call(tagsHandler, "POST", { body: { name: "Theirs" } })).body.id as string;
    await theirs.call(tagsHandler, "PUT", { body: { target_ids: [theirContact], add: [theirTag] } });
    mine.contact("Mine");

    expect(await mine.names()).toEqual(["Mine"]);
    for (const query of [{ campaign: theirCampaign.workflowId }, { list_id: theirList }, { tag: theirTag }, { ids: theirContact }]) {
      expect((await mine.table(query)).total).toBe(0);
    }
  });

  it("can be read by a viewer", async () => {
    const w = workspace();
    w.contact("Ada");
    expect((await w.table({}, { role: "viewer" })).total).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("select all matching", () => {
  it("returns the ids the filters select, in the table's order", async () => {
    const w = workspace();
    const low = w.contact("Low", { intent_score: 20, country: "Spain" });
    const high = w.contact("High", { intent_score: 90, country: "Spain" });
    w.contact("Elsewhere", { country: "Norway" });
    const res = await w.call(targetsHandler, "GET", { query: { view: "ids", country: "Spain" } });
    expect(res.body).toEqual({ ids: [high, low], total: 2, capped: false });
  });

  it("is a number the screen is told, not one it guesses", async () => {
    const w = workspace();
    const facets = (await w.call(targetsHandler, "GET", { query: { view: "facets" } })).body as unknown as ContactFacets;
    expect(facets.max_selection).toBe(MAX_SELECTION);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("what the screen's filters offer", () => {
  it("lists the workspace's lists, campaigns, members, tags, countries and seniorities", async () => {
    const w = workspace();
    const priya = w.user("Priya Raghavan", "manager");
    const a = w.contact("A", { country: "Spain", seniority: "vp", email: "a@example.test", email_verify_requested_at: "2026-10-10 09:00:00" });
    w.contact("B", { country: "Norway", seniority: "vp" });
    const list = w.list("Tier 1", [a]);
    const live = w.campaign("Live", "running", [a]);
    const draft = w.campaign("Finished", "completed");
    db().prepare("INSERT INTO workflows (id, workspace_id, name, is_archived) VALUES (?, ?, 'Archived', 1)").run(`workflow-${++seq}`, w.ws);
    const tag = (await w.call(tagsHandler, "POST", { body: { name: "Champion", color: "brand" } })).body.id as string;
    await w.call(tagsHandler, "PUT", { body: { target_ids: [a], add: [tag] } });

    const facets = (await w.call(targetsHandler, "GET", { query: { view: "facets" }, role: "viewer" })).body as unknown as ContactFacets;
    expect(facets.total).toBe(2);
    expect(facets.verifying).toBe(1);
    expect(facets.lists).toEqual([{ id: list, name: "Tier 1", count: 1 }]);
    // An archived campaign is not offered. Only a campaign that is still going can take more contacts.
    expect(facets.campaigns).toEqual([
      { id: draft.workflowId, name: "Finished", status: "completed", run_id: null },
      { id: live.workflowId, name: "Live", status: "running", run_id: live.runId },
    ]);
    expect(facets.members.find((member) => member.id === priya)).toEqual({ id: priya, name: "Priya Raghavan" });
    expect(facets.tags).toEqual([{ id: tag, name: "Champion", color: "brand", count: 1 }]);
    expect(facets.countries).toEqual(["Norway", "Spain"]);
    expect(facets.seniorities).toEqual(["vp"]);
    expect(facets.apollo_connected).toBe(false);
    w.connectApollo();
    expect(((await w.call(targetsHandler, "GET", { query: { view: "facets" } })).body as unknown as ContactFacets).apollo_connected).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("adding a contact", () => {
  it("still needs a name", async () => {
    const w = workspace();
    const res = await w.call(targetsHandler, "POST", { body: { linkedin_url: "https://www.linkedin.com/in/nobody/" }, role: "member" });
    expect(res.statusCode).toBe(400);
  });

  it("takes an email address in place of a LinkedIn profile", async () => {
    const w = workspace();
    const res = await w.call(targetsHandler, "POST", { body: { full_name: "Email Only", email: "only@example.test" }, role: "member" });
    expect(res.statusCode).toBe(201);
    expect(res.body.linkedin_url).toBeNull();
    // Two contacts without a LinkedIn profile do not collide on it.
    expect((await w.call(targetsHandler, "POST", { body: { full_name: "Another", email: "another@example.test" }, role: "member" })).statusCode).toBe(201);
    expect((await w.call(targetsHandler, "POST", { body: { full_name: "Neither" }, role: "member" })).statusCode).toBe(400);
  });

  it("is not for a viewer", async () => {
    const w = workspace();
    expect((await w.call(targetsHandler, "POST", { body: { full_name: "X", email: "x@example.test" }, role: "viewer" })).statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("contact tags", () => {
  it("are made by a member, with a colour the screen can draw", async () => {
    const w = workspace();
    const res = await w.call(tagsHandler, "POST", { body: { name: "  Decision   maker ", color: "chartreuse" }, role: "member" });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ name: "Decision maker", color: "neutral", count: 0 });
    expect((await w.call(tagsHandler, "POST", { body: { name: "decision MAKER" }, role: "member" })).statusCode).toBe(409);
    expect((await w.call(tagsHandler, "POST", { body: { name: "" }, role: "member" })).statusCode).toBe(400);
    expect((await w.call(tagsHandler, "POST", { body: { name: "x".repeat(33) }, role: "member" })).statusCode).toBe(400);
    expect((await w.call(tagsHandler, "POST", { body: { name: "Nope" }, role: "viewer" })).statusCode).toBe(403);
  });

  it("are put on contacts and taken off, counting only what changed", async () => {
    const w = workspace();
    const [a, b] = [w.contact("A"), w.contact("B")];
    const tag = (await w.call(tagsHandler, "POST", { body: { name: "Champion" } })).body.id as string;
    const first = await w.call(tagsHandler, "PUT", { body: { target_ids: [a, b], add: [tag] }, role: "member" });
    expect(first.body).toMatchObject({ contacts: 2, added: 2, removed: 0 });
    expect((await w.call(tagsHandler, "PUT", { body: { target_ids: [a, b], add: [tag] }, role: "member" })).body).toMatchObject({ added: 0 });
    expect((await w.call(tagsHandler, "PUT", { body: { target_ids: [a], remove: [tag] }, role: "member" })).body).toMatchObject({ removed: 1 });
    expect(((await w.call(tagsHandler, "GET")).body.tags as { count: number }[])[0].count).toBe(1);
  });

  it("can be named and added in one step, reusing a tag of that name", async () => {
    const w = workspace();
    const a = w.contact("A");
    const made = await w.call(tagsHandler, "PUT", { body: { target_ids: [a], create: "Renewal", color: "warn" }, role: "member" });
    expect(made.body).toMatchObject({ added: 1 });
    const again = await w.call(tagsHandler, "PUT", { body: { target_ids: [a], create: "renewal" }, role: "member" });
    expect(again.body.created_tag_id).toBe(made.body.created_tag_id);
    expect((await w.call(tagsHandler, "GET")).body.tags).toEqual([{ id: made.body.created_tag_id, name: "Renewal", color: "warn", count: 1 }]);
  });

  it("are renamed and deleted only by a manager, and deleting takes the tag off every contact", async () => {
    const w = workspace();
    const a = w.contact("A");
    const tag = (await w.call(tagsHandler, "POST", { body: { name: "Old name" } })).body.id as string;
    await w.call(tagsHandler, "PUT", { body: { target_ids: [a], add: [tag] } });
    expect((await w.call(tagsHandler, "PATCH", { body: { id: tag, name: "New name" }, role: "member" })).statusCode).toBe(403);
    expect((await w.call(tagsHandler, "PATCH", { body: { id: tag, name: "New name", color: "li" } })).body).toMatchObject({ name: "New name", color: "li" });
    expect((await w.call(tagsHandler, "DELETE", { query: { id: tag }, role: "member" })).statusCode).toBe(403);
    expect((await w.call(tagsHandler, "DELETE", { query: { id: tag } })).body).toEqual({ ok: true, removed_from: 1 });
    expect((await w.table()).items[0].tags).toEqual([]);
  });

  it("stay inside their workspace", async () => {
    const mine = workspace();
    const theirs = workspace();
    const myContact = mine.contact("Mine");
    const theirContact = theirs.contact("Theirs");
    const myTag = (await mine.call(tagsHandler, "POST", { body: { name: "Mine" } })).body.id as string;
    const theirTag = (await theirs.call(tagsHandler, "POST", { body: { name: "Theirs" } })).body.id as string;
    // Somebody else's tag cannot be used, renamed or deleted.
    expect((await mine.call(tagsHandler, "PUT", { body: { target_ids: [myContact], add: [theirTag] } })).statusCode).toBe(404);
    expect((await mine.call(tagsHandler, "PATCH", { body: { id: theirTag, name: "Taken" } })).statusCode).toBe(404);
    expect((await mine.call(tagsHandler, "DELETE", { query: { id: theirTag } })).statusCode).toBe(404);
    // Somebody else's contact is passed over, not tagged.
    expect((await mine.call(tagsHandler, "PUT", { body: { target_ids: [theirContact], add: [myTag] } })).body).toMatchObject({ contacts: 0, added: 0 });
    expect(db().prepare("SELECT COUNT(*) AS c FROM target_tags WHERE target_id = ?").get(theirContact)).toEqual({ c: 0 });
  });

  it("go when the contact is deleted", async () => {
    const w = workspace();
    const a = w.contact("A");
    await w.call(tagsHandler, "PUT", { body: { target_ids: [a], create: "Champion" } });
    await w.call(targetsHandler, "DELETE", { body: { target_ids: [a] } });
    expect(db().prepare("SELECT COUNT(*) AS c FROM target_tags WHERE target_id = ?").get(a)).toEqual({ c: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("enriching a selection", () => {
  it("says what it would cost without looking anybody up", async () => {
    const w = workspace();
    w.connectApollo();
    const fresh = w.contact("Fresh");
    const tried = w.contact("Tried before", { apollo_enriched_at: "2026-09-01 10:00:00" });
    const hasEmail = w.contact("Has email", { email: "has@example.test" });
    const noAddress = w.contact("No address", { linkedin_url: null });
    const res = await w.call(enrichHandler, "POST", { body: { target_ids: [fresh, tried, hasEmail, noAddress, "not-a-contact"], dry_run: true }, role: "member" });
    expect(res.body).toEqual({
      apollo_connected: true, selected: 4, eligible: 2, eligible_ids: expect.arrayContaining([fresh, tried]), tried_before: 1, have_email: 1, no_profile_address: 1,
      credits: 2, batch: ENRICH_BATCH,
    });
    expect(apollo).not.toHaveBeenCalled();
  });

  it("gives the cost even when Apollo is not connected, and then refuses to run", async () => {
    const w = workspace();
    const a = w.contact("A");
    expect((await w.call(enrichHandler, "POST", { body: { target_ids: [a], dry_run: true } })).body).toMatchObject({ apollo_connected: false, credits: 1 });
    const run = await w.call(enrichHandler, "POST", { body: { target_ids: [a] } });
    expect(run.statusCode).toBe(400);
    expect(run.body.error).toBe("Apollo integration not configured");
    expect(apollo).not.toHaveBeenCalled();
  });

  it("looks up only the contacts that could gain an email, and stores what comes back", async () => {
    const w = workspace();
    w.connectApollo();
    const found = w.contact("Found");
    const missing = w.contact("Missing");
    const hasEmail = w.contact("Has email", { email: "kept@example.test" });
    apollo.mockImplementation(async (url) => (url.includes(found) ? person({ organization: { name: "Northwind", domain: "www.northwind.example", industry: "Logistics", estimated_num_employees: 400, short_description: null, location: null, linkedin_url: null, website_url: null, founded_year: null, logo_url: null, phone: null, annual_revenue_printed: null, technology_names: null, keywords: null, city: null, country: null } }) : null));

    const res = await w.call(enrichHandler, "POST", { body: { target_ids: [found, missing, hasEmail] }, role: "member" });
    expect(res.body).toEqual({ enriched: 1, notFound: 1, skipped: 0, emails_found: 1, looked_up: 2, total: 3 });
    expect(apollo).toHaveBeenCalledTimes(2);
    expect(apollo.mock.calls.every(([, key]) => key === "apollo-test-key")).toBe(true);

    const row = db().prepare("SELECT email, email_status, seniority, country, company_id, apollo_enriched_at FROM targets WHERE id = ?").get(found) as Record<string, string | null>;
    expect(row).toMatchObject({ email: "found@example.test", email_status: "verified", seniority: "vp", country: "Germany" });
    expect(row.apollo_enriched_at).not.toBeNull();
    // The company is filed in this workspace.
    expect(db().prepare("SELECT name, domain, workspace_id FROM companies WHERE id = ?").get(row.company_id)).toEqual({ name: "Northwind", domain: "northwind.example", workspace_id: w.ws });
    // Not found is remembered, so it is not asked for again by a list's enrichment.
    expect((db().prepare("SELECT apollo_enriched_at FROM targets WHERE id = ?").get(missing) as { apollo_enriched_at: string | null }).apollo_enriched_at).not.toBeNull();
    expect((db().prepare("SELECT email FROM targets WHERE id = ?").get(hasEmail) as { email: string }).email).toBe("kept@example.test");
  });

  it("takes one batch per request and no more", async () => {
    const w = workspace();
    w.connectApollo();
    const ids = Array.from({ length: ENRICH_BATCH + 1 }, (_, index) => w.contact(`Contact ${index}`));
    const res = await w.call(enrichHandler, "POST", { body: { target_ids: ids } });
    expect(res.statusCode).toBe(400);
    expect(apollo).not.toHaveBeenCalled();
  });

  it("counts a failed look-up as skipped and carries on", async () => {
    const w = workspace();
    w.connectApollo();
    const [a, b] = [w.contact("A"), w.contact("B")];
    apollo.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(person());
    expect((await w.call(enrichHandler, "POST", { body: { target_ids: [a, b] } })).body).toMatchObject({ enriched: 1, skipped: 1 });
  });

  it("is for members, on their own workspace's contacts", async () => {
    const mine = workspace();
    const theirs = workspace();
    mine.connectApollo();
    const theirContact = theirs.contact("Theirs");
    expect((await mine.call(enrichHandler, "POST", { body: { target_ids: [theirContact] }, role: "viewer" })).statusCode).toBe(403);
    expect((await mine.call(enrichHandler, "POST", { body: { target_ids: [theirContact] } })).body).toMatchObject({ looked_up: 0, total: 0 });
    expect(apollo).not.toHaveBeenCalled();
    expect((await mine.call(enrichHandler, "POST", { body: { target_ids: [] } })).statusCode).toBe(400);
  });

  it("leaves a list's own enrichment answering as it did", async () => {
    const w = workspace();
    w.connectApollo();
    const found = w.contact("Found");
    const missing = w.contact("Missing");
    const done = w.contact("Already tried", { apollo_enriched_at: "2026-09-01 10:00:00" });
    const list = w.list("Tier 1", [found, missing, done]);
    apollo.mockImplementation(async (url) => (url.includes(found) ? person() : null));
    const res = await w.call(listEnrichHandler, "POST", { query: { id: list }, role: "member" });
    expect(res.body).toEqual({ enriched: 1, notFound: 1, skipped: 0, total: 2 });
    // Naming contacts looks them up again even if tried before.
    apollo.mockResolvedValue(null);
    expect((await w.call(listEnrichHandler, "POST", { query: { id: list }, body: { target_ids: [done] }, role: "member" })).body).toEqual({ enriched: 0, notFound: 1, skipped: 0, total: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("custom field definitions", () => {
  const define = (w: ReturnType<typeof workspace>, body: Record<string, unknown>, role = "manager") => w.call(customFieldsHandler, "POST", { body, role });

  it("are still listed as a plain array", async () => {
    const w = workspace();
    await define(w, { name: "Renewal date", key: "renewal_date", field_type: "date" });
    const res = await w.call(customFieldsHandler, "GET", { role: "viewer" });
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown as { key: string; field_type: string }[])[0]).toMatchObject({ key: "renewal_date", field_type: "date" });
  });

  it("take a type from the list and a key used once", async () => {
    const w = workspace();
    expect((await define(w, { name: "Seats", key: "seats", field_type: "number" })).statusCode).toBe(201);
    expect((await define(w, { name: "Seats again", key: "seats" })).statusCode).toBe(409);
    expect((await define(w, { name: "Odd", key: "odd", field_type: "colour" })).statusCode).toBe(400);
    expect((await define(w, { name: "Bad key", key: "Bad Key" })).statusCode).toBe(400);
    expect((await define(w, { name: "By a member", key: "by_member" }, "member")).statusCode).toBe(403);
  });

  it("can be renamed, but keep their key and type", async () => {
    const w = workspace();
    const id = (await define(w, { name: "Seats", key: "seats", field_type: "number" })).body.id as string;
    expect((await w.call(customFieldsHandler, "PATCH", { body: { id, name: "Licensed seats" } })).body).toMatchObject({ name: "Licensed seats", key: "seats", field_type: "number" });
    expect((await w.call(customFieldsHandler, "PATCH", { body: { id, key: "licences" } })).statusCode).toBe(400);
    expect((await w.call(customFieldsHandler, "PATCH", { body: { id, field_type: "text" } })).statusCode).toBe(400);
    expect((await w.call(customFieldsHandler, "PATCH", { body: { id, name: "By a member" }, role: "member" })).statusCode).toBe(403);
  });

  it("say how many contacts hold a value, and take the values with them when deleted", async () => {
    const w = workspace();
    const contact = w.contact("A");
    const id = (await define(w, { name: "Seats", key: "seats", field_type: "number" })).body.id as string;
    await w.call(customFieldsHandler, "PUT", { body: { target_id: contact, field_id: id, value: 40 }, role: "member" });
    const managed = await w.call(customFieldsHandler, "GET", { query: { view: "manage" } });
    expect((managed.body.fields as { contacts: number }[])[0].contacts).toBe(1);
    expect((await w.call(customFieldsHandler, "DELETE", { query: { id }, role: "member" })).statusCode).toBe(403);
    expect((await w.call(customFieldsHandler, "DELETE", { query: { id } })).body).toEqual({ ok: true, values_removed: 1 });
    expect(db().prepare("SELECT COUNT(*) AS c FROM contact_custom_values WHERE target_id = ?").get(contact)).toEqual({ c: 0 });
  });

  it("hold a date as written, and refuse anything that is not one", async () => {
    const w = workspace();
    const contact = w.contact("A");
    const id = (await define(w, { name: "Renewal date", key: "renewal_date", field_type: "date" })).body.id as string;
    const set = (value: unknown) => w.call(customFieldsHandler, "PUT", { body: { target_id: contact, field_id: id, value }, role: "member" });
    expect((await set("2027-02-31")).statusCode).toBe(400);
    expect((await set("next spring")).statusCode).toBe(400);
    expect((await set("2027-13-01")).statusCode).toBe(400);
    expect((await set("2027-03-01")).statusCode).toBe(200);
    const read = await w.call(customFieldsHandler, "GET", { query: { target_id: contact } });
    expect((read.body.values as Record<string, unknown>)[id]).toBe("2027-03-01");
    // It renders in campaign wording as the date it is.
    expect(loadTargetCustomValues(db(), w.ws, contact)).toEqual({ renewal_date: "2027-03-01" });
  });

  it("clear a value when it is set to nothing, so the wording's fallback applies again", async () => {
    const w = workspace();
    const contact = w.contact("A");
    const id = (await define(w, { name: "Seats", key: "seats", field_type: "number" })).body.id as string;
    const set = (value: unknown) => w.call(customFieldsHandler, "PUT", { body: { target_id: contact, field_id: id, value }, role: "member" });
    await set(40);
    expect(loadTargetCustomValues(db(), w.ws, contact)).toEqual({ seats: "40" });
    await set("");
    expect(loadTargetCustomValues(db(), w.ws, contact)).toEqual({ seats: "" });
    expect((await set("forty")).statusCode).toBe(400);
  });

  it("cannot be reached across workspaces", async () => {
    const mine = workspace();
    const theirs = workspace();
    const id = (await define(theirs, { name: "Seats", key: "seats" })).body.id as string;
    expect((await mine.call(customFieldsHandler, "PATCH", { body: { id, name: "Mine now" } })).statusCode).toBe(404);
    expect((await mine.call(customFieldsHandler, "DELETE", { query: { id } })).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("exporting what the contacts screen shows", () => {
  /** A CSV file back into objects keyed by column heading. Cells here never hold a comma. */
  const records = (text: string) => {
    const [header, ...rows] = text.replace(/^﻿/, "").trim().split("\r\n").map((line) => line.split(","));
    return rows.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]])));
  };
  const download = async (w: ReturnType<typeof workspace>, query: Record<string, string>) => records((await w.call(exportHandler, "GET", { query: { resource: "contacts", ...query } })).text);

  it("takes the screen's filters and a hand-picked selection", async () => {
    const w = workspace();
    const a = w.contact("Ada", { intent_score: 80, country: "Spain" });
    w.contact("Bea", { intent_score: 20, country: "Spain" });
    const c = w.contact("Cy", { intent_score: 90, country: "Norway" });
    expect((await download(w, { country: "Spain", intent: "60" })).map((row) => row.Name)).toEqual(["Ada"]);
    expect((await download(w, { ids: `${a},${c}` })).map((row) => row.Name)).toEqual(["Ada", "Cy"]);
    expect((await download(w, { q: "bea" })).map((row) => row.Name)).toEqual(["Bea"]);
  });

  it("carries the owner and the tags", async () => {
    const w = workspace();
    const owner = w.user("Priya Raghavan");
    const a = w.contact("Ada", { owner_id: owner });
    await w.call(tagsHandler, "PUT", { body: { target_ids: [a], create: "Champion" } });
    const [row] = await download(w, {});
    expect(row.Owner).toBe("Priya Raghavan");
    expect(row.Tags).toBe("Champion");
  });

  it("exports the contacts that are in no list", async () => {
    const w = workspace();
    const listed = w.contact("Listed");
    w.contact("Loose");
    w.list("Tier 1", [listed]);
    expect((await download(w, { list_id: "none" })).map((row) => row.Name)).toEqual(["Loose"]);
  });
});
