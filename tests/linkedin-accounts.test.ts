// What governs one LinkedIn account: how its day's activity is counted, its weekly
// invitation limit, pausing, warm-up, and its own wait and withdrawal numbers. Real
// (throwaway) database; every browser-facing function is stubbed.
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
import { WeeklyLimitError, sendConnectionRequest } from "@/lib/linkedin/connect";
import { sendMessage } from "@/lib/linkedin/message";
import { withdrawInvitation } from "@/lib/linkedin/withdraw";
import { visitProfile } from "@/lib/linkedin/visit";
import { accountUsage } from "@/lib/linkedin/usage";
import { effectiveConnectionLimit, inviteWaitDays, rampState, weeklyHold, weeklyNear, withdrawLimit } from "@/lib/linkedin/account-policy";
import { CONNECTION_MAX_WAIT_DAYS, DAILY_WITHDRAW_LIMIT } from "@/lib/linkedin/limits";
import { staleInviteStats } from "@/lib/linkedin/withdrawals";
import { listNotifications } from "@/lib/platform/notifications";
import { localDayBoundsUtc } from "@/lib/outreach/schedule";

const connect = vi.mocked(sendConnectionRequest);
const message = vi.mocked(sendMessage);
const visit = vi.mocked(visitProfile);
const withdraw = vi.mocked(withdrawInvitation);

type StepSpec = { type: "visit" | "connect" | "message" | "delay"; track?: "linkedin" | "email" };
const db = () => getDb();
let seq = 0;

/** A running campaign on one signed-in LinkedIn account that is inside its working hours all day, every day. */
function campaign(steps: StepSpec[], account: Record<string, unknown> = {}) {
  const n = ++seq;
  const ws = `ws-li-${n}`;
  const accountId = `li-acct-${n}`;
  const workflowId = `li-wf-${n}`;
  const runId = `li-run-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare(
    `INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
     VALUES (?, ?, ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`,
  ).run(accountId, `Account ${n}`, `li${n}@example.test`, ws);
  for (const [column, value] of Object.entries(account)) db().prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(value, accountId);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, ?, ?)").run(workflowId, `Campaign ${n}`, ws);
  const order: Record<string, number> = {};
  for (const step of steps) {
    const track = step.track ?? "linkedin";
    order[track] = (order[track] ?? 0) + 1;
    db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, message_body) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .run(`li-step-${n}-${track}-${order[track]}`, workflowId, order[track], track, step.type, step.type === "message" ? "Hello {{first_name}}" : null);
  }
  db().prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, 'running', ?)").run(runId, workflowId, accountId, ws);

  const enrol = (fields: { degree?: number | null; requestedAt?: string | null; at?: number } = {}) => {
    const k = ++seq;
    const targetId = `li-target-${k}`;
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, first_name, linkedin_url, degree, connection_requested_at) VALUES (?, ?, ?, 'Lead', ?, ?, ?)")
      .run(targetId, ws, `Lead ${k}`, `https://www.linkedin.com/in/li-lead-${k}/`, fields.degree ?? null, fields.requestedAt ?? null);
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`li-rp-${k}`, runId, targetId);
    for (const track of Object.keys(order)) {
      db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, ?, 'in_progress', ?)")
        .run(`li-rt-${k}-${track}`, `li-rp-${k}`, track, track === "linkedin" ? fields.at ?? 0 : 0);
    }
    return targetId;
  };
  /** Record an invitation as already sent from this account, `hoursAgo` hours back. */
  const pastConnect = (hoursAgo: number) =>
    db().prepare("INSERT INTO step_sends (id, workspace_id, run_id, workflow_id, channel, action, account_id, sent_at) VALUES (?, ?, ?, ?, 'linkedin', 'connect', ?, datetime('now', ?))")
      .run(`li-send-${++seq}`, ws, runId, workflowId, accountId, `-${hoursAgo} hours`);
  return { ws, accountId, runId, workflowId, enrol, pastConnect };
}

