// Signals read off a company's own website. The comparison is tested as a pure function,
// because "is this actually a signal?" is a judgement worth arguing about in a test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

process.env.NEXTAUTH_SECRET ||= "test-secret-for-research-signal-tests";
vi.mock("@/lib/linkedin/runner", () => ({ ensureGlobalRunnerStarted: vi.fn() }));

import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { ctxHeaders } from "./helpers/ctx";
import { compareResearchSnapshots, readSnapshot, type ResearchSnapshot } from "@/lib/research/signals";
import handler, { SIGNAL_BATCH } from "@/pages/api/research/signals";

const NOW = new Date("2026-10-11T12:00:00Z");
const snap = (over: Partial<ResearchSnapshot> = {}): ResearchSnapshot => ({
  read_at: NOW.toISOString(), open_roles: null, technologies: [], funding_stage: null, funding_date: null, pricing_tiers: [], ...over,
});

describe("compareResearchSnapshots", () => {
  it("treats a first reading as a baseline, not as news", () => {
    // Everything on a page looks new the first time it is read. Reporting all of it would
    // announce a company's whole stack the day it was first looked at.
    const found = compareResearchSnapshots("Acme", null, snap({ technologies: ["Stripe", "Segment"], pricing_tiers: ["Pro", "Team"] }), NOW);
    expect(found).toEqual([]);
  });

  it("does report a fresh funding round and an already-large job board on a first reading", () => {
    // These are self-evidently recent, so they are news even without something to compare to.
    const found = compareResearchSnapshots("Acme", null, snap({ funding_stage: "Series B", funding_date: "2026-09-20", open_roles: 9 }), NOW);
    expect(found.map((s) => s.type).sort()).toEqual(["funding", "hiring"]);
    expect(found.find((s) => s.type === "funding")).toMatchObject({ score: 70, occurred_at: "2026-09-20T00:00:00.000Z" });
  });

  it("does not report a funding round that was already old on a first reading", () => {
    const found = compareResearchSnapshots("Acme", null, snap({ funding_stage: "Seed", funding_date: "2025-01-10" }), NOW);
    expect(found).toEqual([]);
  });

  it("reports hiring on a real jump, not on a wobble", () => {
    const before = snap({ open_roles: 8 });
    // +1 is noise; a board that gains one listing is not a hiring push.
    expect(compareResearchSnapshots("Acme", before, snap({ open_roles: 9 }), NOW)).toEqual([]);
    const jumped = compareResearchSnapshots("Acme", before, snap({ open_roles: 12 }), NOW);
    expect(jumped).toHaveLength(1);
    expect(jumped[0]).toMatchObject({ type: "hiring", score: 50 });
    expect(jumped[0].description).toBe("Up from 8 when their site was last read");
  });

  it("reports only the technologies that are new since last time", () => {
    const found = compareResearchSnapshots("Acme", snap({ technologies: ["Segment"] }), snap({ technologies: ["Segment", "Stripe"] }), NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: "technology", score: 40 });
    expect(found[0].title).toContain("Stripe");
    expect(found[0].title).not.toContain("Segment");
  });

  it("reads a new pricing tier as a product move", () => {
    const found = compareResearchSnapshots("Acme", snap({ pricing_tiers: ["Pro"] }), snap({ pricing_tiers: ["Pro", "Enterprise"] }), NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: "product_intent" });
    expect(found[0].title).toContain("Enterprise");
  });

  it("says nothing when nothing changed", () => {
    const same = snap({ open_roles: 4, technologies: ["Stripe"], pricing_tiers: ["Pro"] });
    expect(compareResearchSnapshots("Acme", same, snap({ ...same, read_at: NOW.toISOString() }), NOW)).toEqual([]);
  });
});

describe("readSnapshot", () => {
  it("keeps only values it can compare later, and drops the rest", () => {
    const result = readSnapshot({
      open_roles: 7.9, technologies: ["Stripe", " Segment ", "", "Stripe"],
      funding_stage: " Series A ", funding_date: "2026-02-30", pricing_tiers: "not an array",
    }, NOW.toISOString());
    expect(result.open_roles).toBe(7);
    expect(result.technologies).toEqual(["Segment", "Stripe"]); // trimmed, deduped, sorted
    expect(result.funding_stage).toBe("Series A");
    // 30 February is not a day, so it cannot be allowed to date a signal.
    expect(result.funding_date).toBeNull();
    expect(result.pricing_tiers).toEqual([]);
  });

  it("survives a reader that returned nothing useful", () => {
    expect(readSnapshot(null, NOW.toISOString())).toMatchObject({ open_roles: null, technologies: [], funding_date: null });
  });
});

