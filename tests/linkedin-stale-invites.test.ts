// The stale-invitation clean-up: which invitations it considers stale, when the automatic
// pass acts, and what it writes down. Run against a real (throwaway) database with the
// browser stubbed — no test here launches Chromium or reaches LinkedIn. What the withdraw
// step does on the page is covered by linkedin-steps.test.ts and linkedin-browser.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ctxHeaders } from "./helpers/ctx";

vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async (id: string) => {
    getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(id);
  }),
}));
vi.mock("@/lib/linkedin/withdraw", async (original) => ({
  ...(await original<typeof import("@/lib/linkedin/withdraw")>()),
  withdrawInvitation: vi.fn(),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({
  shouldSyncAccepted: vi.fn(() => false),
  syncAcceptedConnections: vi.fn(),
}));

import { cleanUpStaleInvitations } from "@/lib/linkedin/runner";
import { staleInviteStats, staleInvites, withdrawalsToday } from "@/lib/linkedin/withdrawals";
import { NoPendingInviteError, WithdrawUnconfirmedError, withdrawInvitation } from "@/lib/linkedin/withdraw";
import { AlreadyConnectedError } from "@/lib/linkedin/connect";
import { SessionExpiredError } from "@/lib/linkedin/navigation";
import handler from "@/pages/api/accounts/[id]/stale-invitations";
import accountsHandler from "@/pages/api/accounts/index";
import { listLinkedinAccounts } from "@/lib/linkedin/account-list";

const withdraw = vi.mocked(withdrawInvitation);
const db = () => getDb();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const notToday = () => String(((new Date().getUTCDay() + 6) % 7 + 1) % 7 + 1);

let seq = 0;
/**
 * A workspace with one signed-in LinkedIn account that is inside its working hours right
 * now (all day, every day) and has the clean-up switched on, unless a test says otherwise.
 */
function account(opts: { enabled?: boolean; authenticated?: boolean; workingDays?: string; workspace?: string } = {}) {
  const n = ++seq;
  const ws = opts.workspace ?? `ws-stale-${n}`;
  const accountId = `stale-acct-${n}`;
  db().prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare(
    `INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days, withdraw_stale_invites)
     VALUES (?, ?, ?, ?, ?, 0, 24, 'UTC', ?, ?)`
  ).run(accountId, `Account ${n}`, `stale${n}@example.com`, opts.authenticated === false ? 0 : 1, ws, opts.workingDays ?? "1,2,3,4,5,6,7", opts.enabled === false ? 0 : 1);

  /** A contact this account invited `requested` days ago. */
  const contact = (fields: { requested?: number | null; degree?: number | null; withdrawnAt?: string | null; url?: string | null; repliedOn?: "linkedin" | "email" } = {}) => {
    const k = ++seq;
    const id = `stale-target-${k}`;
    db().prepare(
      `INSERT INTO targets (id, workspace_id, full_name, linkedin_url, degree, connection_requested_at, invite_withdrawn_at, last_replied_at, email_replied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, ws, `Lead ${k}`, fields.url === undefined ? `https://www.linkedin.com/in/lead-${k}/` : fields.url, fields.degree ?? null,
      fields.requested === null ? null : daysAgo(fields.requested ?? 45), fields.withdrawnAt ?? null,
      fields.repliedOn === "linkedin" ? daysAgo(1) : null, fields.repliedOn === "email" ? daysAgo(1) : null,
    );
    return id;
  };

  /** Put a contact in one of this account's campaigns, with its LinkedIn track in `track`. */
  const inCampaign = (targetId: string, run: "pending" | "running" | "paused" | "completed", track: "pending" | "in_progress" | "skipped" | "completed") => {
    const k = ++seq;
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, ?, ?)").run(`stale-wf-${k}`, `Campaign ${k}`, ws);
    db().prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, ?, ?)").run(`stale-run-${k}`, `stale-wf-${k}`, accountId, run, ws);
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`stale-rp-${k}`, `stale-run-${k}`, targetId);
    db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'linkedin', ?, 0)").run(`stale-rt-${k}`, `stale-rp-${k}`, track);
  };

  return { ws, accountId, contact, inCampaign, queue: () => staleInvites(db(), accountId, 50).map((c) => c.id) };
}