const track = (targetId: string, which: "linkedin" | "email" = "linkedin") =>
  db().prepare(
    `SELECT rt.state, rt.current_step, rt.next_step_at, rt.error_message FROM run_profile_tracks rt
     JOIN run_profiles rp ON rp.id = rt.run_profile_id WHERE rp.target_id = ? AND rt.track = ?`,
  ).get(targetId, which) as { state: string; current_step: number; next_step_at: string | null; error_message: string | null };
const account = (id: string) => db().prepare("SELECT weekly_limit_hit_at, paused_at FROM accounts WHERE id = ?").get(id) as { weekly_limit_hit_at: string | null; paused_at: string | null };
const runStatus = (id: string) => (db().prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string }).status;
const logLines = (runId: string) => (db().prepare("SELECT message FROM logs WHERE run_id = ? ORDER BY rowid").all(runId) as { message: string }[]).map(row => row.message);
const hoursFromNow = (iso: string | null) => (Date.parse(iso!) - Date.now()) / 3_600_000;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status = 'running'").run();
  vi.clearAllMocks();
  connect.mockResolvedValue({ noteSent: false, noteSkipped: null });
  message.mockResolvedValue("sent");
  withdraw.mockResolvedValue(undefined);
});

const run = () => tick(getDb(), { pace: false });

