// The dashboard's figures and what it says needs attention. Real (throwaway) database;
// nothing is sent.
import { beforeEach, describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { currentAlerts } from "@/lib/platform/alerts";
import { workspaceDashboard, type DashboardFunnelStage } from "@/lib/reporting/dashboard";
import { publishDraft, type StepInput } from "@/lib/outreach/publish";
import alertsHandler from "@/pages/api/alerts";
import overviewHandler from "@/pages/api/dashboard/overview";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;
// Noon, so "three days ago" is the same calendar day whatever time the tests run.
const NOW = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 19).replace("T", " ");

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const STEPS: StepInput[] = [
  { key: "connect", step_type: "connect", connect_note: "Hello {{first_name}}" },
  { key: "e1", step_type: "email", email_subject: "Intro", email_body: "Hi {{first_name}}" },
];

/** A workspace with one LinkedIn account, one mailbox and one list. Campaigns are added with `campaign`. */
function workspace() {
  const n = ++seq;
  const ws = `ws-dash-${n}`;
  const w = { ws, list: `dash-list-${n}`, account: `dash-li-${n}`, mailbox: `dash-mail-${n}`, user: `dash-user-${n}` };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, 'Morgan Hale', 'x')").run(w.user, `morgan${n}@dash.test`);
  db().prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(ws, w.user);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, daily_connection_limit, daily_visit_limit, weekly_connection_limit)
    VALUES (?, 'Jordan Mertens', ?, 1, ?, 20, 80, 100)`).run(w.account, `li${n}@dash.test`, ws);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled)
    VALUES (?, ?, 'Outbound', 'Ada Okafor', ?, 'smtp.test.com', 'user', 'pass', 1, 50, 0)`).run(w.mailbox, ws, `ada@dash${n}.test`);
  db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'Enterprise VPs')").run(w.list, ws);
  return w;
}
type Workspace = ReturnType<typeof workspace>;

interface Campaign { id: string; run: string; steps: Record<string, string> }
function campaign(w: Workspace, name: string, options: { status?: string; owner?: string | null; list?: string } = {}): Campaign {
  const id = `dash-wf-${++seq}`;
  const made: Campaign = { id, run: `dash-run-${seq}`, steps: {} };
  db().prepare("INSERT INTO workflows (id, name, workspace_id, owner_id) VALUES (?, ?, ?, ?)").run(id, name, w.ws, options.owner ?? null);
  for (const step of publishDraft(db(), w.ws, id, { steps: STEPS, gates: [] }).steps) if (step.key) made.steps[step.key] = step.id;
  db().prepare("INSERT INTO runs (id, workflow_id, workspace_id, list_id, account_id, status) VALUES (?, ?, ?, ?, ?, ?)").run(made.run, id, w.ws, options.list ?? w.list, w.account, options.status ?? "running");
  return made;
}

