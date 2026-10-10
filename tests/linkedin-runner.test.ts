// The campaign engine's decisions about LinkedIn steps, run against a real (throwaway)
// database with every browser-facing function stubbed. No test here launches Chromium or
// reaches LinkedIn: what the steps do on the page is covered by linkedin-steps.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";

vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async (id: string) => {
    getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(id);
  }),
}));
vi.mock("@/lib/linkedin/connect", async (original) => ({
  ...(await original<typeof import("@/lib/linkedin/connect")>()),
  sendConnectionRequest: vi.fn(),
}));
vi.mock("@/lib/linkedin/message", async (original) => ({
  ...(await original<typeof import("@/lib/linkedin/message")>()),
  sendMessage: vi.fn(),
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

import { tick } from "@/lib/linkedin/runner";
import { AlreadyConnectedError, ConnectUnavailableError, InviteBlockedError, PendingInviteError, sendConnectionRequest } from "@/lib/linkedin/connect";
import { NoPendingInviteError, WithdrawUnconfirmedError, withdrawInvitation } from "@/lib/linkedin/withdraw";
import { MessageUnconfirmedError, NotConnectedError, RecipientRepliedError, sendMessage } from "@/lib/linkedin/message";
import { visitProfile } from "@/lib/linkedin/visit";
import { SessionExpiredError } from "@/lib/linkedin/navigation";
import { shouldSyncAccepted, syncAcceptedConnections } from "@/lib/linkedin/sync-accepted";

const connect = vi.mocked(sendConnectionRequest);
const message = vi.mocked(sendMessage);
const visit = vi.mocked(visitProfile);
const withdraw = vi.mocked(withdrawInvitation);

type StepSpec = { type: "visit" | "connect" | "message" | "delay" | "email"; track?: "linkedin" | "email"; note?: string; body?: string };

let seq = 0;
/**
 * A running campaign for one LinkedIn account that is inside its working hours right now
 * (all day, every day) unless a test narrows the window.
 */
function campaign(steps: StepSpec[], opts: { authenticated?: boolean; workingDays?: string } = {}) {
  const db = getDb();
  const n = ++seq;
  const ws = `ws-runner-${n}`;
  const accountId = `runner-acct-${n}`;
  const workflowId = `runner-wf-${n}`;
  const runId = `runner-run-${n}`;
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db.prepare(
    `INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
     VALUES (?, ?, ?, ?, ?, 0, 24, 'UTC', ?)`
  ).run(accountId, `Account ${n}`, `runner${n}@example.com`, opts.authenticated === false ? 0 : 1, ws, opts.workingDays ?? "1,2,3,4,5,6,7");
  db.prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, ?, ?)").run(workflowId, `Campaign ${n}`, ws);
  const order: Record<string, number> = {};
  for (const step of steps) {
    const track = step.track ?? "linkedin";
    order[track] = (order[track] ?? 0) + 1;
    db.prepare(
      "INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, connect_note, message_body) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
    ).run(`runner-step-${n}-${track}-${order[track]}`, workflowId, order[track], track, step.type, step.note ?? null, step.body ?? null);
  }
  db.prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, 'running', ?)").run(runId, workflowId, accountId, ws);

  /** Enrol a contact with a due track per workflow track, each starting at `at`. */
  const enrol = (fields: { url?: string; degree?: number | null; requestedAt?: string | null; withdrawnAt?: string | null; at?: Partial<Record<"linkedin" | "email", number>> } = {}) => {
    const k = ++seq;
    const targetId = `runner-target-${k}`;
    db.prepare(
      "INSERT INTO targets (id, workspace_id, full_name, first_name, linkedin_url, degree, connection_requested_at, invite_withdrawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(targetId, ws, `Lead ${k}`, "Lead", fields.url ?? `https://www.linkedin.com/in/lead-${k}/`, fields.degree ?? null, fields.requestedAt ?? null, fields.withdrawnAt ?? null);
    db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`runner-rp-${k}`, runId, targetId);
    for (const track of Object.keys(order)) {
      db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, ?, 'in_progress', ?)")
        .run(`runner-rt-${k}-${track}`, `runner-rp-${k}`, track, fields.at?.[track as "linkedin" | "email"] ?? 0);
    }
    return targetId;
  };
  return { ws, accountId, runId, enrol };
}

