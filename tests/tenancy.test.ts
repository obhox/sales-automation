// What one workspace must never see, share or change of another's: the company records
// the campaign runner creates from Apollo, the daily import cap, and (per user) the product
// tours. Run against a real (throwaway) database with the browser and Apollo stubbed.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb, repairCompanyWorkspaces } from "@/lib/db";

vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async () => {}),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({
  shouldSyncAccepted: vi.fn(() => false),
  syncAcceptedConnections: vi.fn(),
}));
vi.mock("@/lib/apollo", () => ({ matchPerson: vi.fn() }));

import { tick } from "@/lib/linkedin/runner";
import { matchPerson, type ApolloMatchResult } from "@/lib/apollo";
import { getDailyImportCap, importedToday, DEFAULT_DAILY_CAP } from "@/lib/import-jobs";
import targetHandler from "@/pages/api/targets/[id]";
import importCapHandler from "@/pages/api/settings/import-cap";
import tourHandler from "@/pages/api/tour";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res = mockRes();
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res);
  return res;
}

function workspace(id: string) {
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(id, id, id);
  return id;
}

let seq = 0;
function contact(ws: string, companyId: string | null = null) {
  const id = `ten-target-${++seq}`;
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url, company_id) VALUES (?, ?, ?, ?, ?)")
    .run(id, ws, `Lead ${seq}`, `https://www.linkedin.com/in/ten-lead-${seq}/`, companyId);
  return id;
}

function company(ws: string | null, domain: string | null, fields: { notes?: string; industry?: string; flagged?: boolean } = {}) {
  const id = `ten-company-${++seq}`;
  db().prepare("INSERT INTO companies (id, workspace_id, name, domain, notes, industry, email_domain_invalid) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, ws, `Company ${seq}`, domain, fields.notes ?? null, fields.industry ?? null, fields.flagged ? 1 : 0);
  return id;
}

const companyOf = (targetId: string) =>
  db().prepare(`SELECT c.id, c.workspace_id, c.domain, c.notes, c.industry, c.email_domain_invalid
    FROM targets t LEFT JOIN companies c ON c.id = t.company_id WHERE t.id = ?`).get(targetId) as
    { id: string | null; workspace_id: string | null; domain: string | null; notes: string | null; industry: string | null; email_domain_invalid: number | null };

/** A running campaign whose only step is an email, with Apollo connected and one contact due. */
function emailCampaign(ws: string) {
  const n = ++seq;
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, ?, ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(`ten-acct-${n}`, `Account ${n}`, `ten${n}@example.com`, ws);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, ?, ?)").run(`ten-wf-${n}`, `Campaign ${n}`, ws);
  db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds) VALUES (?, ?, 1, 'email', 'email', 0)")
    .run(`ten-step-${n}`, `ten-wf-${n}`);
  db().prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, 'running', ?)")
    .run(`ten-run-${n}`, `ten-wf-${n}`, `ten-acct-${n}`, ws);
  db().prepare("INSERT INTO integrations (key, workspace_id, api_key) VALUES ('apollo', ?, 'apollo-key')").run(ws);
  const targetId = contact(ws);
  db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`ten-rp-${n}`, `ten-run-${n}`, targetId);
  db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'email', 'in_progress', 0)")
    .run(`ten-rt-${n}`, `ten-rp-${n}`);
  return targetId;
}

function apolloMatch(domain: string): ApolloMatchResult {
  return {
    apollo_id: `apollo-${++seq}`, linkedin_url: null, headline: null, seniority: null, functions: null, departments: null,
    email: null, email_status: null, email_domain_catchall: false, city: null, country: null, time_zone: null, positions_json: null,
    organization: {
      name: "Acme", domain, industry: "Software", estimated_num_employees: 50, short_description: null, location: null,
      linkedin_url: null, website_url: null, founded_year: null, logo_url: null, phone: null, annual_revenue_printed: null,
      technology_names: null, keywords: null, city: null, country: null,
    },
  };
}

beforeAll(() => { getDb(); });

