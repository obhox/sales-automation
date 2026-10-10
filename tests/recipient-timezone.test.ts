// A campaign that sends in each contact's own working hours. The engine runs against a real
// (throwaway) database with the SMTP send stubbed, and with the clock pinned, so "now" is
// inside one window and outside another by construction rather than by luck.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  markNeedsReauth: vi.fn(async () => {}),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({ shouldSyncAccepted: vi.fn(() => false), syncAcceptedConnections: vi.fn() }));

import { tick } from "@/lib/linkedin/runner";
import { zonedParts } from "@/lib/outreach/schedule";
import targetHandler from "@/pages/api/targets/[id]";
import workflowHandler from "@/pages/api/workflows/[id]";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

// A Monday, 10:00 UTC: inside the mailbox's hours (it is kept on plain UTC), 19:00 in Tokyo.
const MID_MORNING_UTC = new Date("2026-07-20T10:00:00Z");
// The same Monday at 01:00 UTC: 10:00 in Tokyo, the middle of the night for the mailbox.
const NIGHT_UTC = new Date("2026-07-20T01:00:00Z");

/** A running one-email campaign from a mailbox that sends 9 to 18 UTC, every day. */
function campaign(inRecipientTime: boolean) {
  const n = ++seq;
  const ws = `ws-tz-${n}`;
  const c = { ws, run: `tz-run-${n}`, workflow: `tz-wf-${n}`, mailbox: `tz-mailbox-${n}` };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, 'LinkedIn', ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(`tz-li-${n}`, `tz${n}@example.com`, ws);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, ?, 'Sender', ?, 'smtp.test.com', 'user', 'pass', 1, 50, 0, 9, 18, 'UTC', '1,2,3,4,5,6,7')`).run(c.mailbox, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id, send_in_recipient_tz) VALUES (?, 'Campaign', ?, ?)").run(c.workflow, ws, inRecipientTime ? 1 : 0);
  db().prepare(`INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body)
    VALUES (?, ?, 1, 'email', 'email', 0, 'Quick question', 'Hello')`).run(`tz-step-${n}`, c.workflow);
  db().prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, 'running', ?)").run(c.run, c.workflow, `tz-li-${n}`, ws);
  const enrol = (timeZone: string | null) => {
    const k = ++seq;
    const target = `tz-target-${k}`;
    db().prepare(`INSERT INTO targets (id, workspace_id, full_name, email, email_status, email_verified_at, linkedin_url, time_zone)
      VALUES (?, ?, 'Lee Lead', ?, 'verified', datetime('now'), ?, ?)`).run(target, ws, `lead${k}@prospect.test`, `https://www.linkedin.com/in/tz-lead-${k}/`, timeZone);
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`tz-rp-${k}`, c.run, target, c.mailbox);
    db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'email', 'in_progress', 0)").run(`tz-rt-${k}`, `tz-rp-${k}`);
    return { target, email: `lead${k}@prospect.test` };
  };
  return { ...c, enrol };
}

const nextStepAt = (target: string) =>
  (db().prepare(`SELECT rt.next_step_at FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id WHERE rp.target_id = ?`).get(target) as { next_step_at: string | null }).next_step_at;

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status = 'running'").run();
  smtp.sent.length = 0;
  // Only the clock is faked: the engine's awaits still run on real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => { vi.useRealTimers(); });

