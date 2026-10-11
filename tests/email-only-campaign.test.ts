// Campaigns that only send email: started without a LinkedIn account, run by the engine,
// added to, and enrolled into by a signal rule. Plus the one helper all three enrolment
// paths now share, and the limits a LinkedIn account can be edited to. Real (throwaway)
// database; the browser and the SMTP send are stubbed.
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
  markNeedsReauth: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));
vi.mock("@/lib/linkedin/enrich", () => ({ enrichProfile: vi.fn(async () => true) }));
vi.mock("@/lib/linkedin/sync-accepted", () => ({ shouldSyncAccepted: vi.fn(() => false), syncAcceptedConnections: vi.fn() }));

import { tick } from "@/lib/linkedin/runner";
import { assignEmailAccounts } from "@/lib/outreach/enroll";
import { ingestSignal } from "@/lib/platform/signals";
import runsHandler from "@/pages/api/runs";
import enrollHandler from "@/pages/api/runs/[id]/enroll";
import accountHandler from "@/pages/api/accounts/[id]";
import { ctxHeaders } from "./helpers/ctx";

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

/** A workspace with a mailbox, a LinkedIn account, a list of contacts, and a campaign with the given steps. */
function workspace(steps: Array<"email" | "visit">, contacts = 2) {
  const n = ++seq;
  const ws = `ws-eo-${n}`;
  const w = { ws, workflow: `eo-wf-${n}`, list: `eo-list-${n}`, mailbox: `eo-mailbox-${n}`, account: `eo-li-${n}`, targets: [] as string[], headers: {} as Record<string, string> };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, 'LinkedIn', ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(w.account, `eo${n}@example.com`, ws);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, ?, 'Sender', ?, 'smtp.test.com', 'user', 'pass', 1, 50, 0, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(w.mailbox, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(w.workflow, ws);
  const order: Record<string, number> = {};
  for (const type of steps) {
    const track = type === "email" ? "email" : "linkedin";
    order[track] = (order[track] ?? 0) + 1;
    db().prepare(`INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(`eo-step-${n}-${track}-${order[track]}`, w.workflow, order[track], track, type, type === "email" ? "Quick question" : null, type === "email" ? "Hello" : null);
  }
  db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'List')").run(w.list, ws);
  for (let i = 0; i < contacts; i++) w.targets.push(contact(w));
  w.headers = ctxHeaders(ws, { userId: `eo-user-${n}`, role: "manager" });
  return w;
}

function contact(w: { ws: string; list: string }) {
  const k = ++seq;
  const id = `eo-target-${k}`;
  db().prepare(`INSERT INTO targets (id, workspace_id, full_name, email, email_status, email_verified_at, linkedin_url) VALUES (?, ?, 'Lee Lead', ?, 'verified', datetime('now'), ?)`)
    .run(id, w.ws, `lead${k}@prospect.test`, `https://www.linkedin.com/in/eo-lead-${k}/`);
  db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(w.list, id);
  return id;
}

const tracksOf = (runId: string) =>
  (db().prepare(`SELECT rp.target_id, rt.track, rp.email_account_id FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id WHERE rp.run_id = ? ORDER BY rp.target_id, rt.track`).all(runId) as Array<{ target_id: string; track: string; email_account_id: string | null }>);
const run = (id: string) => db().prepare("SELECT account_id, email_account_id, status FROM runs WHERE id = ?").get(id) as { account_id: string | null; email_account_id: string | null; status: string };

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status IN ('running', 'pending')").run();
  smtp.sent.length = 0;
});

describe("starting a campaign", () => {
  it("needs no LinkedIn account when the campaign only sends email", async () => {
    const w = workspace(["email"]);
    const res = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, email_account_ids: [w.mailbox] }, headers: w.headers });

    expect(res.statusCode).toBe(201);
    const runId = String(res.body.id);
    expect(run(runId)).toMatchObject({ account_id: null, email_account_id: w.mailbox });
    expect(tracksOf(runId).map((t) => t.track)).toEqual(["email", "email"]);
  });

  it("asks for a mailbox when email is all there is and none was chosen", async () => {
    const w = workspace(["email"]);
    const res = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list }, headers: w.headers });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("email_account_required");
    expect(db().prepare("SELECT COUNT(*) c FROM runs WHERE workflow_id = ?").get(w.workflow)).toEqual({ c: 0 });
  });

  it("still asks for a LinkedIn account when the campaign has LinkedIn steps", async () => {
    const w = workspace(["visit", "email"]);
    const res = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, email_account_ids: [w.mailbox] }, headers: w.headers });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("linkedin_account_required");

    const ok = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, account_id: w.account, email_account_ids: [w.mailbox] }, headers: w.headers });
    expect(ok.statusCode).toBe(201);
    expect(run(String(ok.body.id)).account_id).toBe(w.account);
    expect(tracksOf(String(ok.body.id)).map((t) => t.track)).toEqual(["email", "linkedin", "email", "linkedin"]);
  });

  it("refuses a mailbox that belongs to another workspace", async () => {
    const w = workspace(["email"]);
    const other = workspace(["email"]);
    const res = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, email_account_ids: [other.mailbox] }, headers: w.headers });
    expect(res.statusCode).toBe(404);
  });
});