describe("companies the campaign runner creates from Apollo", () => {
  it("belong to the contact's workspace, one per workspace for the same domain", async () => {
    const [wsA, wsB] = [workspace("ws-ten-apollo-a"), workspace("ws-ten-apollo-b")];
    const contactA = emailCampaign(wsA);
    const contactB = emailCampaign(wsB);
    vi.mocked(matchPerson).mockImplementation(async () => apolloMatch("acme.test"));

    await tick(getDb(), { pace: false });

    const [a, b] = [companyOf(contactA), companyOf(contactB)];
    expect(a).toMatchObject({ workspace_id: wsA, domain: "acme.test" });
    expect(b).toMatchObject({ workspace_id: wsB, domain: "acme.test" });
    expect(a.id).not.toBe(b.id);
    expect(db().prepare("SELECT COUNT(*) c FROM companies WHERE domain = 'acme.test' AND workspace_id IS NULL").get()).toEqual({ c: 0 });
  });

  it("are reused within a workspace, never matched from another one", async () => {
    const [wsA, wsB] = [workspace("ws-ten-reuse-a"), workspace("ws-ten-reuse-b")];
    const mine = company(wsA, "reuse.test");
    const theirs = company(wsB, "reuse.test", { notes: "B's private notes" });
    const contactA = emailCampaign(wsA);
    vi.mocked(matchPerson).mockImplementation(async () => apolloMatch("reuse.test"));

    await tick(getDb(), { pace: false });

    expect(companyOf(contactA).id).toBe(mine);
    expect(companyOf(contactA).id).not.toBe(theirs);
  });
});

describe("reading a contact", () => {
  it("does not hand over a company that belongs to another workspace", async () => {
    const [wsA, wsB] = [workspace("ws-ten-read-a"), workspace("ws-ten-read-b")];
    const theirs = company(wsA, "read.test", { notes: "A's private notes" });
    const mine = company(wsB, "mine.test");
    const straddling = contact(wsB, theirs);
    const normal = contact(wsB, mine);

    const leaked = await call(targetHandler, { method: "GET", query: { id: straddling }, headers: ctxHeaders(wsB) });
    expect(leaked.statusCode).toBe(200);
    expect(leaked.body.company).toBeNull();

    const own = await call(targetHandler, { method: "GET", query: { id: normal }, headers: ctxHeaders(wsB) });
    expect(own.body.company).toMatchObject({ id: mine });
  });
});

describe("repairCompanyWorkspaces", () => {
  // Each case builds its own straddling contacts; start from a database that has none left.
  beforeEach(() => { repairCompanyWorkspaces(getDb()); });

  it("moves a company nobody in its own workspace uses to the one workspace that does", () => {
    const [legacy, ws] = [workspace("ws-ten-move-legacy"), workspace("ws-ten-move")];
    const stray = company(legacy, "move.test", { notes: "Email domain flagged invalid — bounce for a@move.test on 2026-01-01", flagged: true });
    const lead = contact(ws, stray);

    expect(repairCompanyWorkspaces(getDb())).toMatchObject({ moved: 1, cloned: 0, relinked: 0 });

    // Same row, now in the contact's workspace, bounce note and flag included: both came
    // from that workspace's own contacts.
    expect(companyOf(lead)).toMatchObject({ id: stray, workspace_id: ws, email_domain_invalid: 1 });
  });

  it("copies a company its owner still uses, without the owner's notes or bounce flag", () => {
    const [wsA, wsB] = [workspace("ws-ten-copy-a"), workspace("ws-ten-copy-b")];
    const shared = company(wsA, "copy.test", { notes: "A's private notes", industry: "Software", flagged: true });
    const leadA = contact(wsA, shared);
    const leadB = contact(wsB, shared);

    expect(repairCompanyWorkspaces(getDb())).toMatchObject({ moved: 0, cloned: 1, relinked: 0 });

    expect(companyOf(leadA)).toMatchObject({ id: shared, workspace_id: wsA, notes: "A's private notes" });
    const copy = companyOf(leadB);
    expect(copy.id).not.toBe(shared);
    expect(copy).toMatchObject({ workspace_id: wsB, domain: "copy.test", industry: "Software", notes: null, email_domain_invalid: 0 });
  });

  it("does not move a company that carries notes somebody wrote", () => {
    const [owner, ws] = [workspace("ws-ten-notes-owner"), workspace("ws-ten-notes")];
    const noted = company(owner, "notes.test", { notes: "Met them at the conference" });
    const lead = contact(ws, noted);

    expect(repairCompanyWorkspaces(getDb())).toMatchObject({ moved: 0, cloned: 1 });

    expect(companyOf(lead)).toMatchObject({ workspace_id: ws, notes: null });
    expect(db().prepare("SELECT workspace_id, notes FROM companies WHERE id = ?").get(noted)).toEqual({ workspace_id: owner, notes: "Met them at the conference" });
  });

  it("points the contact at the company its workspace already has for that domain", () => {
    const [wsA, wsB] = [workspace("ws-ten-twin-a"), workspace("ws-ten-twin-b")];
    const theirs = company(wsA, "Twin.test");
    const mine = company(wsB, "twin.test");
    const lead = contact(wsB, theirs);

    expect(repairCompanyWorkspaces(getDb())).toMatchObject({ moved: 0, cloned: 0, relinked: 1 });

    expect(companyOf(lead).id).toBe(mine);
    expect(db().prepare("SELECT COUNT(*) c FROM companies WHERE lower(domain) = 'twin.test'").get()).toEqual({ c: 2 });
  });

  it("gives each workspace its own copy when several share one stray company", () => {
    const [legacy, wsA, wsB] = [workspace("ws-ten-many-legacy"), workspace("ws-ten-many-a"), workspace("ws-ten-many-b")];
    const stray = company(legacy, "many.test");
    const leadA = contact(wsA, stray);
    const leadB = contact(wsB, stray);

    expect(repairCompanyWorkspaces(getDb())).toMatchObject({ moved: 0, cloned: 2 });

    expect(companyOf(leadA).workspace_id).toBe(wsA);
    expect(companyOf(leadB).workspace_id).toBe(wsB);
    expect(companyOf(leadA).id).not.toBe(companyOf(leadB).id);
  });

  it("finds nothing to do once every contact's company is in its own workspace", () => {
    expect(repairCompanyWorkspaces(getDb())).toEqual({ moved: 0, cloned: 0, relinked: 0 });
    expect(db().prepare(`SELECT COUNT(*) c FROM targets t JOIN companies c ON c.id = t.company_id
      WHERE c.workspace_id IS NULL OR c.workspace_id != t.workspace_id`).get()).toEqual({ c: 0 });
  });
});