// ─────────────────────────────────────────────────────────────────────
describe("counting what an account has done today", () => {
  /** The count the runner used before: text matches in the log, through the account's runs. */
  const fromLog = (accountId: string, pattern: string) => {
    const day = localDayBoundsUtc("UTC");
    return (db().prepare(
      `SELECT COUNT(*) AS c FROM logs WHERE run_id IN (SELECT id FROM runs WHERE account_id = ?) AND message LIKE ? AND created_at >= ? AND created_at < ?`,
    ).get(accountId, pattern, day.start, day.end) as { c: number }).c;
  };

  it("agrees with the log-based count it replaces, for every kind of action", async () => {
    const c = campaign([{ type: "visit" }, { type: "connect" }]);
    const messaging = campaign([{ type: "message" }]);
    db().prepare("UPDATE runs SET account_id = ? WHERE id = ?").run(c.accountId, messaging.runId);
    for (let i = 0; i < 3; i++) c.enrol();
    c.enrol({ at: 1 });
    messaging.enrol({ degree: 1 });
    messaging.enrol({ degree: 1 });

    await run();

    const usage = accountUsage(db(), c.accountId, "UTC");
    expect(usage).toMatchObject({ visits: 3, connects: 1, messages: 2, inmails: 0 });
    expect(usage.visits).toBe(fromLog(c.accountId, "Visited %"));
    expect(usage.connects).toBe(fromLog(c.accountId, "Connection request sent%"));
    expect(usage.messages).toBe(fromLog(c.accountId, "Message sent%"));
    expect(visit).toHaveBeenCalledTimes(3);
  });

  it("keeps the count when the campaign that did the work is deleted", async () => {
    const c = campaign([{ type: "connect" }]);
    c.enrol();
    await run();
    expect(accountUsage(db(), c.accountId, "UTC").connects).toBe(1);

    // The log lines go with the run; the old count went back to zero here and the
    // account could send a second day's worth.
    db().prepare("DELETE FROM runs WHERE id = ?").run(c.runId);
    expect(fromLog(c.accountId, "Connection request sent%")).toBe(0);
    expect(accountUsage(db(), c.accountId, "UTC").connects).toBe(1);
  });

  it("uses the account's own calendar day, and seven days for the week", () => {
    const c = campaign([{ type: "connect" }]);
    c.pastConnect(0);
    c.pastConnect(30); // yesterday or the day before
    c.pastConnect(24 * 6);
    c.pastConnect(24 * 8); // outside the week
    const usage = accountUsage(db(), c.accountId, "UTC");
    expect(usage.connects).toBe(1);
    expect(usage.connects_7d).toBe(3);

    // 23:30 in Los Angeles is already tomorrow in UTC: the same instant falls on
    // different days for the two accounts.
    const at = new Date("2026-10-10T06:30:00Z"); // 23:30 on the 9th in Los Angeles
    db().prepare("INSERT INTO step_sends (id, workspace_id, channel, action, account_id, sent_at) VALUES (?, ?, 'linkedin', 'visit', ?, '2026-10-10 06:00:00')").run(`li-send-${++seq}`, c.ws, c.accountId);
    expect(accountUsage(db(), c.accountId, "America/Los_Angeles", at).visits).toBe(1);
    expect(accountUsage(db(), c.accountId, "UTC", new Date("2026-10-09T23:00:00Z")).visits).toBe(0);
  });

  it("counts a reply sent by hand from the inbox against the day's messages", () => {
    const c = campaign([{ type: "message" }]);
    db().prepare("INSERT INTO linkedin_messages (id, workspace_id, account_id, direction, body, sent_at, status, created_by) VALUES (?, ?, ?, 'out', 'Hi', ?, 'delivered', 'someone')")
      .run(`li-msg-${++seq}`, c.ws, c.accountId, new Date().toISOString());
    expect(accountUsage(db(), c.accountId, "UTC").messages).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the weekly invitation limit", () => {
  it("is off unless the account has one, and near when nine tenths are used", () => {
    expect(weeklyHold({ daily_connection_limit: 20 }, 500)).toBeNull();
    expect(weeklyHold({ daily_connection_limit: 20, weekly_connection_limit: 100 }, 99)).toBeNull();
    expect(weeklyHold({ daily_connection_limit: 20, weekly_connection_limit: 100 }, 100)).toEqual({ reason: "cap", used: 100, limit: 100 });
    expect(weeklyNear({ daily_connection_limit: 20, weekly_connection_limit: 100 }, 89)).toBe(false);
    expect(weeklyNear({ daily_connection_limit: 20, weekly_connection_limit: 100 }, 92)).toBe(true);
    expect(weeklyNear({ daily_connection_limit: 20, weekly_connection_limit: 100 }, 100)).toBe(false);
    expect(weeklyNear({ daily_connection_limit: 20 }, 92)).toBe(false);
  });

  it("holds new invitations once the account's own cap for seven days is used up, and nothing else", async () => {
    const c = campaign([{ type: "connect" }, { type: "message" }], { weekly_connection_limit: 3 });
    for (const hours of [2, 40, 100]) c.pastConnect(hours);
    const fresh = c.enrol();
    const connected = c.enrol({ degree: 1, at: 1 });

    await run();

    expect(connect).not.toHaveBeenCalled();
    expect(track(fresh)).toMatchObject({ state: "in_progress", current_step: 0, error_message: null });
    expect(hoursFromNow(track(fresh).next_step_at)).toBeGreaterThan(0);
    expect(logLines(c.runId).join("\n")).toMatch(/Weekly invitation limit reached \(3 of 3 in the last 7 days\)/);
    // People already connected still get their message, and the campaign keeps running.
    expect(message).toHaveBeenCalledTimes(1);
    expect(track(connected).state).toBe("completed");
    expect(runStatus(c.runId)).toBe("running");
  });

  it("lets invitations through again when the oldest ones fall out of the seven days", async () => {
    const c = campaign([{ type: "connect" }], { weekly_connection_limit: 3 });
    c.pastConnect(40);
    c.pastConnect(100);
    c.pastConnect(24 * 8);
    c.enrol();
    await run();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("when LinkedIn reports it, holds the account's invitations and leaves the campaign running", async () => {
    // This used to pause the whole campaign: its email, its messages to people already
    // connected, and everyone assigned to another account stopped with it.
    const c = campaign([{ type: "connect" }, { type: "delay", track: "email" }, { type: "delay", track: "email" }]);
    const first = c.enrol();
    const second = c.enrol();
    connect.mockRejectedValueOnce(new WeeklyLimitError("weekly limit"));

    await run();

    expect(runStatus(c.runId)).toBe("running");
    expect(account(c.accountId).weekly_limit_hit_at).not.toBeNull();
    // The first contact is moved to tomorrow, not failed; the second is not sent at LinkedIn at all.
    expect(connect).toHaveBeenCalledTimes(1);
    for (const lead of [first, second]) {
      expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0, error_message: null });
      expect(hoursFromNow(track(lead).next_step_at)).toBeGreaterThan(0);
    }
    // Email is untouched.
    expect(track(first, "email").current_step).toBe(1);

    // And the workspace is told, once.
    await run();
    const told = listNotifications(c.ws, "nobody", "member").filter(row => row.kind === "linkedin.weekly_limit");
    expect(told).toHaveLength(1);
    expect(told[0].title).toBe(`Weekly invitation limit reached on Account ${c.accountId.split("-").pop()}`);
  });

  it("keeps holding for a day, then tries one invitation, and lifts the hold when it goes through", async () => {
    const c = campaign([{ type: "connect" }], { weekly_limit_hit_at: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    const lead = c.enrol();
    await run();
    expect(connect).not.toHaveBeenCalled();
    expect(logLines(c.runId).join("\n")).toMatch(/LinkedIn's weekly invitation limit was reached on this account/);

    db().prepare("UPDATE accounts SET weekly_limit_hit_at = ? WHERE id = ?").run(new Date(Date.now() - 25 * 3_600_000).toISOString(), c.accountId);
    db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)").run(lead);
    await run();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(account(c.accountId).weekly_limit_hit_at).toBeNull();
  });

  it("holds again if the invitation tried after the hold is refused too", async () => {
    const c = campaign([{ type: "connect" }], { weekly_limit_hit_at: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    c.enrol();
    connect.mockRejectedValueOnce(new WeeklyLimitError("still limited"));
    await run();
    const hit = Date.parse(account(c.accountId).weekly_limit_hit_at!);
    expect(Date.now() - hit).toBeLessThan(60_000);
    expect(runStatus(c.runId)).toBe("running");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a paused account", () => {
  it("does nothing on LinkedIn, fails nobody, and lets email carry on", async () => {
    const c = campaign([{ type: "visit" }, { type: "connect" }, { type: "delay", track: "email" }, { type: "delay", track: "email" }], { paused_at: new Date().toISOString() });
    const lead = c.enrol();

    await run();

    expect(visit).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0, error_message: null, next_step_at: null });
    expect(track(lead, "email").current_step).toBe(1);
    expect(runStatus(c.runId)).toBe("running");
  });

  it("starts nobody new", async () => {
    const c = campaign([{ type: "connect" }], { paused_at: new Date().toISOString() });
    const lead = c.enrol();
    db().prepare("UPDATE run_profile_tracks SET state = 'pending' WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)").run(lead);
    await run();
    expect(track(lead).state).toBe("pending");
  });

  it("picks up where it stopped on the first pass after it is resumed", async () => {
    const c = campaign([{ type: "visit" }], { paused_at: new Date().toISOString() });
    const lead = c.enrol();
    await run();
    expect(visit).not.toHaveBeenCalled();

    db().prepare("UPDATE accounts SET paused_at = NULL WHERE id = ?").run(c.accountId);
    await run();
    expect(visit).toHaveBeenCalledTimes(1);
    expect(track(lead).state).toBe("completed");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("warming an account up", () => {
  const today = new Date().toISOString().slice(0, 10);
  const daysBack = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it("rises in a straight line from the starting number to the full limit", () => {
    const row = (start: string) => ({ daily_connection_limit: 60, ramp_start_date: start, ramp_days: 14, ramp_start_limit: 20 });
    expect(rampState(row(today))).toEqual({ day: 1, days: 14, limit: 20 });
    expect(rampState(row(daysBack(5)))).toMatchObject({ day: 6, limit: 35 });
    expect(rampState(row(daysBack(12)))).toMatchObject({ day: 13, limit: 57 });
    // On the last day, and ever after, the account is at its full limit.
    expect(rampState(row(daysBack(13)))).toBeNull();
    expect(effectiveConnectionLimit(row(daysBack(13)))).toBe(60);
    expect(effectiveConnectionLimit(row(daysBack(400)))).toBe(60);
    expect(effectiveConnectionLimit(row(daysBack(5)))).toBe(35);
  });

  it("is off without a start date or a length, and never exceeds the full limit", () => {
    expect(rampState({ daily_connection_limit: 60 })).toBeNull();
    expect(rampState({ daily_connection_limit: 60, ramp_start_date: today })).toBeNull();
    expect(rampState({ daily_connection_limit: 60, ramp_start_date: "garbage", ramp_days: 14 })).toBeNull();
    // A start in the future has not begun.
    expect(rampState({ daily_connection_limit: 60, ramp_start_date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), ramp_days: 14 })).toBeNull();
    expect(effectiveConnectionLimit({ daily_connection_limit: 10, ramp_start_date: today, ramp_days: 14, ramp_start_limit: 50 })).toBe(10);
    expect(effectiveConnectionLimit({ daily_connection_limit: null })).toBe(20);
  });

  it("limits a day's invitations to the warm-up number, not the full limit", async () => {
    const c = campaign([{ type: "connect" }], { daily_connection_limit: 60, ramp_start_date: today, ramp_days: 14, ramp_start_limit: 2 });
    const leads = [c.enrol(), c.enrol(), c.enrol()];

    await run();

    expect(connect).toHaveBeenCalledTimes(2);
    const waiting = leads.filter(lead => hoursFromNow(track(lead).next_step_at) > 12);
    expect(waiting.length).toBeGreaterThanOrEqual(1);
    expect(logLines(c.runId).join("\n")).toMatch(/Daily LinkedIn connections limit reached/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("an account's own wait and withdrawal numbers", () => {
  it("fall back to the instance's when the account has none", () => {
    expect(inviteWaitDays({})).toBe(CONNECTION_MAX_WAIT_DAYS);
    expect(inviteWaitDays({ invite_max_wait_days: 14 })).toBe(14);
    expect(inviteWaitDays({ invite_max_wait_days: 0 })).toBe(CONNECTION_MAX_WAIT_DAYS);
    expect(withdrawLimit({})).toBe(DAILY_WITHDRAW_LIMIT);
    expect(withdrawLimit({ daily_withdraw_limit: 25 })).toBe(25);
  });

  it("take back an invitation after the account's wait, not the instance's", async () => {
    const quick = campaign([{ type: "connect" }], { invite_max_wait_days: 14 });
    const lead = quick.enrol({ requestedAt: daysAgo(15) });
    await run();
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(track(lead)).toMatchObject({ state: "skipped", error_message: "Did not accept connection after 14 days" });

    vi.clearAllMocks();
    withdraw.mockResolvedValue(undefined);
    db().prepare("UPDATE runs SET status = 'completed' WHERE status = 'running'").run();
    const patient = campaign([{ type: "connect" }]);
    const waiting = patient.enrol({ requestedAt: daysAgo(15) });
    await run();
    expect(withdraw).not.toHaveBeenCalled();
    expect(track(waiting).state).toBe("in_progress");
  });

  it("withdraw up to the account's own number in a day", async () => {
    const c = campaign([{ type: "connect" }], { daily_withdraw_limit: 1 });
    const leads = [c.enrol({ requestedAt: daysAgo(40) }), c.enrol({ requestedAt: daysAgo(41) })];
    await run();
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(leads.map(lead => track(lead).state).sort()).toEqual(["in_progress", "skipped"]);
  });

  it("are what the stale-invitation figures report", () => {
    const c = campaign([{ type: "connect" }], { invite_max_wait_days: 21, daily_withdraw_limit: 25 });
    expect(staleInviteStats(db(), c.accountId, "UTC")).toMatchObject({ after_days: 21, daily_limit: 25 });
    const plain = campaign([{ type: "connect" }]);
    expect(staleInviteStats(db(), plain.accountId, "UTC")).toMatchObject({ after_days: CONNECTION_MAX_WAIT_DAYS, daily_limit: DAILY_WITHDRAW_LIMIT });
  });
});