describe("the engine", () => {
  it("sends an email-only campaign's emails with no LinkedIn account behind it", async () => {
    const w = workspace(["email"], 1);
    const created = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, email_account_ids: [w.mailbox] }, headers: w.headers });
    const runId = String(created.body.id);
    db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);

    // One pass moves the contact from pending to scheduled, the next sends.
    await tick(getDb(), { pace: false });
    db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL WHERE state = 'in_progress'").run();
    await tick(getDb(), { pace: false });

    expect(smtp.sent).toHaveLength(1);
    expect(db().prepare("SELECT action, account_id, email_account_id FROM step_sends WHERE run_id = ?").get(runId)).toEqual({ action: "email", account_id: null, email_account_id: w.mailbox });

    // And the run finishes like any other once everyone is done.
    await tick(getDb(), { pace: false });
    expect(run(runId).status).toBe("completed");
  });
});

describe("adding a contact to a running campaign", () => {
  it("gives them the same tracks and a mailbox, on an email-only run too", async () => {
    const w = workspace(["email"], 1);
    const created = await call(runsHandler, { method: "POST", body: { workflow_id: w.workflow, list_id: w.list, email_account_ids: [w.mailbox] }, headers: w.headers });
    const runId = String(created.body.id);
    const late = contact(w);

    const res = await call(enrollHandler, { method: "POST", query: { id: runId }, body: { target_ids: [late] }, headers: w.headers });

    expect(res.body).toMatchObject({ enrolled: 1 });
    expect(tracksOf(runId).find((t) => t.target_id === late)).toMatchObject({ track: "email", email_account_id: w.mailbox });
  });
});

describe("a signal rule", () => {
  function rule(w: ReturnType<typeof workspace>, fields: { account?: boolean; mailbox?: boolean }) {
    db().prepare(`INSERT INTO signal_rules (id, workspace_id, name, signal_type, min_score, list_id, workflow_id, account_id, email_account_id, enabled, auto_start)
      VALUES (?, ?, 'Rule', 'funding', 0, ?, ?, ?, ?, 1, 1)`).run(`eo-rule-${++seq}`, w.ws, w.list, w.workflow, fields.account ? w.account : null, fields.mailbox ? w.mailbox : null);
  }
  const signal = (w: ReturnType<typeof workspace>, targetId: string) => ingestSignal({ workspaceId: w.ws, targetId, type: "funding", title: "Raised a round", score: 50 });
  const runsOf = (w: ReturnType<typeof workspace>) => db().prepare("SELECT id, account_id, email_account_id FROM runs WHERE workflow_id = ?").all(w.workflow) as Array<{ id: string; account_id: string | null; email_account_id: string | null }>;

  it("enrols a contact in an email-only campaign from the rule's mailbox", () => {
    const w = workspace(["email"], 1);
    rule(w, { mailbox: true });

    signal(w, w.targets[0]);

    const [started] = runsOf(w);
    expect(started).toMatchObject({ account_id: null, email_account_id: w.mailbox });
    expect(tracksOf(started.id)).toEqual([{ target_id: w.targets[0], track: "email", email_account_id: w.mailbox }]);
  });

  it("gives the contact both halves of a campaign that has both", () => {
    // It used to start the LinkedIn half and silently leave the emails out.
    const w = workspace(["visit", "email"], 1);
    rule(w, { account: true, mailbox: true });

    signal(w, w.targets[0]);

    expect(tracksOf(runsOf(w)[0].id).map((t) => t.track)).toEqual(["email", "linkedin"]);
  });

  it("enrols nobody when it lacks the sender its campaign needs", () => {
    const linkedin = workspace(["visit"], 1);
    rule(linkedin, { mailbox: true });
    signal(linkedin, linkedin.targets[0]);
    expect(runsOf(linkedin)).toEqual([]);

    const email = workspace(["email"], 1);
    rule(email, { account: true });
    signal(email, email.targets[0]);
    expect(runsOf(email)).toEqual([]);
  });

  it("does not enrol the same contact twice", () => {
    const w = workspace(["email"], 1);
    rule(w, { mailbox: true });
    signal(w, w.targets[0]);
    signal(w, w.targets[0]);
    expect(runsOf(w)).toHaveLength(1);
    expect(tracksOf(runsOf(w)[0].id)).toHaveLength(1);
  });
});

