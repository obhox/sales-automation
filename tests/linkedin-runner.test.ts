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
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({
  shouldSyncAccepted: vi.fn(() => false),
  syncAcceptedConnections: vi.fn(),
}));

import { tick } from "@/lib/linkedin/runner";
import { ConnectUnavailableError, PendingInviteError, sendConnectionRequest } from "@/lib/linkedin/connect";
import { MessageUnconfirmedError, NotConnectedError, RecipientRepliedError, sendMessage } from "@/lib/linkedin/message";
import { visitProfile } from "@/lib/linkedin/visit";
import { SessionExpiredError } from "@/lib/linkedin/navigation";
import { shouldSyncAccepted, syncAcceptedConnections } from "@/lib/linkedin/sync-accepted";

const connect = vi.mocked(sendConnectionRequest);
const message = vi.mocked(sendMessage);
const visit = vi.mocked(visitProfile);

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
  const enrol = (fields: { url?: string; degree?: number | null; requestedAt?: string | null; at?: Partial<Record<"linkedin" | "email", number>> } = {}) => {
    const k = ++seq;
    const targetId = `runner-target-${k}`;
    db.prepare(
      "INSERT INTO targets (id, workspace_id, full_name, first_name, linkedin_url, degree, connection_requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(targetId, ws, `Lead ${k}`, "Lead", fields.url ?? `https://www.linkedin.com/in/lead-${k}/`, fields.degree ?? null, fields.requestedAt ?? null);
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
  db().prepare("SELECT degree, connected_at, connection_requested_at, message_sent_at, last_replied_at FROM targets WHERE id = ?").get(id) as
    { degree: number | null; connected_at: string | null; connection_requested_at: string | null; message_sent_at: string | null; last_replied_at: string | null };
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
    expect(errors[0].message).toMatch(/session has expired — re-authenticate/);
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
