// The Companies screen's server side: the list with search, filter and sort, the figures
// across every company, one company in detail, updating a company, looking companies up
// on Apollo, the people Apollo suggests, the bounce flag, signals recorded against a
// company, and the CSV import and export. Real (throwaway) database.
//
// Apollo is never reached: `fetch` is replaced for the whole file, every call to it is
// recorded, and a call nobody scripted fails the test.
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb, migrateDatabase } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { readOrganization, readPerson } from "@/lib/apollo";
import { lookupDomain } from "@/lib/companies/enrich";
import { parseDepartments, parseList, type CompanyDetail, type CompanyRow, type CompaniesSummary } from "@/lib/companies/overview";
import { ctxHeaders } from "./helpers/ctx";
import companiesHandler from "@/pages/api/companies/index";
import companyHandler from "@/pages/api/companies/[id]";
import enrichHandler from "@/pages/api/companies/enrich";
import importHandler from "@/pages/api/companies/import";
import suggestionsHandler from "@/pages/api/companies/[id]/suggestions";
import bouncesHandler from "@/pages/api/companies/[id]/bounces";
import signalsHandler from "@/pages/api/platform/signals";
import targetsHandler from "@/pages/api/targets/index";
import exportHandler from "@/pages/api/export/[resource]";

const db = () => getDb();
let seq = 0;

// ── Apollo, scripted ──────────────────────────────────────────────────────────
type Reply = { status?: number; body?: unknown };
const apollo = { calls: [] as { url: string; method: string; key: string | null; body: Record<string, unknown> | null }[], replies: [] as Reply[] };
vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  const url = String(input);
  if (!url.startsWith("https://api.apollo.io/")) throw new Error(`A test reached the network: ${url}`);
  apollo.calls.push({ url, method: init?.method ?? "GET", key: init?.headers?.["X-Api-Key"] ?? null, body: init?.body ? JSON.parse(init.body) : null });
  const reply = apollo.replies.shift();
  if (!reply) throw new Error(`Apollo was asked something no test scripted: ${url}`);
  const status = reply.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => reply.body ?? {} };
});
beforeEach(() => { apollo.calls = []; apollo.replies = []; });

const NORTHWIND = {
  name: "Northwind Logistics BV", primary_domain: "northwind.test", industry: "logistics & supply chain", estimated_num_employees: 1840,
  short_description: "A Rotterdam freight forwarder.", linkedin_url: "http://www.linkedin.com/company/northwind", website_url: "http://www.northwind.test",
  founded_year: 1998, logo_url: "https://logo.test/northwind.png", phone: "+31 10 555 0100", annual_revenue_printed: "310M", city: "Rotterdam", country: "Netherlands",
  technology_names: ["Salesforce", "Snowflake"], keywords: ["freight forwarding", "cold chain"],
  total_funding_printed: "410M", latest_funding_stage: "Series D", latest_funding_round_date: "2026-09-12T00:00:00.000+00:00",
  funding_events: [{ date: "2024-03-01T00:00:00.000+00:00", type: "Series C", amount: "90M", currency: "$" }, { date: "2026-09-12T00:00:00.000+00:00", type: "Series D", amount: "120M", currency: "$" }],
  departmental_head_count: { operations: 820, sales: 240, engineering: 160, finance: 90, legal: 0 },
  organization_headcount_twelve_month_growth: 0.08, publicly_traded_symbol: null, publicly_traded_exchange: null, alexa_ranking: 41208,
};

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown>; text: string; headers: Record<string, string> };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined, text: "", headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.send = (payload: unknown) => { res.text = String(payload); return res; };
  res.write = (chunk: string) => { res.text = String(res.text) + chunk; return true; };
  res.end = () => res;
  res.once = () => res;
  res.off = () => res;
  res.setHeader = (name: string, value: unknown) => { (res.headers as Record<string, string>)[name.toLowerCase()] = String(value); return res; };
  return res as unknown as Res;
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
interface CallOptions { body?: unknown; query?: Record<string, string>; role?: string; user?: string }

