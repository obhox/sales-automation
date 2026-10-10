// A campaign that runs its LinkedIn steps from several accounts: how contacts are shared
// out, that each contact is worked by its own account and held by that account's limits
// alone, changing the accounts later, and what an account's own lists may speak for.
// Real (throwaway) database; every browser-facing function is stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb, migrateDatabase } from "@/lib/db";

vi.mock("@/lib/linkedin/session", () => ({
  // The page remembers whose session it is, so a test can see which account did a step.
  getSessionPage: vi.fn(async (accountId: string) => ({ accountId, close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async (id: string) => {
    getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(id);
  }),
}));
vi.mock("@/lib/linkedin/connect", async (original) => ({
  ...(await original<typeof import("@/lib/linkedin/connect")>()),
  sendConnectionRequest: vi.fn(),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", async (original) => ({
  ...(await original<typeof import("@/lib/linkedin/sync-accepted")>()),
  shouldSyncAccepted: vi.fn(() => false),
  syncAcceptedConnections: vi.fn(),
}));

import { tick } from "@/lib/linkedin/runner";
import { sendConnectionRequest } from "@/lib/linkedin/connect";
import { visitProfile } from "@/lib/linkedin/visit";
import { SessionExpiredError } from "@/lib/linkedin/navigation";
import { resolveLinkedInAccount } from "@/lib/linkedin/resolve-account";
import { staleInvites } from "@/lib/linkedin/withdrawals";
import { assignLinkedinAccounts, runAccountPool, runAccounts } from "@/lib/outreach/enroll";
import runsHandler from "@/pages/api/runs";
import runHandler from "@/pages/api/runs/[id]";
import runAccountsHandler from "@/pages/api/runs/[id]/accounts";
import enrollHandler from "@/pages/api/runs/[id]/enroll";
import accountHandler from "@/pages/api/accounts/[id]";
import { ctxHeaders } from "./helpers/ctx";

const connect = vi.mocked(sendConnectionRequest);
const visit = vi.mocked(visitProfile);
const db = () => getDb();
let seq = 0;

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

type Step = "visit" | "connect";

/** A workspace with a campaign of LinkedIn steps, a list, and as many signed-in accounts as asked for, awake all day every day. */
function workspace(steps: Step[], accounts = 2) {
  const n = ++seq;
  const ws = `ws-pool-${n}`;
  const w = { ws, workflow: `pool-wf-${n}`, list: `pool-list-${n}`, accounts: [] as string[], headers: {} as Record<string, string>, adminHeaders: {} as Record<string, string> };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  for (let i = 0; i < accounts; i++) w.accounts.push(account(w));
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(w.workflow, ws);
  steps.forEach((type, index) =>
    db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds) VALUES (?, ?, ?, 'linkedin', ?, 0)").run(`pool-step-${n}-${index + 1}`, w.workflow, index + 1, type));
  db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'List')").run(w.list, ws);
  w.headers = ctxHeaders(ws, { userId: `pool-manager-${n}`, role: "manager" });
  w.adminHeaders = ctxHeaders(ws, { userId: `pool-admin-${n}`, role: "admin" });
  return w;
}

function account(w: { ws: string }, fields: Record<string, unknown> = {}) {
  const id = `pool-acct-${++seq}`;
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, ?, ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(id, `Account ${seq}`, `${id}@example.test`, w.ws);
  for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(value, id);
  return id;
}

function company(w: { ws: string }) {
  const id = `pool-co-${++seq}`;
  db().prepare("INSERT INTO companies (id, workspace_id, name) VALUES (?, ?, ?)").run(id, w.ws, `Company ${seq}`);
  return id;
}

function contact(w: { ws: string; list: string }, fields: Record<string, unknown> = {}) {
  const id = `pool-target-${++seq}`;
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, first_name, linkedin_url) VALUES (?, ?, ?, 'Lead', ?)").run(id, w.ws, `Lead ${seq}`, `https://www.linkedin.com/in/pool-lead-${seq}/`);
  for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE targets SET ${column} = ? WHERE id = ?`).run(value, id);
  db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(w.list, id);
  return id;
}

/** Start a run over the list through the API, and set it running with every contact due now. */
async function start(w: ReturnType<typeof workspace>, body: Record<string, unknown>) {
  const res = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, ...body }, headers: w.headers });
  if (res.statusCode !== 201) return { res, runId: "" };
  const runId = String(res.body.id);
  db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
  db().prepare("UPDATE run_profile_tracks SET state = 'in_progress' WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)").run(runId);
  return { res, runId };
}

const accountOf = (runId: string, targetId: string) =>
  (db().prepare("SELECT account_id FROM run_profiles WHERE run_id = ? AND target_id = ?").get(runId, targetId) as { account_id: string | null }).account_id;
const trackOf = (targetId: string) =>
  db().prepare("SELECT rt.state, rt.current_step, rt.next_step_at, rt.error_message FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id WHERE rp.target_id = ? AND rt.track = 'linkedin'")
    .get(targetId) as { state: string; current_step: number; next_step_at: string | null; error_message: string | null };
const runRow = (id: string) => db().prepare("SELECT account_id, linkedin_rotation, status FROM runs WHERE id = ?").get(id) as { account_id: string | null; linkedin_rotation: string | null; status: string };
/** Which account's session each call of a stubbed step was made on. */
const sessionsOf = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map((args) => (args[0] as { accountId: string }).accountId);
const run = () => tick(getDb(), { pace: false });

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status IN ('running', 'pending', 'paused')").run();
  vi.clearAllMocks();
  visit.mockReset();
  visit.mockResolvedValue(undefined);
  connect.mockReset();
  connect.mockResolvedValue({ noteSent: false, noteSkipped: null });
});

// ─────────────────────────────────────────────────────────────────────
describe("sharing contacts out between a campaign's accounts", () => {
  it("has nothing to decide with one account or none", () => {
    const w = workspace(["visit"], 1);
    const leads = [contact(w), contact(w)];
    expect(assignLinkedinAccounts(db(), leads, []).size).toBe(0);
    expect(assignLinkedinAccounts(db(), leads, w.accounts).size).toBe(0);
  });

  it("takes the accounts in turn", () => {
    const w = workspace(["visit"], 3);
    const [a, b, c] = w.accounts;
    const leads = Array.from({ length: 7 }, () => contact(w));
    const assignment = assignLinkedinAccounts(db(), leads, w.accounts);
    expect(leads.map((lead) => assignment.get(lead))).toEqual([a, b, c, a, b, c, a]);
  });

  it("keeps a company with one account", () => {
    const w = workspace(["visit"], 2);
    const [a, b] = w.accounts;
    const acme = company(w);
    const leads = [contact(w, { company_id: acme }), contact(w), contact(w, { company_id: acme }), contact(w, { company_id: acme }), contact(w)];
    const assignment = assignLinkedinAccounts(db(), leads, w.accounts);
    // Acme's three all go where its first went; the others fill the lighter account.
    expect(leads.map((lead) => assignment.get(lead))).toEqual([a, b, a, a, b]);
  });

  it("keeps a contact with the account that has already written to them, if it is in the campaign", () => {
    const w = workspace(["visit"], 2);
    const [a, b] = w.accounts;
    const outsider = account(w);
    const leads = [contact(w, { linkedin_account_id: b }), contact(w, { linkedin_account_id: b }), contact(w, { linkedin_account_id: outsider }), contact(w)];
    const assignment = assignLinkedinAccounts(db(), leads, w.accounts);
    expect(leads.map((lead) => assignment.get(lead))).toEqual([b, b, a, a]);
  });

  it("can share out in proportion to each account's daily invitation limit", () => {
    const w = workspace(["visit"], 0);
    const big = account(w, { daily_connection_limit: 30 });
    const small = account(w, { daily_connection_limit: 10 });
    const leads = Array.from({ length: 8 }, () => contact(w));
    const assignment = assignLinkedinAccounts(db(), leads, [big, small], "capacity");
    const share = (id: string) => [...assignment.values()].filter((assigned) => assigned === id).length;
    expect([share(big), share(small)]).toEqual([6, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("starting a campaign with several LinkedIn accounts", () => {
  it("records the pool, gives every contact an account, and says how they were shared", async () => {
    const w = workspace(["visit"], 3);
    const leads = Array.from({ length: 6 }, () => contact(w));
    const { res, runId } = await start(w, { account_ids: w.accounts });

    expect(res.statusCode).toBe(201);
    expect(runRow(runId)).toMatchObject({ account_id: w.accounts[0], linkedin_rotation: "round_robin" });
    expect(runAccountPool(db(), runId)).toEqual(w.accounts);
    expect(leads.map((lead) => accountOf(runId, lead))).toEqual([...w.accounts, ...w.accounts]);
    expect(res.body.linkedin_accounts).toEqual(Object.fromEntries(w.accounts.map((id) => [id, 2])));
  });

  it("is an ordinary one-account campaign when given one account, however it is sent", async () => {
    const w = workspace(["visit"], 1);
    const lead = contact(w);
    const asList = await start(w, { account_ids: w.accounts });
    expect(asList.res.statusCode).toBe(201);
    expect(runRow(asList.runId)).toMatchObject({ account_id: w.accounts[0], linkedin_rotation: null });
    expect(runAccountPool(db(), asList.runId)).toEqual([]);
    expect(accountOf(asList.runId, lead)).toBeNull();

    const other = workspace(["visit"], 1);
    const otherLead = contact(other);
    const asAlways = await start(other, { account_id: other.accounts[0] });
    expect(runRow(asAlways.runId)).toMatchObject({ account_id: other.accounts[0], linkedin_rotation: null });
    expect(accountOf(asAlways.runId, otherLead)).toBeNull();
    expect(asAlways.res.body).not.toHaveProperty("linkedin_accounts");
  });

  it("refuses an account from another workspace, and a rotation it does not know", async () => {
    const w = workspace(["visit"], 1);
    const elsewhere = workspace(["visit"], 1);
    contact(w);
    expect((await start(w, { account_ids: [w.accounts[0], elsewhere.accounts[0]] })).res.statusCode).toBe(400);
    expect((await start(w, { account_ids: w.accounts, linkedin_rotation: "random" })).res.statusCode).toBe(400);
    expect((await start(w, { account_ids: "all" })).res.statusCode).toBe(400);
    expect(db().prepare("SELECT COUNT(*) AS c FROM runs WHERE workflow_id = ?").get(w.workflow)).toEqual({ c: 0 });
  });

  it("reports the accounts and each contact's account on the run", async () => {
    const w = workspace(["visit"], 2);
    const leads = [contact(w), contact(w), contact(w)];
    const { runId } = await start(w, { account_ids: w.accounts });
    const res = await call(runHandler, { method: "GET", query: { id: runId }, headers: w.headers });
    expect(res.body.linkedin_accounts).toEqual([
      { id: w.accounts[0], name: expect.any(String), signed_in: true, paused: false, in_pool: true, contacts: 2 },
      { id: w.accounts[1], name: expect.any(String), signed_in: true, paused: false, in_pool: true, contacts: 1 },
    ]);
    const profiles = res.body.profiles as Array<{ target_id: string; account_id: string }>;
    expect(Object.fromEntries(profiles.map((profile) => [profile.target_id, profile.account_id]))).toEqual({ [leads[0]]: w.accounts[0], [leads[1]]: w.accounts[1], [leads[2]]: w.accounts[0] });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("running a campaign with several accounts", () => {
  it("works each contact from its own account, and records who wrote to whom", async () => {
    const w = workspace(["visit", "connect"], 2);
    const [a, b] = w.accounts;
    const leads = [contact(w), contact(w), contact(w), contact(w)];
    const { runId } = await start(w, { account_ids: w.accounts });

    await run();
    // A visit is done on the contact's account and leaves the contact tied to nobody.
    expect(sessionsOf(visit).sort()).toEqual([a, a, b, b].sort());
    expect(db().prepare("SELECT COUNT(*) AS c FROM targets WHERE workspace_id = ? AND linkedin_account_id IS NOT NULL").get(w.ws)).toEqual({ c: 0 });

    await run();
    expect(connect).toHaveBeenCalledTimes(4);
    const invitedFrom = Object.fromEntries(connect.mock.calls.map((args) => [String(args[1]).match(/pool-lead-(\d+)/)![1], (args[0] as unknown as { accountId: string }).accountId]));
    for (const lead of leads) {
      const number = lead.replace("pool-target-", "");
      expect(invitedFrom[number], lead).toBe(accountOf(runId, lead));
      // The invitation is from that account, so the contact now belongs with it.
      expect((db().prepare("SELECT linkedin_account_id FROM targets WHERE id = ?").get(lead) as { linkedin_account_id: string }).linkedin_account_id).toBe(accountOf(runId, lead));
    }
    const sends = db().prepare("SELECT account_id, COUNT(*) AS c FROM step_sends WHERE run_id = ? AND action = 'connect' GROUP BY account_id ORDER BY account_id").all(runId);
    expect(sends).toEqual([a, b].sort().map((account_id) => ({ account_id, c: 2 })));
  });

  it("holds only the contacts of an account that has used up its day", async () => {
    const w = workspace(["connect"], 0);
    const tight = account(w, { daily_connection_limit: 1 });
    const roomy = account(w, { daily_connection_limit: 20 });
    const leads = [contact(w), contact(w), contact(w), contact(w)];
    const { runId } = await start(w, { account_ids: [tight, roomy] });

    await run();

    expect(sessionsOf(connect).sort()).toEqual([tight, roomy, roomy].sort());
    // Exactly one contact was not invited, and it is one of the tight account's.
    const invited = new Set((db().prepare("SELECT target_id FROM step_sends WHERE run_id = ? AND action = 'connect'").all(runId) as Array<{ target_id: string }>).map((row) => row.target_id));
    const held = leads.filter((lead) => !invited.has(lead));
    expect(held).toHaveLength(1);
    expect(accountOf(runId, held[0])).toBe(tight);
    expect(trackOf(held[0])).toMatchObject({ state: "in_progress", current_step: 0, error_message: null });
    expect(db().prepare("SELECT COUNT(*) AS c FROM logs WHERE run_id = ? AND target_id = ? AND message LIKE 'Daily LinkedIn connections limit reached%'").get(runId, held[0])).toEqual({ c: 1 });
  });

  it("holds only the contacts of a paused account, and carries on with the rest", async () => {
    const w = workspace(["visit"], 2);
    const [a, b] = w.accounts;
    const leads = [contact(w), contact(w), contact(w), contact(w)];
    const { runId } = await start(w, { account_ids: w.accounts });
    db().prepare("UPDATE accounts SET paused_at = datetime('now') WHERE id = ?").run(a);

    await run();

    expect(sessionsOf(visit)).toEqual([b, b]);
    for (const lead of leads) {
      const onPaused = accountOf(runId, lead) === a;
      expect(trackOf(lead), lead).toMatchObject(onPaused ? { state: "in_progress", current_step: 0, error_message: null, next_step_at: null } : { state: "completed" });
    }
    expect(runRow(runId).status).toBe("running");

    db().prepare("UPDATE accounts SET paused_at = NULL WHERE id = ?").run(a);
    await run();
    expect(sessionsOf(visit).sort()).toEqual([a, a, b, b].sort());
  });

  it("holds only the contacts of an account that turns out to be signed out", async () => {
    const w = workspace(["visit"], 2);
    const [a, b] = w.accounts;
    const leads = [contact(w), contact(w), contact(w), contact(w)];
    const { runId } = await start(w, { account_ids: w.accounts });
    visit.mockImplementation(async (page) => {
      if ((page as unknown as { accountId: string }).accountId === a) throw new SessionExpiredError("redirected to login");
    });

    await run();

    // One contact found out for account A; its other contact was not sent to find out again.
    expect(sessionsOf(visit).filter((id) => id === a)).toHaveLength(1);
    expect(sessionsOf(visit).filter((id) => id === b)).toHaveLength(2);
    for (const lead of leads) expect(trackOf(lead).state, lead).toBe(accountOf(runId, lead) === a ? "in_progress" : "completed");
    expect(db().prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(a)).toEqual({ is_authenticated: 0 });
    expect(db().prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(b)).toEqual({ is_authenticated: 1 });
  });

  it("starts new contacts against each account's own day", async () => {
    const w = workspace(["connect"], 0);
    const tight = account(w, { daily_connection_limit: 1 });
    const roomy = account(w, { daily_connection_limit: 20 });
    const leads = Array.from({ length: 6 }, () => contact(w));
    const res = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, account_ids: [tight, roomy] }, headers: w.headers });
    const runId = String(res.body.id);
    db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);

    await run();

    const started = (id: string) => leads.filter((lead) => accountOf(runId, lead) === id && trackOf(lead).state !== "pending").length;
    // Three contacts each. The tight account has room to start one today; the roomy one starts all three.
    expect(started(tight)).toBe(1);
    expect(started(roomy)).toBe(3);
  });

  it("finishes once, however many accounts it had", async () => {
    const w = workspace(["visit"], 3);
    Array.from({ length: 3 }, () => contact(w));
    const { runId } = await start(w, { account_ids: w.accounts });

    await run();
    await run();

    expect(runRow(runId).status).toBe("completed");
    expect(db().prepare("SELECT COUNT(*) AS c FROM logs WHERE run_id = ? AND message LIKE '%run completed%'").get(runId)).toEqual({ c: 1 });
    expect(db().prepare("SELECT COUNT(*) AS c FROM domain_events WHERE workspace_id = ? AND type = 'workflow.completed'").get(w.ws)).toEqual({ c: 1 });
  });

  it("runs a one-account campaign from the campaign's account, as it always has", async () => {
    const w = workspace(["visit", "connect"], 2);
    const [a] = w.accounts;
    const leads = [contact(w), contact(w)];
    const { runId } = await start(w, { account_id: a });

    await run();
    await run();

    expect(sessionsOf(visit)).toEqual([a, a]);
    expect(sessionsOf(connect)).toEqual([a, a]);
    expect(leads.map((lead) => accountOf(runId, lead))).toEqual([null, null]);
    expect(runAccounts(db(), runId)).toEqual([{ id: a, name: expect.any(String), signed_in: true, paused: false, in_pool: true, contacts: 2 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("changing a campaign's accounts", () => {
  const put = (w: ReturnType<typeof workspace>, runId: string, body: Record<string, unknown>, headers = w.headers) =>
    call(runAccountsHandler, { method: "PUT", query: { id: runId }, body, headers });

  it("leaves started contacts where they are and shares the rest out again", async () => {
    const w = workspace(["visit", "connect"], 2);
    const [a, b] = w.accounts;
    const c = account(w);
    const leads = Array.from({ length: 6 }, () => contact(w));
    const created = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, account_ids: [a, b] }, headers: w.headers });
    const runId = String(created.body.id);
    // The first two have started (one on each account); the other four are still waiting.
    db().prepare(`UPDATE run_profile_tracks SET state = 'in_progress' WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ? AND target_id IN (?, ?))`).run(runId, leads[0], leads[1]);

    const res = await put(w, runId, { account_ids: [b, c] });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ pool: [b, c], rotation: "round_robin", reassigned: 4, finishing_elsewhere: 1 });
    // Started: untouched, including the one on the account that left.
    expect(accountOf(runId, leads[0])).toBe(a);
    expect(accountOf(runId, leads[1])).toBe(b);
    // Waiting: only ever on the new accounts, and levelled against the one B already has:
    // C takes the first, and they alternate from there.
    const waiting = leads.slice(2).map((lead) => accountOf(runId, lead));
    expect(waiting).toEqual([c, b, c, b]);
    expect(runRow(runId).account_id).toBe(b);
    const listed = res.body.accounts as Array<{ id: string; in_pool: boolean; contacts: number }>;
    expect(listed.find((entry) => entry.id === a)).toMatchObject({ in_pool: false, contacts: 1 });
  });

  it("pins contacts already started on a one-account campaign before the account changes", async () => {
    const w = workspace(["visit", "connect"], 2);
    const [a, b] = w.accounts;
    const leads = [contact(w), contact(w), contact(w)];
    const created = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, account_id: a }, headers: w.headers });
    const runId = String(created.body.id);
    db().prepare(`UPDATE run_profile_tracks SET state = 'in_progress' WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?)`).run(runId, leads[0]);

    // Hand the whole campaign to B. The contact A has started stays with A.
    const res = await put(w, runId, { account_ids: [b] });

    expect(res.body).toMatchObject({ pool: [b], rotation: null, reassigned: 2, finishing_elsewhere: 1 });
    expect(runRow(runId)).toMatchObject({ account_id: b, linkedin_rotation: null });
    expect(runAccountPool(db(), runId)).toEqual([]);
    expect(leads.map((lead) => accountOf(runId, lead))).toEqual([a, null, null]);

    db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    db().prepare("UPDATE run_profile_tracks SET state = 'in_progress' WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)").run(runId);
    await run();
    expect(sessionsOf(visit).sort()).toEqual([a, b, b].sort());
  });

  it("is for managers, on a campaign that has LinkedIn steps and has not finished", async () => {
    const w = workspace(["visit"], 2);
    contact(w);
    const { runId } = await start(w, { account_ids: w.accounts });
    const member = ctxHeaders(w.ws, { userId: `${w.ws}-member`, role: "member" });
    expect((await put(w, runId, { account_ids: w.accounts }, member)).statusCode).toBe(403);
    expect((await put(w, runId, { account_ids: [] })).statusCode).toBe(400);
    expect((await put(w, runId, { account_ids: w.accounts, linkedin_rotation: "sideways" })).statusCode).toBe(400);
    const elsewhere = workspace(["visit"], 1);
    expect((await put(w, runId, { account_ids: [elsewhere.accounts[0]] })).statusCode).toBe(400);
    expect((await put(elsewhere, runId, { account_ids: elsewhere.accounts })).statusCode).toBe(404);
    db().prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(runId);
    expect((await put(w, runId, { account_ids: w.accounts })).statusCode).toBe(400);
    expect(runAccountPool(db(), runId)).toEqual(w.accounts);
  });

  it("gives contacts added later to the lighter account, and a known company to its own", async () => {
    const w = workspace(["visit"], 2);
    const [a, b] = w.accounts;
    const acme = company(w);
    const first = [contact(w, { company_id: acme }), contact(w), contact(w)];
    const { runId } = await start(w, { account_ids: w.accounts });
    expect(first.map((lead) => accountOf(runId, lead))).toEqual([a, b, a]);

    const later = [contact(w), contact(w, { company_id: acme }), contact(w)];
    const res = await call(enrollHandler, { method: "POST", query: { id: runId }, body: { target_ids: later }, headers: w.headers });

    expect(res.body).toMatchObject({ enrolled: 3 });
    // B was one behind, so it takes the first; Acme's colleague joins Acme's account; then B again to level.
    expect(later.map((lead) => accountOf(runId, lead))).toEqual([b, a, b]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("deleting an account that campaigns share", () => {
  const remove = (w: ReturnType<typeof workspace>, id: string) => call(accountHandler, { method: "DELETE", query: { id }, headers: w.adminHeaders });

  it("is refused while it still has contacts to finish, in a running or a paused campaign", async () => {
    const w = workspace(["visit", "connect"], 2);
    const [, b] = w.accounts;
    contact(w); contact(w);
    const { runId } = await start(w, { account_ids: w.accounts });

    const running = await remove(w, b);
    expect(running.statusCode).toBe(409);
    expect(running.body.campaigns).toEqual([{ run_id: runId, name: "Campaign" }]);

    db().prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(runId);
    expect((await remove(w, b)).statusCode).toBe(409);
    expect(db().prepare("SELECT 1 AS here FROM accounts WHERE id = ?").get(b)).toEqual({ here: 1 });
  });

  it("keeps a finished campaign it shared, and forgets what the account had", async () => {
    const w = workspace(["visit"], 2);
    const [a, b] = w.accounts;
    const leads = [contact(w), contact(w)];
    const { runId } = await start(w, { account_ids: w.accounts });
    await run();
    await run();
    expect(runRow(runId).status).toBe("completed");
    db().prepare("UPDATE targets SET linkedin_account_id = ? WHERE id = ?").run(a, leads[0]);

    // The campaign's first account goes. The campaign stays, under the one that is left.
    const res = await remove(w, a);

    expect(res.statusCode).toBe(204);
    expect(runRow(runId)).toMatchObject({ account_id: b, status: "completed" });
    expect(db().prepare("SELECT COUNT(*) AS c FROM run_profiles WHERE run_id = ?").get(runId)).toEqual({ c: 2 });
    expect(db().prepare("SELECT COUNT(*) AS c FROM run_profiles WHERE account_id = ?").get(a)).toEqual({ c: 0 });
    expect(runAccountPool(db(), runId)).toEqual([b]);
    expect(db().prepare("SELECT linkedin_account_id FROM targets WHERE id = ?").get(leads[0])).toEqual({ linkedin_account_id: null });
  });

  it("still takes a one-account campaign's history with it, as before", async () => {
    const w = workspace(["visit"], 1);
    contact(w);
    const { runId } = await start(w, { account_id: w.accounts[0] });
    await run();
    await run();
    expect((await remove(w, w.accounts[0])).statusCode).toBe(204);
    expect(db().prepare("SELECT 1 FROM runs WHERE id = ?").get(runId)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("which account answers for a contact", () => {
  /** An invitation old enough to be stale, on a contact no live campaign is working. */
  const invited = (w: ReturnType<typeof workspace>, fields: Record<string, unknown> = {}) =>
    contact(w, { connection_requested_at: new Date(Date.now() - 60 * 86_400_000).toISOString(), ...fields });

  it("is the contact's own account in a campaign with several, not the campaign's first", async () => {
    const w = workspace(["visit"], 2);
    const [a, b] = w.accounts;
    const leads = [invited(w), invited(w)];
    const { runId } = await start(w, { account_ids: w.accounts });
    db().prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(runId);
    db().prepare("UPDATE run_profile_tracks SET state = 'completed' WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)").run(runId);

    // Each account's sent-invitations list speaks only for the contact it was given.
    expect(staleInvites(db(), a, 10).map((invite) => invite.id)).toEqual([leads[0]]);
    expect(staleInvites(db(), b, 10).map((invite) => invite.id)).toEqual([leads[1]]);
    expect(resolveLinkedInAccount(db(), leads[1])?.id).toBe(b);
  });

  it("is the account that wrote to them, once one has, whatever campaigns they were in", async () => {
    const w = workspace(["visit"], 2);
    const [a, b] = w.accounts;
    const lead = invited(w);
    const { runId } = await start(w, { account_id: a });
    db().prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(runId);
    db().prepare("UPDATE run_profile_tracks SET state = 'completed' WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)").run(runId);
    expect(staleInvites(db(), a, 10).map((invite) => invite.id)).toEqual([lead]);

    db().prepare("UPDATE targets SET linkedin_account_id = ? WHERE id = ?").run(b, lead);
    expect(staleInvites(db(), a, 10)).toEqual([]);
    expect(staleInvites(db(), b, 10).map((invite) => invite.id)).toEqual([lead]);
    expect(resolveLinkedInAccount(db(), lead)?.id).toBe(b);
    // A signed-out account is never handed back, even when it is the one that wrote.
    db().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(b);
    expect(resolveLinkedInAccount(db(), lead)?.id).toBe(a);
  });

  it("is worked out once for contacts written to before it was recorded", () => {
    const w = workspace(["visit"], 2);
    const [a, b] = w.accounts;
    const fromSends = contact(w);
    const fromCampaign = contact(w, { connection_requested_at: new Date().toISOString() });
    const untouched = contact(w);
    const visited = contact(w);
    const runId = `pool-old-run-${++seq}`;
    db().prepare("INSERT INTO runs (id, workspace_id, workflow_id, list_id, account_id, status) VALUES (?, ?, ?, ?, ?, 'completed')").run(runId, w.ws, w.workflow, w.list, a);
    for (const lead of [fromCampaign, untouched]) db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`pool-rp-${++seq}`, runId, lead);
    const send = (target: string, action: string, accountId: string, when: string) =>
      db().prepare("INSERT INTO step_sends (id, workspace_id, channel, action, account_id, target_id, sent_at) VALUES (?, ?, 'linkedin', ?, ?, ?, datetime('now', ?))").run(`pool-send-${++seq}`, w.ws, action, accountId, target, when);
    send(fromSends, "connect", a, "-9 days");
    send(fromSends, "message", b, "-2 days");
    send(visited, "visit", a, "-1 days");

    db().prepare("DELETE FROM _migration_flags WHERE key = 'target_linkedin_account_v1'").run();
    migrateDatabase(db());

    const wrote = (id: string) => (db().prepare("SELECT linkedin_account_id FROM targets WHERE id = ?").get(id) as { linkedin_account_id: string | null }).linkedin_account_id;
    expect(wrote(fromSends)).toBe(b);       // the latest account to write
    expect(wrote(fromCampaign)).toBe(a);    // no record of sends: the campaign that invited them
    expect(wrote(untouched)).toBeNull();    // in a campaign, never written to
    expect(wrote(visited)).toBeNull();      // a visit is not writing
    expect(db().prepare("SELECT 1 AS done FROM _migration_flags WHERE key = 'target_linkedin_account_v1'").get()).toEqual({ done: 1 });
  });
});