describe("a campaign that sends in the contact's working hours", () => {
  it("holds an email for a contact whose day is over, until their morning", async () => {
    vi.setSystemTime(MID_MORNING_UTC);
    const c = campaign(true);
    const tokyo = c.enrol("Asia/Tokyo");

    await tick(getDb(), { pace: false });

    expect(smtp.sent).toEqual([]);
    const slot = new Date(nextStepAt(tokyo.target)!);
    expect(slot.getTime()).toBeGreaterThan(MID_MORNING_UTC.getTime());
    const there = zonedParts("Asia/Tokyo", slot);
    expect(there.hour).toBeGreaterThanOrEqual(9);
    expect(there.hour).toBeLessThan(18);
  });

  it("sends to a contact who is at work while the mailbox's own hours are closed", async () => {
    vi.setSystemTime(NIGHT_UTC);
    const c = campaign(true);
    const tokyo = c.enrol("Asia/Tokyo");

    await tick(getDb(), { pace: false });

    expect(smtp.sent).toEqual([tokyo.email]);
  });

  it("goes by the mailbox's clock for a contact with no zone, or one it cannot read", async () => {
    vi.setSystemTime(MID_MORNING_UTC);
    const c = campaign(true);
    const unknown = c.enrol(null);

    await tick(getDb(), { pace: false });
    expect(smtp.sent).toEqual([unknown.email]);

    const d = campaign(true);
    const garbled = d.enrol("Tokyo time");
    db().prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(c.run);
    db().prepare("UPDATE logs SET created_at = datetime(created_at, '-1 day')").run();
    await tick(getDb(), { pace: false });
    expect(smtp.sent).toContain(garbled.email);
  });
});

describe("a campaign that does not", () => {
  it("sends on the mailbox's clock whatever the contact's zone", async () => {
    vi.setSystemTime(MID_MORNING_UTC);
    const c = campaign(false);
    const tokyo = c.enrol("Asia/Tokyo");

    await tick(getDb(), { pace: false });

    expect(smtp.sent).toEqual([tokyo.email]);
  });

  it("waits for the mailbox's hours even when the contact is at work", async () => {
    vi.setSystemTime(NIGHT_UTC);
    const c = campaign(false);
    c.enrol("Asia/Tokyo");

    await tick(getDb(), { pace: false });

    expect(smtp.sent).toEqual([]);
  });
});

describe("the settings behind it", () => {
  function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return res as unknown as { statusCode: number; body: Record<string, unknown> };
  }

  it("turn on and off per campaign", () => {
    const c = campaign(false);
    const headers = ctxHeaders(c.ws, { userId: "tz-user", role: "member" });
    expect(call(workflowHandler, { method: "PUT", query: { id: c.workflow }, body: { send_in_recipient_tz: true }, headers }).body).toMatchObject({ send_in_recipient_tz: 1 });
    // Saving something else leaves it as it was.
    expect(call(workflowHandler, { method: "PUT", query: { id: c.workflow }, body: { name: "Renamed" }, headers }).body).toMatchObject({ name: "Renamed", send_in_recipient_tz: 1 });
    expect(call(workflowHandler, { method: "PUT", query: { id: c.workflow }, body: { send_in_recipient_tz: false }, headers }).body).toMatchObject({ send_in_recipient_tz: 0 });
  });

  it("take a contact's time zone, and refuse one that is not a zone", () => {
    const c = campaign(false);
    const { target } = c.enrol(null);
    const headers = ctxHeaders(c.ws, { userId: "tz-user-2", role: "member" });

    expect(call(targetHandler, { method: "PATCH", query: { id: target }, body: { time_zone: "America/Chicago" }, headers }).statusCode).toBe(200);
    expect(db().prepare("SELECT time_zone FROM targets WHERE id = ?").get(target)).toEqual({ time_zone: "America/Chicago" });

    expect(call(targetHandler, { method: "PATCH", query: { id: target }, body: { time_zone: "Chicago" }, headers }).statusCode).toBe(400);
    expect(db().prepare("SELECT time_zone FROM targets WHERE id = ?").get(target)).toEqual({ time_zone: "America/Chicago" });

    expect(call(targetHandler, { method: "PATCH", query: { id: target }, body: { time_zone: "" }, headers }).statusCode).toBe(200);
    expect(db().prepare("SELECT time_zone FROM targets WHERE id = ?").get(target)).toEqual({ time_zone: null });
  });
});
