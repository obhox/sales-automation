// What the runner does with a published sequence: it does not repeat a step for a contact
// after a reorder, it settles gates with their outcomes, it starts the email track on a
// hand-over, it holds a track that is switched off, and it keeps a step inside its own
// window. Real (throwaway) database; the browser and the SMTP send are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

const smtp = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, to: string, _subject: string, _body: string, options: { messageId: string }) => { smtp.sent.push(to); return { messageId: options.messageId }; },
}));
vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async () => {}),
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
vi.mock("@/lib/linkedin/sync-accepted", () => ({ shouldSyncAccepted: vi.fn(() => false), syncAcceptedConnections: vi.fn() }));

import { tick } from "@/lib/linkedin/runner";
import { sendConnectionRequest } from "@/lib/linkedin/connect";
import { sendMessage } from "@/lib/linkedin/message";
import { withdrawInvitation } from "@/lib/linkedin/withdraw";
import { visitProfile } from "@/lib/linkedin/visit";
import { seededWeightedPick, withStepWindow } from "@/lib/outreach/gates";
import { seededPick } from "@/lib/outreach/seed";
import { campaignBreakdown } from "@/lib/reporting/breakdown";
import { lastDays } from "@/lib/reporting/range";
import { publishDraft, publishSequence, type GateInput, type SequenceSettings, type StepInput } from "@/lib/outreach/publish";
import runsHandler from "@/pages/api/runs";
import { ctxHeaders } from "./helpers/ctx";

const connect = vi.mocked(sendConnectionRequest);
const message = vi.mocked(sendMessage);
const visit = vi.mocked(visitProfile);
const withdraw = vi.mocked(withdrawInvitation);
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

interface Draft { steps: StepInput[]; gates?: GateInput[]; settings?: Partial<SequenceSettings> }

/** A workspace with a LinkedIn account and a mailbox (both awake all day, every day), a list, and a campaign with this sequence published. */
function campaign(draft: Draft, account: Record<string, unknown> = {}) {
  const n = ++seq;
  const ws = `ws-eng-${n}`;
  const c = { ws, workflow: `eng-wf-${n}`, list: `eng-list-${n}`, account: `eng-li-${n}`, mailbox: `eng-mail-${n}`, headers: {} as Record<string, string>, steps: {} as Record<string, string> };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, 'LinkedIn', ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(c.account, `eng${n}@example.test`, ws);
  for (const [column, value] of Object.entries(account)) db().prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(value, c.account);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, ?, 'Sender', ?, 'smtp.test.com', 'user', 'pass', 1, 50, 0, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(c.mailbox, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(c.workflow, ws);
  db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'List')").run(c.list, ws);
  const published = publishDraft(db(), ws, c.workflow, { steps: draft.steps, gates: draft.gates ?? [], settings: draft.settings });
  for (const step of published.steps) if (step.key) c.steps[step.key] = step.id;
  c.headers = ctxHeaders(ws, { userId: `eng-user-${n}`, role: "manager" });
  return c;
}
type Campaign = ReturnType<typeof campaign>;