describe("assignEmailAccounts", () => {
  it("gives everyone at one company the same mailbox, and takes mailboxes in turn otherwise", () => {
    const w = workspace(["email"], 0);
    db().prepare("INSERT INTO companies (id, workspace_id, name) VALUES ('eo-co-1', ?, 'Initech'), ('eo-co-2', ?, 'Globex')").run(w.ws, w.ws);
    const ids = [contact(w), contact(w), contact(w), contact(w)];
    db().prepare("UPDATE targets SET company_id = 'eo-co-1' WHERE id IN (?, ?)").run(ids[0], ids[1]);
    db().prepare("UPDATE targets SET company_id = 'eo-co-2' WHERE id = ?").run(ids[2]);

    const assigned = assignEmailAccounts(getDb(), ids, ["mailbox-a", "mailbox-b"]);

    expect(assigned.get(ids[0])).toBe(assigned.get(ids[1]));
    expect(new Set([assigned.get(ids[0]), assigned.get(ids[2])]).size).toBe(2);
    expect(["mailbox-a", "mailbox-b"]).toContain(assigned.get(ids[3]));
    expect(assignEmailAccounts(getDb(), ids, []).size).toBe(0);
  });
});

describe("editing a LinkedIn account's limits and hours", () => {
  it("saves sound values", async () => {
    const w = workspace(["visit"], 0);
    const headers = ctxHeaders(w.ws, { userId: "eo-admin", role: "admin" });
    const res = await call(accountHandler, { method: "PUT", query: { id: w.account }, headers,
      body: { daily_connection_limit: 25, daily_message_limit: 60, active_hours_start: 8, active_hours_end: 17, timezone: "America/Chicago", working_days: "1,2,3,4" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ daily_connection_limit: 25, daily_message_limit: 60, active_hours_start: 8, active_hours_end: 17, timezone: "America/Chicago", working_days: "1,2,3,4" });
  });

  it("refuses limits past the ceilings, hours that do not make a window, and unreadable zones or days", async () => {
    const w = workspace(["visit"], 0);
    const headers = ctxHeaders(w.ws, { userId: "eo-admin-2", role: "admin" });
    const before = db().prepare("SELECT daily_connection_limit, active_hours_start, active_hours_end, timezone, working_days FROM accounts WHERE id = ?").get(w.account);
    for (const body of [
      { daily_connection_limit: 500 }, { daily_message_limit: 0 }, { daily_inmail_limit: 12.5 },
      { active_hours_start: 18, active_hours_end: 9 }, { active_hours_end: 0 }, { active_hours_start: 25 },
      { timezone: "Chicago" }, { working_days: "0,1,2" }, { working_days: "1,1,2" }, { working_days: "" },
    ]) {
      const res = await call(accountHandler, { method: "PUT", query: { id: w.account }, headers, body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(db().prepare("SELECT daily_connection_limit, active_hours_start, active_hours_end, timezone, working_days FROM accounts WHERE id = ?").get(w.account)).toEqual(before);
  });

  it("still takes a change to one setting on its own", async () => {
    const w = workspace(["visit"], 0);
    const headers = ctxHeaders(w.ws, { userId: "eo-admin-3", role: "admin" });
    expect((await call(accountHandler, { method: "PUT", query: { id: w.account }, headers, body: { withdraw_stale_invites: true } })).statusCode).toBe(200);
    expect((await call(accountHandler, { method: "PUT", query: { id: w.account }, headers, body: { active_hours_end: 20 } })).statusCode).toBe(200);
  });
});