const target = (id: string) =>
  db().prepare("SELECT degree, connected_at, connection_requested_at, invite_withdrawn_at FROM targets WHERE id = ?").get(id) as
    { degree: number | null; connected_at: string | null; connection_requested_at: string | null; invite_withdrawn_at: string | null };
const ledger = (targetId: string) =>
  db().prepare("SELECT source, outcome, detail FROM linkedin_withdrawals WHERE target_id = ? ORDER BY rowid").all(targetId) as Array<{ source: string; outcome: string; detail: string | null }>;
const authenticated = (accountId: string) =>
  (db().prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(accountId) as { is_authenticated: number }).is_authenticated;
/** Withdrawals already made today by some other path. */
const alreadyWithdrawnToday = (accountId: string, count: number, source = "campaign") => {
  for (let i = 0; i < count; i++) {
    db().prepare("INSERT INTO linkedin_withdrawals (id, account_id, target_id, source, outcome) VALUES (?, ?, NULL, ?, 'withdrawn')").run(`stale-w-${++seq}`, accountId, source);
  }
};

/** One account's clean-up at a time: switch off whatever an earlier test left on. */
beforeEach(() => {
  db().prepare("UPDATE accounts SET withdraw_stale_invites = 0").run();
  vi.clearAllMocks();
  withdraw.mockResolvedValue(undefined);
});

const pass = () => cleanUpStaleInvitations(getDb(), { pace: false });