const db = () => getDb();
const track = (targetId: string, which: "linkedin" | "email" = "linkedin") =>
  db().prepare(
    `SELECT rt.state, rt.current_step, rt.next_step_at, rt.error_message, rt.attempts FROM run_profile_tracks rt
     JOIN run_profiles rp ON rp.id = rt.run_profile_id WHERE rp.target_id = ? AND rt.track = ?`
  ).get(targetId, which) as { state: string; current_step: number; next_step_at: string | null; error_message: string | null; attempts: number };
const target = (id: string) =>
  db().prepare("SELECT degree, connected_at, connection_requested_at, invite_withdrawn_at, message_sent_at, last_replied_at FROM targets WHERE id = ?").get(id) as
    { degree: number | null; connected_at: string | null; connection_requested_at: string | null; invite_withdrawn_at: string | null; message_sent_at: string | null; last_replied_at: string | null };
const logs = (runId: string) =>
  (db().prepare("SELECT level, message FROM logs WHERE run_id = ? ORDER BY rowid").all(runId) as Array<{ level: string; message: string }>);
const authenticated = (accountId: string) =>
  (db().prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(accountId) as { is_authenticated: number }).is_authenticated;
const minutesFromNow = (iso: string | null) => (Date.parse(iso!) - Date.now()) / 60_000;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Only one campaign runs at a time in these tests: finish whatever a previous test left. */
beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status = 'running'").run();
  vi.clearAllMocks();
  vi.mocked(shouldSyncAccepted).mockReturnValue(false);
  connect.mockResolvedValue({ noteSent: false, noteSkipped: null });
  message.mockResolvedValue("sent");
  withdraw.mockResolvedValue(undefined);
});

const run = () => tick(getDb(), { pace: false });

