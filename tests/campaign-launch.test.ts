// Setting a campaign up and launching it: who in a list is enrolled and who is left out,
// taking a contact over from another campaign and giving them back, what the setup
// remembers, the pre-launch checks, the launch itself, and the AI brief a campaign carries.
// Real (throwaway) database; the browser, the SMTP send and the model are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

const smtp = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; body: string }> }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, to: string, subject: string, body: string, options: { messageId: string }) => { smtp.sent.push({ to, subject, body }); return { messageId: options.messageId }; },
}));
vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async () => {}),
}));
vi.mock("@/lib/linkedin/message", async (original) => ({
  ...(await original<typeof import("@/lib/linkedin/message")>()),
  sendMessage: vi.fn(),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({ shouldSyncAccepted: vi.fn(() => false), syncAcceptedConnections: vi.fn() }));

import { tick } from "@/lib/linkedin/runner";
import { sendMessage } from "@/lib/linkedin/message";
import { aiContextOf, aiContextProblem, campaignContextText, contactTriggers, saveAiContext, withCampaignTone, withTriggers } from "@/lib/campaigns/context";
import { DEFAULT_SETUP, prelaunch, saveSetup, setupOf, setupOptions, setupProblem, type Check } from "@/lib/campaigns/setup";
import { encryptSecret } from "@/lib/crypto";
import { audienceFor, overlappingContacts, releaseSuperseded } from "@/lib/outreach/launch";
import { publishDraft, type StepInput } from "@/lib/outreach/publish";
import runsHandler from "@/pages/api/runs";
import launchHandler from "@/pages/api/workflows/[id]/launch";
import prelaunchHandler from "@/pages/api/workflows/[id]/prelaunch";
import setupHandler from "@/pages/api/workflows/[id]/setup";
import { ctxHeaders } from "./helpers/ctx";

const message = vi.mocked(sendMessage);
const db = () => getDb();
let seq = 0;
const DAY = 86_400;
const run = () => tick(getDb(), { pace: false });

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

const EMAIL_ONLY: StepInput[] = [{ key: "e1", step_type: "email", email_subject: "Hello", email_body: "Hi {{first_name}}" }, { step_type: "delay", track: "email", delay_seconds: DAY }, { key: "e2", step_type: "email", email_subject: "Again", email_body: "Following up" }];

/** A workspace with a signed-in LinkedIn account, a verified mailbox, a list, and one campaign. More campaigns are added with `another`. */
function workspace(steps: StepInput[] = EMAIL_ONLY) {
  const n = ++seq;
  const ws = `ws-launch-${n}`;
  const w = { ws, list: `launch-list-${n}`, account: `launch-li-${n}`, mailbox: `launch-mail-${n}`, user: `launch-user-${n}`, workflow: "", steps: {} as Record<string, string> };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, 'Morgan', 'x')").run(w.user, `morgan${n}@acme.test`);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, 'Jordan Mertens', ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(w.account, `launch${n}@example.test`, ws);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, ?, 'Outbound', 'Ada Okafor', ?, 'smtp.test.com', 'user', 'pass', 1, 50, 0, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(w.mailbox, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'Enterprise VPs')").run(w.list, ws);
  // The stages a workspace is given when it is created.
  for (const [suffix, won, lost] of [["meeting", 0, 0], ["won", 1, 0], ["lost", 0, 1]] as const) {
    db().prepare("INSERT INTO pipeline_stages (id, workspace_id, name, is_won, is_lost) VALUES (?, ?, ?, ?, ?)").run(`${ws}:stage:${suffix}`, ws, suffix, won, lost);
  }
  w.workflow = another(w, "Campaign", steps, w.steps);
  return w;
}
type Workspace = ReturnType<typeof workspace>;

function another(w: { ws: string }, name: string, steps: StepInput[] = EMAIL_ONLY, keys: Record<string, string> = {}) {
  const id = `launch-wf-${++seq}`;
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, ?, ?)").run(id, name, w.ws);
  for (const step of publishDraft(db(), w.ws, id, { steps, gates: [] }).steps) if (step.key) keys[step.key] = step.id;
  return id;
}
const as = (w: Workspace, role: "viewer" | "member" | "manager") => ctxHeaders(w.ws, { userId: w.user, role });

