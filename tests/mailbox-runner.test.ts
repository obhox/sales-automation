// What the campaign runner does with a mailbox's new settings, end to end: the engine is
// run for real against a throwaway database and only the SMTP send is stubbed, recording
// what it was handed. Each setting is checked both ways: left alone the runner does what
// it always did, and set it does the new thing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";

const smtp = vi.hoisted(() => ({ sent: [] as Array<{ from: string; to: string; subject: string; body: string }>, fail: null as null | Error }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (account: { from_email: string }, to: string, subject: string, body: string, options: { messageId: string }) => {
    if (smtp.fail) throw smtp.fail;
    smtp.sent.push({ from: account.from_email, to, subject, body });
    return { messageId: options.messageId };
  },
}));
vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  getSessionContext: vi.fn(async () => ({})),
  saveSessionState: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async () => {}),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({ shouldSyncAccepted: vi.fn(() => false), syncAcceptedConnections: vi.fn() }));

import { tick } from "@/lib/linkedin/runner";
import { markConnected } from "@/lib/email/connection";

const db = () => getDb();
let seq = 0;

/** A running campaign of email steps, sending from one mailbox, with contacts due. */
function campaign(opts: { steps?: Array<{ signature?: string | null }>; mailbox?: Record<string, unknown>; contacts?: number } = {}) {
  const n = ++seq;
  const ws = `ws-mbr-${n}`;
  const ids = { ws, run: `mbr-run-${n}`, mailbox: `mbr-mailbox-${n}`, workflow: `mbr-wf-${n}`, targets: [] as string[] };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, 'LinkedIn', ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(`mbr-li-${n}`, `mbr${n}@example.com`, ws);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days, signature)
    VALUES (?, ?, 'Sender', ?, 'smtp.test.com', 'user', 'pass', 1, 50, 0, 0, 24, 'UTC', '1,2,3,4,5,6,7', 'Ada Lovelace\nAcme')`).run(ids.mailbox, ws, `ada${n}@acme.test`);
  for (const [column, value] of Object.entries(opts.mailbox ?? {})) db().prepare(`UPDATE email_accounts SET ${column} = ? WHERE id = ?`).run(value, ids.mailbox);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(ids.workflow, ws);
  (opts.steps ?? [{}, {}, {}]).forEach((step, i) => {
    db().prepare(`INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body, email_position, email_signature)
      VALUES (?, ?, ?, 'email', 'email', 0, ?, 'Hello {{first_name}}', ?, ?)`).run(`mbr-step-${n}-${i + 1}`, ids.workflow, i + 1, `Subject ${i + 1}`, i + 1, step.signature === undefined ? null : step.signature);
  });
  db().prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, 'running', ?)").run(ids.run, ids.workflow, `mbr-li-${n}`, ws);
  for (let c = 0; c < (opts.contacts ?? 1); c++) {
    const target = `mbr-target-${n}-${c}`;
    ids.targets.push(target);
    db().prepare(`INSERT INTO targets (id, workspace_id, full_name, first_name, company, email, email_status, email_verified_at, linkedin_url)
      VALUES (?, ?, 'Lee Lead', 'Lee', 'Initech', ?, 'verified', datetime('now'), ?)`).run(target, ws, `lee${n}-${c}@prospect.test`, `https://www.linkedin.com/in/mbr-lead-${n}-${c}/`);
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`${target}-rp`, ids.run, target, ids.mailbox);
    db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'email', 'in_progress', 0)").run(`${target}-rt`, `${target}-rp`);
  }
  return ids;
}

/** Run the engine once, as if a day had passed since the last email: no pacing, step due. */
async function nextDay() {
  db().prepare("UPDATE logs SET created_at = datetime(created_at, '-1 day') WHERE message LIKE 'Email sent%'").run();
  db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL WHERE state = 'in_progress'").run();
  await tick(getDb(), { pace: false });
}

const track = (target: string) => db().prepare("SELECT state, current_step, error_message FROM run_profile_tracks WHERE run_profile_id = ?").get(`${target}-rp`) as { state: string; current_step: number; error_message: string | null };

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status = 'running'").run();
  smtp.sent.length = 0;
  smtp.fail = null;
});

describe("the mailbox's signature on campaign emails", () => {
  it("goes on every email of a sequence, as it always has", async () => {
    campaign();
    await nextDay(); await nextDay(); await nextDay();
    expect(smtp.sent.map((email) => email.body)).toEqual(["Hello Lee\n\n--\nAda Lovelace\nAcme", "Hello Lee\n\n--\nAda Lovelace\nAcme", "Hello Lee\n\n--\nAda Lovelace\nAcme"]);
  });

  it("goes on the first email only when the mailbox is set that way", async () => {
    campaign({ mailbox: { signature_first_only: 1 } });
    await nextDay(); await nextDay(); await nextDay();
    expect(smtp.sent.map((email) => email.body)).toEqual(["Hello Lee\n\n--\nAda Lovelace\nAcme", "Hello Lee", "Hello Lee"]);
  });

  it("never overrides a step that has its own signature, or its own none", async () => {
    campaign({ mailbox: { signature_first_only: 1 }, steps: [{ signature: "" }, { signature: "Step two sig" }, {}] });
    await nextDay(); await nextDay(); await nextDay();
    expect(smtp.sent.map((email) => email.body)).toEqual(["Hello Lee", "Hello Lee\n\n--\nStep two sig", "Hello Lee"]);
  });
});

