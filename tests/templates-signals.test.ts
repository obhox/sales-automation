// Behind the Templates and Signals screens: a template's figures across campaigns, the
// signal feed and what counts as new, and scheduled detection from Apollo with its cap.
// Real (throwaway) database. Apollo is a stub in every test: nothing here can spend a credit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { apolloUrl } from "@/lib/signals/apollo-org";
import {
  FRESH_FUNDING_DAYS, compareSnapshots, creditsPerAccount, creditsSpentThisMonth, estimate, readDetectionConfig, recentRuns, runDetection, runDueSignalDetection, runProblem,
  saveDetectionConfig, watchCompanies, watchedAccounts, type Snapshot,
} from "@/lib/signals/detection";
import { templateCampaigns, templateFigures } from "@/lib/templates/usage";
import detection, { type DetectionOverview } from "@/pages/api/platform/signal-detection";
import signals from "@/pages/api/platform/signals";
import templates, { type TemplateLibrary } from "@/pages/api/templates/index";
import type { SignalFeed } from "@/lib/signals/feed";
import { ctxHeaders } from "./helpers/ctx";

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
interface Answer { statusCode: number; body: unknown }

const db = () => getDb();
let seq = 0;
const NOW = new Date("2026-10-10T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

async function call(handler: Handler, req: Partial<NextApiRequest>): Promise<Answer> {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, headers: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as Answer;
}

function workspace() {
  const ws = `ws-ts-${++seq}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const as = (role: string) => ctxHeaders(ws, { userId: `${ws}-${role}`, role });
  return { ws, as };
}
type Workspace = ReturnType<typeof workspace>;

// ── Apollo, stubbed ──────────────────────────────────────────────────

interface FakeOrg { id?: string; name?: string; employees?: number; stage?: string | null; funded?: string | null; total?: string; tech?: string[]; roles?: string[] }
const apollo = { orgs: new Map<string, FakeOrg | number>(), calls: [] as Array<{ path: string; key: string | null }> };

function stubApollo() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    // The only place detection may ask is Apollo. Anything else is a bug.
    expect(url.origin).toBe("https://api.apollo.io");
    const key = new Headers(init?.headers).get("x-api-key");
    apollo.calls.push({ path: `${url.pathname}${url.search}`, key });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v1/organizations/enrich") {
      const found = apollo.orgs.get(url.searchParams.get("domain") ?? "");
      if (typeof found === "number") return json(found, { error: "refused" });
      if (!found) return json(200, { organization: null });
      return json(200, { organization: { id: found.id ?? "org-1", name: found.name, estimated_num_employees: found.employees ?? null, latest_funding_stage: found.stage ?? null, latest_funding_round_date: found.funded ? `${found.funded}T00:00:00.000+00:00` : null, total_funding_printed: found.total ?? null, technology_names: found.tech ?? [] } });
    }
    const postings = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/job_postings$/);
    if (postings) {
      const found = [...apollo.orgs.values()].find((org) => typeof org !== "number" && (org.id ?? "org-1") === postings[1]) as FakeOrg | undefined;
      return json(200, { organization_job_postings: (found?.roles ?? []).map((title, index) => ({ id: `job-${index}`, title, posted_at: "2026-10-01T00:00:00Z" })) });
    }
    return json(404, { error: "no such path" });
  }));
}

/** A workspace with Apollo connected and some companies, watched. */
function watching(companies: Array<{ name: string; domain?: string | null }>, options: { key?: boolean } = {}) {
  const w = workspace();
  if (options.key !== false) db().prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'apollo', ?)").run(w.ws, encryptSecret("apollo-test-key"));
  const ids = companies.map((company, index) => {
    const id = `${w.ws}-co-${index}`;
    db().prepare("INSERT INTO companies (id, workspace_id, name, domain) VALUES (?, ?, ?, ?)").run(id, w.ws, company.name, company.domain === undefined ? `${company.name.toLowerCase()}.test` : company.domain);
    return id;
  });
  watchCompanies(db(), w.ws, null, ids);
  return { ...w, companies: ids };
}

beforeEach(() => {
  apollo.orgs.clear();
  apollo.calls.length = 0;
  delete process.env.APOLLO_BASE_URL;
  stubApollo();
});
afterEach(() => vi.unstubAllGlobals());

// ─────────────────────────────────────────────────────────────────────
describe("a template's figures", () => {
  function campaign(w: Workspace, name: string) {
    const id = `${w.ws}-wf-${++seq}`;
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, ?, ?)").run(id, name, w.ws);
    db().prepare("INSERT INTO runs (id, workflow_id, workspace_id, status) VALUES (?, ?, ?, 'running')").run(`${id}-run`, id, w.ws);
    db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track) VALUES (?, ?, 1, 'message', 'linkedin')").run(`${id}-step`, id);
    return { id, run: `${id}-run`, step: `${id}-step` };
  }
  function template(w: Workspace, name: string, fields: Record<string, unknown> = {}) {
    const id = `${w.ws}-tpl-${++seq}`;
    db().prepare("INSERT INTO templates (id, workspace_id, name, body, channel, subject, category) VALUES (?, ?, ?, 'Hi {{first_name}}', ?, ?, ?)").run(id, w.ws, name, fields.channel ?? "linkedin", fields.subject ?? null, fields.category ?? null);
    return id;
  }
  /** Send a template to a new contact, who may answer. */
  function send(w: Workspace, c: ReturnType<typeof campaign>, templateId: string | null, reply?: "positive" | "negative") {
    const target = `${w.ws}-t-${++seq}`;
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, 'Lee Park', ?)").run(target, w.ws, `https://www.linkedin.com/in/${target}`);
    db().prepare("INSERT INTO step_sends (id, workspace_id, workflow_id, run_id, step_id, target_id, channel, action, template_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'linkedin', 'message', ?, ?)")
      .run(`${w.ws}-ss-${++seq}`, w.ws, c.id, c.run, c.step, target, templateId, ago(5));
    if (reply) db().prepare("UPDATE targets SET last_replied_at = ?, reply_kind = ? WHERE id = ?").run(ago(3), reply, target);
    return target;
  }
  const offer = (c: ReturnType<typeof campaign>, templateId: string) => db().prepare("INSERT INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)").run(c.step, templateId);

  it("add up across every campaign that sent it, and say which steps offer it now", () => {
    const w = workspace();
    const first = campaign(w, "Q4 Enterprise"), second = campaign(w, "Nordics");
    const intro = template(w, "Intro"), nudge = template(w, "Nudge"), unused = template(w, "Never used");
    offer(first, intro); offer(second, intro); offer(first, nudge);
    send(w, first, intro, "positive"); send(w, first, intro); send(w, first, intro, "negative");
    send(w, second, intro, "positive"); send(w, second, intro);
    send(w, first, nudge);
    // Written in the step, not from a template: nobody's figure.
    send(w, first, null, "positive");

    const figures = templateFigures(db(), w.ws);
    expect(figures.get(intro)).toMatchObject({ sent: 5, contacts: 5, replied: 3, positive: 2, steps: 2, campaigns: 2 });
    expect(figures.get(intro)!.last_sent_at).toBe(ago(5));
    expect(figures.get(nudge)).toMatchObject({ sent: 1, replied: 0, positive: 0, steps: 1, campaigns: 1 });
    expect(figures.has(unused)).toBe(false);
    expect(templateCampaigns(db(), w.ws, intro)).toEqual([{ id: second.id, name: "Nordics", steps: 1 }, { id: first.id, name: "Q4 Enterprise", steps: 1 }]);
    // Another workspace's sends are not this one's.
    expect(templateFigures(db(), workspace().ws).size).toBe(0);
  });

  it("count an email sent from a template as well as a LinkedIn message", () => {
    const w = workspace();
    const c = campaign(w, "Email only");
    const cold = template(w, "Cold email", { channel: "email", subject: "Quick question" });
    for (let i = 0; i < 3; i++) {
      const target = `${w.ws}-mail-${i}`;
      db().prepare("INSERT INTO targets (id, workspace_id, full_name, email, linkedin_url) VALUES (?, ?, 'Lee Park', ?, ?)").run(target, w.ws, `lee${i}@prospect.test`, `https://www.linkedin.com/in/${target}`);
      // The last one was written in the step, not from the template.
      db().prepare("INSERT INTO step_sends (id, workspace_id, workflow_id, run_id, step_id, target_id, channel, action, template_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'email', 'email', ?, ?)")
        .run(`${w.ws}-ms-${i}`, w.ws, c.id, c.run, c.step, target, i < 2 ? cold : null, ago(4));
    }
    expect(templateFigures(db(), w.ws).get(cold)).toMatchObject({ sent: 2, contacts: 2, replied: 0 });
    expect(templateFigures(db(), w.ws).size).toBe(1);
  });

  it("come with the library view, and the plain list is what it always was", async () => {
    const w = workspace();
    const c = campaign(w, "Q4 Enterprise");
    const intro = template(w, "Intro", { category: "Openers" });
    template(w, "Cold email", { channel: "email", subject: "Quick question", category: "Openers" });
    template(w, "Break-up", { channel: "email", subject: "Closing the loop", category: "Follow-ups" });
    offer(c, intro);
    send(w, c, intro, "positive");

    const plain = (await call(templates as Handler, { method: "GET", headers: w.as("viewer") })).body as Array<Record<string, unknown>>;
    expect(Array.isArray(plain)).toBe(true);
    expect(Object.keys(plain[0]).sort()).toEqual(["body", "category", "channel", "created_at", "id", "name", "subject"]);

    const library = (await call(templates as Handler, { method: "GET", headers: w.as("viewer"), query: { view: "library" } })).body as TemplateLibrary;
    expect(library.categories).toEqual(["Follow-ups", "Openers"]);
    expect(library.templates.map((t) => [t.name, t.figures?.sent ?? null, t.figures?.replied ?? null])).toEqual([["Break-up", null, null], ["Cold email", null, null], ["Intro", 1, 1]]);
    const emails = (await call(templates as Handler, { method: "GET", headers: w.as("viewer"), query: { view: "library", channel: "email" } })).body as TemplateLibrary;
    expect(emails.templates.map((t) => t.name)).toEqual(["Break-up", "Cold email"]);
  });

  it("a viewer reads the library and cannot add to it", async () => {
    const w = workspace();
    expect((await call(templates as Handler, { method: "GET", headers: w.as("viewer"), query: { view: "library" } })).statusCode).toBe(200);
    expect((await call(templates as Handler, { method: "POST", headers: w.as("viewer"), body: { name: "x", body: "y" } })).statusCode).toBe(403);
    expect((await call(templates as Handler, { method: "POST", headers: w.as("member"), body: { name: "x", body: "y" } })).statusCode).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the signal feed", () => {
  function seeded() {
    const w = workspace();
    db().prepare("INSERT INTO companies (id, workspace_id, name) VALUES (?, ?, 'Initech'), (?, ?, 'Globex')").run(`${w.ws}-initech`, w.ws, `${w.ws}-globex`, w.ws);
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, company_id, linkedin_url) VALUES (?, ?, 'Dana Okoye', ?, ?)").run(`${w.ws}-dana`, w.ws, `${w.ws}-globex`, `https://www.linkedin.com/in/${w.ws}-dana`);
    const add = (id: string, type: string, title: string, days: number, fields: { target?: string; company?: string; source?: string; seen?: boolean } = {}) =>
      db().prepare("INSERT INTO signals (id, workspace_id, target_id, company_id, type, title, description, score, source, occurred_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, 'More about it', 50, ?, ?, ?)")
        .run(`${w.ws}-${id}`, w.ws, fields.target ?? null, fields.company ?? null, type, title, fields.source ?? "manual", ago(days), fields.seen ? ago(days) : null);
    add("s1", "funding", "Initech raised a Series B", 1, { company: `${w.ws}-initech`, source: "apollo" });
    add("s2", "job_change", "Dana moved to Globex", 2, { target: `${w.ws}-dana` });
    add("s3", "hiring", "Globex has 12 open roles", 3, { company: `${w.ws}-globex`, source: "apollo", seen: true });
    add("s4", "funding", "Old round", 40, { company: `${w.ws}-globex`, seen: true });
    return w;
  }
  const feed = async (w: Workspace, query: Record<string, string> = {}, role = "viewer") =>
    (await call(signals as Handler, { method: "GET", headers: w.as(role), query: { view: "feed", ...query } })).body as SignalFeed;

  it("lists signals newest first with who each is about, and counts the new ones", async () => {
    const w = seeded();
    const all = await feed(w);
    expect(all.signals.map((s) => s.title)).toEqual(["Initech raised a Series B", "Dana moved to Globex", "Globex has 12 open roles", "Old round"]);
    expect(all).toMatchObject({ total: 4, new_count: 2, all_count: 4, by_type: { funding: 2, job_change: 1, hiring: 1 }, sources: ["apollo", "manual"] });
    expect(all.signals[0]).toMatchObject({ seen: false, contact: null, company: { name: "Initech" }, source: "apollo" });
    // A signal about a contact is also about the company they work at.
    expect(all.signals[1]).toMatchObject({ contact: { id: `${w.ws}-dana`, name: "Dana Okoye" }, company: { name: "Globex" } });
    expect(all.signals[2].seen).toBe(true);
  });

  it("narrows by kind, source, what is new, and text, and pages", async () => {
    const w = seeded();
    expect((await feed(w, { type: "funding" })).signals.map((s) => s.title)).toEqual(["Initech raised a Series B", "Old round"]);
    expect(await feed(w, { state: "new" })).toMatchObject({ total: 2, by_type: { funding: 1, job_change: 1 } });
    // The counts by kind follow the other filters but not the kind itself, so the chips keep their numbers.
    expect((await feed(w, { type: "hiring", source: "apollo" })).by_type).toEqual({ funding: 1, hiring: 1 });
    expect((await feed(w, { source: "apollo" })).signals).toHaveLength(2);
    expect((await feed(w, { q: "globex" })).signals.map((s) => s.title)).toEqual(["Dana moved to Globex", "Globex has 12 open roles", "Old round"]);
    expect((await feed(w, { q: "dana" })).total).toBe(1);
    expect((await feed(w, { type: "not-a-kind" })).total).toBe(4);
    const second = await feed(w, { limit: "2", offset: "2" });
    expect(second.signals.map((s) => s.title)).toEqual(["Globex has 12 open roles", "Old round"]);
    expect(second.total).toBe(4);
  });

  it("marks signals seen, one or all, and can put one back", async () => {
    const w = seeded();
    const fresh = () => (db().prepare("SELECT COUNT(*) AS c FROM signals WHERE workspace_id = ? AND processed_at IS NULL").get(w.ws) as { c: number }).c;
    expect(fresh()).toBe(2);
    expect((await call(signals as Handler, { method: "PATCH", headers: w.as("member"), body: { ids: [`${w.ws}-s1`] } })).body).toEqual({ changed: 1 });
    expect(fresh()).toBe(1);
    expect((await call(signals as Handler, { method: "PATCH", headers: w.as("member"), body: { ids: [`${w.ws}-s1`], seen: false } })).body).toEqual({ changed: 1 });
    expect((await call(signals as Handler, { method: "PATCH", headers: w.as("member"), body: { all: true } })).body).toEqual({ changed: 2 });
    expect(fresh()).toBe(0);
    expect((await feed(w)).new_count).toBe(0);
    expect((await call(signals as Handler, { method: "PATCH", headers: w.as("member"), body: {} })).statusCode).toBe(400);
    expect((await call(signals as Handler, { method: "PATCH", headers: w.as("viewer"), body: { all: true } })).statusCode).toBe(403);
    // Another workspace's signals are not touched by its neighbour.
    const other = seeded();
    await call(signals as Handler, { method: "PATCH", headers: w.as("member"), body: { ids: [`${other.ws}-s1`] } });
    expect((await feed(other)).new_count).toBe(2);
  });

  it("still answers the plain list with the stored rows, and records a signal by hand", async () => {
    const w = seeded();
    const plain = (await call(signals as Handler, { method: "GET", headers: w.as("viewer") })).body as Array<Record<string, unknown>>;
    expect(plain).toHaveLength(4);
    expect(plain[0]).toHaveProperty("metadata_json");
    const made = await call(signals as Handler, { method: "POST", headers: w.as("member"), body: { type: "product_intent", title: "Asked for pricing", company_id: `${w.ws}-initech`, score: 80 } });
    expect(made.statusCode).toBe(201);
    expect((await feed(w)).signals[0]).toMatchObject({ title: "Asked for pricing", seen: false, company: { name: "Initech" } });
    expect((await call(signals as Handler, { method: "POST", headers: w.as("viewer"), body: { type: "custom", title: "x" } })).statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("what a check makes of an account", () => {
  const snapshot = (fields: Partial<Snapshot> = {}): Snapshot => ({ checked_at: NOW.toISOString(), headcount: 100, funding_stage: null, funding_date: null, funding_total: null, technologies: [], open_roles: null, ...fields });
  const ALL = ["funding", "hiring", "technology"] as const;
  const roles = (...titles: string[]) => titles.map((title) => ({ title, posted_at: null }));

  it("on the first check, reports a recent round and an account already hiring, but not its tools", () => {
    const found = compareSnapshots("Initech", null, snapshot({ funding_stage: "Series B", funding_date: "2026-09-20", funding_total: "$45M", technologies: ["Snowflake", "dbt"], open_roles: 6 }), roles("AE", "SDR", "AE"), ALL, NOW);
    expect(found.map((s) => [s.type, s.title])).toEqual([["funding", "Initech raised a Series B round"], ["hiring", "Initech has 6 open roles"]]);
    expect(found[0]).toMatchObject({ score: 70, occurred_at: "2026-09-20T00:00:00.000Z", description: "Round dated 2026-09-20 · $45M raised in all" });
    expect(found[1].description).toBe("Open roles include AE, SDR");
    // An old round is history, not news.
    const old = new Date(NOW.getTime() - (FRESH_FUNDING_DAYS + 5) * 86_400_000).toISOString().slice(0, 10);
    expect(compareSnapshots("Initech", null, snapshot({ funding_date: old, open_roles: 4 }), [], ALL, NOW)).toEqual([]);
  });

  it("afterwards, reports only what changed since the last check", () => {
    const before = snapshot({ funding_date: "2025-03-01", funding_stage: "Series A", technologies: ["Salesforce", "Slack"], open_roles: 8 });
    expect(compareSnapshots("Initech", before, snapshot({ funding_date: "2025-03-01", funding_stage: "Series A", technologies: ["Slack", "salesforce"], open_roles: 9 }), [], ALL, NOW)).toEqual([]);
    const after = snapshot({ funding_date: "2026-10-02", funding_stage: "Series B", technologies: ["Salesforce", "Slack", "Snowflake", "dbt"], open_roles: 14 });
    expect(compareSnapshots("Initech", before, after, roles("Data engineer"), ALL, NOW).map((s) => s.title)).toEqual([
      "Initech raised a Series B round", "Initech went from 8 to 14 open roles", "Initech started using Snowflake, dbt",
    ]);
    // Only the kinds asked for.
    expect(compareSnapshots("Initech", before, after, [], ["technology"], NOW).map((s) => s.type)).toEqual(["technology"]);
    // Headcount stands in when open roles were not asked about.
    expect(compareSnapshots("Initech", snapshot({ headcount: 100 }), snapshot({ headcount: 118 }), [], ["hiring"], NOW).map((s) => s.title)).toEqual(["Initech grew from 100 to 118 people"]);
    expect(compareSnapshots("Initech", snapshot({ headcount: 100 }), snapshot({ headcount: 103 }), [], ["hiring"], NOW)).toEqual([]);
    // A list that was empty before says nothing about what is new.
    expect(compareSnapshots("Initech", snapshot(), snapshot({ technologies: ["Slack"] }), [], ["technology"], NOW)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("scheduled detection", () => {
  const on = (w: Workspace, cap = 100, extra: Record<string, unknown> = {}) => saveDetectionConfig(db(), w.ws, null, { enabled: true, monthly_credit_cap: cap, ...extra });

  it("is off, and asks Apollo nothing, for a workspace that never set it up", async () => {
    const w = watching([{ name: "Initech" }]);
    expect(readDetectionConfig(db(), w.ws)).toEqual({ enabled: false, kinds: ["funding", "hiring", "technology"], interval_days: 7, monthly_credit_cap: 0 });
    expect(await runDueSignalDetection(db(), NOW)).toBe(0);
    expect(apollo.calls).toEqual([]);
    expect(recentRuns(db(), w.ws)).toEqual([]);
    expect(runProblem(db(), w.ws, NOW)).toBe("No monthly cap on Apollo credits has been set.");
  });

  it("cannot be turned on without Apollo, a cap, something to detect and an account to look up", () => {
    const noKey = watching([{ name: "Initech" }], { key: false });
    expect(on(noKey)).toEqual({ ok: false, error: expect.stringMatching(/Connect Apollo first/) });
    const w = watching([{ name: "NoSite", domain: null }]);
    expect(on(w, 0)).toEqual({ ok: false, error: expect.stringMatching(/monthly cap/) });
    expect(on(w, 100, { kinds: [] })).toEqual({ ok: false, error: expect.stringMatching(/at least one kind/) });
    expect(on(w)).toEqual({ ok: false, error: expect.stringMatching(/has a website/) });
    expect(readDetectionConfig(db(), w.ws).enabled).toBe(false);
    for (const wrong of [{ monthly_credit_cap: -1 }, { monthly_credit_cap: 1.5 }, { monthly_credit_cap: "100" }, { interval_days: 3 }, { kinds: ["weather"] }, { enabled: "yes" }]) {
      expect(saveDetectionConfig(db(), w.ws, null, wrong).ok, JSON.stringify(wrong)).toBe(false);
    }
    // The settings can be changed while it is off; only turning it on is held to the rules.
    expect(saveDetectionConfig(db(), w.ws, null, { monthly_credit_cap: 50, interval_days: 30, kinds: ["funding"] })).toMatchObject({ ok: true, config: { enabled: false, monthly_credit_cap: 50, interval_days: 30, kinds: ["funding"] } });
    expect(apollo.calls).toEqual([]);
  });

  it("says what it would cost before anything is asked", () => {
    const w = watching([{ name: "Initech" }, { name: "Globex" }, { name: "NoSite", domain: null }]);
    expect(creditsPerAccount(["funding", "hiring", "technology"])).toBe(2);
    expect(creditsPerAccount(["funding", "technology"])).toBe(1);
    expect(creditsPerAccount([])).toBe(0);
    saveDetectionConfig(db(), w.ws, null, { monthly_credit_cap: 20 });
    expect(estimate(db(), w.ws, readDetectionConfig(db(), w.ws), NOW)).toEqual({
      accounts: 3, checkable: 2, credits_per_account: 2, credits_per_run: 4, runs_per_month: 5, credits_per_month: 20, cap: 20, spent_this_month: 0, remaining: 20, fits: true,
    });
    saveDetectionConfig(db(), w.ws, null, { interval_days: 1 });
    expect(estimate(db(), w.ws, readDetectionConfig(db(), w.ws), NOW)).toMatchObject({ runs_per_month: 30, credits_per_month: 120, fits: false });
    saveDetectionConfig(db(), w.ws, null, { interval_days: 30, kinds: ["funding"] });
    expect(estimate(db(), w.ws, readDetectionConfig(db(), w.ws), NOW)).toMatchObject({ credits_per_account: 1, credits_per_run: 2, runs_per_month: 1, credits_per_month: 2, fits: true });
    expect(apollo.calls).toEqual([]);
  });

  it("checks each watched account, records what it found against the company, and writes down what it spent", async () => {
    const w = watching([{ name: "Initech" }, { name: "Globex" }, { name: "NoSite", domain: null }, { name: "Unknown" }]);
    apollo.orgs.set("initech.test", { id: "org-initech", name: "Initech", employees: 240, stage: "Series B", funded: "2026-09-28", total: "$45M", tech: ["Salesforce"], roles: ["AE", "SDR", "SDR", "RevOps", "CSM", "AE"] });
    apollo.orgs.set("globex.test", { id: "org-globex", name: "Globex", employees: 90, stage: "Seed", funded: "2024-01-10", tech: ["HubSpot"], roles: ["Engineer"] });
    expect(on(w).ok).toBe(true);

    const run = await runDetection(db(), w.ws, { trigger: "manual", now: NOW });
    expect(run).toMatchObject({ status: "done", trigger: "manual", accounts_checked: 3, credits_spent: 5, signals_found: 2, error: null });
    // Two lookups each for the two Apollo knows, one for the one it does not, none for the one with no website.
    expect(apollo.calls.map((c) => c.path)).toEqual([
      "/api/v1/organizations/enrich?domain=globex.test", "/api/v1/organizations/org-globex/job_postings?per_page=100",
      "/api/v1/organizations/enrich?domain=initech.test", "/api/v1/organizations/org-initech/job_postings?per_page=100",
      "/api/v1/organizations/enrich?domain=unknown.test",
    ]);
    expect(new Set(apollo.calls.map((c) => c.key))).toEqual(new Set(["apollo-test-key"]));

    const stored = db().prepare("SELECT type, title, source, target_id, company_id, processed_at FROM signals WHERE workspace_id = ? ORDER BY type").all(w.ws) as Array<Record<string, unknown>>;
    expect(stored).toEqual([
      { type: "funding", title: "Initech raised a Series B round", source: "apollo", target_id: null, company_id: w.companies[0], processed_at: null },
      { type: "hiring", title: "Initech has 6 open roles", source: "apollo", target_id: null, company_id: w.companies[0], processed_at: null },
    ]);
    const accounts = Object.fromEntries(watchedAccounts(db(), w.ws).map((a) => [a.name, a]));
    expect(accounts.Initech.last_result).toBe("Initech raised a Series B round · Initech has 6 open roles");
    expect(accounts.Globex.last_result).toBe("Nothing new");
    expect(accounts.Unknown.last_result).toBe("Apollo does not know this company");
    expect(accounts.NoSite).toMatchObject({ last_result: "No website to look it up by", last_checked_at: null });
    expect(creditsSpentThisMonth(db(), w.ws, NOW)).toBe(5);
    expect(db().prepare("SELECT kind, title FROM notifications WHERE workspace_id = ?").all(w.ws)).toEqual([{ kind: "signals.detected", title: "2 new signals from your watched accounts" }]);

    // A second check reports only what changed since the first.
    apollo.orgs.set("globex.test", { id: "org-globex", name: "Globex", employees: 90, stage: "Series A", funded: "2026-10-09", tech: ["HubSpot", "Snowflake"], roles: ["Engineer"] });
    const later = new Date(NOW.getTime() + 7 * 86_400_000);
    const second = await runDetection(db(), w.ws, { trigger: "schedule", now: later });
    expect(second).toMatchObject({ status: "done", signals_found: 2 });
    expect((db().prepare("SELECT title FROM signals WHERE workspace_id = ? AND company_id = ? ORDER BY type").all(w.ws, w.companies[1]) as Array<{ title: string }>).map((s) => s.title)).toEqual(["Globex raised a Series A round", "Globex started using Snowflake"]);
    expect(db().prepare("SELECT COUNT(*) AS c FROM signals WHERE workspace_id = ? AND company_id = ?").get(w.ws, w.companies[0])).toEqual({ c: 2 });
  });

  it("stops before the month's cap would be passed, and starts with the accounts it did not reach next time", async () => {
    const w = watching([{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }]);
    for (const name of ["alpha", "beta", "gamma"]) apollo.orgs.set(`${name}.test`, { id: `org-${name}`, name, tech: ["Slack"], roles: [] });
    // Two credits an account, and five for the month: two accounts fit, the third does not.
    expect(on(w, 5).ok).toBe(true);
    const run = await runDetection(db(), w.ws, { trigger: "schedule", now: NOW });
    expect(run).toMatchObject({ status: "stopped_at_cap", accounts_checked: 2, credits_spent: 4 });
    expect(apollo.calls).toHaveLength(4);
    expect(creditsSpentThisMonth(db(), w.ws, NOW)).toBeLessThanOrEqual(5);
    expect(db().prepare("SELECT kind, min_role FROM notifications WHERE workspace_id = ?").all(w.ws)).toEqual([{ kind: "signals.cap_reached", min_role: "admin" }]);
    expect(runProblem(db(), w.ws, NOW)).toBe("This month's cap of 5 credits is used up.");

    // Later the same month nothing more is asked.
    apollo.calls.length = 0;
    const again = await runDetection(db(), w.ws, { trigger: "manual", now: new Date(NOW.getTime() + 86_400_000) });
    expect(again).toMatchObject({ status: "stopped_at_cap", accounts_checked: 0, credits_spent: 0 });
    expect(apollo.calls).toEqual([]);

    // Next month the count starts again, with the account that was not reached first.
    const run2 = await runDetection(db(), w.ws, { trigger: "schedule", now: new Date("2026-11-02T12:00:00Z") });
    expect(run2).toMatchObject({ status: "stopped_at_cap", accounts_checked: 2, credits_spent: 4 });
    expect(apollo.calls[0].path).toBe("/api/v1/organizations/enrich?domain=gamma.test");
    expect(creditsSpentThisMonth(db(), w.ws, new Date("2026-11-02T12:00:00Z"))).toBe(4);
  });

  it("stops at once when Apollo refuses the key, and counts no credit for a question Apollo turned away", async () => {
    const w = watching([{ name: "Alpha" }, { name: "Beta" }]);
    apollo.orgs.set("alpha.test", 401);
    apollo.orgs.set("beta.test", { name: "Beta" });
    expect(on(w).ok).toBe(true);
    const run = await runDetection(db(), w.ws, { trigger: "schedule", now: NOW });
    expect(run).toMatchObject({ status: "failed", error: "Apollo refused the API key", accounts_checked: 0, credits_spent: 0 });
    expect(apollo.calls).toHaveLength(1);
    expect(watchedAccounts(db(), w.ws)[0].last_result).toBe("Apollo refused the API key");
    expect(db().prepare("SELECT COUNT(*) AS c FROM signals WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
  });

  it("runs on its schedule: when it is on, once each interval, and not for a workspace that turned it off", async () => {
    const w = watching([{ name: "Alpha" }]);
    const idle = watching([{ name: "Beta" }]);
    apollo.orgs.set("alpha.test", { name: "Alpha" });
    apollo.orgs.set("beta.test", { name: "Beta" });
    expect(on(w, 100, { kinds: ["funding"] }).ok).toBe(true);
    saveDetectionConfig(db(), idle.ws, null, { monthly_credit_cap: 100 });

    const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
    // Counted by this workspace's own runs: the schedule looks at every workspace in the database.
    const mine = () => recentRuns(db(), w.ws).length;
    await runDueSignalDetection(db(), NOW);
    expect(mine()).toBe(1);
    await runDueSignalDetection(db(), day(1));
    await runDueSignalDetection(db(), day(6));
    expect(mine()).toBe(1);
    await runDueSignalDetection(db(), day(7));
    expect(mine()).toBe(2);
    expect(recentRuns(db(), w.ws).map((r) => [r.trigger, r.status, r.credits_spent])).toEqual([["schedule", "done", 1], ["schedule", "done", 1]]);
    // Turned off, it is left alone.
    saveDetectionConfig(db(), w.ws, null, { enabled: false });
    await runDueSignalDetection(db(), day(30));
    expect(mine()).toBe(2);
    // A cap alone is not "on": the other workspace was never asked about.
    expect(recentRuns(db(), idle.ws)).toEqual([]);
  });

  it("can be pointed at a stand-in for Apollo by the operator, and at Apollo otherwise", () => {
    expect(apolloUrl("/organizations/enrich")).toBe("https://api.apollo.io/api/v1/organizations/enrich");
    expect(apolloUrl("organizations/enrich", { APOLLO_BASE_URL: "http://127.0.0.1:4998/api/v1/" })).toBe("http://127.0.0.1:4998/api/v1/organizations/enrich");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the detection route", () => {
  const read = async (w: Workspace, role = "viewer") => (await call(detection as Handler, { method: "GET", headers: w.as(role) })).body as DetectionOverview;

  it("shows a viewer the settings, the cost and the accounts, and lets only an admin spend", async () => {
    const w = watching([{ name: "Initech" }]);
    const seen = await read(w);
    expect(seen).toMatchObject({ apollo_connected: true, config: { enabled: false }, running: false, next_run_at: null, run_problem: "No monthly cap on Apollo credits has been set." });
    expect(seen.accounts.map((a) => a.name)).toEqual(["Initech"]);
    expect(seen.estimate).toMatchObject({ accounts: 1, checkable: 1, credits_per_run: 2 });

    for (const role of ["viewer", "member", "manager"]) {
      expect((await call(detection as Handler, { method: "PUT", headers: w.as(role), body: { enabled: true, monthly_credit_cap: 50 } })).statusCode, role).toBe(403);
      expect((await call(detection as Handler, { method: "POST", headers: w.as(role), body: { action: "run" } })).statusCode, role).toBe(403);
    }
    for (const role of ["viewer", "member"]) expect((await call(detection as Handler, { method: "POST", headers: w.as(role), body: { action: "unwatch", company_ids: w.companies } })).statusCode, role).toBe(403);
    expect(apollo.calls).toEqual([]);
  });

  it("lets a manager choose the accounts: by company, or every company of a list", async () => {
    const w = workspace();
    db().prepare("INSERT INTO companies (id, workspace_id, name, domain) VALUES (?, ?, 'Initech', 'initech.test'), (?, ?, 'Globex', 'globex.test')").run(`${w.ws}-a`, w.ws, `${w.ws}-b`, w.ws);
    db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'Enterprise')").run(`${w.ws}-list`, w.ws);
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, company_id, linkedin_url) VALUES (?, ?, 'Lee', ?, ?)").run(`${w.ws}-t`, w.ws, `${w.ws}-b`, `https://www.linkedin.com/in/${w.ws}-t`);
    db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(`${w.ws}-list`, `${w.ws}-t`);
    const other = watching([{ name: "Theirs" }]);

    const added = await call(detection as Handler, { method: "POST", headers: w.as("manager"), body: { action: "watch", company_ids: [`${w.ws}-a`, other.companies[0], "nonsense"] } });
    expect(added.body).toMatchObject({ added: 1, left_out: 0 });
    const byList = await call(detection as Handler, { method: "POST", headers: w.as("manager"), body: { action: "watch", list_id: `${w.ws}-list` } });
    expect(byList.body).toMatchObject({ added: 1 });
    expect((await read(w)).accounts.map((a) => [a.name, a.contacts])).toEqual([["Globex", 1], ["Initech", 0]]);
    expect((await call(detection as Handler, { method: "POST", headers: w.as("manager"), body: { action: "watch", list_id: "no-such-list" } })).statusCode).toBe(404);
    expect((await call(detection as Handler, { method: "POST", headers: w.as("manager"), body: { action: "unwatch", company_ids: [`${w.ws}-a`] } })).body).toMatchObject({ removed: 1 });
    expect((await read(w)).accounts.map((a) => a.name)).toEqual(["Globex"]);
    // Their list is theirs.
    expect((await read(other)).accounts.map((a) => a.name)).toEqual(["Theirs"]);
  });

  it("turns on for an admin, and a run started there is written down and finishes", async () => {
    const w = watching([{ name: "Initech" }]);
    apollo.orgs.set("initech.test", { id: "org-initech", name: "Initech", stage: "Series B", funded: new Date().toISOString().slice(0, 10), roles: [] });
    expect((await call(detection as Handler, { method: "POST", headers: w.as("admin"), body: { action: "run" } })).statusCode).toBe(409);
    const turnedOn = await call(detection as Handler, { method: "PUT", headers: w.as("admin"), body: { enabled: true, monthly_credit_cap: 40, kinds: ["funding"] } });
    expect(turnedOn.statusCode).toBe(200);
    expect(turnedOn.body).toMatchObject({ config: { enabled: true, monthly_credit_cap: 40, kinds: ["funding"] }, run_problem: null });
    expect((turnedOn.body as DetectionOverview).next_run_at).not.toBeNull();
    expect(apollo.calls).toEqual([]);

    const started = await call(detection as Handler, { method: "POST", headers: w.as("admin"), body: { action: "run" } });
    expect(started.statusCode).toBe(202);
    // A second press while it is going is refused, not doubled.
    expect((await call(detection as Handler, { method: "POST", headers: w.as("admin"), body: { action: "run" } })).body).toEqual({ error: "A run is already under way." });
    await vi.waitFor(() => expect(recentRuns(db(), w.ws)[0].status).toBe("done"));
    expect(recentRuns(db(), w.ws)[0]).toMatchObject({ trigger: "manual", accounts_checked: 1, credits_spent: 1, signals_found: 1 });
    expect(apollo.calls).toHaveLength(1);
    const audit = (db().prepare("SELECT action FROM audit_logs WHERE workspace_id = ? ORDER BY rowid").all(w.ws) as Array<{ action: string }>).map((row) => row.action);
    expect(audit).toEqual(["signal_detection.enabled", "signal_detection.run_started"]);
    expect((await call(detection as Handler, { method: "PUT", headers: w.as("admin"), body: { monthly_credit_cap: 0 } })).statusCode).toBe(400);
  });
});