function contact(w: Workspace, fields: Record<string, unknown> = {}) {
  const k = ++seq;
  const id = `launch-target-${k}`;
  db().prepare(`INSERT INTO targets (id, workspace_id, full_name, first_name, company, email, email_status, email_verified_at, linkedin_url, degree)
    VALUES (?, ?, ?, 'Lee', 'Initech', ?, 'verified', datetime('now'), ?, 1)`).run(id, w.ws, `Lee Lead ${k}`, `lead${k}@prospect.test`, `https://www.linkedin.com/in/launch-lead-${k}/`);
  for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE targets SET ${column} = ? WHERE id = ?`).run(value, id);
  db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(w.list, id);
  return id;
}

function deal(w: Workspace, on: { target?: string; company?: string }, stage: "won" | "lost" | "meeting") {
  db().prepare("INSERT INTO opportunities (id, workspace_id, target_id, company_id, stage_id, name, closed_at) VALUES (?, ?, ?, ?, ?, 'Deal', ?)")
    .run(`launch-opp-${++seq}`, w.ws, on.target ?? null, on.company ?? null, `${w.ws}:stage:${stage}`, stage === "meeting" ? null : "2026-09-01 10:00:00");
}

/** Start a run of a campaign over the workspace's list, with every free track due now. */
async function start(w: Workspace, workflowId: string, body: Record<string, unknown> = {}) {
  const res = await call(runsHandler, { method: "POST", body: { workflow_id: workflowId, list_id: w.list, account_id: w.account, email_account_ids: [w.mailbox], ...body }, headers: as(w, "manager") });
  if (res.statusCode !== 201) return res;
  db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(String(res.body.id));
  db().prepare("UPDATE run_profile_tracks SET state = 'in_progress', next_step_at = datetime('now', '-1 minute') WHERE hold IS NULL AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)").run(String(res.body.id));
  return res;
}
const tracksOf = (targetId: string, workflowId: string) => db().prepare(
  `SELECT rt.track, rt.state, rt.current_step, rt.hold FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id JOIN runs r ON r.id = rp.run_id WHERE rp.target_id = ? AND r.workflow_id = ?`,
).all(targetId, workflowId) as Array<{ track: string; state: string; current_step: number; hold: string | null }>;
const check = (checks: Check[], key: Check["key"]) => checks.find((entry) => entry.key === key)!;
/** A mailbox leaves a few minutes between two sends. Put what it has sent a day back, and make everything in progress due, so the next tick can send. */
function nextTick() {
  db().prepare("UPDATE logs SET created_at = datetime(created_at, '-1 day') WHERE message LIKE 'Email sent%'").run();
  db().prepare("UPDATE run_profile_tracks SET next_step_at = datetime('now', '-1 minute') WHERE state = 'in_progress'").run();
  smtp.sent.length = 0;
}

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status IN ('running', 'pending', 'paused')").run();
  smtp.sent.length = 0;
  message.mockReset();
  message.mockResolvedValue("sent");
});
afterEach(() => vi.unstubAllGlobals());

describe("who in a list is enrolled", () => {
  it("counts customers and open deals by the contact's own deals or their company's, and leaves them out only when asked", () => {
    const w = workspace();
    db().prepare("INSERT INTO companies (id, workspace_id, name) VALUES ('launch-co-won', ?, 'Customer Co'), ('launch-co-open', ?, 'Prospect Co')").run(w.ws, w.ws);
    const plain = contact(w);
    const customer = contact(w); deal(w, { target: customer }, "won");
    const colleague = contact(w, { company_id: "launch-co-won" }); deal(w, { company: "launch-co-won" }, "won");
    const inTalks = contact(w, { company_id: "launch-co-open" }); deal(w, { company: "launch-co-open" }, "meeting");
    const lost = contact(w); deal(w, { target: lost }, "lost");

    const everyone = audienceFor(db(), w.ws, w.workflow, w.list);
    expect(everyone.audience).toMatchObject({ total: 5, customers: 2, open_deals: 1, excluded: 0, enrol: 5, with_email: 5, verified_email: 5 });
    const noCustomers = audienceFor(db(), w.ws, w.workflow, w.list, { exclude: { customers: true } });
    expect(noCustomers.enrol.sort()).toEqual([plain, inTalks, lost].sort());
    const neither = audienceFor(db(), w.ws, w.workflow, w.list, { exclude: { customers: true, open_deals: true } });
    expect(neither.audience).toMatchObject({ excluded: 3, enrol: 2 });
    expect(neither.enrol.sort()).toEqual([plain, lost].sort());
    void colleague;
  });

  it("skips a contact who is part-way through another campaign, and says which", async () => {
    const w = workspace();
    const other = another(w, "Series B FinTech");
    const busy = contact(w);
    await start(w, other);
    const free = contact(w);

    const { audience, enrol, takeOver } = audienceFor(db(), w.ws, w.workflow, w.list);
    expect(audience).toMatchObject({ total: 2, overlapping: 1, enrol: 1, overlaps: [{ workflow_id: other, name: "Series B FinTech", contacts: 1 }] });
    expect(enrol).toEqual([free]);
    expect(takeOver).toEqual([]);
    expect(overlappingContacts(db(), w.ws, w.workflow, w.list)).toEqual([{ id: busy, name: expect.stringContaining("Lee Lead"), company: "Initech", workflow_id: other, campaign: "Series B FinTech" }]);

    const taking = audienceFor(db(), w.ws, w.workflow, w.list, { overlap: "take_over" });
    expect(taking.audience).toMatchObject({ overlapping: 1, enrol: 2 });
    expect(taking.takeOver).toEqual([busy]);
  });

  it("never enrols a contact in the same campaign twice", async () => {
    const w = workspace();
    const first = contact(w);
    await start(w, w.workflow);
    db().prepare("UPDATE runs SET status = 'completed' WHERE workflow_id = ?").run(w.workflow);
    const second = contact(w);
    const { audience, enrol } = audienceFor(db(), w.ws, w.workflow, w.list, { overlap: "take_over" });
    expect(audience).toMatchObject({ total: 2, already_enrolled: 1, enrol: 1 });
    expect(enrol).toEqual([second]);
    void first;
  });

  it("creates a run through the API with exclusions, and as it always did without them", async () => {
    const w = workspace();
    contact(w);
    const customer = contact(w); deal(w, { target: customer }, "won");
    const res = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, email_account_ids: [w.mailbox], exclude: { customers: true } }, headers: as(w, "manager") });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ enrolled: 1, excluded: 1 });

    const plain = workspace();
    contact(plain); const alsoCustomer = contact(plain); deal(plain, { target: alsoCustomer }, "won");
    const unfiltered = await call(runsHandler, { method: "POST", body: { workflow_id: plain.workflow, list_id: plain.list, email_account_ids: [plain.mailbox] }, headers: as(plain, "manager") });
    expect(unfiltered.body).toMatchObject({ enrolled: 2 });
    expect(unfiltered.body).not.toHaveProperty("excluded");
    expect((await call(runsHandler, { method: "POST", body: { workflow_id: plain.workflow, list_id: plain.list, email_account_ids: [plain.mailbox], overlap: "steal" }, headers: as(plain, "manager") })).statusCode).toBe(400);
  });
});

describe("taking a contact over from another campaign", () => {
  it("holds their steps there while they are here, and gives them back when they are done", async () => {
    const w = workspace();
    const first = another(w, "The first campaign");
    const lee = contact(w);
    await start(w, first);
    await run();
    expect(smtp.sent.map((mail) => mail.subject)).toEqual(["Hello"]);
    expect(tracksOf(lee, first)).toEqual([{ track: "email", state: "in_progress", current_step: 1, hold: null }]);

    // Launched on the same list, taking over.
    const taken = await start(w, w.workflow, { overlap: "take_over" });
    expect(taken.body).toMatchObject({ enrolled: 1, taken_over: 1 });
    const hold = tracksOf(lee, first)[0].hold;
    expect(hold).toBe(`superseded:${taken.body.id}`);

    // The first campaign's follow-up is due, and is not sent. The new campaign's first email is.
    nextTick();
    await run();
    expect(smtp.sent.map((mail) => mail.subject)).toEqual(["Hello"]);
    expect(tracksOf(lee, first)[0]).toMatchObject({ state: "in_progress", current_step: 1, hold });

    // Done in the new campaign: the old one carries on from where it stood.
    db().prepare(`UPDATE run_profile_tracks SET state = 'completed' WHERE run_profile_id IN (SELECT rp.id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE r.workflow_id = ?)`).run(w.workflow);
    nextTick();
    await run();
    // Given back, and the wait it was standing on is now served.
    expect(tracksOf(lee, first)[0]).toMatchObject({ hold: null, current_step: 2 });
    nextTick();
    await run();
    expect(smtp.sent.map((mail) => mail.subject)).toEqual(["Again"]);
  });

  it("gives the steps back if the campaign that took them is paused away or removed", async () => {
    const w = workspace();
    const first = another(w, "The first campaign");
    const lee = contact(w);
    await start(w, first);
    const taken = await start(w, w.workflow, { overlap: "take_over" });
    expect(tracksOf(lee, first)[0].hold).toBe(`superseded:${taken.body.id}`);
    // Still running there: nothing to give back yet.
    expect(releaseSuperseded(db())).toBe(0);
    db().prepare("DELETE FROM runs WHERE id = ?").run(String(taken.body.id));
    expect(releaseSuperseded(db())).toBe(1);
    expect(tracksOf(lee, first)[0].hold).toBeNull();
  });

  it("leaves a contact who is not in another campaign, and the other campaign's other contacts, untouched", async () => {
    const w = workspace();
    const first = another(w, "The first campaign");
    const shared = contact(w);
    await start(w, first);
    const elsewhere = `launch-target-${++seq}`;
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, email, email_status) VALUES (?, ?, 'Only There', 'only@there.test', 'verified')").run(elsewhere, w.ws);
    const firstRun = (db().prepare("SELECT id FROM runs WHERE workflow_id = ?").get(first) as { id: string }).id;
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES ('launch-rp-only', ?, ?, ?)").run(firstRun, elsewhere, w.mailbox);
    db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES ('launch-rt-only', 'launch-rp-only', 'email', 'in_progress', 0)").run();
    const fresh = contact(w);
    const taken = await start(w, w.workflow, { overlap: "take_over" });
    expect(taken.body).toMatchObject({ enrolled: 2, taken_over: 1 });
    expect(tracksOf(shared, first)[0].hold).not.toBeNull();
    expect(tracksOf(elsewhere, first)[0].hold).toBeNull();
    expect(tracksOf(fresh, w.workflow)[0].hold).toBeNull();
  });
});

describe("what a campaign's setup remembers", () => {
  it("starts from sensible defaults, keeps what is saved, and leaves the rest alone", () => {
    const w = workspace();
    expect(setupOf(db(), w.workflow)).toEqual(DEFAULT_SETUP);
    saveSetup(db(), w.workflow, { list_id: w.list, step: "context" });
    saveSetup(db(), w.workflow, { exclude: { customers: false, open_deals: true }, email_account_ids: [w.mailbox, w.mailbox] });
    expect(setupOf(db(), w.workflow)).toEqual({ ...DEFAULT_SETUP, step: "context", list_id: w.list, exclude: { customers: false, open_deals: true }, email_account_ids: [w.mailbox] });
  });

  it("reads a campaign launched before the wizard from its last run", async () => {
    const w = workspace();
    contact(w);
    await start(w, w.workflow);
    expect(setupOf(db(), w.workflow)).toMatchObject({ step: "summary", list_id: w.list, account_ids: [w.account], email_account_ids: [w.mailbox], exclude: { customers: false, open_deals: false } });
  });

  it("refuses what is not in the workspace or not a choice", () => {
    const w = workspace();
    const stranger = workspace();
    expect(setupProblem(db(), w.ws, { list_id: stranger.list })).toBe("That list is not in this workspace");
    expect(setupProblem(db(), w.ws, { account_ids: [stranger.account] })).toBe("A LinkedIn account that was chosen is not in this workspace");
    expect(setupProblem(db(), w.ws, { email_account_ids: [w.mailbox, stranger.mailbox] })).toBe("A mailbox that was chosen is not in this workspace");
    expect(setupProblem(db(), w.ws, { overlap: "steal" })).toBe("setup.overlap must be skip or take_over");
    expect(setupProblem(db(), w.ws, { step: "payment" })).toContain("setup.step must be one of");
    expect(setupProblem(db(), w.ws, { list_id: w.list, account_ids: [w.account], email_account_ids: [w.mailbox], rotation: "capacity" })).toBeNull();
  });

  it("lists what there is to choose from, with what each can do today", () => {
    const w = workspace();
    contact(w); contact(w, { email_status: "unverified" }); contact(w, { email: null });
    db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, ramp_start_date, paused_at)
      VALUES (?, ?, 'New box', 'new@acme.test', 'smtp.test.com', 'u', 'p', 1, 40, 1, date('now', '-2 days'), NULL), (?, ?, 'Paused box', 'paused@acme.test', 'smtp.test.com', 'u', 'p', 1, 40, 0, NULL, datetime('now'))`)
      .run(`${w.mailbox}-new`, w.ws, `${w.mailbox}-paused`, w.ws);
    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, email_account_id, domain, spf_status, dkim_status) VALUES (?, ?, ?, 'acme.test', 'pass', 'pass')").run(`dc-${w.ws}`, w.ws, w.mailbox);
    const options = setupOptions(db(), w.ws);
    expect(options.lists).toEqual([{ id: w.list, name: "Enterprise VPs", contacts: 3, with_email: 2, verified_email: 1 }]);
    expect(options.linkedin_accounts).toEqual([expect.objectContaining({ id: w.account, name: "Jordan Mertens", usable: true, connections_per_day: expect.any(Number) })]);
    const byName = Object.fromEntries(options.mailboxes.map((mailbox) => [mailbox.name, mailbox]));
    expect(byName["Ada Okafor"]).toMatchObject({ usable: true, emails_per_day: 50, warming_up: false, domain_checked: true, domain_ok: true });
    // The check is of the sending domain, so it speaks for every mailbox on it.
    expect(byName["New box"]).toMatchObject({ usable: true, emails_per_day: 6, warming_up: true, domain_checked: true, domain_ok: true });
    expect(byName["Paused box"]).toMatchObject({ usable: false, paused: true });
  });
});