// ── the route ────────────────────────────────────────────────────────────────────────────

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
  const ws = `ws-sig-${++seq}`;
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, `Sig ${seq}`, `sig-ws-${seq}`);
  if (connected) db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'firecrawl', ?)").run(ws, encryptSecret("fc-test-key"));
  return ws;
}
function company(ws: string, website: string | null = "https://acmewidgets.com/") {
  const id = `c-${ws}-${Math.random().toString(36).slice(2, 8)}`;
  getDb().prepare("INSERT INTO companies (id, workspace_id, name, website) VALUES (?, ?, ?, ?)").run(id, ws, "Acme", website);
  return id;
}
const call = async (ws: string, body: unknown, role = "member") => {
  const res = mockRes();
  await handler({ method: "POST", body, query: {}, headers: ctxHeaders(ws, { userId: `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
  return res;
};

beforeEach(() => { net.calls = []; net.replies = []; });

describe("reading companies for signals", () => {
  it("quotes five credits a company without reading anything", async () => {
    const ws = workspace();
    const res = await call(ws, { dry_run: true, company_ids: [company(ws), company(ws, null)] });
    expect(res.body).toMatchObject({ selected: 2, eligible: 1, no_website: 1, credits: 5, batch: SIGNAL_BATCH, read_before: 0, firecrawl_connected: true });
    expect(net.calls).toEqual([]);
  });

  it("records a signal, and does not record it again on an unchanged second read", async () => {
    // ingestSignal has no dedupe of its own, so without the saved snapshot the same
    // "they are hiring" would be raised and re-scored on every run.
    const ws = workspace();
    const id = company(ws);
    net.replies.push(extracted({ open_roles: 11, technologies: [], funding_stage: null, funding_date: null, pricing_tiers: [] }));
    const first = await call(ws, { company_ids: [id] });
    expect(first.body).toMatchObject({ signals: 1, detected: 1 });

    net.replies.push(extracted({ open_roles: 11, technologies: [], funding_stage: null, funding_date: null, pricing_tiers: [] }));
    const second = await call(ws, { company_ids: [id] });
    expect(second.body).toMatchObject({ signals: 0, no_change: 1, detected: 0 });

    const rows = getDb().prepare("SELECT type, score FROM signals WHERE workspace_id = ? AND company_id = ?").all(ws, id);
    expect(rows).toEqual([{ type: "hiring", score: 50 }]);
  });

  it("files the signal on the company, which scores it and enrols nobody", async () => {
    // Signal rules are written for a contact; a company-scoped signal has none to act on.
    const ws = workspace();
    const id = company(ws);
    net.replies.push(extracted({ open_roles: 9, technologies: [], funding_stage: null, funding_date: null, pricing_tiers: [] }));
    await call(ws, { company_ids: [id] });

    const row = getDb().prepare("SELECT target_id, company_id, source FROM signals WHERE workspace_id = ?").get(ws) as { target_id: string | null; company_id: string; source: string };
    expect(row).toMatchObject({ target_id: null, company_id: id, source: "firecrawl" });
    expect((getDb().prepare("SELECT intent_score FROM companies WHERE id = ?").get(id) as { intent_score: number }).intent_score).toBeGreaterThan(0);
  });

  it("saves a baseline on a first read, so the next one has something to compare", async () => {
    const ws = workspace();
    const id = company(ws);
    net.replies.push(extracted({ open_roles: 2, technologies: ["Stripe"], funding_stage: null, funding_date: null, pricing_tiers: [] }));
    const res = await call(ws, { company_ids: [id] });
    expect(res.body).toMatchObject({ baseline: 1, signals: 0 });

    const saved = getDb().prepare("SELECT provider, url, snapshot_json FROM research_findings WHERE workspace_id = ? AND company_id = ?").get(ws, id) as { provider: string; url: string; snapshot_json: string };
    expect(saved).toMatchObject({ provider: "firecrawl", url: "https://acmewidgets.com/" });
    expect(JSON.parse(saved.snapshot_json)).toMatchObject({ open_roles: 2, technologies: ["Stripe"] });
  });

  it("refuses a viewer, an empty selection, and more than one batch", async () => {
    const ws = workspace();
    expect((await call(ws, { dry_run: true, company_ids: [company(ws)] }, "viewer")).statusCode).toBe(403);
    expect((await call(ws, { company_ids: [] })).statusCode).toBe(400);
    expect((await call(ws, { company_ids: Array.from({ length: SIGNAL_BATCH + 1 }, () => company(ws)) })).statusCode).toBe(400);
    expect(net.calls).toEqual([]);
  });

  it("says what to connect when Firecrawl is not, since the snapshot needs a schema read", async () => {
    const ws = workspace(false);
    const res = await call(ws, { company_ids: [company(ws)] });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toContain("Connect Firecrawl");
    expect(net.calls).toEqual([]);
  });

  it("stops the run when Firecrawl refuses, and reports what was read", async () => {
    const ws = workspace();
    net.replies.push(extracted({ open_roles: 9, technologies: [], funding_stage: null, funding_date: null, pricing_tiers: [] }));
    net.replies.push({ status: 402, body: { success: false, error: "Insufficient credits" } });
    const res = await call(ws, { company_ids: [company(ws), company(ws)] });
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ signals: 1 });
    expect(String(res.body.error)).toContain("out of credits");
  });
});