function contact(c: Campaign, fields: Record<string, unknown> = {}) {
  const k = ++seq;
  const id = `eng-target-${k}`;
  db().prepare(`INSERT INTO targets (id, workspace_id, full_name, first_name, email, email_status, email_verified_at, linkedin_url) VALUES (?, ?, ?, 'Lee', ?, 'verified', datetime('now'), ?)`)
    .run(id, c.ws, `Lee Lead ${k}`, `lead${k}@prospect.test`, `https://www.linkedin.com/in/eng-lead-${k}/`);
  for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE targets SET ${column} = ? WHERE id = ?`).run(value, id);
  db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(c.list, id);
  return id;
}

/** Start a run over the list through the API and set it running, with every track that is free to start due now. */
async function start(c: Campaign) {
  const res = await call(runsHandler, { method: "POST", body: { workflow_id: c.workflow, list_id: c.list, account_id: c.account, email_account_ids: [c.mailbox] }, headers: c.headers });
  expect(res.statusCode).toBe(201);
  const runId = String(res.body.id);
  db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
  db().prepare("UPDATE run_profile_tracks SET state = 'in_progress' WHERE hold IS NULL AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)").run(runId);
  return runId;
}

type TrackRow = { state: string; current_step: number; next_step_at: string | null; error_message: string | null; hold: string | null };
const track = (targetId: string, which: "linkedin" | "email" = "linkedin") =>
  db().prepare(`SELECT rt.state, rt.current_step, rt.next_step_at, rt.error_message, rt.hold FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id WHERE rp.target_id = ? AND rt.track = ?`)
    .get(targetId, which) as TrackRow;
const outcomes = (runId: string) =>
  db().prepare("SELECT target_id, kind, side, outcome FROM step_outcomes WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as Array<{ target_id: string; kind: string; side: string; outcome: string }>;
const runStatus = (id: string) => (db().prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string }).status;
const logLines = (runId: string) => (db().prepare("SELECT message FROM logs WHERE run_id = ? ORDER BY rowid").all(runId) as { message: string }[]).map((row) => row.message);
/** Make everything that is in progress due now (a pass that starts a track gives it a time later today). */
const dueNow = (runId: string) => db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL WHERE state = 'in_progress' AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)").run(runId);
const run = () => tick(getDb(), { pace: false });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status IN ('running', 'pending', 'paused')").run();
  vi.clearAllMocks();
  smtp.sent.length = 0;
  visit.mockReset();
  visit.mockResolvedValue(undefined);
  connect.mockReset();
  connect.mockResolvedValue({ noteSent: false, noteSkipped: null });
  message.mockReset();
  message.mockResolvedValue("sent");
  withdraw.mockReset();
  withdraw.mockResolvedValue(undefined);
});

const li = (step_type: StepInput["step_type"], key: string, extra: Partial<StepInput> = {}): StepInput => ({ step_type, key, ...(step_type === "message" ? { message_body: `Hello from ${key}` } : {}), ...extra });
const mail = (key: string, extra: Partial<StepInput> = {}): StepInput => ({ step_type: "email", key, email_subject: `Subject ${key}`, email_body: "Hello", ...extra });

// ─────────────────────────────────────────────────────────────────────
describe("reordering a sequence while contacts are part-way through", () => {
  it("does not do a step again for a contact who has had it", async () => {
    const c = campaign({ steps: [li("visit", "look"), li("message", "hello"), li("message", "nudge")] });
    const lead = contact(c, { degree: 1 });
    const runId = await start(c);
    await run(); // look
    await run(); // hello
    expect(visit).toHaveBeenCalledTimes(1);
    expect(message).toHaveBeenCalledTimes(1);
    expect(track(lead).current_step).toBe(2);

    // The steps the contact has done are moved behind the one they are standing on.
    const result = publishSequence(db(), c.workflow, [
      { ...li("message", "nudge"), id: c.steps.nudge }, { ...li("visit", "look"), id: c.steps.look }, { ...li("message", "hello"), id: c.steps.hello },
    ]);
    expect(result.moved).toBe(1);
    expect(track(lead).current_step).toBe(0);

    await run(); // nudge: not done yet, so it is sent
    await run(); // look: done already
    await run(); // hello: done already
    await run();

    expect(message).toHaveBeenCalledTimes(2);
    expect(visit).toHaveBeenCalledTimes(1);
    expect(track(lead).state).toBe("completed");
    expect(logLines(runId).filter((line) => line.includes("already had this step"))).toHaveLength(2);
    expect(db().prepare("SELECT COUNT(*) AS c FROM step_sends WHERE run_id = ? AND target_id = ?").get(runId, lead)).toEqual({ c: 3 });
  });

  it("still sends a step again to the same contact in a later run of the campaign", async () => {
    const c = campaign({ steps: [li("visit", "look")] });
    contact(c);
    const first = await start(c);
    await run();
    await run();
    expect(runStatus(first)).toBe("completed");
    // A second run is a new start: what the first run did is not held against it.
    db().prepare("DELETE FROM run_profiles WHERE run_id = ?").run(first);
    await start(c);
    await run();
    expect(visit).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a gate on conditions", () => {
  const isVp = { conditions: [{ field: "title", operator: "contains" as const, value: "VP" }] };

  it("ends the track, takes the contact out, or hands them to email, as its outcome says", async () => {
    const c = campaign({
      steps: [li("visit", "look"), li("message", "hello"), mail("intro")],
      gates: [{ source: "look", kind: "conditions", conditions: isVp, on_true: { then: "end_track" }, on_false: { then: "leave" } }],
    });
    const vp = contact(c, { title: "VP Sales", degree: 1 });
    const other = contact(c, { title: "Engineer", degree: 1 });
    const runId = await start(c);
    // Only the LinkedIn track runs in this pass; email is given a moment later.
    db().prepare("UPDATE run_profile_tracks SET next_step_at = datetime('now', '+1 hour') WHERE track = 'email'").run();

    await run();

    expect(visit).toHaveBeenCalledTimes(2);
    // The VP's LinkedIn track ends and their email carries on. The other leaves on every track.
    expect(track(vp)).toMatchObject({ state: "skipped", error_message: "Stopped by a gate on this step" });
    expect(track(vp, "email").state).toBe("in_progress");
    expect(track(other).state).toBe("skipped");
    expect(track(other, "email")).toMatchObject({ state: "skipped", error_message: "Stopped by a gate on this step" });
    expect(message).not.toHaveBeenCalled();
    expect(outcomes(runId)).toEqual([
      { target_id: vp, kind: "conditions", side: "true", outcome: "end_track" },
      { target_id: other, kind: "conditions", side: "false", outcome: "leave" },
    ]);
  });

  it("carries out its effects once: a list, and a task that can name the contact", async () => {
    const c = campaign({ steps: [li("visit", "look"), li("visit", "again")] });
    db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'VPs')").run(`${c.workflow}-vps`, c.ws);
    publishDraft(db(), c.ws, c.workflow, {
      steps: [{ ...li("visit", "look"), id: c.steps.look }, { ...li("visit", "again"), id: c.steps.again }],
      gates: [{ source: c.steps.look, kind: "conditions", conditions: isVp, on_true: { then: "continue", effects: [{ type: "add_to_list", list_id: `${c.workflow}-vps` }, { type: "create_task", title: "Call {{first_name}}", due_in_days: 2 }] } }],
    });
    const vp = contact(c, { title: "VP Sales" });
    const other = contact(c, { title: "Engineer" });
    await start(c);

    await run();
    await run();

    expect(db().prepare("SELECT target_id FROM list_targets WHERE list_id = ?").all(`${c.workflow}-vps`)).toEqual([{ target_id: vp }]);
    const tasks = db().prepare("SELECT target_id, title, due_date FROM todos WHERE workspace_id = ?").all(c.ws) as Array<{ target_id: string; title: string; due_date: string }>;
    expect(tasks).toEqual([{ target_id: vp, title: "Call Lee", due_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) }]);
    expect(track(vp).state).toBe("completed");
    expect(track(other).state).toBe("completed");
  });

  it("still jumps to a step when that is all it was told, and waits out the delay in front of it", async () => {
    const c = campaign({
      steps: [li("visit", "look"), li("message", "skipped"), li("delay", "wait", { delay_seconds: 3600 }), li("message", "landed")],
      gates: [{ source: "look", kind: "conditions", conditions: isVp, on_true: { then: "jump", step: "landed" } }],
    });
    const vp = contact(c, { title: "VP Sales", degree: 1 });
    await start(c);
    await run();
    // On the delay that guards the step it jumps to, due in an hour: not on the step itself.
    const after = track(vp);
    expect(after.current_step).toBe(2);
    expect((Date.parse(after.next_step_at!) - Date.now()) / 60_000).toBeGreaterThan(55);
    expect(message).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a gate on whether the invitation was accepted", () => {
  const sequence = (gates: GateInput[] = []): Draft => ({ steps: [li("connect", "invite"), li("message", "thanks"), mail("intro")], gates });

  it("without one, a contact who never accepts ends the LinkedIn track, as before", async () => {
    const c = campaign(sequence());
    const lead = contact(c, { connection_requested_at: daysAgo(45), degree: 2 });
    const runId = await start(c);
    db().prepare("UPDATE run_profile_tracks SET next_step_at = datetime('now', '+1 hour') WHERE track = 'email'").run();

    await run();

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(track(lead)).toMatchObject({ state: "skipped", error_message: "Did not accept connection after 30 days" });
    expect(track(lead, "email").state).toBe("in_progress");
    expect(outcomes(runId)).toEqual([]);
  });

  it("hands a contact who never accepts over to email, when the campaign's email waits for that", async () => {
    const c = campaign({ ...sequence([{ source: "invite", kind: "connected", on_false: { then: "handover_email" } }]), settings: { email_start: "handover" } });
    const never = contact(c, { connection_requested_at: daysAgo(45), degree: 2 });
    const accepted = contact(c, { degree: 1 });
    const runId = await start(c);
    // Email is there from the start, waiting.
    expect(track(never, "email")).toMatchObject({ state: "pending", hold: "handover" });

    await run();

    expect(track(never)).toMatchObject({ state: "skipped", error_message: "Handed over to email" });
    expect(track(never, "email")).toMatchObject({ state: "pending", hold: null });
    // The one who accepted goes on to the message, and their email goes on waiting.
    expect(track(accepted).current_step).toBe(1);
    expect(track(accepted, "email")).toMatchObject({ state: "pending", hold: "handover" });
    expect(outcomes(runId)).toEqual(expect.arrayContaining([
      { target_id: never, kind: "connected", side: "false", outcome: "handover_email" },
      { target_id: accepted, kind: "connected", side: "true", outcome: "continue" },
    ]));
    expect(smtp.sent).toEqual([]);

    // The next pass starts the handed-over email track; once due, it sends.
    await run();
    expect(track(never, "email").state).toBe("in_progress");
    dueNow(runId);
    await run();
    expect(smtp.sent).toHaveLength(1);

    // The one who accepted finishes LinkedIn without being handed over: their email has
    // nothing left to wait for, and the campaign can finish.
    await run();
    await run();
    expect(track(accepted).state).toBe("completed");
    expect(track(accepted, "email")).toMatchObject({ state: "skipped", error_message: "Not handed over to email", hold: null });
    await run();
    expect(runStatus(runId)).toBe("completed");
  });

  it("leaves email alone at enrolment when the campaign has not asked for a hand-over", async () => {
    const c = campaign(sequence());
    const lead = contact(c, { degree: 1 });
    await start(c);
    expect(track(lead, "email")).toMatchObject({ hold: null });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a gate on a reply, and one on having an address to send to", () => {
  it("counts a contact who replies on its other side, makes the task, and takes them out as always", async () => {
    const c = campaign({
      steps: [li("message", "hello"), li("message", "nudge"), mail("intro")],
      gates: [{ source: "hello", kind: "no_reply", on_false: { then: "leave", effects: [{ type: "create_task", title: "Answer {{first_name}}" }] } }],
    });
    const replied = contact(c, { degree: 1 });
    const quiet = contact(c, { degree: 1 });
    const runId = await start(c);
    db().prepare("UPDATE run_profile_tracks SET next_step_at = datetime('now', '+1 hour') WHERE track = 'email'").run();
    await run(); // hello goes to both
    db().prepare("UPDATE targets SET last_replied_at = datetime('now') WHERE id = ?").run(replied);

    await run();

    expect(track(replied)).toMatchObject({ state: "skipped", error_message: "Lead replied" });
    expect(track(replied, "email")).toMatchObject({ state: "skipped", error_message: "Lead replied" });
    expect(db().prepare("SELECT title FROM todos WHERE target_id = ?").all(replied)).toEqual([{ title: "Answer Lee" }]);
    expect(message).toHaveBeenCalledTimes(3); // hello twice, nudge once
    expect(outcomes(runId)).toEqual(expect.arrayContaining([
      { target_id: quiet, kind: "no_reply", side: "true", outcome: "continue" },
      { target_id: replied, kind: "no_reply", side: "false", outcome: "leave" },
    ]));
  });

  it("without a gate, a contact with no address loses only the email track; with one, what it says happens", async () => {
    const plain = campaign({ steps: [li("visit", "look"), mail("intro")] });
    const noAddress = contact(plain, { email: null });
    await start(plain);
    db().prepare("UPDATE run_profile_tracks SET next_step_at = datetime('now', '+1 hour') WHERE track = 'linkedin'").run();
    await run();
    expect(track(noAddress, "email")).toMatchObject({ state: "skipped", error_message: "No email address found" });
    expect(track(noAddress).state).toBe("in_progress");

    const gated = campaign({ steps: [li("visit", "look"), mail("intro")], gates: [{ source: "intro", kind: "verified_email", on_false: { then: "leave" } }] });
    const invalid = contact(gated, { email_status: "invalid" });
    const good = contact(gated);
    const runId = await start(gated);
    db().prepare("UPDATE run_profile_tracks SET next_step_at = datetime('now', '+1 hour') WHERE track = 'linkedin'").run();
    await run();
    await run();

    expect(track(invalid, "email")).toMatchObject({ state: "skipped", error_message: "Email bounced — invalid address" });
    expect(track(invalid)).toMatchObject({ state: "skipped", error_message: "Email bounced — invalid address" });
    expect(smtp.sent).toHaveLength(1);
    expect(outcomes(runId)).toEqual(expect.arrayContaining([
      { target_id: invalid, kind: "verified_email", side: "false", outcome: "leave" },
      { target_id: good, kind: "verified_email", side: "true", outcome: "continue" },
    ]));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("switching a track off", () => {
  it("holds its contacts where they are, lets the other track carry on, and picks up when switched back on", async () => {
    const c = campaign({ steps: [li("visit", "look"), mail("intro")], settings: { linkedin_track_enabled: false } });
    const lead = contact(c);
    const runId = await start(c);

    await run();
    await run();

    expect(visit).not.toHaveBeenCalled();
    expect(track(lead)).toMatchObject({ state: "in_progress", current_step: 0, error_message: null });
    expect(smtp.sent).toHaveLength(1);
    expect(runStatus(runId)).toBe("running");

    db().prepare("UPDATE workflows SET linkedin_track_enabled = 1 WHERE id = ?").run(c.workflow);
    await run();
    expect(visit).toHaveBeenCalledTimes(1);
    await run();
    expect(runStatus(runId)).toBe("completed");
  });

  it("starts nobody new on it", async () => {
    const c = campaign({ steps: [li("visit", "look"), mail("intro")], settings: { email_track_enabled: false } });
    const lead = contact(c);
    const res = await call(runsHandler, { method: "POST", body: { workflow_id: c.workflow, list_id: c.list, account_id: c.account, email_account_ids: [c.mailbox] }, headers: c.headers });
    db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(res.body.id);
    await run();
    expect(track(lead, "email").state).toBe("pending");
    expect(track(lead).state).toBe("in_progress");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a step's own window", () => {
  const sender = { active_hours_start: 9, active_hours_end: 18, timezone: "UTC", working_days: "1,2,3,4,5" };

  it("narrows the sender's schedule, never widens it, and says when the two do not meet", () => {
    expect(withStepWindow(sender, {})).toBe(sender);
    expect(withStepWindow(sender, { window_start: 10, window_end: 12 })).toMatchObject({ active_hours_start: 10, active_hours_end: 12, working_days: "1,2,3,4,5" });
    expect(withStepWindow(sender, { window_start: 6, window_end: 22 })).toMatchObject({ active_hours_start: 9, active_hours_end: 18 });
    expect(withStepWindow(sender, { window_days: "2,4,6" })).toMatchObject({ active_hours_start: 9, working_days: "2,4" });
    expect(withStepWindow(sender, { window_start: 19, window_end: 22 })).toBeNull();
    expect(withStepWindow(sender, { window_days: "6,7" })).toBeNull();
  });

  it("keeps a step that is due outside its window waiting until the window opens", async () => {
    // A two-hour window that does not include now, whatever the time is.
    const hour = new Date().getUTCHours();
    const [start, end] = hour < 12 ? [20, 22] : [2, 4];
    const c = campaign({ steps: [li("visit", "look", { window_start: start, window_end: end })] });
    const lead = contact(c);
    await start_(c);

    await run();

    expect(visit).not.toHaveBeenCalled();
    const next = new Date(track(lead).next_step_at!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getUTCHours()).toBeGreaterThanOrEqual(start);
    expect(next.getUTCHours()).toBeLessThan(end);
  });

  it("uses the sender's hours, and says so once, when a window can never open", async () => {
    // The account works only today; the step's window names only another day.
    const today = ((new Date().getUTCDay() + 6) % 7) + 1;
    const another = (today % 7) + 1;
    const c = campaign({ steps: [li("visit", "look", { window_days: String(another) })] }, { working_days: String(today) });
    contact(c);
    contact(c);
    const runId = await start_(c);

    await run();

    expect(visit).toHaveBeenCalledTimes(2);
    expect(logLines(runId).filter((line) => line.includes("never overlaps its sender's working hours"))).toHaveLength(1);
  });

  // `start` is shadowed by a window's start hour in the tests above.
  const start_ = (c: Campaign) => start(c);
});

// ─────────────────────────────────────────────────────────────────────
describe("choosing between versions of an email", () => {
  const versions = ["control", "b", "c"] as const;
  const seeds = Array.from({ length: 3000 }, (_, index) => `track-${index}:step-1`);
  const shareOf = (weights: Array<number | null>) => {
    const counts: Record<string, number> = { control: 0, b: 0, c: 0 };
    for (const seed of seeds) counts[seededWeightedPick(seed, versions, weights)] += 1;
    return versions.map((version) => counts[version] / seeds.length);
  };

  it("picks exactly what it always did when no weight is set, or every weight is the same", () => {
    for (const seed of seeds.slice(0, 500)) {
      const before = seededPick(seed, versions);
      expect(seededWeightedPick(seed, versions, [null, null, null])).toBe(before);
      expect(seededWeightedPick(seed, versions, [40, 40, 40])).toBe(before);
      expect(seededWeightedPick(seed, versions, [])).toBe(before);
    }
  });

  it("sends in proportion to the weights, the same version every time for the same contact", () => {
    const [control, b, c] = shareOf([70, 20, 10]);
    expect(control).toBeGreaterThan(0.65); expect(control).toBeLessThan(0.75);
    expect(b).toBeGreaterThan(0.16); expect(b).toBeLessThan(0.24);
    expect(c).toBeGreaterThan(0.07); expect(c).toBeLessThan(0.13);
    expect(seededWeightedPick("same-seed", versions, [70, 20, 10])).toBe(seededWeightedPick("same-seed", versions, [70, 20, 10]));
  });

  it("gives a version with no weight the average of the ones that have one", () => {
    // 60 and 20 are given; the third takes 40: shares of a half, a sixth and a third.
    const [control, b, c] = shareOf([60, 20, null]);
    expect(control).toBeGreaterThan(0.45); expect(control).toBeLessThan(0.55);
    expect(b).toBeGreaterThan(0.13); expect(b).toBeLessThan(0.21);
    expect(c).toBeGreaterThan(0.29); expect(c).toBeLessThan(0.38);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a sequence that opens with a wait", () => {
  it("starts a new contact that long after their slot, not at it", async () => {
    const c = campaign({ steps: [li("visit", "look", { delay_seconds: 3 * 3600 })] });
    const lead = contact(c);
    const res = await call(runsHandler, { method: "POST", body: { workflow_id: c.workflow, list_id: c.list, account_id: c.account, email_account_ids: [c.mailbox] }, headers: c.headers });
    db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(res.body.id);

    await run();

    const started = track(lead);
    expect(started.state).toBe("in_progress");
    expect((Date.parse(started.next_step_at!) - Date.now()) / 3_600_000).toBeGreaterThanOrEqual(2.99);
    expect(visit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("what a step's figures say", () => {
  it("counts the emails of a step that bounced", async () => {
    const c = campaign({ steps: [mail("intro")] });
    contact(c);
    const runId = await start(c);
    await run();
    expect(smtp.sent).toHaveLength(1);
    const figures = () => campaignBreakdown(db(), c.workflow, "step", lastDays(30)).rows;
    expect(figures()).toMatchObject([{ key: c.steps.intro, sent: 1, bounced: 0 }]);

    // It comes back.
    db().prepare("UPDATE sent_messages SET status = 'bounced', bounced_at = datetime('now') WHERE run_id = ?").run(runId);

    expect(figures()).toMatchObject([{ key: c.steps.intro, sent: 1, bounced: 1 }]);
  });
});