describe("the mailbox's daily limit while it ramps up", () => {
  const start = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  /** Contacts the runner put off to tomorrow because the mailbox has no room left today. */
  const putOff = (run: string) => (db().prepare("SELECT COUNT(*) c FROM logs WHERE run_id = ? AND message LIKE 'Daily email limit reached%'").get(run) as { c: number }).c;

  it("gives a mailbox on the original ramp room for two emails on its first day, as it always has", async () => {
    const c = campaign({ contacts: 5, mailbox: { ramp_up_enabled: 1, ramp_start_date: start(0) } });
    await tick(getDb(), { pace: false });
    // Two of the five have room; the other three are put off. (Of the two, the second
    // waits out the gap between sends from one mailbox, which is not what is tested here.)
    expect(putOff(c.run)).toBe(3);
    expect(smtp.sent).toHaveLength(1);
    // Nobody is failed by the limit: everyone is still in the campaign.
    expect(c.targets.map((target) => track(target).state)).toEqual(Array(5).fill("in_progress"));
  });

  it("gives it room for five on its third day (2, 4, 6: but only five contacts)", async () => {
    const c = campaign({ contacts: 5, mailbox: { ramp_up_enabled: 1, ramp_start_date: start(2) } });
    await tick(getDb(), { pace: false });
    expect(putOff(c.run)).toBe(0);
  });

  it("gives a mailbox with a ramp length that ramp's figure for the day", async () => {
    const c = campaign({ contacts: 6, mailbox: { ramp_up_enabled: 1, ramp_start_date: start(0), ramp_days: 10, ramp_start_limit: 4, daily_email_limit: 40 } });
    await tick(getDb(), { pace: false });
    expect(putOff(c.run)).toBe(2);
    expect(smtp.sent).toHaveLength(1);
  });

  it("gives a mailbox that is not ramping its whole limit", async () => {
    const c = campaign({ contacts: 6, mailbox: { ramp_up_enabled: 0, ramp_start_date: start(0), ramp_days: 10, ramp_start_limit: 1, daily_email_limit: 4 } });
    await tick(getDb(), { pace: false });
    expect(putOff(c.run)).toBe(2);
  });
});

describe("a mailbox whose sign-in the server refuses", () => {
  const refusal = () => Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 });

  it("is disconnected, and its contacts wait where they are instead of failing", async () => {
    const c = campaign({ contacts: 2 });
    smtp.fail = refusal();
    await tick(getDb(), { pace: false });
    await nextDay();
    expect(smtp.sent).toHaveLength(0);
    const mailbox = db().prepare("SELECT disconnected_at, disconnect_reason FROM email_accounts WHERE id = ?").get(c.mailbox) as { disconnected_at: string | null; disconnect_reason: string };
    expect(mailbox.disconnected_at).not.toBeNull();
    expect(mailbox.disconnect_reason).toMatch(/refused the sign-in used to send/);
    for (const target of c.targets) expect(track(target)).toMatchObject({ state: "in_progress", current_step: 0, error_message: null });
    expect(db().prepare("SELECT message FROM logs WHERE run_id = ? AND level = 'warn' AND message LIKE '%holding%' LIMIT 1").get(c.run)).toMatchObject({ message: expect.stringMatching(/holding Lee Lead until it resumes/) });
    expect(db().prepare("SELECT COUNT(*) c FROM email_jobs WHERE run_id = ? AND status = 'failed'").get(c.run)).toEqual({ c: 0 });
  });

  it("holds a contact tried again within minutes of a pause, where it used to be failed", async () => {
    // A held email is put back for fifteen minutes. Asked for again inside that time, the
    // sender answered with a plain error, which the runner took for a failed send.
    const c = campaign({ contacts: 1 });
    db().prepare("UPDATE email_accounts SET paused_at = datetime('now'), paused_reason = 'Manually paused' WHERE id = ?").run(c.mailbox);
    await tick(getDb(), { pace: false });
    await nextDay();
    await nextDay();
    expect(track(c.targets[0])).toMatchObject({ state: "in_progress", current_step: 0, error_message: null });
    db().prepare("UPDATE email_accounts SET paused_at = NULL, paused_reason = NULL WHERE id = ?").run(c.mailbox);
    db().prepare("UPDATE email_jobs SET available_at = datetime('now', '-1 minute') WHERE run_id = ?").run(c.run);
    await nextDay();
    expect(smtp.sent.map((email) => email.subject)).toEqual(["Subject 1"]);
  });

  it("sends the email that was waiting, once, when it is reconnected", async () => {
    const c = campaign({ contacts: 1, steps: [{}] });
    smtp.fail = refusal();
    await tick(getDb(), { pace: false });
    expect(track(c.targets[0])).toMatchObject({ state: "in_progress", current_step: 0 });

    smtp.fail = null;
    markConnected(c.mailbox);
    db().prepare("UPDATE email_jobs SET available_at = datetime('now', '-1 minute') WHERE run_id = ?").run(c.run);
    await nextDay();
    await nextDay();
    expect(smtp.sent.map((email) => email.subject)).toEqual(["Subject 1"]);
    expect(track(c.targets[0]).state).toBe("completed");
  });

  it("is not disconnected by a failure that is not a refused sign-in", async () => {
    const c = campaign({ contacts: 1 });
    smtp.fail = Object.assign(new Error("Message rejected: mailbox unavailable"), { code: "EENVELOPE", responseCode: 550 });
    await tick(getDb(), { pace: false });
    expect(db().prepare("SELECT disconnected_at FROM email_accounts WHERE id = ?").get(c.mailbox)).toEqual({ disconnected_at: null });
  });
});
