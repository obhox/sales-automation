// Filling a company in from its own website. The rule under test throughout: only an empty
// field is filled, so this never argues with Apollo or with something a member typed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

process.env.NEXTAUTH_SECRET ||= "test-secret-for-company-research-tests";

import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { ctxHeaders } from "./helpers/ctx";
import { readCompanyFacts } from "@/lib/research/company";
import handler, { COMPANY_RESEARCH_BATCH } from "@/pages/api/research/company";

describe("readCompanyFacts", () => {
  it("keeps what a website can answer and trims it to size", () => {
    const facts = readCompanyFacts({
      description: "  Payroll for dental practices.  ", industry: "HR software", location: "Austin, US",
      founded_year: 2019, technologies: ["Stripe", " stripe ", "Segment"], keywords: ["payroll", "dental"],
    });
    expect(facts).toMatchObject({ description: "Payroll for dental practices.", industry: "HR software", location: "Austin, US", founded_year: 2019 });
    expect(facts.technologies).toEqual(["Segment", "Stripe", "stripe"]); // deduped on exact text, sorted
    expect(facts.keywords).toEqual(["dental", "payroll"]);
  });

  it("drops a founding year the model cannot have read off the page", () => {
    // Asked for a year it cannot see, a model will sometimes offer one anyway.
    for (const year of [1200, 3000, new Date().getUTCFullYear() + 5]) {
      expect(readCompanyFacts({ founded_year: year }).founded_year, String(year)).toBeNull();
    }
    expect(readCompanyFacts({ founded_year: 2019 }).founded_year).toBe(2019);
  });

  it("caps the keyword list, so one page cannot fill the column with noise", () => {
    const facts = readCompanyFacts({ keywords: Array.from({ length: 30 }, (_, i) => `kw${i}`) });
    expect(facts.keywords).toHaveLength(8);
  });

  it("survives a reader that returned nothing useful", () => {
    expect(readCompanyFacts(null)).toEqual({ description: null, industry: null, location: null, founded_year: null, technologies: [], keywords: [] });
  });
});

type Reply = { status?: number; body?: unknown };
const net = { calls: [] as string[], replies: [] as Reply[] };
vi.stubGlobal("fetch", async (input: unknown) => {
  const url = String(input);
  if (!url.startsWith("https://api.firecrawl.dev")) throw new Error(`A test reached the network: ${url}`);
  net.calls.push(url);
  const reply = net.replies.shift();
  if (!reply) throw new Error(`Firecrawl was asked something no test scripted: ${url}`);
  const status = reply.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => reply.body ?? {} };
});
const extracted = (json: unknown) => ({ body: { success: true, data: { json, metadata: { statusCode: 200 } } } });

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