describe("is it ready to launch", () => {
  it("blocks on what would stop it, one check at a time, and is ready once each is put right", () => {
    const w = workspace([
      { key: "c", step_type: "connect" },
      { step_type: "delay", track: "linkedin", delay_seconds: DAY },
      { key: "m", step_type: "message", message_body: "" },
      { key: "e", step_type: "email", email_subject: "Hello", email_body: "Hi {{first_name}}" },
    ]);
    let result = prelaunch(db(), w.ws, w.workflow);
    expect(result.ready).toBe(false);
    expect(check(result.checks, "sequence")).toMatchObject({ state: "block", detail: "1 step has nothing to send yet." });
    expect(check(result.checks, "audience")).toMatchObject({ state: "block", detail: "Choose the list to run the campaign on." });
    expect(check(result.checks, "linkedin").state).toBe("block");
    expect(check(result.checks, "mailboxes").state).toBe("block");
    expect(check(result.checks, "ai")).toMatchObject({ state: "ok", detail: "No step is written by AI." });

    db().prepare("UPDATE workflow_steps SET message_body = 'Thanks for connecting' WHERE id = ?").run(w.steps.m);
    saveSetup(db(), w.workflow, { list_id: w.list, account_ids: [w.account], email_account_ids: [w.mailbox] });
    result = prelaunch(db(), w.ws, w.workflow);
    expect(check(result.checks, "audience")).toMatchObject({ state: "block", detail: "The list is empty." });
    contact(w);
    result = prelaunch(db(), w.ws, w.workflow);
    expect(result.checks.map((entry) => [entry.key, entry.state])).toEqual([["sequence", "ok"], ["audience", "ok"], ["linkedin", "ok"], ["mailboxes", "warn"], ["ai", "ok"], ["overlap", "ok"]]);
    expect(check(result.checks, "mailboxes").detail).toContain("never had SPF and DKIM checked");
    expect(result.ready).toBe(true);
    expect(result.capacity).toMatchObject({ linkedin_accounts: 1, mailboxes: 1, emails_per_day: 50 });
    expect(result.audience).toMatchObject({ enrol: 1 });
  });

  it("warns about senders that cannot send, and blocks when none can", () => {
    const w = workspace([{ key: "c", step_type: "connect" }, { key: "e", step_type: "email", email_subject: "S", email_body: "B" }]);
    contact(w);
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Signed out', ?, 0, ?)").run(`${w.account}-out`, `out-${w.ws}@example.test`, w.ws);
    saveSetup(db(), w.workflow, { list_id: w.list, account_ids: [w.account, `${w.account}-out`], email_account_ids: [w.mailbox] });
    expect(check(prelaunch(db(), w.ws, w.workflow).checks, "linkedin")).toMatchObject({ state: "warn", detail: expect.stringContaining("1 account is signed out or paused") });
    saveSetup(db(), w.workflow, { account_ids: [`${w.account}-out`] });
    expect(check(prelaunch(db(), w.ws, w.workflow).checks, "linkedin").state).toBe("block");

    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, email_account_id, domain, spf_status, dkim_status) VALUES (?, ?, ?, 'acme.test', 'pass', 'fail')").run(`dc-${w.ws}`, w.ws, w.mailbox);
    expect(check(prelaunch(db(), w.ws, w.workflow).checks, "mailboxes")).toMatchObject({ state: "warn", detail: expect.stringContaining("SPF or DKIM is not passing") });
    db().prepare("UPDATE email_accounts SET paused_at = datetime('now') WHERE id = ?").run(w.mailbox);
    expect(check(prelaunch(db(), w.ws, w.workflow).checks, "mailboxes").state).toBe("block");
  });

  it("needs a key and a model for a step that AI writes, and estimates the cost from what it has cost before", () => {
    const w = workspace([{ key: "e", step_type: "email", ai_enabled: 1, ai_prompt: "Open with their hiring" }, { key: "m", step_type: "message", ai_enabled: 1, ai_prompt: "Thank them" }]);
    contact(w); contact(w); contact(w, { email: null });
    saveSetup(db(), w.workflow, { list_id: w.list, account_ids: [w.account], email_account_ids: [w.mailbox] });
    expect(check(prelaunch(db(), w.ws, w.workflow).checks, "ai")).toMatchObject({ state: "block", detail: expect.stringContaining("no OpenRouter key") });
    db().prepare("INSERT INTO integrations (key, workspace_id, api_key) VALUES ('openrouter', ?, ?)").run(w.ws, encryptSecret("sk-test"));
    expect(check(prelaunch(db(), w.ws, w.workflow).checks, "ai")).toMatchObject({ state: "block", detail: expect.stringContaining("2 AI steps have no model") });
    saveAiContext(db(), w.workflow, { model: "acme/writer-1" });
    let result = prelaunch(db(), w.ws, w.workflow);
    expect(check(result.checks, "ai")).toMatchObject({ state: "ok", detail: "2 steps written by acme/writer-1." });
    // Three contacts get the LinkedIn message; the two with an address get the email.
    expect(result.cost).toMatchObject({ ai_steps: 2, generations: 5, per_generation_usd: null, total_usd: null, sample: 0 });

    const spend = db().prepare("INSERT INTO agent_sessions (id, workspace_id, step_id, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 'some-step', 'acme/writer-1', ?, ?, ?)");
    spend.run(`as-${w.ws}-1`, w.ws, 3000, 400, 0.01);
    spend.run(`as-${w.ws}-2`, w.ws, 5000, 600, 0.03);
    result = prelaunch(db(), w.ws, w.workflow);
    expect(result.cost).toMatchObject({ per_generation_usd: 0.02, total_usd: 0.1, input_tokens: 20_000, output_tokens: 2500, sample: 2, spent_this_month_usd: 0.04 });
  });

  it("shows the month's AI budget, and warns when the writing would not fit in what is left", () => {
    const w = workspace([{ key: "e", step_type: "email", ai_enabled: 1, ai_prompt: "Open with their hiring" }]);
    contact(w); contact(w);
    saveSetup(db(), w.workflow, { list_id: w.list, email_account_ids: [w.mailbox] });
    db().prepare("INSERT INTO integrations (key, workspace_id, api_key) VALUES ('openrouter', ?, ?)").run(w.ws, encryptSecret("sk-test"));
    db().prepare("INSERT OR REPLACE INTO workspace_ai_config (workspace_id, default_model, monthly_budget_usd) VALUES (?, 'acme/writer-1', 10)").run(w.ws);
    const spend = db().prepare("INSERT INTO agent_sessions (id, workspace_id, step_id, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 'some-step', 'acme/writer-1', 1000, 100, ?)");
    spend.run(`as-${w.ws}-1`, w.ws, 2);
    let result = prelaunch(db(), w.ws, w.workflow);
    expect(result.cost).toMatchObject({ budget_usd: 10, spent_this_month_usd: 2, per_generation_usd: 2, total_usd: 4 });
    expect(check(result.checks, "ai").state).toBe("ok");

    // 9.50 spent: two more messages at about 4.75 each will not fit in the 0.50 that is left.
    spend.run(`as-${w.ws}-2`, w.ws, 7.5);
    result = prelaunch(db(), w.ws, w.workflow);
    expect(check(result.checks, "ai")).toMatchObject({ state: "warn", detail: expect.stringContaining("$0.50 is left of this month's budget") });
    spend.run(`as-${w.ws}-3`, w.ws, 1);
    expect(check(prelaunch(db(), w.ws, w.workflow).checks, "ai")).toMatchObject({ state: "warn", detail: expect.stringContaining("This month's AI budget is used up") });
    // A warning, not a block: the rest of the campaign can still run.
    expect(prelaunch(db(), w.ws, w.workflow).ready).toBe(true);
  });

  it("says what will happen to contacts in another campaign", async () => {
    const w = workspace();
    const other = another(w, "Another");
    contact(w);
    await start(w, other);
    contact(w);
    saveSetup(db(), w.workflow, { list_id: w.list, email_account_ids: [w.mailbox] });
    expect(check(prelaunch(db(), w.ws, w.workflow).checks, "overlap")).toMatchObject({ state: "warn", detail: "1 contact is part-way through another campaign and will be skipped." });
    saveSetup(db(), w.workflow, { overlap: "take_over" });
    const result = prelaunch(db(), w.ws, w.workflow);
    expect(check(result.checks, "overlap").detail).toContain("Their steps there will be held until they are done here.");
    expect(result.audience).toMatchObject({ enrol: 2, overlapping: 1 });
  });
});