function workspace() {
  const n = ++seq;
  const ws = `ws-co-${n}`;
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
  const company = (name: string, fields: Record<string, unknown> = {}) => {
    const id = `co-${++seq}`;
    insert("companies", { id, workspace_id: ws, name, ...fields });
    return id;
  };
  const contact = (companyId: string | null, fields: Record<string, unknown> = {}) => {
    const id = `cperson-${++seq}`;
    insert("targets", { id, workspace_id: ws, full_name: `Person ${seq}`, linkedin_url: `https://www.linkedin.com/in/${id}/`, company_id: companyId, ...fields });
    return id;
  };
  /** A campaign with these contacts enrolled, their email track in the given state. */
  const run = (name: string, status: string, members: string[], trackState = "in_progress") => {
    const workflowId = `cwf-${++seq}`;
    const runId = `crun-${++seq}`;
    insert("workflows", { id: workflowId, workspace_id: ws, name });
    insert("runs", { id: runId, workspace_id: ws, workflow_id: workflowId, status });
    for (const member of members) {
      const profile = `crp-${++seq}`;
      insert("run_profiles", { id: profile, run_id: runId, target_id: member });
      insert("run_profile_tracks", { id: `ctrack-${++seq}`, run_profile_id: profile, track: "email", state: trackState });
    }
    return workflowId;
  };
  const mailbox = () => {
    const id = `cmail-${++seq}`;
    insert("email_accounts", { id, workspace_id: ws, name: "Sales", from_email: `${id}@sender.test`, smtp_host: "smtp.test", username: "u", password: encryptSecret("p") });
    return id;
  };
  /** A hard bounce from an address, as the mailbox reader records one. */
  const bounce = (mailboxId: string, recipient: string, when = "now") => insert("sender_events", {
    id: `cev-${++seq}`, workspace_id: ws, email_account_id: mailboxId, provider: "imap", provider_event_id: `dsn-${seq}`, event_type: "bounced", recipient,
    occurred_at: db().prepare("SELECT datetime('now', ?) AS at").pluck().get(when === "now" ? "-1 minutes" : when) as string,
  });
  const connectApollo = () => insert("integrations", { key: "apollo", workspace_id: ws, api_key: encryptSecret("apollo-test-key") });
  /** A person Apollo suggested for a company. The id is this workspace's own `key`. */
  const sid = (key: string) => `${ws}-${key}`;
  const suggest = (companyId: string, key: string, name: string, fields: Record<string, unknown> = {}) => {
    insert("company_suggestions", { id: sid(key), workspace_id: ws, company_id: companyId, external_id: `ap-${key}`, name, ...fields });
    return sid(key);
  };
  const table = async (query: Record<string, string> = {}, opts: CallOptions = {}) =>
    (await call(companiesHandler, "GET", { ...opts, query: { view: "table", ...query } })).body as unknown as { items: CompanyRow[]; total: number; page: number; limit: number };
  const names = async (query: Record<string, string> = {}) => (await table(query)).items.map((row) => row.name);
  const detail = async (id: string) => (await call(companyHandler, "GET", { query: { id, view: "detail" } })).body as unknown as CompanyDetail;
  const row = (id: string) => db().prepare("SELECT * FROM companies WHERE id = ?").get(id) as Record<string, unknown>;
  const person = (id: string) => db().prepare("SELECT * FROM targets WHERE id = ?").get(id) as Record<string, unknown>;
  return { ws, call, insert, company, contact, run, mailbox, bounce, connectApollo, sid, suggest, table, names, detail, row, person };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("companies as the API has always given them", () => {
  it("is still { companies, total } with each company's contact count, and one company with its contacts", async () => {
    const w = workspace();
    const id = w.company("Northwind", { domain: "northwind.test", industry: "Logistics" });
    w.contact(id, { full_name: "Marcus Oyelaran" });
    w.company("Lumen");
    const list = (await w.call(companiesHandler, "GET", { role: "viewer" })).body as { companies: Record<string, unknown>[]; total: number };
    expect(list.total).toBe(2);
    expect(list.companies.map((company) => [company.name, company.contact_count])).toEqual([["Lumen", 0], ["Northwind", 1]]);
    const one = (await w.call(companyHandler, "GET", { query: { id }, role: "viewer" })).body as Record<string, unknown>;
    expect(one).toMatchObject({ id, name: "Northwind", domain: "northwind.test" });
    expect((one.contacts as { full_name: string }[]).map((contact) => contact.full_name)).toEqual(["Marcus Oyelaran"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the companies list", () => {
  it("gives each company the higher of its own intent and its contacts', and counts its contacts", async () => {
    const w = workspace();
    const northwind = w.company("Northwind", { domain: "northwind.test", employee_count: 1840, intent_score: 20 });
    w.contact(northwind, { intent_score: 86 });
    w.contact(northwind, { intent_score: 34 });
    const lumen = w.company("Lumen", { intent_score: 91, is_target: 1 });
    w.contact(lumen, { intent_score: 10 });
    w.company("Quiet Co", { email_domain_invalid: 1 });
    const { items, total } = await w.table();
    expect(total).toBe(3);
    // Highest intent first by default.
    expect(items).toEqual([
      { id: lumen, name: "Lumen", domain: null, logo_url: null, employee_count: null, intent: 91, contacts: 1, bouncing: false, is_target: true },
      { id: northwind, name: "Northwind", domain: "northwind.test", logo_url: null, employee_count: 1840, intent: 86, contacts: 2, bouncing: false, is_target: false },
      expect.objectContaining({ name: "Quiet Co", intent: 0, contacts: 0, bouncing: true }),
    ]);
  });

  it("filters to companies with contacts, bouncing, in a campaign, or marked as targets", async () => {
    const w = workspace();
    const active = w.company("Active");
    const finished = w.company("Finished");
    const bouncing = w.company("Bouncing", { email_domain_invalid: 1 });
    w.company("Target", { is_target: 1 });
    const a = w.contact(active);
    const f = w.contact(finished);
    w.contact(bouncing);
    w.run("Running push", "running", [a]);
    // Enrolled once, nothing left to come: not "in a campaign".
    w.run("Old push", "running", [f], "completed");
    expect(await w.names({ filter: "contacts", sort: "name:asc" })).toEqual(["Active", "Bouncing", "Finished"]);
    expect(await w.names({ filter: "bouncing" })).toEqual(["Bouncing"]);
    expect(await w.names({ filter: "campaign" })).toEqual(["Active"]);
    expect(await w.names({ filter: "target" })).toEqual(["Target"]);
    // A filter nobody defined is no filter.
    expect((await w.table({ filter: "'; DROP TABLE companies; --" })).total).toBe(4);
  });

  it("searches names and domains, sorts only by a key on its list, and pages", async () => {
    const w = workspace();
    const big = w.company("Zephyr Mobility", { domain: "zephyr.test", employee_count: 5400 });
    w.company("Arcadia Labs", { domain: "arcadia.test", employee_count: 180 });
    w.company("Meridian Freight", { domain: "meridianfr.test", employee_count: 1120 });
    w.contact(big);
    w.contact(big);
    expect(await w.names({ q: "arcadia" })).toEqual(["Arcadia Labs"]);
    expect(await w.names({ q: "meridianfr.test" })).toEqual(["Meridian Freight"]);
    // "%" and "_" are looked for as themselves.
    expect(await w.names({ q: "%" })).toEqual([]);
    expect(await w.names({ sort: "name:asc" })).toEqual(["Arcadia Labs", "Meridian Freight", "Zephyr Mobility"]);
    expect(await w.names({ sort: "employees:desc" })).toEqual(["Zephyr Mobility", "Meridian Freight", "Arcadia Labs"]);
    expect((await w.names({ sort: "contacts:desc" }))[0]).toBe("Zephyr Mobility");
    // An unknown key falls back to intent, then name.
    expect(await w.names({ sort: "notes:asc" })).toEqual(["Arcadia Labs", "Meridian Freight", "Zephyr Mobility"]);
    const second = await w.table({ sort: "name:asc", limit: "2", page: "2" });
    expect(second).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(second.items.map((item) => item.name)).toEqual(["Zephyr Mobility"]);
  });

  it("stays inside its workspace and can be read by a viewer", async () => {
    const mine = workspace();
    const theirs = workspace();
    mine.company("Mine");
    theirs.company("Theirs");
    expect((await mine.table({}, { role: "viewer" })).items.map((item) => item.name)).toEqual(["Mine"]);
  });

  it("adds every company up", async () => {
    const w = workspace();
    const a = w.company("A", { domain: "a.test", email_domain_invalid: 1, is_target: 1 });
    w.company("B", { domain: "b.test" });
    w.company("C");
    w.contact(a);
    const summary = (await w.call(companiesHandler, "GET", { query: { view: "summary" }, role: "viewer" })).body as unknown as CompaniesSummary;
    expect(summary).toEqual({ total: 3, bouncing: 1, targets: 1, with_contacts: 1, with_domain: 2, apollo_connected: false });
    w.connectApollo();
    expect(((await w.call(companiesHandler, "GET", { query: { view: "summary" } })).body as unknown as CompaniesSummary).apollo_connected).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("one company in detail", () => {
  it("reads lists kept as JSON or as text with commas, and departments largest first", () => {
    expect(parseList('["Salesforce","Snowflake","salesforce",""]')).toEqual(["Salesforce", "Snowflake"]);
    expect(parseList("freight forwarding, cold chain ,")).toEqual(["freight forwarding", "cold chain"]);
    expect(parseList(null)).toEqual([]);
    expect(parseDepartments('{"sales":240,"operations":820,"legal":0,"odd":"many"}')).toEqual([{ name: "operations", count: 820 }, { name: "sales", count: 240 }]);
    expect(parseDepartments("not json")).toEqual([]);
    expect(parseDepartments("[1,2]")).toEqual([]);
  });

  it("gathers the company, its contacts, the campaigns they are in, suggestions and signals", async () => {
    const w = workspace();
    const id = w.company("Northwind", {
      domain: "northwind.test", technology_names: '["Salesforce","Snowflake"]', keywords: "freight forwarding, cold chain", department_headcount: '{"sales":240,"operations":820}',
      headcount_growth: 0.08, funding_stage: "Series D", funding_amount: "$120M", is_target: 1, enrichment_source: "apollo", enriched_at: "2026-10-07 09:00:00",
    });
    const marcus = w.contact(id, { full_name: "Marcus Oyelaran", title: "VP Revenue Ops", email: "m.oyelaran@northwind.test", email_status: "invalid", degree: 1, intent_score: 86 });
    const sanne = w.contact(id, { full_name: "Sanne Visser", connection_requested_at: "2026-10-01 09:00:00", intent_score: 58 });
    w.contact(id, { full_name: "Bram Koster", intent_score: 34 });
    w.run("Q4 Logistics", "running", [marcus, sanne]);
    w.run("Paused push", "paused", [marcus]);
    w.run("Done", "completed", [marcus]);
    w.suggest(id, "1", "Pieter Gr***f", { title: "Director of Procurement" });
    w.suggest(id, "2", "Gone", { status: "dismissed" });
    w.insert("signals", { id: `sig-${++seq}`, workspace_id: w.ws, company_id: id, type: "funding", title: "Raised Series D", score: 60, occurred_at: "2026-09-12T10:00:00Z" });
    w.insert("signals", { id: `sig-${++seq}`, workspace_id: w.ws, company_id: id, type: "hiring", title: "3 RevOps roles posted", score: 40, occurred_at: "2026-10-05T10:00:00Z", processed_at: "2026-10-06 09:00:00" });

    const detail = await w.detail(id);
    expect(detail.company).toMatchObject({
      name: "Northwind", domain: "northwind.test", technologies: ["Salesforce", "Snowflake"], keywords: ["freight forwarding", "cold chain"],
      departments: [{ name: "operations", count: 820 }, { name: "sales", count: 240 }], headcount_growth: 0.08, funding_stage: "Series D", funding_amount: "$120M",
      is_target: true, bouncing: false, intent: 86, enrichment_source: "apollo", enriched_at: "2026-10-07 09:00:00",
    });
    expect(detail.contacts.total).toBe(3);
    // Highest intent first, each with where they stand on LinkedIn.
    expect(detail.contacts.items.map((contact) => [contact.full_name, contact.linkedin_status, contact.intent_score])).toEqual([
      ["Marcus Oyelaran", "connected", 86], ["Sanne Visser", "invite_sent", 58], ["Bram Koster", "not_connected", 34],
    ]);
    expect(detail.contacts.items[0]).toMatchObject({ id: marcus, email: "m.oyelaran@northwind.test", email_status: "invalid", title: "VP Revenue Ops" });
    expect(detail.campaigns.map((campaign) => campaign.name)).toEqual(["Paused push", "Q4 Logistics"]);
    expect(detail.suggestions).toEqual([{ id: w.sid("1"), name: "Pieter Gr***f", title: "Director of Procurement", seniority: null, linkedin_url: null }]);
    expect(detail.suggestions_searched_at).toEqual(expect.any(String));
    expect(detail.signals).toMatchObject({ total: 2, new: 1 });
    expect(detail.signals.items.map((signal) => [signal.title, signal.handled])).toEqual([["3 RevOps roles posted", true], ["Raised Series D", false]]);
    // No flag, nothing to say about bounces.
    expect(detail.bounce).toBeNull();
    expect(detail.apollo_connected).toBe(false);
  });

  it("is not found across workspaces", async () => {
    const mine = workspace();
    const theirs = workspace();
    const id = theirs.company("Theirs");
    expect((await mine.call(companyHandler, "GET", { query: { id, view: "detail" } })).statusCode).toBe(404);
    expect((await mine.call(bouncesHandler, "GET", { query: { id } })).statusCode).toBe(404);
    expect((await mine.call(suggestionsHandler, "POST", { query: { id }, body: { action: "find", dry_run: true } })).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("changing a company", () => {
  it("changes only what is sent, where it used to blank everything else", async () => {
    const w = workspace();
    const id = w.company("Northwind", { domain: "northwind.test", industry: "Logistics", location: "Rotterdam", website: "https://northwind.test", linkedin_url: "https://www.linkedin.com/company/northwind", notes: "Met in May" });
    const res = await w.call(companyHandler, "PUT", { query: { id }, body: { industry: "Freight & logistics" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ industry: "Freight & logistics", domain: "northwind.test", location: "Rotterdam", website: "https://northwind.test", notes: "Met in May" });
    // A field sent empty is emptied, on purpose.
    await w.call(companyHandler, "PUT", { query: { id }, body: { notes: "", location: null } });
    expect(w.row(id)).toMatchObject({ notes: null, location: null, industry: "Freight & logistics", name: "Northwind" });
    // Nothing sent, nothing changed.
    expect((await w.call(companyHandler, "PUT", { query: { id }, body: {} })).body).toMatchObject({ name: "Northwind", domain: "northwind.test" });
  });

  it("marks and unmarks a target account", async () => {
    const w = workspace();
    const id = w.company("Northwind", { notes: "Kept" });
    await w.call(companyHandler, "PUT", { query: { id }, body: { is_target: true } });
    expect(w.row(id)).toMatchObject({ is_target: 1, notes: "Kept" });
    await w.call(companyHandler, "PUT", { query: { id }, body: { is_target: false } });
    expect(w.row(id).is_target).toBe(0);
    expect((await w.call(companyHandler, "PUT", { query: { id }, body: { is_target: "yes" } })).statusCode).toBe(400);
  });

  it("refuses a blank name, a domain another company has, a company that is not there, and a viewer", async () => {
    const w = workspace();
    const id = w.company("Northwind", { domain: "northwind.test" });
    w.company("Lumen", { domain: "lumen.test" });
    expect((await w.call(companyHandler, "PUT", { query: { id }, body: { name: "  " } })).statusCode).toBe(400);
    expect((await w.call(companyHandler, "PUT", { query: { id }, body: { domain: "https://www.Lumen.test/about" } })).statusCode).toBe(409);
    expect((await w.call(companyHandler, "PUT", { query: { id: "nobody" }, body: { name: "X" } })).statusCode).toBe(404);
    expect((await w.call(companyHandler, "PUT", { query: { id }, body: { name: "X" }, role: "viewer" })).statusCode).toBe(403);
    expect(w.row(id)).toMatchObject({ name: "Northwind", domain: "northwind.test" });
    // Its own domain, typed the long way, is kept bare.
    await w.call(companyHandler, "PUT", { query: { id }, body: { domain: "HTTPS://WWW.Northwind.test/" } });
    expect(w.row(id).domain).toBe("northwind.test");
  });

  it("keeps a new company's domain bare, and makes one company per domain", async () => {
    const w = workspace();
    const made = await w.call(companiesHandler, "POST", { body: { name: "Northwind", domain: "https://www.Northwind.test/nl", is_target: true } });
    expect(made.statusCode).toBe(201);
    expect(made.body).toMatchObject({ name: "Northwind", domain: "northwind.test", is_target: 1 });
    expect((await w.call(companiesHandler, "POST", { body: { name: "Northwind again", domain: "northwind.test" } })).statusCode).toBe(409);
    // Without a domain there is nothing to tell two companies apart by.
    expect((await w.call(companiesHandler, "POST", { body: { name: "Northwind" } })).statusCode).toBe(201);
  });

  it("links a contact added from a company's page to that company", async () => {
    const w = workspace();
    const id = w.company("Northwind");
    const made = await w.call(targetsHandler, "POST", { body: { full_name: "Ayla Demir", email: "a.demir@northwind.test", company_id: id } });
    expect(made.statusCode).toBe(201);
    expect(made.body).toMatchObject({ full_name: "Ayla Demir", company_id: id, company: "Northwind" });
    expect((await w.call(targetsHandler, "POST", { body: { full_name: "Nobody", email: "n@x.test", company_id: "not-a-company" } })).statusCode).toBe(400);
    // As before, a contact needs no company.
    expect((await w.call(targetsHandler, "POST", { body: { full_name: "Free Agent", email: "free@x.test" } })).body).toMatchObject({ company_id: null });
    // "Add to campaign" takes everyone at the company, however many the card shows.
    const other = w.company("Lumen");
    w.contact(other);
    const ids = (await w.call(targetsHandler, "GET", { query: { view: "ids", company_id: id } })).body as { ids: string[]; total: number };
    expect(ids).toMatchObject({ ids: [made.body.id], total: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("looking companies up on Apollo", () => {
  it("reads a domain out of what someone typed", () => {
    expect(lookupDomain("https://www.Northwind.test/about?x=1")).toBe("northwind.test");
    expect(lookupDomain(" northwind.test ")).toBe("northwind.test");
    expect(lookupDomain("northwind")).toBeNull();
    expect(lookupDomain("")).toBeNull();
    expect(lookupDomain(null)).toBeNull();
  });

  it("reads Apollo's record into what a company keeps", () => {
    expect(readOrganization(NORTHWIND)).toMatchObject({
      name: "Northwind Logistics BV", domain: "northwind.test", estimated_num_employees: 1840, funding_stage: "Series D", funding_amount: "$120M",
      funding_at: "2026-09-12T00:00:00.000+00:00", funding_total: "$410M", department_headcount: { operations: 820, sales: 240, engineering: 160, finance: 90 },
      headcount_growth: 0.08, stock_symbol: null, domain_rank: 41208, technology_names: ["Salesforce", "Snowflake"],
    });
    // Amounts sent as numbers are printed short, and a record with nothing in it is all nulls.
    expect(readOrganization({ total_funding: 1_250_000_000, funding_events: [{ date: "2025-01-01", amount: 30_000_000, currency: "€", type: "Series B" }] }))
      .toMatchObject({ funding_total: "$1.3B", funding_amount: "€30M", funding_stage: "Series B", funding_at: "2025-01-01" });
    expect(readOrganization({})).toMatchObject({ name: null, funding_stage: null, department_headcount: null, technology_names: null, domain_rank: null });
  });

  it("says what a look-up would cost without asking Apollo anything", async () => {
    const w = workspace();
    const a = w.company("A", { domain: "a.test" });
    const b = w.company("B", { website: "https://www.b.test/home", enriched_at: "2026-10-01 09:00:00" });
    const c = w.company("C");
    w.connectApollo();
    const cost = (await w.call(enrichHandler, "POST", { body: { ids: [a, b, c, "not-in-this-workspace"], dry_run: true } })).body;
    expect(cost).toMatchObject({ apollo_connected: true, selected: 3, eligible: 2, no_domain: 1, enriched_before: 1, credits: 2, capped: false, batch: 10 });
    expect([...(cost.eligible_ids as string[])].sort()).toEqual([a, b].sort());
    // Without ids it is the whole list as the screen has it filtered.
    expect((await w.call(enrichHandler, "POST", { body: { dry_run: true } })).body).toMatchObject({ selected: 3, eligible: 2, credits: 2 });
    expect((await w.call(enrichHandler, "POST", { body: { dry_run: true, q: "A" } })).body).toMatchObject({ selected: 1, eligible: 1, credits: 1 });
    expect(apollo.calls).toEqual([]);
  });

  it("asks nothing when Apollo is not connected, when no ids are named, or for a viewer", async () => {
    const w = workspace();
    const a = w.company("A", { domain: "a.test" });
    expect((await w.call(enrichHandler, "POST", { body: { ids: [a], dry_run: true } })).body).toMatchObject({ apollo_connected: false, credits: 1 });
    expect((await w.call(enrichHandler, "POST", { body: { ids: [a] } })).statusCode).toBe(400);
    w.connectApollo();
    expect((await w.call(enrichHandler, "POST", { body: {} })).statusCode).toBe(400);
    expect((await w.call(enrichHandler, "POST", { body: { ids: Array.from({ length: 11 }, (_, i) => `x-${i}`) } })).statusCode).toBe(400);
    expect((await w.call(enrichHandler, "POST", { body: { ids: [a] }, role: "viewer" })).statusCode).toBe(403);
    expect(apollo.calls).toEqual([]);
    expect(w.row(a).enriched_at).toBeNull();
  });

  it("looks a company up by its domain and keeps what comes back, without overwriting what someone typed", async () => {
    const w = workspace();
    w.connectApollo();
    const id = w.company("Northwind", { domain: "northwind.test", industry: "Freight & logistics", location: "Port of Rotterdam", employee_count: 900, notes: "Typed by hand" });
    apollo.replies.push({ body: { organization: NORTHWIND } });
    const res = await w.call(enrichHandler, "POST", { body: { ids: [id] } });
    expect(res.body).toEqual({ enriched: 1, not_found: 0, no_domain: 0, failed: 0 });
    expect(apollo.calls).toEqual([{ url: "https://api.apollo.io/api/v1/organizations/enrich?domain=northwind.test", method: "GET", key: "apollo-test-key", body: null }]);
    expect(w.row(id)).toMatchObject({
      // Typed fields stay; the name is never taken from Apollo.
      name: "Northwind", industry: "Freight & logistics", location: "Port of Rotterdam", notes: "Typed by hand",
      // What Apollo measures is the newest word on it.
      employee_count: 1840, description: "A Rotterdam freight forwarder.", founded_year: 1998, annual_revenue: "310M", city: "Rotterdam", country: "Netherlands",
      technology_names: '["Salesforce","Snowflake"]', keywords: '["freight forwarding","cold chain"]',
      funding_stage: "Series D", funding_amount: "$120M", funding_total: "$410M", department_headcount: '{"operations":820,"sales":240,"engineering":160,"finance":90}',
      headcount_growth: 0.08, domain_rank: 41208, stock_symbol: null, enrichment_source: "apollo",
    });
    expect(w.row(id).enriched_at).toEqual(expect.any(String));
    expect(db().prepare("SELECT action, metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'companies.enriched'").get(w.ws)).toMatchObject({ metadata_json: expect.stringContaining('"credits":1') });
  });

  it("does not blank a field Apollo has nothing for on a second look-up", async () => {
    const w = workspace();
    w.connectApollo();
    const id = w.company("Northwind", { domain: "northwind.test" });
    apollo.replies.push({ body: { organization: NORTHWIND } }, { body: { organization: { primary_domain: "northwind.test", estimated_num_employees: 1900 } } });
    await w.call(enrichHandler, "POST", { body: { ids: [id] } });
    await w.call(enrichHandler, "POST", { body: { ids: [id] } });
    expect(w.row(id)).toMatchObject({ employee_count: 1900, funding_stage: "Series D", technology_names: '["Salesforce","Snowflake"]', founded_year: 1998 });
  });

  it("counts a domain Apollo does not know, skips a company with no domain, and stops when Apollo refuses", async () => {
    const w = workspace();
    w.connectApollo();
    const unknown = w.company("Unknown", { domain: "unknown.test" });
    const bare = w.company("No domain");
    const refused = w.company("Refused", { domain: "refused.test" });
    const never = w.company("Never asked", { domain: "never.test" });
    // 404: not known. Then 402: out of credits.
    apollo.replies.push({ status: 404 }, { status: 402 });
    const res = await w.call(enrichHandler, "POST", { body: { ids: [unknown, bare, refused, never] } });
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: "Apollo could not be asked: the Apollo account has no credits left", enriched: 0, not_found: 1, no_domain: 1, failed: 0 });
    // The company with no domain cost nothing, and the one after the refusal was never asked about.
    expect(apollo.calls.map((call) => call.url.split("domain=")[1])).toEqual(["unknown.test", "refused.test"]);
    expect(w.row(unknown)).toMatchObject({ enrichment_source: "apollo", enriched_at: expect.any(String) });
    expect(w.row(refused).enriched_at).toBeNull();
    expect(w.row(never).enriched_at).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("people Apollo suggests for a company", () => {
  it("reads a person from a search, whichever shape Apollo sends", () => {
    expect(readPerson({ id: "ap-1", first_name: "Pieter", last_name_obfuscated: "Gr***f", title: "Director of Procurement", seniority: "director" }))
      .toEqual({ id: "ap-1", name: "Pieter Gr***f", title: "Director of Procurement", seniority: "director", linkedin_url: null });
    expect(readPerson({ id: "ap-2", name: "Noor Jansen", linkedin_url: "http://www.linkedin.com/in/noor-jansen" })).toMatchObject({ name: "Noor Jansen", linkedin_url: "http://www.linkedin.com/in/noor-jansen" });
    // A Sales Navigator address is not a profile address.
    expect(readPerson({ id: "ap-3", name: "X Y", linkedin_url: "https://www.linkedin.com/sales/lead/abc" })?.linkedin_url).toBeNull();
    expect(readPerson({ first_name: "No", last_name: "Id" })).toBeNull();
    expect(readPerson({ id: "ap-4" })).toBeNull();
  });

  it("says what a search and an addition would cost without asking Apollo anything", async () => {
    const w = workspace();
    const id = w.company("Northwind", { domain: "northwind.test" });
    w.suggest(id, "1", "Pieter Gr***f");
    w.suggest(id, "2", "Noor J***n");
    w.suggest(id, "3", "Dismissed", { status: "dismissed" });
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "find", dry_run: true } })).body).toEqual({ apollo_connected: false, domain: "northwind.test", credits: 0, people: 10 });
    // One credit a person, counted over the people still on offer.
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "add", ids: [w.sid("1"), w.sid("2"), w.sid("3"), "nobody"], dry_run: true } })).body).toEqual({ apollo_connected: false, people: 2, credits: 2 });
    // Without Apollo neither does anything.
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "find" } })).statusCode).toBe(400);
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "add", ids: [w.sid("1")] } })).statusCode).toBe(400);
    w.connectApollo();
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "find" }, role: "viewer" })).statusCode).toBe(403);
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "add", ids: [] } })).statusCode).toBe(400);
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "add", ids: Array.from({ length: 11 }, (_, i) => `x-${i}`) } })).statusCode).toBe(400);
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "invent" } })).statusCode).toBe(400);
    expect(apollo.calls).toEqual([]);
  });

  it("keeps the people a search names who are not contacts yet, once each", async () => {
    const w = workspace();
    w.connectApollo();
    const id = w.company("Northwind", { website: "https://www.northwind.test" });
    w.contact(id, { full_name: "Already Here", apollo_id: "ap-known" });
    w.contact(null, { full_name: "Known By Address", linkedin_url: "https://www.linkedin.com/in/known-by-address" });
    const people = [
      { id: "ap-known", first_name: "Already", last_name_obfuscated: "H***e", title: "CFO" },
      { id: "ap-url", name: "Known By Address", linkedin_url: "https://www.linkedin.com/in/Known-By-Address/" },
      { id: "ap-1", first_name: "Pieter", last_name_obfuscated: "Gr***f", title: "Director of Procurement", seniority: "director" },
      { id: "ap-2", first_name: "Noor", last_name_obfuscated: "Ja***n", title: "VP Customer Operations", seniority: "vp" },
      { first_name: "No", last_name: "Id" },
    ];
    apollo.replies.push({ body: { people, total_entries: 5 } });
    const found = await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "find" } });
    expect(found.body).toEqual({ found: 4, added: 2 });
    expect(apollo.calls).toHaveLength(1);
    expect(apollo.calls[0]).toMatchObject({ url: "https://api.apollo.io/api/v1/mixed_people/api_search", method: "POST", key: "apollo-test-key" });
    expect(apollo.calls[0].body).toMatchObject({ q_organization_domains_list: ["northwind.test"], page: 1, per_page: 10 });
    expect((await w.detail(id)).suggestions.map((person) => [person.name, person.title])).toEqual([["Pieter Gr***f", "Director of Procurement"], ["Noor Ja***n", "VP Customer Operations"]]);

    // Asked again: nobody is suggested twice, and someone put aside stays aside.
    const [pieter] = (await w.detail(id)).suggestions;
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "dismiss", ids: [pieter.id] } })).body).toEqual({ dismissed: 1 });
    apollo.replies.push({ body: { people } });
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "find" } })).body).toEqual({ found: 4, added: 0 });
    expect((await w.detail(id)).suggestions.map((person) => person.name)).toEqual(["Noor Ja***n"]);
  });

  it("has nothing to search by for a company with no domain", async () => {
    const w = workspace();
    w.connectApollo();
    const id = w.company("No domain");
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "find", dry_run: true } })).body).toMatchObject({ domain: null });
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "find" } })).statusCode).toBe(400);
    expect(apollo.calls).toEqual([]);
  });

  it("looks a person up when they are added, and makes them a contact of the company", async () => {
    const w = workspace();
    w.connectApollo();
    const id = w.company("Northwind", { domain: "northwind.test" });
    w.suggest(id, "1", "Pieter Gr***f", { title: "Director of Procurement" });
    apollo.replies.push({ body: { person: {
      id: "ap-1", first_name: "Pieter", last_name: "Graaf", name: "Pieter Graaf", title: "Director of Procurement", linkedin_url: "http://www.linkedin.com/in/pieter-graaf",
      email: "p.graaf@northwind.test", email_status: "verified", seniority: "director", city: "Rotterdam", country: "Netherlands", departments: ["master_operations"],
    } } });
    const res = await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "add", ids: [w.sid("1")] }, user: "adder" });
    expect(res.body).toMatchObject({ added: 1, linked: 0, not_found: 0, failed: 0 });
    expect(apollo.calls).toEqual([{ url: "https://api.apollo.io/api/v1/people/match", method: "POST", key: "apollo-test-key", body: { id: "ap-1", reveal_personal_emails: false } }]);
    const [contactId] = res.body.target_ids as string[];
    expect(w.person(contactId)).toMatchObject({
      full_name: "Pieter Graaf", first_name: "Pieter", last_name: "Graaf", title: "Director of Procurement", company: "Northwind", company_id: id, owner_id: "adder",
      linkedin_url: "http://www.linkedin.com/in/pieter-graaf", email: "p.graaf@northwind.test", email_status: "verified", seniority: "director", apollo_id: "ap-1", city: "Rotterdam",
    });
    expect(db().prepare("SELECT status, target_id FROM company_suggestions WHERE id = ?").get(w.sid("1"))).toEqual({ status: "added", target_id: contactId });
    const detail = await w.detail(id);
    expect(detail.suggestions).toEqual([]);
    expect(detail.contacts.items.map((contact) => contact.full_name)).toEqual(["Pieter Graaf"]);
    // Added already: asking again looks nobody up.
    expect((await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "add", ids: [w.sid("1")] } })).body).toMatchObject({ added: 0, linked: 0 });
    expect(apollo.calls).toHaveLength(1);
  });

  it("links someone the workspace already has, and puts aside someone Apollo cannot place", async () => {
    const w = workspace();
    w.connectApollo();
    const id = w.company("Northwind", { domain: "northwind.test" });
    const existing = w.contact(null, { full_name: "Noor Jansen", email: "N.Jansen@northwind.test", linkedin_url: null });
    w.suggest(id, "1", "Noor Ja***n");
    w.suggest(id, "2", "Ghost");
    w.suggest(id, "3", "Unreachable");
    apollo.replies.push(
      { body: { person: { id: "ap-1", name: "Noor Jansen", email: "n.jansen@northwind.test" } } },
      { body: { person: null } },
      { body: { person: { id: "ap-3", name: "Unreachable Person" } } },
    );
    const res = await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "add", ids: [w.sid("1"), w.sid("2"), w.sid("3")] } });
    expect(res.body).toMatchObject({ added: 0, linked: 1, not_found: 2, target_ids: [existing] });
    expect(w.person(existing)).toMatchObject({ company_id: id, apollo_id: "ap-1", full_name: "Noor Jansen" });
    expect(db().prepare("SELECT COUNT(*) AS c FROM targets WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 1 });
    expect(db().prepare("SELECT id, status FROM company_suggestions WHERE company_id = ? ORDER BY id").all(id)).toEqual([{ id: w.sid("1"), status: "added" }, { id: w.sid("2"), status: "dismissed" }, { id: w.sid("3"), status: "dismissed" }]);
  });

  it("stops adding when Apollo refuses, keeping the people it had not reached", async () => {
    const w = workspace();
    w.connectApollo();
    const id = w.company("Northwind", { domain: "northwind.test" });
    w.suggest(id, "1", "One");
    w.suggest(id, "2", "Two");
    // Too many requests: nobody is made a contact, and nobody is put aside either.
    apollo.replies.push({ status: 429 });
    const res = await w.call(suggestionsHandler, "POST", { query: { id }, body: { action: "add", ids: [w.sid("1"), w.sid("2")] } });
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: "Apollo could not be asked: too many requests; try again in a minute", added: 0, not_found: 0 });
    expect(apollo.calls).toHaveLength(1);
    expect(db().prepare("SELECT COUNT(*) AS c FROM targets WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
    expect((await w.detail(id)).suggestions.map((person) => person.name)).toEqual(["One", "Two"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a company whose email is bouncing", () => {
  function bouncing() {
    const w = workspace();
    const id = w.company("Northwind", { domain: "northwind.test", email_domain_invalid: 1 });
    const mailboxId = w.mailbox();
    const marcus = w.contact(id, { full_name: "Marcus Oyelaran", email: "m.oyelaran@northwind.test", email_status: "invalid" });
    // Marked invalid only because Marcus bounced.
    const sanne = w.contact(id, { full_name: "Sanne Visser", email: "s.visser@northwind.test", email_status: "invalid", email_verified_at: "2026-09-01 09:00:00" });
    const bram = w.contact(id, { full_name: "Bram Koster", email: "b.koster@northwind.test", email_status: "verified" });
    const noEmail = w.contact(id, { full_name: "No Email" });
    w.bounce(mailboxId, "m.oyelaran@northwind.test");
    w.bounce(mailboxId, "old.hire@northwind.test", "-20 days");
    w.bounce(mailboxId, "someone@elsewhere.test");
    return { w, id, mailboxId, marcus, sanne, bram, noEmail };
  }

  it("counts the bounces from its addresses and domain, and lists them newest first", async () => {
    const { w, id, mailboxId, marcus } = bouncing();
    for (const [index, target] of [marcus, marcus].entries()) {
      const job = `cjob-${++seq}`;
      w.insert("email_jobs", { id: job, workspace_id: w.ws, email_account_id: mailboxId, recipient: "m.oyelaran@northwind.test", subject: "Hello", body_text: "Hi", idempotency_key: job });
      w.insert("sent_messages", { id: `csent-${++seq}`, workspace_id: w.ws, job_id: job, email_account_id: mailboxId, target_id: target, recipient: "m.oyelaran@northwind.test", subject: "Hello", message_id: `<${job}@x>`, accepted_at: index === 0 ? "2020-01-01 09:00:00" : new Date().toISOString() });
    }
    const detail = await w.detail(id);
    expect(detail.company.bouncing).toBe(true);
    expect(detail.bounce).toEqual({ bounces_7d: 1, sends_7d: 1, bounces_total: 2, last_bounce_at: expect.any(String), contacts_with_email: 3, verifying: 0 });
    const review = (await w.call(bouncesHandler, "GET", { query: { id }, role: "viewer" })).body as { flagged: boolean; bounces: Record<string, unknown>[]; figures: Record<string, number> };
    expect(review.flagged).toBe(true);
    expect(review.figures).toMatchObject({ bounces_total: 2, bounces_7d: 1 });
    // The contact's address, then one at the domain that belongs to nobody. Not the address elsewhere.
    expect(review.bounces.map((bounce) => [bounce.recipient, bounce.contact_name, bounce.contact_id])).toEqual([
      ["m.oyelaran@northwind.test", "Marcus Oyelaran", marcus], ["old.hire@northwind.test", null, null],
    ]);
    expect(review.bounces[0].mailbox).toMatch(/@sender\.test$/);
  });

  it("queues its addresses for a check, but not the one that bounced", async () => {
    const { w, id, marcus, sanne, bram, noEmail } = bouncing();
    const res = await w.call(bouncesHandler, "POST", { query: { id }, body: { action: "reverify" } });
    expect(res.body).toEqual({ queued: 2, restored: 1 });
    // Sanne was only invalid by association: unchecked again, and in the queue.
    expect(w.person(sanne)).toMatchObject({ email_status: null, email_verified_at: null, email_verify_requested_at: expect.any(String) });
    expect(w.person(bram)).toMatchObject({ email_status: "verified", email_verify_requested_at: expect.any(String) });
    expect(w.person(marcus)).toMatchObject({ email_status: "invalid", email_verify_requested_at: null });
    expect(w.person(noEmail).email_verify_requested_at).toBeNull();
    // The flag is a person's call: a check does not clear it.
    expect(w.row(id).email_domain_invalid).toBe(1);
    expect((await w.detail(id)).bounce).toMatchObject({ verifying: 2 });
  });

  it("clears the flag, restoring the colleagues it marked and nobody whose own address bounced", async () => {
    const { w, id, marcus, sanne, bram } = bouncing();
    // On the do-not-send list by hand: also left alone.
    const listed = w.contact(id, { full_name: "Listed", email: "listed@northwind.test", email_status: "invalid" });
    w.insert("suppressions", { id: `csup-${++seq}`, workspace_id: w.ws, kind: "email", value: "Listed@northwind.test", reason: "asked not to be emailed" });
    const res = await w.call(bouncesHandler, "POST", { query: { id }, body: { action: "clear" }, user: "clearer" });
    expect(res.body).toEqual({ cleared: true, restored: 1 });
    expect(w.row(id)).toMatchObject({ email_domain_invalid: 0, bounce_cleared_by: "clearer", bounce_cleared_at: expect.any(String) });
    expect(w.person(sanne).email_status).toBeNull();
    expect(w.person(marcus).email_status).toBe("invalid");
    expect(w.person(listed).email_status).toBe("invalid");
    expect(w.person(bram).email_status).toBe("verified");
    expect((await w.detail(id)).bounce).toBeNull();
    // Not flagged any more: clearing again changes nothing.
    w.insert("targets", { id: `cperson-${++seq}`, workspace_id: w.ws, full_name: "Later", company_id: id, email: "later@northwind.test", email_status: "invalid" });
    expect((await w.call(bouncesHandler, "POST", { query: { id }, body: { action: "clear" } })).body).toEqual({ cleared: false, restored: 0 });
    expect(db().prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE workspace_id = ? AND action = 'company.bounce_flag_cleared'").get(w.ws)).toEqual({ c: 1 });
  });

  it("lets a viewer read the bounces and change nothing", async () => {
    const { w, id } = bouncing();
    expect((await w.call(bouncesHandler, "GET", { query: { id }, role: "viewer" })).statusCode).toBe(200);
    expect((await w.call(bouncesHandler, "POST", { query: { id }, body: { action: "clear" }, role: "viewer" })).statusCode).toBe(403);
    expect((await w.call(bouncesHandler, "POST", { query: { id }, body: { action: "reverify" }, role: "viewer" })).statusCode).toBe(403);
    expect((await w.call(bouncesHandler, "POST", { query: { id }, body: { action: "forgive" } })).statusCode).toBe(400);
    expect(w.row(id).email_domain_invalid).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("signals about a company", () => {
  it("raise the company's intent, not anyone else's, and enrol nobody", async () => {
    const w = workspace();
    const id = w.company("Northwind");
    const other = w.company("Lumen");
    const person = w.contact(id, { intent_score: 10 });
    const res = await w.call(signalsHandler, "POST", { body: { type: "funding", title: "Raised Series D", company_id: id, score: 60 } });
    expect(res.statusCode).toBe(201);
    // The same sum a contact's signal uses: the score, plus a tenth of it.
    expect(w.row(id).intent_score).toBe(66);
    expect(w.row(other).intent_score).toBe(0);
    expect(w.person(person).intent_score).toBe(10);
    expect((await w.detail(id)).company.intent).toBe(66);
    await w.call(signalsHandler, "POST", { body: { type: "hiring", title: "Hiring", company_id: id, score: 90 } });
    expect(w.row(id).intent_score).toBe(99);
    await w.call(signalsHandler, "POST", { body: { type: "hiring", title: "Hiring more", company_id: id, score: 90 } });
    expect(w.row(id).intent_score).toBe(100);
    expect(db().prepare("SELECT COUNT(*) AS c FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE r.workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
  });

  it("are marked as dealt with for a whole company or one by one, and can be reopened", async () => {
    const w = workspace();
    const id = w.company("Northwind");
    const other = w.company("Lumen");
    const signal = (companyId: string, title: string) => { const sid = `sig-${++seq}`; w.insert("signals", { id: sid, workspace_id: w.ws, company_id: companyId, type: "custom", title, occurred_at: new Date().toISOString() }); return sid; };
    const a = signal(id, "A");
    signal(id, "B");
    const elsewhere = signal(other, "C");
    const fresh = () => db().prepare("SELECT COUNT(*) AS c FROM signals WHERE workspace_id = ? AND processed_at IS NULL").get(w.ws) as { c: number };
    expect((await w.call(signalsHandler, "PATCH", { body: { ids: [a], handled: true } })).body).toEqual({ changed: 1 });
    expect((await w.call(signalsHandler, "PATCH", { body: { company_id: id, handled: true } })).body).toEqual({ changed: 1 });
    expect(fresh()).toEqual({ c: 1 });
    expect((await w.detail(id)).signals).toMatchObject({ total: 2, new: 0 });
    expect((await w.call(signalsHandler, "PATCH", { body: { ids: [a], handled: false } })).body).toEqual({ changed: 1 });
    expect((await w.detail(id)).signals.new).toBe(1);
    expect((await w.call(signalsHandler, "PATCH", { body: { handled: true } })).statusCode).toBe(400);
    expect((await w.call(signalsHandler, "PATCH", { body: { ids: [elsewhere] } })).statusCode).toBe(400);
    expect((await w.call(signalsHandler, "PATCH", { body: { ids: [elsewhere], handled: true }, role: "viewer" })).statusCode).toBe(403);
    // Another workspace cannot reach them.
    const stranger = workspace();
    expect((await stranger.call(signalsHandler, "PATCH", { body: { ids: [elsewhere], handled: true } })).body).toEqual({ changed: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("companies from and to a CSV file", () => {
  it("makes new companies, and fills the gaps of ones it matches by domain or by name", async () => {
    const w = workspace();
    const northwind = w.company("Northwind", { domain: "northwind.test", industry: "Typed by hand" });
    const bare = w.company("Lumen Analytics");
    const csv = [
      "Company Name,Website,Sector,HQ,LinkedIn,Fleet size",
      'Northwind Logistics,https://www.northwind.test/nl,Freight,"Rotterdam, NL",https://www.linkedin.com/company/northwind,40',
      "lumen analytics,,Analytics,,,",
      "Arcadia Labs,arcadia.test,Software,Berlin,,",
      ",orphan.test,,,,",
      "Northwind,northwind.test,,,,",
    ].join("\n");
    const res = await w.call(importHandler, "POST", { body: { csv } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ created: 1, updated: 2, unchanged: 1, errors: ["Row 5: no company name"], ignored_columns: ["fleet_size"] });
    // Matched by domain: gaps filled, what was typed kept, the name not replaced.
    expect(w.row(northwind)).toMatchObject({ name: "Northwind", industry: "Typed by hand", location: "Rotterdam, NL", website: "https://www.northwind.test/nl", linkedin_url: "https://www.linkedin.com/company/northwind" });
    // No domain on either side: matched by name, whatever the capitals.
    expect(w.row(bare)).toMatchObject({ name: "Lumen Analytics", industry: "Analytics", domain: null });
    expect(db().prepare("SELECT name, domain, industry, location FROM companies WHERE workspace_id = ? AND name = 'Arcadia Labs'").get(w.ws)).toEqual({ name: "Arcadia Labs", domain: "arcadia.test", industry: "Software", location: "Berlin" });
  });

  it("refuses a file with no name column, an empty one, and a viewer; and hands out a template", async () => {
    const w = workspace();
    const bad = await w.call(importHandler, "POST", { body: { csv: "domain,industry\nx.test,Software\n" } });
    expect(bad.statusCode).toBe(400);
    expect((bad.body.errors as string[])[0]).toMatch(/column for the company's name/);
    expect((await w.call(importHandler, "POST", { body: { csv: "  " } })).statusCode).toBe(400);
    expect((await w.call(importHandler, "POST", { body: { csv: "name\nX\n" }, role: "viewer" })).statusCode).toBe(403);
    const template = await w.call(importHandler, "GET", { role: "viewer" });
    expect(template.headers["content-type"]).toMatch(/text\/csv/);
    expect(template.text.split("\n")[0]).toBe("name,domain,website,industry,location,linkedin_url,notes");
    // The template imports as it stands.
    expect((await w.call(importHandler, "POST", { body: { csv: template.text } })).body).toMatchObject({ created: 1, errors: [], ignored_columns: [] });
  });

  it("downloads the list as it is filtered and sorted", async () => {
    const w = workspace();
    const northwind = w.company("Northwind", { domain: "northwind.test", is_target: 1, technology_names: '["Salesforce","Snowflake"]', employee_count: 1840 });
    w.contact(northwind, { intent_score: 86 });
    w.company("Lumen", { email_domain_invalid: 1 });
    w.company("Quiet");
    const download = async (query: Record<string, string>, role = "manager") => {
      const res = await w.call(exportHandler as Handler, "GET", { query: { resource: "companies", ...query }, role });
      return { res, lines: res.text.replace(/^﻿/, "").trim().split(/\r?\n/) };
    };
    const all = await download({ sort: "name:asc" });
    expect(all.res.headers["content-type"]).toMatch(/text\/csv/);
    expect(all.lines[0]).toBe("Company,Domain,Website,LinkedIn URL,Industry,Location,Employees,Revenue,Founded,Last funding,Funding amount,Intent,Contacts,Target account,Email bouncing,Technologies,Keywords,Enriched from,Enriched,Created");
    expect(all.lines.slice(1).map((line) => line.split(",")[0])).toEqual(["Lumen", "Northwind", "Quiet"]);
    const targets = await download({ filter: "target" });
    expect(targets.lines).toHaveLength(2);
    expect(targets.lines[1]).toContain('Northwind,northwind.test');
    expect(targets.lines[1]).toContain(',86,1,yes,no,"Salesforce, Snowflake",');
    expect((await download({ filter: "bouncing" })).lines.slice(1).map((line) => line.split(",")[0])).toEqual(["Lumen"]);
    // Exports are for managers, as every other export is.
    expect((await download({}, "member")).res.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("companies made before this release", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linki-companies-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("are told where their enrichment came from once, and nothing else about them changes", () => {
    const old = new Database(path.join(dir, "old.db"));
    old.pragma("foreign_keys = ON");
    old.exec(fs.readFileSync(path.join(__dirname, "fixtures", "schema", "release-2026-10-10.sql"), "utf8"));
    old.exec(`
      INSERT INTO workspaces (id, name, slug) VALUES ('ws-old', 'Old', 'old');
      INSERT INTO companies (id, workspace_id, name, domain, technology_names, notes, email_domain_invalid) VALUES ('enriched', 'ws-old', 'Enriched', 'enriched.test', '["Salesforce"]', 'Kept', 1);
      INSERT INTO companies (id, workspace_id, name, industry) VALUES ('by-hand', 'ws-old', 'Typed by hand', 'Software');
    `);
    migrateDatabase(old);
    const rows = () => Object.fromEntries((old.prepare("SELECT id, enrichment_source, enriched_at, intent_score, is_target, notes, email_domain_invalid, technology_names FROM companies ORDER BY id").all() as { id: string }[]).map((row) => [row.id, row]));
    expect(rows()).toMatchObject({
      // The date is not known, so it is not made up.
      enriched: { enrichment_source: "apollo", enriched_at: null, intent_score: 0, is_target: 0, notes: "Kept", email_domain_invalid: 1, technology_names: '["Salesforce"]' },
      "by-hand": { enrichment_source: null, enriched_at: null, intent_score: 0, is_target: 0 },
    });
    // It runs once: a value changed afterwards is not changed back on the next start.
    old.prepare("UPDATE companies SET enrichment_source = NULL WHERE id = 'enriched'").run();
    migrateDatabase(old);
    expect((rows().enriched as { enrichment_source: string | null }).enrichment_source).toBeNull();
    old.close();
  });
});