let seq = 0;
function workspace(connected = true) {
  const db = getDb();
  const ws = `ws-cres-${++seq}`;
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, `CRes ${seq}`, `cres-ws-${seq}`);
  if (connected) db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'firecrawl', ?)").run(ws, encryptSecret("fc-test-key"));
  return ws;
}
function company(ws: string, over: Record<string, unknown> = {}) {
  const id = `c-${ws}-${Math.random().toString(36).slice(2, 8)}`;
  const row = { id, workspace_id: ws, name: "Acme", website: "https://acmewidgets.com/", ...over };
  const cols = Object.keys(row);
  getDb().prepare(`INSERT INTO companies (${cols.join(",")}) VALUES (${cols.map((c) => `@${c}`).join(",")})`).run(row);
  return id;
}
const call = async (ws: string, body: unknown, role = "member") => {
  const res = mockRes();
  await handler({ method: "POST", body, query: {}, headers: ctxHeaders(ws, { userId: `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
  return res;
};
const read = (id: string) => getDb().prepare("SELECT description, industry, location, founded_year, technology_names, keywords, enrichment_source FROM companies WHERE id = ?").get(id) as Record<string, unknown>;

const FULL = { description: "Payroll for dental practices.", industry: "HR software", location: "Austin, US", founded_year: 2019, technologies: ["Stripe"], keywords: ["payroll"] };

beforeEach(() => { net.calls = []; net.replies = []; });

describe("the cost of reading companies", () => {
  it("says what it would cost without reading anything", async () => {
    const ws = workspace();
    const withSite = company(ws);
    const without = company(ws, { website: null });
    const res = await call(ws, { dry_run: true, company_ids: [withSite, without] });
    expect(res.body).toMatchObject({ selected: 2, eligible: 1, eligible_ids: [withSite], no_website: 1, credits: 5, batch: COMPANY_RESEARCH_BATCH, described: 0, firecrawl_connected: true });
    expect(net.calls).toEqual([]);
  });

  it("counts the ones already described, since re-reading them fills less", async () => {
    const ws = workspace();
    const res = await call(ws, { dry_run: true, company_ids: [company(ws, { description: "Already known" }), company(ws)] });
    expect(res.body).toMatchObject({ eligible: 2, described: 1 });
  });
});

describe("filling a company in", () => {
  it("fills every empty field and stamps where it came from", async () => {
    const ws = workspace();
    const id = company(ws);
    net.replies.push(extracted(FULL));
    const res = await call(ws, { company_ids: [id] });
    expect(res.body).toMatchObject({ enriched: 1 });
    expect(read(id)).toMatchObject({
      description: "Payroll for dental practices.", industry: "HR software", location: "Austin, US",
      founded_year: 2019, technology_names: "Stripe", keywords: "payroll", enrichment_source: "firecrawl",
    });
  });

  it("never overwrites what Apollo or a member already put there", async () => {
    // If the website could overwrite Apollo and Apollo the website, a company's record
    // would depend on which button was pressed last.
    const ws = workspace();
    const id = company(ws, { description: "What Apollo said", industry: "Dentistry", enrichment_source: "apollo" });
    net.replies.push(extracted(FULL));
    await call(ws, { company_ids: [id] });

    const row = read(id);
    expect(row.description).toBe("What Apollo said");
    expect(row.industry).toBe("Dentistry");
    expect(row.enrichment_source).toBe("apollo"); // one scalar, first writer keeps it
    expect(row.location).toBe("Austin, US");      // but an empty field is still filled
  });

  it("reports nothing_new when every field was already set", async () => {
    const ws = workspace();
    const id = company(ws, { description: "d", industry: "i", location: "l", founded_year: 2001, technology_names: "t", keywords: "k" });
    net.replies.push(extracted(FULL));
    const res = await call(ws, { company_ids: [id] });
    expect(res.body).toMatchObject({ enriched: 0, nothing_new: 1 });
    expect(read(id).description).toBe("d");
  });

  it("records the read even when it filled nothing, so it is not re-read every run", async () => {
    const ws = workspace();
    const id = company(ws, { description: "d", industry: "i", location: "l", founded_year: 2001, technology_names: "t", keywords: "k" });
    net.replies.push(extracted(FULL));
    await call(ws, { company_ids: [id] });
    const found = getDb().prepare("SELECT kind, provider, url FROM research_findings WHERE workspace_id = ? AND company_id = ?").get(ws, id);
    expect(found).toMatchObject({ kind: "website:facts", provider: "firecrawl", url: "https://acmewidgets.com/" });
  });

  it("keeps its snapshot separate from the signals one", async () => {
    // Same company, two kinds of read, asked for different fields and compared differently:
    // one must not overwrite the other's snapshot.
    const ws = workspace();
    const id = company(ws);
    net.replies.push(extracted(FULL));
    await call(ws, { company_ids: [id] });
    getDb().prepare("INSERT INTO research_findings (id, workspace_id, company_id, kind, provider, url, snapshot_json) VALUES ('x', ?, ?, 'website', 'firecrawl', 'u', '{}')").run(ws, id);
    const kinds = (getDb().prepare("SELECT kind FROM research_findings WHERE workspace_id = ? AND company_id = ? ORDER BY kind").all(ws, id) as { kind: string }[]).map((r) => r.kind);
    expect(kinds).toEqual(["website", "website:facts"]);
  });

  it("refuses a viewer, an empty selection, and more than one batch", async () => {
    const ws = workspace();
    expect((await call(ws, { dry_run: true, company_ids: [company(ws)] }, "viewer")).statusCode).toBe(403);
    expect((await call(ws, { company_ids: [] })).statusCode).toBe(400);
    expect((await call(ws, { company_ids: Array.from({ length: COMPANY_RESEARCH_BATCH + 1 }, () => company(ws)) })).statusCode).toBe(400);
    expect(net.calls).toEqual([]);
  });

  it("stops the run when Firecrawl refuses, and reports what was read", async () => {
    const ws = workspace();
    net.replies.push(extracted(FULL));
    net.replies.push({ status: 401, body: { success: false, error: "bad key" } });
    const res = await call(ws, { company_ids: [company(ws), company(ws)] });
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ enriched: 1 });
  });
});