describe("the routes", () => {
  it("reads and changes a campaign's setup, name and AI brief", async () => {
    const w = workspace();
    const read = await call(setupHandler, { method: "GET", query: { id: w.workflow }, headers: as(w, "viewer") });
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ campaign: { name: "Campaign", status: "draft" }, setup: DEFAULT_SETUP, ai: { angle: "", triggers: [], model: null }, ai_available: true });
    expect((read.body.options as { lists: unknown[] }).lists).toHaveLength(1);

    const saved = await call(setupHandler, {
      method: "PUT", query: { id: w.workflow }, headers: as(w, "member"),
      body: { name: "  Q4 Enterprise  ", prompt: "We sell outbound tooling.", setup: { list_id: w.list, step: "senders", email_account_ids: [w.mailbox] }, ai: { angle: "Hiring-driven capacity gap", tone: "Direct", triggers: ["hiring", "funding"] } },
    });
    expect(saved.body).toMatchObject({ campaign: { name: "Q4 Enterprise", prompt: "We sell outbound tooling." }, setup: { list_id: w.list, step: "senders", email_account_ids: [w.mailbox] }, ai: { angle: "Hiring-driven capacity gap", tone: "Direct", triggers: ["funding", "hiring"] } });

    expect((await call(setupHandler, { method: "PUT", query: { id: w.workflow }, body: { name: " " }, headers: as(w, "member") })).statusCode).toBe(400);
    expect((await call(setupHandler, { method: "PUT", query: { id: w.workflow }, body: { ai: { triggers: ["gossip"] } }, headers: as(w, "member") })).statusCode).toBe(400);
    expect((await call(setupHandler, { method: "PUT", query: { id: w.workflow }, body: { setup: { list_id: "someone-elses" } }, headers: as(w, "member") })).statusCode).toBe(400);
    expect((await call(setupHandler, { method: "PUT", query: { id: w.workflow }, body: { name: "x" }, headers: as(w, "viewer") })).statusCode).toBe(403);
    expect((await call(setupHandler, { method: "GET", query: { id: "nope" }, headers: as(w, "viewer") })).statusCode).toBe(404);
  });

  it("refuses to launch what is not ready, and says why", async () => {
    const w = workspace();
    const refused = await call(launchHandler, { method: "POST", query: { id: w.workflow }, headers: as(w, "manager") });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatchObject({ outcome: "not_ready", error: "Choose the list to run the campaign on." });
    expect(db().prepare("SELECT COUNT(*) AS c FROM runs WHERE workflow_id = ?").get(w.workflow)).toEqual({ c: 0 });
    expect((await call(launchHandler, { method: "POST", query: { id: w.workflow }, headers: as(w, "member") })).statusCode).toBe(403);
  });

  it("launches: enrols the audience as set up, starts the run, and the first email goes out", async () => {
    const w = workspace();
    const keep = contact(w);
    const customer = contact(w); deal(w, { target: customer }, "won");
    saveSetup(db(), w.workflow, { list_id: w.list, email_account_ids: [w.mailbox] });

    const ready = await call(prelaunchHandler, { method: "GET", query: { id: w.workflow, overlaps: "1" }, headers: as(w, "viewer") });
    expect(ready.body).toMatchObject({ ready: true, audience: { total: 2, excluded: 1, enrol: 1 }, overlapping_contacts: [] });

    const launched = await call(launchHandler, { method: "POST", query: { id: w.workflow }, headers: as(w, "manager") });
    expect(launched.statusCode).toBe(201);
    expect(launched.body).toMatchObject({ ok: true, enrolled: 1, excluded: 1, taken_over: 0 });
    expect(db().prepare("SELECT status, list_id FROM runs WHERE id = ?").get(String(launched.body.run_id))).toEqual({ status: "running", list_id: w.list });
    expect(tracksOf(keep, w.workflow)).toHaveLength(1);
    expect(tracksOf(customer, w.workflow)).toEqual([]);

    db().prepare("UPDATE run_profile_tracks SET state = 'in_progress', next_step_at = datetime('now', '-1 minute') WHERE state = 'pending'").run();
    await run();
    expect(smtp.sent.map((mail) => mail.subject)).toEqual(["Hello"]);
    // Launching again while it runs is refused, and nobody is enrolled twice.
    const again = await call(launchHandler, { method: "POST", query: { id: w.workflow }, headers: as(w, "manager") });
    expect(again.statusCode).toBe(400);
  });
});