describe("the daily import cap", () => {
  it("is set by, and counts against, one workspace only", async () => {
    const [wsA, wsB] = [workspace("ws-ten-cap-a"), workspace("ws-ten-cap-b")];
    const set = await call(importCapHandler, { method: "PUT", body: { cap: 200 }, headers: ctxHeaders(wsA, { userId: "ten-cap-admin", role: "admin" }) });
    expect(set.body).toEqual({ cap: 200 });

    const other = await call(importCapHandler, { method: "GET", headers: ctxHeaders(wsB) });
    expect(other.body).toMatchObject({ cap: DEFAULT_DAILY_CAP });
    expect(getDailyImportCap(getDb(), wsA)).toBe(200);

    db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES ('ten-list-a', ?, 'A list')").run(wsA);
    db().prepare("INSERT INTO list_imports (id, list_id, status, imported, started_at, finished_at) VALUES ('ten-import-a', 'ten-list-a', 'done', 150, datetime('now'), datetime('now'))").run();
    expect(importedToday(getDb(), wsA)).toBe(150);
    expect(importedToday(getDb(), wsB)).toBe(0);
  });

  it("cannot be changed by someone who is not an admin of that workspace", async () => {
    const ws = workspace("ws-ten-cap-role");
    const res = await call(importCapHandler, { method: "PUT", body: { cap: 5 }, headers: ctxHeaders(ws, { userId: "ten-cap-member", role: "member" }) });
    expect(res.statusCode).toBe(403);
    expect(getDailyImportCap(getDb(), ws)).toBe(DEFAULT_DAILY_CAP);
  });
});

describe("product tours", () => {
  it("are marked seen per user, not for everyone on the instance", async () => {
    const ws = workspace("ws-ten-tour");
    const first = ctxHeaders(ws, { userId: "ten-tour-first", role: "member" });
    const second = ctxHeaders(ws, { userId: "ten-tour-second", role: "member" });

    expect((await call(tourHandler, { method: "POST", body: { page: "dashboard" }, headers: first })).statusCode).toBe(200);

    expect((await call(tourHandler, { method: "GET", headers: first })).body).toEqual({ seen: ["dashboard"] });
    expect((await call(tourHandler, { method: "GET", headers: second })).body).toEqual({ seen: [] });
  });
});