/** A contact enrolled in a campaign so many days ago. */
function contact(w: Workspace, c: Campaign, daysAgo: number, fields: Record<string, unknown> = {}) {
  const id = `dash-target-${++seq}`;
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, email, email_status) VALUES (?, ?, ?, ?, 'verified')").run(id, w.ws, `Lee Lead ${seq}`, `lead${seq}@prospect.test`);
  for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE targets SET ${column} = ? WHERE id = ?`).run(value, id);
  db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id, account_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`dash-rp-${seq}`, c.run, id, w.mailbox, w.account, ago(daysAgo));
  db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES (?, ?, 'linkedin', 'in_progress')").run(`dash-rt-${seq}`, `dash-rp-${seq}`);
  return id;
}

function linkedin(w: Workspace, c: Campaign, targetId: string, action: "visit" | "connect" | "message", daysAgo: number) {
  db().prepare("INSERT INTO step_sends (id, workspace_id, workflow_id, run_id, step_id, target_id, channel, action, account_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'linkedin', ?, ?, ?)")
    .run(`dash-ss-${++seq}`, w.ws, c.id, c.run, c.steps.connect, targetId, action, w.account, ago(daysAgo));
}

function email(w: Workspace, c: Campaign, targetId: string, daysAgo: number, opened = false) {
  const k = ++seq;
  const job = `dash-job-${k}`;
  db().prepare(`INSERT INTO email_jobs (id, workspace_id, email_account_id, run_id, step_id, target_id, recipient, subject, body_text, idempotency_key, status, track_opens)
    VALUES (?, ?, ?, ?, ?, ?, 'lead@prospect.test', 'Intro', 'Hi', ?, 'sent', 1)`).run(job, w.ws, w.mailbox, c.run, c.steps.e1, targetId, job);
  db().prepare("INSERT INTO sent_messages (id, workspace_id, email_account_id, job_id, message_id, recipient, subject, run_id, target_id) VALUES (?, ?, ?, ?, ?, 'lead@prospect.test', 'Intro', ?, ?)")
    .run(`dash-sm-${k}`, w.ws, w.mailbox, job, `<${job}@dash.test>`, c.run, targetId);
  db().prepare("INSERT INTO step_sends (id, workspace_id, workflow_id, run_id, step_id, target_id, channel, action, email_account_id, email_job_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'email', 'email', ?, ?, ?)")
    .run(`dash-ss-${k}`, w.ws, c.id, c.run, c.steps.e1, targetId, w.mailbox, job, ago(daysAgo));
  if (opened) db().prepare("INSERT INTO sender_events (id, workspace_id, email_account_id, sent_message_id, provider, event_type, occurred_at, is_bot) VALUES (?, ?, ?, ?, 'pixel', 'opened', ?, 0)").run(`dash-ev-${k}`, w.ws, w.mailbox, `dash-sm-${k}`, ago(daysAgo));
}

/** An email reply from a contact. The time is written the way the mail reader writes it (ISO), unlike a send. */
function reply(w: Workspace, targetId: string, daysAgo: number, kind = "human_reply") {
  const at = new Date(NOW - daysAgo * DAY).toISOString();
  db().prepare("INSERT INTO email_replies (id, workspace_id, target_id, from_email, body_text, received_at, classification_json) VALUES (?, ?, ?, 'lead@prospect.test', 'Sure', ?, ?)")
    .run(`dash-er-${++seq}`, w.ws, targetId, at, JSON.stringify({ kind }));
  db().prepare("UPDATE targets SET email_replied_at = ?, reply_kind = ? WHERE id = ?").run(at, kind, targetId);
}

function meeting(w: Workspace, targetId: string, daysAgo: number, status: string | null = "confirmed") {
  db().prepare("INSERT INTO meetings (id, workspace_id, target_id, title, starts_at, created_at, status) VALUES (?, ?, ?, 'Intro call', ?, ?, ?)").run(`dash-mt-${++seq}`, w.ws, targetId, ago(-2), ago(daysAgo), status);
}

const count = (stages: DashboardFunnelStage[], key: DashboardFunnelStage["key"]) => stages.find((stage) => stage.key === key)!.count;
const as = (w: Workspace, role: "viewer" | "member" | "manager" | "admin") => ctxHeaders(w.ws, { userId: `${w.user}-${role}`, role });

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status IN ('running', 'pending', 'paused')").run();
  db().prepare("DELETE FROM worker_leases").run();
});

describe("the dashboard's figures", () => {
  /** This week: three emails and two invitations, one reply, one positive, one meeting. Last week: two emails, one reply. */
  function scene() {
    const w = workspace();
    const c = campaign(w, "Q4 Enterprise");
    const keen = contact(w, c, 6);
    email(w, c, keen, 3, true);
    reply(w, keen, 2, "positive");
    meeting(w, keen, 1);
    const quiet = contact(w, c, 6);
    email(w, c, quiet, 3);
    linkedin(w, c, quiet, "connect", 2);
    const visited = contact(w, c, 6);
    linkedin(w, c, visited, "visit", 2);
    linkedin(w, c, visited, "connect", 1);
    email(w, c, visited, 0.2);
    // The week before.
    const earlier = contact(w, c, 13);
    email(w, c, earlier, 10);
    reply(w, earlier, 9);
    const silent = contact(w, c, 13);
    email(w, c, silent, 10);
    return { w, c, keen, quiet, visited, earlier, silent };
  }

  it("counts what was sent in the period beside the period before, with bars across it", () => {
    const { w } = scene();
    const { kpis } = workspaceDashboard(db(), w.ws, { range: "7d", now: NOW });
    expect(kpis.emails).toMatchObject({ value: 3, previous: 2 });
    expect(kpis.linkedin).toMatchObject({ value: 3, previous: 0 });
    expect(kpis.emails.spark).toHaveLength(7);
    expect(kpis.emails.spark.reduce((a, b) => a + b, 0)).toBe(3);
    // A longer period takes in both weeks, and has nothing before it.
    const month = workspaceDashboard(db(), w.ws, { range: "30d", now: NOW }).kpis;
    expect(month.emails).toMatchObject({ value: 5, previous: 0 });
    expect(month.emails.spark).toHaveLength(8);
  });

  it("gives the reply rate of the people written to in the period, a reply counting for the message it answers", () => {
    const { w } = scene();
    const { kpis } = workspaceDashboard(db(), w.ws, { range: "7d", now: NOW });
    // Three people were written to this week (a visit alone would not count), and one answered.
    expect(kpis.reply).toMatchObject({ part: 1, whole: 3 });
    expect(kpis.reply.value).toBeCloseTo(1 / 3);
    // Last week two were written to and one answered.
    expect(kpis.reply.previous).toBe(0.5);
    expect(kpis.reply.spark).toHaveLength(8);
  });

  it("counts positive replies and meetings on the day they came, and leaves out automatic answers and cancelled meetings", () => {
    const { w, c, quiet, silent } = scene();
    reply(w, quiet, 1, "out_of_office");
    meeting(w, silent, 1, "cancelled");
    void c;
    const { kpis } = workspaceDashboard(db(), w.ws, { range: "7d", now: NOW });
    expect(kpis.positive).toMatchObject({ value: 1, previous: 0 });
    expect(kpis.meetings).toMatchObject({ value: 1, previous: 0 });
    // The out-of-office is not an answer to the rate either.
    expect(kpis.reply).toMatchObject({ part: 1, whole: 3 });
  });

  it("charts a fortnight of days for a week, the month's days for a month, and weeks for a quarter", () => {
    const { w } = scene();
    const week = workspaceDashboard(db(), w.ws, { range: "7d", now: NOW }).activity;
    expect(week.unit).toBe("day");
    expect(week.points).toHaveLength(14);
    expect(week.points.at(-1)!.start).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(week.points.reduce((sum, point) => sum + point.email, 0)).toBe(5);
    expect(week.points.reduce((sum, point) => sum + point.linkedin, 0)).toBe(3);
    // Two people replied, each on one day.
    expect(week.points.reduce((sum, point) => sum + point.replies, 0)).toBe(2);
    expect(workspaceDashboard(db(), w.ws, { range: "30d", now: NOW }).activity.points).toHaveLength(30);
    const quarter = workspaceDashboard(db(), w.ws, { range: "90d", now: NOW }).activity;
    expect(quarter.unit).toBe("week");
    expect(quarter.points).toHaveLength(13);
    expect(quarter.points.at(-1)!.email).toBe(3);
    expect(quarter.points.reduce((sum, point) => sum + point.email, 0)).toBe(5);
  });

  it("adds the funnel up over the campaigns in flight, or the one picked, or everything when nothing is running", () => {
    const { w, c } = scene();
    const done = campaign(w, "Summer launch", { status: "completed" });
    const old = contact(w, done, 40);
    email(w, done, old, 39);

    const inFlight = workspaceDashboard(db(), w.ws, { now: NOW }).funnel;
    expect(inFlight).toMatchObject({ scope: "in_flight", campaigns: 1 });
    // Five enrolled and reached; two engaged (one opened, one replied without an open being seen), both of whom replied; one liked it and booked.
    expect(inFlight.stages.both.map((stage) => stage.count)).toEqual([5, 5, 2, 2, 1, 1]);
    expect(count(inFlight.stages.email, "delivered")).toBe(5);
    expect(count(inFlight.stages.linkedin, "delivered")).toBe(2);

    const picked = workspaceDashboard(db(), w.ws, { workflow_id: done.id, now: NOW }).funnel;
    expect(picked).toMatchObject({ scope: "campaign", campaigns: 1 });
    expect(count(picked.stages.both, "enrolled")).toBe(1);

    db().prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(c.run);
    const all = workspaceDashboard(db(), w.ws, { now: NOW }).funnel;
    expect(all).toMatchObject({ scope: "all", campaigns: 2 });
    expect(count(all.stages.both, "enrolled")).toBe(6);
  });

  it("keeps to one campaign, one list or one member's campaigns when asked", () => {
    const { w, c } = scene();
    db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'Second list')").run(`${w.list}-b`, w.ws);
    const other = campaign(w, "RevOps push", { owner: w.user, list: `${w.list}-b` });
    const theirs = contact(w, other, 4);
    email(w, other, theirs, 2);
    reply(w, theirs, 1, "positive");
    meeting(w, theirs, 0.5);

    const everything = workspaceDashboard(db(), w.ws, { now: NOW });
    expect(everything.kpis.emails.value).toBe(4);
    expect(everything.kpis.positive.value).toBe(2);
    expect(everything.kpis.meetings.value).toBe(2);
    expect(everything.campaigns.map((entry) => entry.name).sort()).toEqual(["Q4 Enterprise", "RevOps push"]);

    for (const filter of [{ workflow_id: other.id }, { list_id: `${w.list}-b` }, { owner_id: w.user }]) {
      const narrowed = workspaceDashboard(db(), w.ws, { ...filter, now: NOW });
      expect(narrowed.kpis.emails.value).toBe(1);
      expect(narrowed.kpis.linkedin.value).toBe(0);
      expect(narrowed.kpis.reply).toMatchObject({ part: 1, whole: 1 });
      // Replies and meetings follow the contacts the scope wrote to.
      expect(narrowed.kpis.positive.value).toBe(1);
      expect(narrowed.kpis.meetings.value).toBe(1);
      expect(narrowed.campaigns.map((entry) => entry.name)).toEqual(["RevOps push"]);
      expect(count(narrowed.funnel.stages.both, "enrolled")).toBe(1);
    }
    expect(workspaceDashboard(db(), w.ws, { workflow_id: c.id, now: NOW }).kpis.emails.value).toBe(3);
    // What there is to filter by.
    expect(everything.options.campaigns.map((entry) => entry.name)).toEqual(["Q4 Enterprise", "RevOps push"]);
    expect(everything.options.lists.map((entry) => entry.name)).toEqual(["Enterprise VPs", "Second list"]);
    expect(everything.options.members).toEqual([{ id: w.user, name: "Morgan Hale" }]);
  });

  it("sets today's sends against what the senders in use may do", () => {
    const { w } = scene();
    // A second mailbox that is paused, and a second account that is signed out: neither adds to the allowance.
    db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, paused_at, paused_reason)
      VALUES (?, ?, 'Paused', 'paused@dash.test', 'smtp.test.com', 'user', 'pass', 1, 400, 0, datetime('now'), 'Paused by Morgan')`).run(`${w.mailbox}-b`, w.ws);
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, daily_connection_limit, daily_visit_limit) VALUES (?, 'Signed out', 'out@dash.test', 0, ?, 500, 500)").run(`${w.account}-b`, w.ws);
    const live = workspaceDashboard(db(), w.ws).today;
    expect(live.emails.cap).toBe(50);
    expect(live.invites.cap).toBe(20);
    expect(live.visits.cap).toBe(80);
    expect(live.emails.sent).toBeGreaterThanOrEqual(0);
  });

  it("ranks nothing and divides by nothing in an empty workspace", () => {
    const w = workspace();
    const empty = workspaceDashboard(db(), w.ws, { now: NOW });
    expect(empty.kpis.emails).toMatchObject({ value: 0, previous: 0 });
    expect(empty.kpis.reply).toMatchObject({ value: null, previous: null, whole: 0 });
    expect(empty.funnel).toMatchObject({ scope: "all", campaigns: 0 });
    expect(empty.funnel.stages.both.every((stage) => stage.count === 0)).toBe(true);
    expect(empty.campaigns).toEqual([]);
    expect(empty.activity.points).toHaveLength(14);
  });

  it("is read through its route by anyone in the workspace, with only its own campaigns, lists and members", async () => {
    const { w, c } = scene();
    const ok = await call(overviewHandler, { method: "GET", query: { range: "30d", workflow_id: c.id }, headers: as(w, "viewer") });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.dashboard).toMatchObject({ range: "30d", filters: { workflow_id: c.id } });
    expect(ok.body.alerts).toEqual([]);
    expect(ok.body.health.status).toBeTruthy();
    expect((await call(overviewHandler, { method: "GET", query: { range: "1y" }, headers: as(w, "viewer") })).statusCode).toBe(400);
    const stranger = workspace();
    expect((await call(overviewHandler, { method: "GET", query: { workflow_id: c.id }, headers: as(stranger, "manager") })).statusCode).toBe(404);
    expect((await call(overviewHandler, { method: "GET", query: { list_id: w.list }, headers: as(stranger, "manager") })).statusCode).toBe(404);
    expect((await call(overviewHandler, { method: "GET", query: { owner_id: w.user }, headers: as(stranger, "manager") })).statusCode).toBe(404);
  });
});