// ─────────────────────────────────────────────────────────────────────────────
describe("which invitations are stale", () => {
  it("is one sent longer ago than the acceptance wait, longest-pending first", () => {
    const a = account();
    const recent = a.contact({ requested: 12 });
    const old = a.contact({ requested: 40 });
    const older = a.contact({ requested: 80 });

    expect(a.queue()).toEqual([older, old]);
    expect(a.queue()).not.toContain(recent);
  });

  it("is never a contact who connected, whose invitation was withdrawn, or who was never invited", () => {
    const a = account();
    a.contact({ degree: 1 });
    a.contact({ withdrawnAt: daysAgo(3) });
    a.contact({ requested: null });
    const second = a.contact({ degree: 2 }); // not connected: a 2nd-degree contact still waiting
    expect(a.queue()).toEqual([second]);
  });

  it("is never a contact who has replied, on either channel", () => {
    // Someone is talking to them; what happens to their invitation is that person's call.
    const a = account();
    a.contact({ repliedOn: "linkedin" });
    a.contact({ repliedOn: "email" });
    expect(a.queue()).toEqual([]);
  });

  it("needs a profile URL to work from", () => {
    const a = account();
    a.contact({ url: "https://www.linkedin.com/sales/lead/ACwAAexample,NAME,x" });
    a.contact({ url: null });
    expect(a.queue()).toEqual([]);
  });

  it("is never a contact a live campaign is still working on", () => {
    // That campaign's own connect step withdraws when its wait runs out. A withdrawal from
    // here would make it invite the contact a second time three weeks later.
    const a = account();
    const waiting = a.contact();
    a.inCampaign(waiting, "running", "in_progress");
    const paused = a.contact();
    a.inCampaign(paused, "paused", "in_progress");
    const queued = a.contact();
    a.inCampaign(queued, "running", "pending");
    const notStarted = a.contact();
    a.inCampaign(notStarted, "pending", "pending");
    expect(a.queue()).toEqual([]);
  });

  it("is the contact a campaign gave up on, or whose campaign is over", () => {
    // The backlog this exists for: skipped as "did not accept", invitation left behind.
    const a = account();
    const gaveUp = a.contact({ requested: 60 });
    a.inCampaign(gaveUp, "running", "skipped");
    const finished = a.contact({ requested: 50 });
    a.inCampaign(finished, "completed", "skipped");
    const abandoned = a.contact({ requested: 40 });
    a.inCampaign(abandoned, "completed", "in_progress"); // the run ended around it
    expect(a.queue()).toEqual([gaveUp, finished, abandoned]);
  });

  it("stays inside the account's workspace", () => {
    const a = account();
    const other = account();
    const mine = a.contact();
    other.contact();
    expect(a.queue()).toEqual([mine]);
  });

  it("is only the account's own contacts where a workspace has several accounts", () => {
    // An invitation is pending on the account that sent it, not on its neighbour.
    const a = account();
    const b = account({ workspace: a.ws });
    const fromA = a.contact();
    a.inCampaign(fromA, "completed", "skipped");
    const fromB = b.contact();
    b.inCampaign(fromB, "completed", "skipped");
    a.contact(); // invited outside any campaign: nothing says whose it is

    expect(a.queue()).toEqual([fromA]);
    expect(b.queue()).toEqual([fromB]);
  });

  it("counts what is waiting and what has been done", () => {
    const a = account();
    a.contact(); a.contact(); a.contact({ requested: 5 });
    alreadyWithdrawnToday(a.accountId, 2, "campaign");
    alreadyWithdrawnToday(a.accountId, 1, "cleanup");
    expect(staleInviteStats(db(), a.accountId, "UTC")).toEqual({ after_days: 30, waiting: 2, withdrawn_today: 3, daily_limit: 10, withdrawn_by_cleanup: 1, on_hold: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the automatic clean-up", () => {
  it("does nothing until it is switched on for the account", async () => {
    // Off by default: a copy of a database that holds a live session must never start
    // withdrawing real invitations by itself.
    const a = account({ enabled: false });
    a.contact();
    // An account created the ordinary way, in a workspace of its own, to read the default off.
    db().prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-stale-default', 'd', 'ws-stale-default')").run();
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES ('stale-default', 'Default', 'stale-default@example.com', 1, 'ws-stale-default')").run();
    expect(db().prepare("SELECT withdraw_stale_invites AS on_by_default FROM accounts WHERE id = 'stale-default'").get()).toEqual({ on_by_default: 0 });

    await pass();
    expect(withdraw).not.toHaveBeenCalled();

    db().prepare("UPDATE accounts SET withdraw_stale_invites = 1 WHERE id = ?").run(a.accountId);
    await pass();
    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  it("withdraws one invitation per pass, oldest first, with no campaign running at all", async () => {
    const a = account();
    const old = a.contact({ requested: 40, url: "http://linkedin.com/in/never-answered" });
    const older = a.contact({ requested: 90 });

    await pass();

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(target(older).invite_withdrawn_at).not.toBeNull();
    expect(ledger(older)).toEqual([{ source: "cleanup", outcome: "withdrawn", detail: null }]);
    expect(target(old).invite_withdrawn_at).toBeNull();

    await pass();
    expect(withdraw).toHaveBeenLastCalledWith(expect.anything(), "http://linkedin.com/in/never-answered");
    expect(a.queue()).toEqual([]);
    expect(withdrawalsToday(db(), a.accountId, "UTC")).toBe(2);
  });

  it("spaces its withdrawals out instead of working through the queue in one go", async () => {
    const a = account();
    a.contact(); a.contact(); a.contact();

    await cleanUpStaleInvitations(getDb()); // paced, as the runner calls it
    await cleanUpStaleInvitations(getDb());
    await cleanUpStaleInvitations(getDb());

    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  it("keeps to the account's working hours", async () => {
    const a = account({ workingDays: notToday() });
    a.contact();
    await pass();
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("leaves a signed-out account alone", async () => {
    const a = account({ authenticated: false });
    a.contact();
    await pass();
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("shares the day's withdrawal limit with the campaigns", async () => {
    const a = account();
    a.contact(); a.contact();
    alreadyWithdrawnToday(a.accountId, 9);

    await pass(); // the tenth of the day
    await pass(); // over the limit
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(a.queue()).toHaveLength(1);
  });

  it("stops for the day when LinkedIn reports a withdrawal that did not take effect", async () => {
    // What happened on the live account: "Invitation to … withdrawn", and the invitation
    // still pending afterwards — for every one tried.
    const a = account();
    const first = a.contact({ requested: 60 });
    const second = a.contact({ requested: 50 });
    withdraw.mockRejectedValueOnce(new WithdrawUnconfirmedError('LinkedIn reported the withdrawal ("Invitation to Lead withdrawn.") but the profile still shows the invitation as pending'));

    await pass();
    await pass();

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(target(first).invite_withdrawn_at).toBeNull();
    expect(ledger(first)).toEqual([{ source: "cleanup", outcome: "unconfirmed", detail: expect.stringContaining("Invitation to Lead withdrawn.") }]);
    expect(withdrawalsToday(db(), a.accountId, "UTC")).toBe(0);
    expect(staleInviteStats(db(), a.accountId, "UTC")).toMatchObject({ on_hold: true, waiting: 1 });

    // The next day it carries on, and looks at the same contact again: by then LinkedIn may
    // show the invitation as withdrawn after all.
    db().prepare("UPDATE linkedin_withdrawals SET created_at = datetime('now', '-2 days') WHERE account_id = ?").run(a.accountId);
    expect(staleInviteStats(db(), a.accountId, "UTC").on_hold).toBe(false);
    expect(a.queue()).toEqual([first, second]);
    withdraw.mockRejectedValueOnce(new NoPendingInviteError(true));
    await pass();
    expect(target(first).invite_withdrawn_at).not.toBeNull();
    expect(a.queue()).toEqual([second]);
  });

  it("flags the account and stops when the session turns out to be signed out", async () => {
    const a = account();
    const first = a.contact({ requested: 60 });
    a.contact({ requested: 50 });
    withdraw.mockRejectedValue(new SessionExpiredError("LinkedIn redirected to https://www.linkedin.com/login/"));

    await pass();
    await pass();

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(authenticated(a.accountId)).toBe(0);
    expect(ledger(first)).toEqual([]); // says nothing about the contact, so nothing is held against them
    expect(a.queue()).toHaveLength(2);
  });

  describe("records what LinkedIn showed, and does not go back for the same contact", () => {
    it("when there was no invitation left to withdraw", async () => {
      const a = account();
      const gone = a.contact({ requested: 60 });
      const next = a.contact({ requested: 50 });
      withdraw.mockRejectedValueOnce(new NoPendingInviteError(false));

      await pass();
      expect(ledger(gone)).toEqual([{ source: "cleanup", outcome: "not_pending", detail: null }]);
      expect(target(gone).invite_withdrawn_at).toBeNull();
      expect(withdrawalsToday(db(), a.accountId, "UTC")).toBe(0); // nothing was withdrawn, so nothing is spent
      expect(a.queue()).toEqual([next]);
    });

    it("when LinkedIn showed the invitation as withdrawn already", async () => {
      const a = account();
      const lead = a.contact();
      withdraw.mockRejectedValueOnce(new NoPendingInviteError(true));

      await pass();
      expect(target(lead).invite_withdrawn_at).not.toBeNull(); // a later connect step waits LinkedIn's block out
      expect(ledger(lead)).toEqual([{ source: "cleanup", outcome: "already_withdrawn", detail: null }]);
      expect(withdrawalsToday(db(), a.accountId, "UTC")).toBe(0);
    });

    it("when the contact had accepted after all", async () => {
      const a = account();
      const lead = a.contact();
      withdraw.mockRejectedValueOnce(new AlreadyConnectedError("Already connected"));

      await pass();

      expect(target(lead)).toMatchObject({ degree: 1, invite_withdrawn_at: null });
      expect(target(lead).connected_at).not.toBeNull();
      expect(ledger(lead)).toEqual([{ source: "cleanup", outcome: "connected", detail: null }]);
      const events = db().prepare("SELECT payload_json FROM domain_events WHERE type = 'linkedin.connected' AND entity_id = ?").all(lead) as Array<{ payload_json: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].payload_json)).toMatchObject({ account_id: a.accountId });
      expect(a.queue()).toEqual([]);
    });

    it("gives a page that failed a day before another try, and three tries in all", async () => {
      const a = account();
      const broken = a.contact({ requested: 60 });
      const next = a.contact({ requested: 50 });
      withdraw.mockRejectedValueOnce(new Error("page.goto: Timeout 30000ms exceeded.\nCall log: …"));

      await pass();
      expect(ledger(broken)).toEqual([{ source: "cleanup", outcome: "failed", detail: "page.goto: Timeout 30000ms exceeded." }]);
      expect(a.queue()).toEqual([next]); // not stuck behind it

      const age = (days: number) => db().prepare("UPDATE linkedin_withdrawals SET created_at = datetime('now', ?) WHERE target_id = ?").run(`-${days} days`, broken);
      age(2);
      expect(a.queue()).toEqual([broken, next]); // a day on, it is tried again

      for (let i = 0; i < 2; i++) db().prepare("INSERT INTO linkedin_withdrawals (id, account_id, target_id, source, outcome) VALUES (?, ?, ?, 'cleanup', 'failed')").run(`stale-w-${++seq}`, a.accountId, broken);
      age(2);
      expect(a.queue()).toEqual([next]); // three failures: left for a person to look at
    });
  });

  it("comes back for a contact who was invited again and went unanswered again", () => {
    const a = account();
    const lead = a.contact({ requested: 40 });
    // An earlier invitation that LinkedIn no longer showed, checked before this one was sent.
    db().prepare("INSERT INTO linkedin_withdrawals (id, account_id, target_id, source, outcome, created_at) VALUES (?, ?, ?, 'cleanup', 'not_pending', datetime('now', '-70 days'))").run(`stale-w-${++seq}`, a.accountId, lead);
    expect(a.queue()).toEqual([lead]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET / POST /api/accounts/{id}/stale-invitations", () => {
  function mockRes() {
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    res.end = () => res;
    res.setHeader = () => res;
    return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
  }
  async function call(a: { ws: string; accountId: string }, method: "GET" | "POST", body?: unknown, opts: { role?: string; ws?: string } = {}) {
    const res = mockRes();
    await handler({
      method, query: { id: a.accountId }, body,
      headers: ctxHeaders(opts.ws ?? a.ws, { userId: "user-1", role: opts.role ?? "admin" }),
    } as unknown as NextApiRequest, res);
    return res;
  }

  it("shows what is waiting, what was done today, and who is next", async () => {
    const a = account({ enabled: false });
    const older = a.contact({ requested: 70 });
    const old = a.contact({ requested: 40 });
    alreadyWithdrawnToday(a.accountId, 4);

    const res = await call(a, "GET", undefined, { role: "viewer" });

    expect(res.body).toMatchObject({ enabled: false, after_days: 30, waiting: 2, withdrawn_today: 4, daily_limit: 10, withdrawn_by_cleanup: 0, on_hold: false });
    expect((res.body.next as Array<{ contact_id: string }>).map((c) => c.contact_id)).toEqual([older, old]);
    expect((res.body.next as Array<{ url: string }>)[0].url).toMatch(/^https:\/\/www\.linkedin\.com\/in\/lead-\d+\/$/);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("cannot be read or run from another workspace", async () => {
    const a = account();
    const other = account();
    a.contact();
    expect((await call(a, "GET", undefined, { ws: other.ws })).statusCode).toBe(404);
    expect((await call(a, "POST", { confirm: true }, { ws: other.ws })).statusCode).toBe(404);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("withdraws only for an admin who confirms", async () => {
    const a = account();
    a.contact();
    expect((await call(a, "POST", { confirm: true }, { role: "member" })).statusCode).toBe(403);
    const unconfirmed = await call(a, "POST", {});
    expect(unconfirmed.statusCode).toBe(400);
    expect(String(unconfirmed.body.error)).toMatch(/really withdraws/);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("withdraws the next in line on request, whether or not the automatic clean-up is on", async () => {
    const a = account({ enabled: false });
    const lead = a.contact();

    const res = await call(a, "POST", { confirm: true });

    expect(res.body).toMatchObject({ ok: true, results: [{ contact_id: lead, outcome: "withdrawn" }], waiting: 0, withdrawn_today: 1 });
    expect(target(lead).invite_withdrawn_at).not.toBeNull();
    const audit = db().prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'account.stale_invites_withdrawn' AND entity_id = ?").get(a.accountId) as { c: number };
    expect(audit.c).toBe(1);
  });

  it("withdraws exactly the contacts named, and says which of them are not stale", async () => {
    const a = account();
    const stale = a.contact({ requested: 40 });
    a.contact({ requested: 90 }); // older, but not asked for
    const recent = a.contact({ requested: 3 });

    const res = await call(a, "POST", { confirm: true, contact_ids: [recent, stale, "no-such-contact"] });

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(res.body.results).toEqual(expect.arrayContaining([
      { contact_id: stale, name: expect.stringMatching(/^Lead/), outcome: "withdrawn" },
      { contact_id: recent, name: null, outcome: "not_stale" },
      { contact_id: "no-such-contact", name: null, outcome: "not_stale" },
    ]));
    expect(a.queue()).toHaveLength(1);
  });

  it("stays inside the day's limit", async () => {
    const a = account();
    a.contact(); a.contact();
    alreadyWithdrawnToday(a.accountId, 9);

    const res = await call(a, "POST", { confirm: true, limit: 2 });

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect((res.body.results as Array<{ outcome: string }>).map((r) => r.outcome)).toEqual(["withdrawn", "daily_limit_reached"]);
  });

  it("does not go on to the next contact once LinkedIn fails to apply a withdrawal", async () => {
    const a = account();
    const first = a.contact({ requested: 60 });
    const second = a.contact({ requested: 50 });
    withdraw.mockRejectedValueOnce(new WithdrawUnconfirmedError('LinkedIn reported the withdrawal ("Invitation to Lead withdrawn.") but the profile still shows the invitation as pending'));

    const res = await call(a, "POST", { confirm: true, limit: 2 });

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ ok: true, on_hold: true });
    expect((res.body.results as Array<{ contact_id: string; outcome: string }>).map((r) => [r.contact_id, r.outcome])).toEqual([[first, "unconfirmed"], [second, "not_attempted"]]);
  });

  it("refuses more than a few at a time, and an account that is not signed in", async () => {
    const a = account();
    a.contact();
    expect((await call(a, "POST", { confirm: true, limit: 4 })).statusCode).toBe(400);
    db().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(a.accountId);
    expect((await call(a, "POST", { confirm: true })).statusCode).toBe(400);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("reports a session that has expired, and flags the account", async () => {
    const a = account();
    a.contact();
    withdraw.mockRejectedValue(new SessionExpiredError("LinkedIn redirected to https://www.linkedin.com/login/"));

    const res = await call(a, "POST", { confirm: true });

    expect(res.statusCode).toBe(409);
    expect(authenticated(a.accountId)).toBe(0);
  });
});

// The settings page prints these figures for every account. It is first rendered from
// listLinkedinAccounts and then refreshes from GET /api/accounts after each action, and
// the route used to answer without them, so the page broke on its first refresh.
describe("the list of LinkedIn accounts", () => {
  async function listed(headers: Record<string, string>, method = "GET", body: Record<string, unknown> = {}) {
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    res.end = () => res;
    res.setHeader = () => res;
    await accountsHandler({ method, query: {}, body, headers } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return res as unknown as { statusCode: number; body: unknown };
  }

  it("carries each account's stale-invitation figures when it is fetched again", async () => {
    const a = account();
    a.contact({ requested: 40 });
    a.contact({ requested: 40 });
    a.contact({ requested: 2 });
    const rows = (await listed(ctxHeaders(a.ws))).body as Array<{ id: string; stale_invites: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].stale_invites).toEqual(staleInviteStats(db(), a.accountId, "UTC"));
    expect(rows[0].stale_invites).toMatchObject({ waiting: 2, on_hold: false });
  });

  it("is the same list, field for field, as the one the page is first rendered with", async () => {
    const a = account();
    account({ workspace: a.ws, authenticated: false });
    a.contact({ requested: 40 });
    const fetched = (await listed(ctxHeaders(a.ws))).body;
    expect(fetched).toEqual(listLinkedinAccounts(db(), a.ws));
    expect((fetched as unknown[]).length).toBe(2);
  });

  it("gives a newly added account its figures too, and never another workspace's accounts", async () => {
    const a = account();
    const other = account();
    const created = await listed(ctxHeaders(a.ws), "POST", { name: "Second seat", email: `second-${a.accountId}@example.com` });
    expect(created.statusCode).toBe(201);
    expect((created.body as { stale_invites: Record<string, unknown> }).stale_invites).toMatchObject({ waiting: 0 });
    const ids = ((await listed(ctxHeaders(a.ws))).body as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toContain(a.accountId);
    expect(ids).not.toContain(other.accountId);
  });

  it("does not hand the stored session to the browser", async () => {
    const a = account();
    db().prepare("UPDATE accounts SET cookies_json = 'secret-session' WHERE id = ?").run(a.accountId);
    expect(JSON.stringify((await listed(ctxHeaders(a.ws))).body)).not.toContain("secret-session");
  });
});