describe("the brief a campaign gives the AI writer", () => {
  it("is exactly the free text until something structured is set", () => {
    const w = workspace();
    expect(campaignContextText(db(), w.workflow)).toBeNull();
    db().prepare("UPDATE workflows SET prompt = 'We sell outbound tooling.' WHERE id = ?").run(w.workflow);
    expect(campaignContextText(db(), w.workflow)).toBe("We sell outbound tooling.");
    saveAiContext(db(), w.workflow, { angle: "Hiring-driven capacity gap", tone: "Direct, peer-to-peer", triggers: ["hiring"] });
    expect(campaignContextText(db(), w.workflow)).toBe(
      "We sell outbound tooling.\nAngle: Hiring-driven capacity gap\nTone: Direct, peer-to-peer\nIf the contact has a recent signal of one of these kinds, open with it as the reason for writing: hiring. Their recent signals are listed with the contact. Never invent one.",
    );
    expect(aiContextOf(db(), w.workflow)).toEqual({ angle: "Hiring-driven capacity gap", tone: "Direct, peer-to-peer", triggers: ["hiring"], model: null });
    expect(aiContextProblem({ triggers: ["hiring", "rumour"] })).toContain("ai.triggers must be a list from");
    expect(aiContextProblem({ angle: 4 })).toBe("ai.angle must be text");
  });

  it("hands the writer the contact's recent signals of the chosen kinds, and nothing when there are none", () => {
    const w = workspace();
    db().prepare("INSERT INTO companies (id, workspace_id, name) VALUES ('launch-co-sig', ?, 'Initech')").run(w.ws);
    const lee = contact(w, { company_id: "launch-co-sig" });
    const signal = db().prepare("INSERT INTO signals (id, workspace_id, target_id, company_id, type, title, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    signal.run(`sig-${w.ws}-1`, w.ws, lee, null, "job_change", "Became VP Sales", new Date(Date.now() - 5 * 86_400_000).toISOString());
    signal.run(`sig-${w.ws}-2`, w.ws, null, "launch-co-sig", "funding", "Raised a Series B", new Date(Date.now() - 20 * 86_400_000).toISOString());
    signal.run(`sig-${w.ws}-3`, w.ws, lee, null, "hiring", "Posted 4 AE roles", new Date(Date.now() - 400 * 86_400_000).toISOString());

    expect(contactTriggers(db(), lee, ["job_change", "funding", "hiring"]).map((trigger) => trigger.title)).toEqual(["Became VP Sales", "Raised a Series B"]);
    expect(contactTriggers(db(), lee, ["technology"])).toEqual([]);
    const data = { contact: { id: lee, first_name: "Lee" }, company: null };
    expect(withTriggers(db(), w.workflow, lee, data)).toBe(data);
    saveAiContext(db(), w.workflow, { triggers: ["funding"] });
    expect(withTriggers(db(), w.workflow, lee, data).contact).toMatchObject({ first_name: "Lee", recent_signals: [{ type: "funding", title: "Raised a Series B" }] });
  });

  it("writes an AI step with the campaign's model and brief, the step's own model winning", async () => {
    const w = workspace([{ key: "e1", step_type: "email", ai_enabled: 1, ai_prompt: "Open with their hiring" }]);
    db().prepare("UPDATE workflows SET prompt = 'We sell outbound tooling.' WHERE id = ?").run(w.workflow);
    db().prepare("INSERT INTO integrations (key, workspace_id, api_key) VALUES ('openrouter', ?, ?)").run(w.ws, encryptSecret("sk-test"));
    db().prepare("INSERT OR REPLACE INTO workspace_ai_config (workspace_id, default_model) VALUES (?, 'workspace/default')").run(w.ws);
    saveAiContext(db(), w.workflow, { angle: "Capacity gap", model: "campaign/model" });
    const asked: Array<{ model: string; prompt: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { model: string; messages: Array<{ content: string }> };
      asked.push({ model: body.model, prompt: body.messages[1].content });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ subject: "Written", body: "By the model" }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }) };
    }));
    contact(w);
    await start(w, w.workflow);
    await run();
    expect(asked).toHaveLength(1);
    expect(asked[0].model).toBe("campaign/model");
    expect(JSON.parse(asked[0].prompt).campaign_context).toBe("We sell outbound tooling.\nAngle: Capacity gap");
    expect(smtp.sent.map((mail) => mail.subject)).toEqual(["Written"]);

    // The workspace writes formally; this campaign has no tone of its own, so that stands.
    db().prepare("UPDATE workspace_ai_config SET tone = 'formal' WHERE workspace_id = ?").run(w.ws);
    expect(withCampaignTone(db(), w.workflow, { tone: "formal", default_model: "x" })).toEqual({ tone: "formal", default_model: "x" });
    saveAiContext(db(), w.workflow, { tone: "Warm and conversational" });
    expect(withCampaignTone(db(), w.workflow, { tone: "formal", default_model: "x" })).toEqual({ tone: null, default_model: "x" });

    db().prepare("UPDATE workflow_steps SET ai_model = 'step/own' WHERE id = ?").run(w.steps.e1);
    db().prepare("UPDATE runs SET status = 'completed' WHERE workflow_id = ?").run(w.workflow);
    contact(w);
    await start(w, w.workflow);
    await run();
    expect(asked[1].model).toBe("step/own");
    // Written in the campaign's tone, and not in the workspace's as well.
    expect(JSON.parse(asked[1].prompt).campaign_context).toContain("Tone: Warm and conversational");
    expect(asked[1].prompt).not.toMatch(/formal/i);
  });
});