// ─────────────────────────────────────────────────────────────────────────────
describe("a signed-out LinkedIn account", () => {
  it("puts LinkedIn steps on hold without failing anyone, while the email track keeps moving", async () => {
    // The engine used to select only runs whose account was signed in and return when there
    // were none — so an expired LinkedIn session silently stopped every email campaign too.
    const c = campaign([{ type: "connect" }, { type: "delay", track: "email" }, { type: "delay", track: "email" }], { authenticated: false });
    const lead = c.enrol();

    await run();

    expect(connect).not.toHaveBeenCalled();
    expect(track(lead, "linkedin")).toMatchObject({ state: "in_progress", current_step: 0, error_message: null, attempts: 0 });
    expect(track(lead, "email").current_step).toBe(1); // the email track advanced
  });

  it("is recognised on the first contact; the rest of the queue is not sent at it", async () => {
    const c = campaign([{ type: "connect" }]);
    const first = c.enrol();
    const second = c.enrol();
    connect.mockRejectedValueOnce(new SessionExpiredError("LinkedIn redirected to https://www.linkedin.com/login/"));

    await run();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(authenticated(c.accountId)).toBe(0);
    for (const lead of [first, second]) {
      expect(track(lead)).toMatchObject({ state: "in_progress", error_message: null, attempts: 0 });
      expect(target(lead).connection_requested_at).toBeNull();
    }
    const errors = logs(c.runId).filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/session has expired — sign it in again on the LinkedIn accounts page/);
  });

  it("is flagged by the connections sync, which then holds the tick's LinkedIn steps", async () => {
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol();
    vi.mocked(shouldSyncAccepted).mockReturnValue(true);
    vi.mocked(syncAcceptedConnections).mockResolvedValue({
      stamped: 0, unmarked: 0, pulled: 0, declaredTotal: null, fullPass: false, verifiedComplete: false, signedOut: true,
    });

    await run();

    expect(connect).not.toHaveBeenCalled();
    expect(track(lead).state).toBe("in_progress");
    expect(logs(c.runId).some((l) => l.level === "error" && /session has expired/.test(l.message))).toBe(true);
  });

  it("resumes on the first tick after it is signed back in", async () => {
    const c = campaign([{ type: "connect" }], { authenticated: false });
    const lead = c.enrol();
    await run();
    expect(connect).not.toHaveBeenCalled();

    db().prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = ?").run(c.accountId);
    await run();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(target(lead).connection_requested_at).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("connect step", () => {
  it("records the request only after the step confirms it, and passes the rendered note", async () => {
    const c = campaign([{ type: "connect", note: "Hi {{first_name}}, good to meet you." }]);
    const lead = c.enrol({ url: "http://www.linkedin.com/in/some-lead" });
    connect.mockResolvedValue({ noteSent: true, noteSkipped: null });

    await run();

    expect(connect).toHaveBeenCalledWith(expect.anything(), "http://www.linkedin.com/in/some-lead", { note: "Hi Lead, good to meet you." });
    expect(target(lead).connection_requested_at).not.toBeNull();
    expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0 });
    expect(minutesFromNow(track(lead).next_step_at)).toBeGreaterThan(5 * 60);
    expect(logs(c.runId).some((l) => /^Connection request sent to Lead \d+ with a note/.test(l.message))).toBe(true);
  });

  it("says so when the request went out without its note", async () => {
    const c = campaign([{ type: "connect", note: "Hello" }]);
    c.enrol();
    connect.mockResolvedValue({ noteSent: false, noteSkipped: "this account has no personalised invitations left this month" });
    await run();
    expect(logs(c.runId).some((l) => l.level === "warn" && /went out without its note: this account has no personalised/.test(l.message))).toBe(true);
  });

  it("does not record a request the step could not confirm, and retries it later", async () => {
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol();
    connect.mockRejectedValue(new Error("LinkedIn did not confirm the invitation — the profile does not show it as pending"));

    await run();

    expect(target(lead).connection_requested_at).toBeNull();
    expect(track(lead)).toMatchObject({ state: "in_progress", attempts: 1, error_message: null });
    expect(minutesFromNow(track(lead).next_step_at)).toBeGreaterThan(25);
    expect(logs(c.runId).some((l) => /^Connection request sent/.test(l.message))).toBe(false); // nothing for the daily cap to count
  });

  it("fails the contact only after the retries are used up", async () => {
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol();
    connect.mockRejectedValue(new Error("page.goto: Timeout 30000ms exceeded."));
    const makeDue = () => db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL").run();

    await run();
    expect(track(lead)).toMatchObject({ state: "in_progress", attempts: 1 });
    makeDue(); await run();
    expect(track(lead)).toMatchObject({ state: "in_progress", attempts: 2 });
    expect(minutesFromNow(track(lead).next_step_at)).toBeGreaterThan(150);
    makeDue(); await run();
    expect(track(lead)).toMatchObject({ state: "failed", error_message: "page.goto: Timeout 30000ms exceeded." });
  });

  it("clears the retry count once a retried request goes through", async () => {
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol();
    connect.mockRejectedValueOnce(new Error("page.goto: Timeout 30000ms exceeded."));
    await run();
    db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL").run();
    await run();
    expect(track(lead).attempts).toBe(0);
    expect(target(lead).connection_requested_at).not.toBeNull();
  });

  it("records an invitation LinkedIn already shows as pending, without a new send", async () => {
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol();
    connect.mockRejectedValue(new PendingInviteError("Invitation already pending"));
    await run();
    expect(target(lead).connection_requested_at).not.toBeNull();
    expect(track(lead)).toMatchObject({ state: "in_progress", attempts: 0 });
  });

  it("skips a member LinkedIn offers no Connect for", async () => {
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol();
    connect.mockRejectedValue(new ConnectUnavailableError("LinkedIn does not offer Connect on this profile"));
    await run();
    expect(track(lead)).toMatchObject({ state: "skipped", error_message: "LinkedIn does not offer Connect on this profile" });
  });

  it("re-checks a waiting contact quietly, even outside working hours", async () => {
    // Not today's weekday: the account is outside its schedule for the whole test.
    const notToday = String(((new Date().getUTCDay() + 6) % 7 + 1) % 7 + 1);
    const c = campaign([{ type: "connect" }, { type: "message", body: "Hi" }], { workingDays: notToday });
    const lead = c.enrol({ requestedAt: daysAgo(2) });

    await run();

    expect(connect).not.toHaveBeenCalled();
    expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0 });
    expect(minutesFromNow(track(lead).next_step_at)).toBeGreaterThan(5 * 60);
    expect(logs(c.runId).filter((l) => /Lead/.test(l.message))).toEqual([]); // no per-pass log row
  });

  it("hands an accepted connection to the next step whatever the hour", async () => {
    const notToday = String(((new Date().getUTCDay() + 6) % 7 + 1) % 7 + 1);
    const c = campaign([{ type: "connect" }, { type: "message", body: "Hi" }], { workingDays: notToday });
    const lead = c.enrol({ requestedAt: daysAgo(2), degree: 1 });
    await run();
    expect(track(lead).current_step).toBe(1);
  });

  it("keeps waiting past a week, and gives up after thirty days", async () => {
    // Six of sixteen real acceptances arrived after day 7.
    const c = campaign([{ type: "connect" }]);
    const dayTwenty = c.enrol({ requestedAt: daysAgo(20) });
    const dayThirtyOne = c.enrol({ requestedAt: daysAgo(31) });

    await run();

    expect(track(dayTwenty).state).toBe("in_progress");
    expect(track(dayThirtyOne)).toMatchObject({ state: "skipped", error_message: "Did not accept connection after 30 days" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("an invitation nobody answered", () => {
  const GAVE_UP = "Did not accept connection after 30 days";
  const notToday = () => String(((new Date().getUTCDay() + 6) % 7 + 1) % 7 + 1);
  const makeDue = () => db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL WHERE state = 'in_progress'").run();
  const withdrawnLogs = (runId: string) => logs(runId).filter((l) => /^Invitation withdrawn/.test(l.message));

  it("is withdrawn when the wait runs out, and only then is the contact given up on", async () => {
    // It used to be left pending on LinkedIn for good, and they pile up.
    const c = campaign([{ type: "connect" }]);
    const requestedAt = daysAgo(31);
    const lead = c.enrol({ url: "http://linkedin.com/in/never-answered", requestedAt });
    const stillWaiting = c.enrol({ requestedAt: daysAgo(20) });

    await run();

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(withdraw).toHaveBeenCalledWith(expect.anything(), "http://linkedin.com/in/never-answered");
    expect(target(lead).invite_withdrawn_at).not.toBeNull();
    expect(target(lead).connection_requested_at).toBe(requestedAt); // the request stays on record
    expect(track(lead)).toMatchObject({ state: "skipped", error_message: GAVE_UP });
    expect(withdrawnLogs(c.runId)).toHaveLength(1);
    // The ledger row is what the daily cap counts, and what tells the clean-up this one is done.
    expect(db().prepare("SELECT source, outcome FROM linkedin_withdrawals WHERE target_id = ?").all(lead)).toEqual([{ source: "campaign", outcome: "withdrawn" }]);
    expect(track(stillWaiting).state).toBe("in_progress");
    expect(target(stillWaiting).invite_withdrawn_at).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it("waits for working hours, like every other action on the account", async () => {
    const c = campaign([{ type: "connect" }], { workingDays: notToday() });
    const lead = c.enrol({ requestedAt: daysAgo(31) });

    await run();

    expect(withdraw).not.toHaveBeenCalled();
    expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0 });
    expect(Date.parse(track(lead).next_step_at!)).toBeGreaterThan(Date.now());
    expect(target(lead).invite_withdrawn_at).toBeNull();
  });

  it("is held, untouched, while the account is signed out", async () => {
    const c = campaign([{ type: "connect" }], { authenticated: false });
    const lead = c.enrol({ requestedAt: daysAgo(31) });

    await run();

    expect(withdraw).not.toHaveBeenCalled();
    expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0, next_step_at: null, error_message: null, attempts: 0 });

    db().prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = ?").run(c.accountId);
    await run();
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(track(lead).state).toBe("skipped");
  });

  it("stops at the day's cap and carries the rest over to tomorrow", async () => {
    const c = campaign([{ type: "connect" }]);
    const leads = Array.from({ length: 12 }, () => c.enrol({ requestedAt: daysAgo(40) }));

    await run();

    expect(withdraw).toHaveBeenCalledTimes(10);
    const left = leads.filter((lead) => track(lead).state === "in_progress");
    expect(left).toHaveLength(2);
    for (const lead of left) {
      expect(minutesFromNow(track(lead).next_step_at)).toBeGreaterThan(0);
      expect(target(lead).invite_withdrawn_at).toBeNull();
    }
    const overflow = logs(c.runId).filter((l) => /^Daily LinkedIn invitation withdrawal limit reached/.test(l.message));
    expect(overflow.map((l) => l.level)).toEqual(["info", "info"]);

    // Still the same day: the ten already done count, so nothing more goes out.
    makeDue();
    await run();
    expect(withdraw).toHaveBeenCalledTimes(10);
  });

  it("counts withdrawals made outside any campaign against the same daily cap", async () => {
    // The stale-invitation clean-up and the test endpoint write to the same ledger.
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol({ requestedAt: daysAgo(31) });
    for (let i = 0; i < 10; i++) {
      db().prepare("INSERT INTO linkedin_withdrawals (id, account_id, source, outcome) VALUES (?, ?, 'cleanup', 'withdrawn')").run(`runner-w-${++seq}`, c.accountId);
    }

    await run();

    expect(withdraw).not.toHaveBeenCalled();
    expect(track(lead).state).toBe("in_progress");
    expect(minutesFromNow(track(lead).next_step_at)).toBeGreaterThan(0);
  });

  it("does not draw on the connection cap, nor new invitations on the withdrawal cap", async () => {
    const c = campaign([{ type: "connect" }]);
    db().prepare("UPDATE accounts SET daily_connection_limit = 1 WHERE id = ?").run(c.accountId);
    const expired = [c.enrol({ requestedAt: daysAgo(31) }), c.enrol({ requestedAt: daysAgo(31) })];
    const fresh = c.enrol();

    await run();

    expect(withdraw).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(1);
    for (const lead of expired) expect(track(lead).state).toBe("skipped");
    expect(target(fresh).connection_requested_at).not.toBeNull();
  });

  it("moves a contact on who turns out to have accepted", async () => {
    const c = campaign([{ type: "connect" }, { type: "message", body: "Hi" }]);
    const lead = c.enrol({ requestedAt: daysAgo(31) });
    withdraw.mockRejectedValue(new AlreadyConnectedError("Already connected"));

    await run();

    expect(target(lead)).toMatchObject({ degree: 1, invite_withdrawn_at: null });
    expect(target(lead).connected_at).not.toBeNull();
    expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 1 });
  });

  it("gives up without a withdrawal when LinkedIn shows no invitation left", async () => {
    // Declined, expired, or withdrawn by hand: nothing was taken back, so nothing is recorded.
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol({ requestedAt: daysAgo(31) });
    withdraw.mockRejectedValue(new NoPendingInviteError(false));

    await run();

    expect(track(lead)).toMatchObject({ state: "skipped", error_message: GAVE_UP });
    expect(target(lead).invite_withdrawn_at).toBeNull();
    expect(withdrawnLogs(c.runId)).toEqual([]); // nothing for the daily cap to count
  });

  it("retries a withdrawal that failed, and then still skips the contact rather than failing it", async () => {
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol({ requestedAt: daysAgo(31) });
    withdraw.mockRejectedValue(new Error("LinkedIn did not confirm the withdrawal — the profile still shows the invitation as pending"));

    await run();
    expect(track(lead)).toMatchObject({ state: "in_progress", attempts: 1, error_message: null });
    expect(minutesFromNow(track(lead).next_step_at)).toBeGreaterThan(25);
    makeDue(); await run();
    expect(track(lead)).toMatchObject({ state: "in_progress", attempts: 2 });
    makeDue(); await run();

    expect(withdraw).toHaveBeenCalledTimes(3);
    expect(track(lead)).toMatchObject({ state: "skipped", error_message: GAVE_UP });
    expect(target(lead).invite_withdrawn_at).toBeNull();
    expect(withdrawnLogs(c.runId)).toEqual([]);
    expect(logs(c.runId).some((l) => l.level === "error" && /could not be withdrawn and is still pending on LinkedIn/.test(l.message))).toBe(true);
  });

  it("records the withdrawal when LinkedIn shows the invitation as withdrawn already", async () => {
    // The first attempt pressed Withdraw and could not confirm it; the retry finds
    // LinkedIn's own mark that it went through.
    const c = campaign([{ type: "connect" }]);
    const lead = c.enrol({ requestedAt: daysAgo(31) });
    withdraw.mockRejectedValueOnce(new Error("page.goto: Timeout 30000ms exceeded."));
    withdraw.mockRejectedValueOnce(new NoPendingInviteError(true));

    await run();
    expect(target(lead).invite_withdrawn_at).toBeNull();
    makeDue(); await run();

    expect(track(lead)).toMatchObject({ state: "skipped", error_message: GAVE_UP });
    expect(target(lead).invite_withdrawn_at).not.toBeNull();
    expect(withdrawnLogs(c.runId)).toEqual([]); // this run withdrew nothing, so the cap is not spent
  });

  it("records nothing when LinkedIn reports a withdrawal that did not take effect, and stops for the day", async () => {
    // Seen live: LinkedIn answered "withdrawn" and went on showing the invitation as
    // pending — and did the same for the next one tried.
    const c = campaign([{ type: "connect" }]);
    const first = c.enrol({ requestedAt: daysAgo(40) });
    const second = c.enrol({ requestedAt: daysAgo(35) });
    withdraw.mockRejectedValueOnce(new WithdrawUnconfirmedError('LinkedIn reported the withdrawal ("Invitation to Lead withdrawn.") but the profile still shows the invitation as pending'));

    await run();

    expect(withdraw).toHaveBeenCalledTimes(1); // the second was not sent after it
    expect(target(first).invite_withdrawn_at).toBeNull();
    expect(track(first)).toMatchObject({ state: "in_progress", attempts: 1, error_message: null });
    expect(db().prepare("SELECT source, outcome FROM linkedin_withdrawals WHERE target_id = ?").all(first)).toEqual([{ source: "campaign", outcome: "unconfirmed" }]);
    expect(withdrawnLogs(c.runId)).toEqual([]);
    expect(logs(c.runId).some((l) => l.level === "warn" && /checking again tomorrow/.test(l.message))).toBe(true);
    for (const lead of [first, second]) {
      expect(track(lead).state).toBe("in_progress");
      expect(minutesFromNow(track(lead).next_step_at)).toBeGreaterThan(0);
    }

    // Still today: nothing more is attempted, however due the tracks are.
    makeDue();
    await run();
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(logs(c.runId).some((l) => /LinkedIn is not applying invitation withdrawals today/.test(l.message))).toBe(true);

    // Tomorrow the hold is over; the first reads as withdrawn after all, the second goes through.
    db().prepare("UPDATE linkedin_withdrawals SET created_at = datetime('now', '-1 day') WHERE account_id = ?").run(c.accountId);
    withdraw.mockRejectedValueOnce(new NoPendingInviteError(true));
    makeDue();
    await run();
    expect(withdraw).toHaveBeenCalledTimes(3);
    for (const lead of [first, second]) {
      expect(track(lead)).toMatchObject({ state: "skipped", error_message: GAVE_UP });
      expect(target(lead).invite_withdrawn_at).not.toBeNull();
    }
  });

  it("holds the account's LinkedIn steps when the session expires on the way", async () => {
    const c = campaign([{ type: "connect" }]);
    const first = c.enrol({ requestedAt: daysAgo(31) });
    const second = c.enrol({ requestedAt: daysAgo(31) });
    withdraw.mockRejectedValueOnce(new SessionExpiredError("LinkedIn redirected to https://www.linkedin.com/login/"));

    await run();

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(authenticated(c.accountId)).toBe(0);
    for (const lead of [first, second]) {
      expect(track(lead)).toMatchObject({ state: "in_progress", error_message: null, attempts: 0 });
      expect(target(lead).invite_withdrawn_at).toBeNull();
    }
  });

  describe("and a later campaign that reaches the same contact", () => {
    it("does not invite again inside LinkedIn's three-week block — and needs no browser to know", async () => {
      const c = campaign([{ type: "connect" }], { authenticated: false, workingDays: notToday() });
      const lead = c.enrol({ requestedAt: daysAgo(36), withdrawnAt: daysAgo(5) });

      await run();

      expect(connect).not.toHaveBeenCalled();
      expect(withdraw).not.toHaveBeenCalled();
      expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0 });
      const days = minutesFromNow(track(lead).next_step_at) / 1440;
      expect(days).toBeGreaterThan(15.9); // 21 days from the withdrawal
      expect(days).toBeLessThan(16.1);
      expect(logs(c.runId).filter((l) => /LinkedIn will not take another yet/.test(l.message))).toHaveLength(1);
    });

    it("invites again once the block has passed, as a new request", async () => {
      const c = campaign([{ type: "connect" }]);
      const lead = c.enrol({ requestedAt: daysAgo(55), withdrawnAt: daysAgo(22) });

      await run();

      expect(connect).toHaveBeenCalledTimes(1);
      expect(withdraw).not.toHaveBeenCalled();
      expect(target(lead).invite_withdrawn_at).toBeNull();
      expect(minutesFromNow(target(lead).connection_requested_at)).toBeGreaterThan(-1);
      expect(track(lead).state).toBe("in_progress"); // now waiting on the new request
    });

    it("waits, rather than writing the contact off, when LinkedIn shows a withdrawal this app has no record of", async () => {
      // Withdrawn by hand: the profile offers no Connect, which used to read as "cannot be
      // invited" and skip the contact for good.
      const c = campaign([{ type: "connect" }]);
      const lead = c.enrol();
      connect.mockRejectedValue(new InviteBlockedError("An invitation to this member was withdrawn recently — LinkedIn is not taking a new one yet"));

      await run();

      expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0, error_message: null, attempts: 0 });
      expect(target(lead).invite_withdrawn_at).not.toBeNull();
      expect(target(lead).connection_requested_at).toBeNull();
      const days = minutesFromNow(track(lead).next_step_at) / 1440;
      expect(days).toBeGreaterThan(20.9);
      expect(days).toBeLessThan(21.1);

      // Not asked again in the meantime, even when the track is made due.
      makeDue();
      await run();
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("takes LinkedIn's word when it shows an invitation out after all", async () => {
      const c = campaign([{ type: "connect" }]);
      const lead = c.enrol({ requestedAt: daysAgo(55), withdrawnAt: daysAgo(22) });
      connect.mockRejectedValue(new PendingInviteError("Invitation already pending"));

      await run();

      expect(target(lead).invite_withdrawn_at).toBeNull();
      expect(minutesFromNow(target(lead).connection_requested_at)).toBeGreaterThan(-1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("message step", () => {
  const messaging = () => campaign([{ type: "message", body: "Thanks for connecting, {{first_name}}." }]);

  it("addresses the message by profile URL, not by name", async () => {
    const c = messaging();
    const lead = c.enrol({ degree: 1, url: "https://linkedin.com/in/the-lead" });

    await run();

    expect(message).toHaveBeenCalledWith(expect.anything(), "https://linkedin.com/in/the-lead", "Thanks for connecting, Lead.");
    expect(target(lead).message_sent_at).not.toBeNull();
    expect(track(lead).state).toBe("completed");
    expect(logs(c.runId).some((l) => /^Message sent to Lead/.test(l.message))).toBe(true);
  });

  it("corrects the record and skips when LinkedIn says they are not a connection", async () => {
    // The 101 contacts the old manual sync wrongly marked as connected land here.
    const c = messaging();
    const lead = c.enrol({ degree: 1, requestedAt: daysAgo(40) });
    db().prepare("UPDATE targets SET connected_at = ? WHERE id = ?").run("2026-08-09T21:24:07.000Z", lead);
    message.mockRejectedValue(new NotConnectedError("connectable", 2));

    await run();

    expect(target(lead)).toMatchObject({ degree: 2, connected_at: null });
    expect(track(lead)).toMatchObject({ state: "skipped", error_message: "Not connected on LinkedIn" });
  });

  it("keeps waiting when the invitation is still pending", async () => {
    const c = messaging();
    const lead = c.enrol({ degree: 1, requestedAt: daysAgo(3) });
    message.mockRejectedValue(new NotConnectedError("pending", 2));

    await run();

    expect(target(lead)).toMatchObject({ degree: 2, connected_at: null });
    expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0 });
    expect(minutesFromNow(track(lead).next_step_at)).toBeGreaterThan(5 * 60);
  });

  it("stops every track for a contact who has replied, and records the reply", async () => {
    const c = campaign([{ type: "message", body: "Following up" }, { type: "delay", track: "email" }]);
    const lead = c.enrol({ degree: 1 });
    // The email track is not due yet, so only the reply can be what stops it.
    db().prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE track = 'email' AND run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)")
      .run(new Date(Date.now() + 86_400_000).toISOString(), lead);
    message.mockRejectedValue(new RecipientRepliedError("Sure, send me details"));

    await run();

    expect(target(lead).last_replied_at).not.toBeNull();
    expect(target(lead).message_sent_at).toBeNull();
    expect(track(lead, "linkedin")).toMatchObject({ state: "skipped", error_message: "Lead replied" });
    expect(track(lead, "email")).toMatchObject({ state: "skipped", error_message: "Lead replied" });
    const events = db().prepare("SELECT payload_json FROM domain_events WHERE type = 'reply.received' AND entity_id = ?").all(lead) as Array<{ payload_json: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload_json)).toMatchObject({ channel: "linkedin", source: "conversation_check" });
  });

  it("fails an unconfirmed send outright instead of retrying it", async () => {
    const c = messaging();
    const lead = c.enrol({ degree: 1 });
    message.mockRejectedValue(new MessageUnconfirmedError("Send was pressed but LinkedIn did not show the message"));

    await run();

    expect(track(lead)).toMatchObject({ state: "failed", attempts: 0 });
    expect(message).toHaveBeenCalledTimes(1);
  });

  it("moves on without counting a second send when the message was already delivered", async () => {
    const c = messaging();
    const lead = c.enrol({ degree: 1 });
    message.mockResolvedValue("already-sent");

    await run();

    expect(track(lead).state).toBe("completed");
    expect(logs(c.runId).some((l) => /^Message sent/.test(l.message))).toBe(false); // the daily cap counts that prefix
    expect(db().prepare("SELECT COUNT(*) AS c FROM domain_events WHERE type = 'linkedin.message_sent' AND entity_id = ?").get(lead)).toEqual({ c: 0 });
  });

  it("does not open the browser for a contact the database knows is not connected", async () => {
    const c = messaging();
    const lead = c.enrol({ degree: 2, requestedAt: daysAgo(1) });
    await run();
    expect(message).not.toHaveBeenCalled();
    expect(track(lead).state).toBe("in_progress");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("visit step", () => {
  it("visits inside working hours", async () => {
    const c = campaign([{ type: "visit" }]);
    const lead = c.enrol();
    await run();
    expect(visit).toHaveBeenCalledTimes(1);
    expect(track(lead).state).toBe("completed");
  });

  it("waits for working hours like every other LinkedIn action", async () => {
    const notToday = String(((new Date().getUTCDay() + 6) % 7 + 1) % 7 + 1);
    const c = campaign([{ type: "visit" }], { workingDays: notToday });
    const lead = c.enrol();

    await run();

    expect(visit).not.toHaveBeenCalled();
    expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0 });
    expect(Date.parse(track(lead).next_step_at!)).toBeGreaterThan(Date.now());
  });
});