describe("what needs attention", () => {
  it("is nothing while everything is in order", () => {
    const w = workspace();
    campaign(w, "Q4 Enterprise");
    expect(currentAlerts(db(), w.ws, "owner")).toEqual([]);
  });

  it("names a mailbox that paused itself or cannot sign in, and where to deal with it", () => {
    const w = workspace();
    db().prepare("UPDATE email_accounts SET paused_at = datetime('now'), paused_reason = 'Auto-paused: 30-day bounce rate 4.8% is over 4.0%' WHERE id = ?").run(w.mailbox);
    db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, disconnected_at, disconnect_reason)
      VALUES (?, ?, 'Second', 'second@dash.test', 'smtp.test.com', 'user', 'pass', 1, datetime('now'), 'The password was refused')`).run(`${w.mailbox}-b`, w.ws);
    // One a person paused on purpose is not a problem to report.
    db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, paused_at, paused_reason)
      VALUES (?, ?, 'Third', 'third@dash.test', 'smtp.test.com', 'user', 'pass', 1, datetime('now'), 'Paused by Morgan')`).run(`${w.mailbox}-c`, w.ws);
    const alerts = currentAlerts(db(), w.ws, "member");
    expect(alerts.map((alert) => alert.kind).sort()).toEqual(["mailbox.auto_paused", "mailbox.disconnected"]);
    const paused = alerts.find((alert) => alert.kind === "mailbox.auto_paused")!;
    expect(paused).toMatchObject({ tone: "bad", title: "Mailbox auto-paused", action: { label: "Review", href: `/mailboxes?mailbox=${w.mailbox}` } });
    expect(paused.detail).toContain("bounce rate 4.8%");
    expect(alerts.find((alert) => alert.kind === "mailbox.disconnected")!.detail).toContain("second@dash.test");
  });

  it("names a LinkedIn account that is signed out, or close to its weekly invitations", () => {
    const w = workspace();
    const c = campaign(w, "Q4 Enterprise");
    for (let index = 0; index < 92; index++) linkedin(w, c, contact(w, c, 3), "connect", 2);
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, session_state, workspace_id) VALUES (?, 'Sam Second', 'second@dash.test', 0, 'needs_signin', ?)").run(`${w.account}-b`, w.ws);
    // One never connected is not a problem yet.
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'New', 'new@dash.test', 0, ?)").run(`${w.account}-c`, w.ws);
    const alerts = currentAlerts(db(), w.ws, "member");
    expect(alerts.map((alert) => [alert.kind, alert.tone])).toEqual([["linkedin.signin", "bad"], ["linkedin.weekly_near", "warn"]]);
    expect(alerts[1]).toMatchObject({ title: "LinkedIn weekly invite limit near", detail: "Jordan Mertens · 92 of 100 invites used this week", action: { label: "Adjust", href: "/linkedin-accounts" } });
    expect(alerts[0].detail).toContain("Sam Second");
  });

  it("says background work has stalled, and which part only to an admin", () => {
    const w = workspace();
    const before = process.env.LINKI_RUNNER;
    delete process.env.LINKI_RUNNER;
    try {
      db().prepare("INSERT INTO worker_leases (name, owner_id, heartbeat_at, expires_at) VALUES ('runner', 'test', datetime('now', '-40 minutes'), datetime('now'))").run();
      const [forAdmin] = currentAlerts(db(), w.ws, "admin");
      expect(forAdmin).toMatchObject({ kind: "runner.stalled", tone: "bad", action: { href: "/developers" } });
      expect(forAdmin.title).toMatch(/^Background work stalled for 4\d minutes$/);
      const [forMember] = currentAlerts(db(), w.ws, "member");
      expect(forMember.detail).toContain("A workspace admin can see which part");
      expect(forMember.action.href).toBe("/");
    } finally {
      if (before !== undefined) process.env.LINKI_RUNNER = before;
    }
  });

  it("says when the month's AI budget is used up, a sending domain's DNS fails, or prospects are stuck", () => {
    const w = workspace();
    const c = campaign(w, "Q4 Enterprise");
    db().prepare("INSERT INTO workspace_ai_config (workspace_id, monthly_budget_usd) VALUES (?, 5)").run(w.ws);
    db().prepare("INSERT INTO agent_sessions (id, workspace_id, cost_usd) VALUES (?, ?, 6.5)").run(`dash-ai-${++seq}`, w.ws);
    const domain = (db().prepare("SELECT from_email FROM email_accounts WHERE id = ?").get(w.mailbox) as { from_email: string }).from_email.split("@")[1];
    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, domain, spf_status, dkim_status, dmarc_status, mx_status) VALUES (?, ?, ?, 'pass', 'fail', 'fail', 'pass')").run(`dash-dc-${++seq}`, w.ws, domain);
    // A domain nothing sends from is nobody's problem.
    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, domain, spf_status, dkim_status, dmarc_status) VALUES (?, ?, 'unused.test', 'fail', 'fail', 'fail')").run(`dash-dc-${++seq}`, w.ws);
    for (let index = 0; index < 2; index++) db().prepare("UPDATE run_profile_tracks SET state = 'failed', error_message = 'Profile not found' WHERE run_profile_id = (SELECT id FROM run_profiles WHERE target_id = ?)").run(contact(w, c, 2));

    const alerts = currentAlerts(db(), w.ws, "member");
    expect(alerts.map((alert) => alert.kind)).toEqual(["domain.dns", "ai.budget", "campaign.failed"]);
    expect(alerts[0]).toMatchObject({ tone: "bad", title: `DKIM and DMARC failing on ${domain}`, action: { href: `/deliverability?domain=${domain}` } });
    expect(alerts[1].detail).toContain("$6.50 of $5.00 spent this month");
    expect(alerts[2]).toMatchObject({ title: "2 prospects stuck on a failed step", action: { label: "Review", href: `/campaigns/${c.id}/prospects?status=failed` } });
    // Another workspace sees none of it.
    expect(currentAlerts(db(), workspace().ws, "owner")).toEqual([]);
  });

  it("is read through its route by anyone in the workspace", async () => {
    const w = workspace();
    db().prepare("UPDATE email_accounts SET paused_at = datetime('now'), paused_reason = 'Auto-paused: complaints' WHERE id = ?").run(w.mailbox);
    const read = await call(alertsHandler, { method: "GET", headers: as(w, "viewer") });
    expect(read.statusCode).toBe(200);
    expect(read.body.alerts).toMatchObject([{ kind: "mailbox.auto_paused" }]);
    expect((await call(alertsHandler, { method: "POST", headers: as(w, "viewer") })).statusCode).toBe(405);
  });
});
