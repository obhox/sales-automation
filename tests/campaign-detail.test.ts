// A campaign's own pages: the Overview's figures, its report links, promoting an A/B
// winner without being asked, the Prospects tab and what can be done to prospects, the run
// log, and the Settings tab. Real (throwaway) database; nothing is sent.
import { beforeEach, describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { autoPromote, promoteVersion } from "@/lib/campaigns/auto-promote";
import { campaignOverview, type FunnelStage } from "@/lib/campaigns/overview";
import { actOnProspects, addProspects, campaignLog, campaignProspects } from "@/lib/campaigns/prospects";
import { campaignSettings } from "@/lib/campaigns/settings";
import { saveSetup } from "@/lib/campaigns/setup";
import { createShare, listShares, MAX_LIVE_SHARES, openShare, revokeShare } from "@/lib/campaigns/share";
import { publishDraft, saveDraft, getDraft, type StepInput } from "@/lib/outreach/publish";
import workflowHandler from "@/pages/api/workflows/[id]/index";
import logHandler from "@/pages/api/workflows/[id]/log";
import overviewHandler from "@/pages/api/workflows/[id]/overview";
import prospectsHandler from "@/pages/api/workflows/[id]/prospects";
import settingsHandler from "@/pages/api/workflows/[id]/settings";
import shareHandler from "@/pages/api/workflows/[id]/share";
import exportHandler from "@/pages/api/export/[resource]";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;
const NOW = Date.now();
const DAY = 86_400_000;
/** A time so many days before now, as SQLite writes them. */
const ago = (days: number, minutes = 0) => new Date(NOW - days * DAY + minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined, text: "" };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = (chunk?: unknown) => { if (chunk !== undefined) res.text = String(res.text) + String(chunk); return res; };
  res.write = (chunk: unknown) => { res.text = String(res.text) + String(chunk); return true; };
  res.send = (chunk: unknown) => { res.text = String(chunk); return res; };
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, any>; text: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const BOTH: StepInput[] = [
  { key: "connect", step_type: "connect", connect_note: "Hello {{first_name}}" },
  { step_type: "delay", track: "linkedin", delay_seconds: 86_400 },
  { key: "message", step_type: "message", message_body: "Thanks for connecting" },
  { key: "e1", step_type: "email", email_subject: "Intro", email_body: "Hi {{first_name}}", email_variants: [{ subject: "Another way in", body: "Hello {{first_name}}" }] },
  { step_type: "delay", track: "email", delay_seconds: 86_400 },
  { key: "e2", step_type: "email", email_subject: "Following up", email_body: "Any thoughts?" },
];

/** A workspace with a LinkedIn account, a mailbox, a list and one two-channel campaign with a run. */
function workspace(runStatus: "running" | "paused" | "completed" = "running") {
  const n = ++seq;
  const ws = `ws-detail-${n}`;
  const w = { ws, list: `detail-list-${n}`, account: `detail-li-${n}`, mailbox: `detail-mail-${n}`, user: `detail-user-${n}`, workflow: `detail-wf-${n}`, run: `detail-run-${n}`, steps: {} as Record<string, string>, variant: "" };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, 'Morgan Hale', 'x')").run(w.user, `morgan${n}@detail.test`);
  db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Jordan Mertens', ?, 1, ?)").run(w.account, `li${n}@detail.test`, ws);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_name, from_email, smtp_host, username, password, is_verified)
    VALUES (?, ?, 'Outbound', 'Ada Okafor', ?, 'smtp.test.com', 'user', 'pass', 1)`).run(w.mailbox, ws, `ada${n}@detail.test`);
  db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'Enterprise VPs')").run(w.list, ws);
  for (const [suffix, won, lost] of [["meeting", 0, 0], ["won", 1, 0], ["lost", 0, 1]] as const) {
    db().prepare("INSERT INTO pipeline_stages (id, workspace_id, name, is_won, is_lost) VALUES (?, ?, ?, ?, ?)").run(`${ws}:stage:${suffix}`, ws, suffix, won, lost);
  }
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Q4 Enterprise', ?)").run(w.workflow, ws);
  for (const step of publishDraft(db(), ws, w.workflow, { steps: BOTH, gates: [] }).steps) if (step.key) w.steps[step.key] = step.id;
  w.variant = (db().prepare("SELECT id FROM workflow_step_email_variants WHERE step_id = ?").get(w.steps.e1) as { id: string }).id;
  db().prepare("INSERT INTO runs (id, workflow_id, workspace_id, list_id, account_id, status) VALUES (?, ?, ?, ?, ?, ?)").run(w.run, w.workflow, ws, w.list, w.account, runStatus);
  return w;
}
type Workspace = ReturnType<typeof workspace>;
const as = (w: Workspace, role: "viewer" | "member" | "manager") => ctxHeaders(w.ws, { userId: `${w.user}-${role}`, role });

/** A contact in the workspace's list. */
function contact(w: Workspace, fields: Record<string, unknown> = {}) {
  const k = ++seq;
  const id = `detail-target-${k}`;
  db().prepare(`INSERT INTO targets (id, workspace_id, full_name, first_name, company, email, email_status, linkedin_url, degree)
    VALUES (?, ?, ?, 'Lee', 'Initech', ?, 'verified', ?, 2)`).run(id, w.ws, `Lee Lead ${k}`, `lead${k}@prospect.test`, `https://www.linkedin.com/in/detail-lead-${k}/`);
  for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE targets SET ${column} = ? WHERE id = ?`).run(value, id);
  db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(w.list, id);
  return id;
}

type TrackState = "pending" | "in_progress" | "completed" | "failed" | "skipped";
/** Enrol a contact so many days ago, with each track in the state given. Returns the enrolment's id. */
function enrol(w: Workspace, targetId: string, daysAgo: number, tracks: Partial<Record<"linkedin" | "email", TrackState | { state: TrackState; step?: number; note?: string; hold?: string }>> = { linkedin: "in_progress", email: "in_progress" }, runId = w.run) {
  const id = `detail-rp-${++seq}`;
  db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id, account_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, runId, targetId, w.mailbox, w.account, ago(daysAgo));
  for (const [track, value] of Object.entries(tracks)) {
    const place = typeof value === "string" ? { state: value } : value!;
    db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, error_message, hold) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`detail-rt-${++seq}`, id, track, place.state, place.step ?? 0, place.note ?? null, place.hold ?? null);
  }
  return id;
}

/** Record a LinkedIn action the campaign took. */
function linkedin(w: Workspace, targetId: string, action: "visit" | "connect" | "message", daysAgo: number, workflowId = w.workflow) {
  db().prepare("INSERT INTO step_sends (id, workspace_id, workflow_id, run_id, step_id, target_id, channel, action, account_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'linkedin', ?, ?, ?)")
    .run(`detail-ss-${++seq}`, w.ws, workflowId, w.run, action === "message" ? w.steps.message : w.steps.connect, targetId, action, w.account, ago(daysAgo));
}

/** Record an email the campaign sent, and what became of it. Returns the job's id, which a reply can name. */
function email(w: Workspace, targetId: string, daysAgo: number, options: { step?: string; variant?: string | null; opened?: boolean; clicked?: boolean; bounced?: boolean; bot?: string; tracked?: boolean } = {}) {
  const k = ++seq;
  const job = `detail-job-${k}`;
  const tracked = options.tracked !== false ? 1 : 0;
  db().prepare(`INSERT INTO email_jobs (id, workspace_id, email_account_id, run_id, step_id, variant_id, target_id, recipient, subject, body_text, idempotency_key, status, track_opens, track_clicks)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'lead@prospect.test', 'Intro', 'Hi', ?, 'sent', ?, ?)`).run(job, w.ws, w.mailbox, w.run, options.step ?? w.steps.e1, options.variant ?? null, targetId, job, tracked, tracked);
  db().prepare("INSERT INTO sent_messages (id, workspace_id, email_account_id, job_id, message_id, recipient, subject, run_id, target_id, bounced_at) VALUES (?, ?, ?, ?, ?, 'lead@prospect.test', 'Intro', ?, ?, ?)")
    .run(`detail-sm-${k}`, w.ws, w.mailbox, job, `<${job}@detail.test>`, w.run, targetId, options.bounced ? ago(daysAgo) : null);
  db().prepare("INSERT INTO step_sends (id, workspace_id, workflow_id, run_id, step_id, variant_id, target_id, channel, action, email_account_id, email_job_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'email', 'email', ?, ?, ?)")
    .run(`detail-ss-${k}`, w.ws, w.workflow, w.run, options.step ?? w.steps.e1, options.variant ?? null, targetId, w.mailbox, job, ago(daysAgo));
  const event = (type: string, bot: string | null) => db().prepare(
    "INSERT INTO sender_events (id, workspace_id, email_account_id, sent_message_id, provider, event_type, occurred_at, is_bot, bot_reason) VALUES (?, ?, ?, ?, 'pixel', ?, ?, ?, ?)",
  ).run(`detail-ev-${++seq}`, w.ws, w.mailbox, `detail-sm-${k}`, type, ago(daysAgo, 30), bot ? 1 : 0, bot);
  if (options.opened) event("opened", null);
  if (options.clicked) event("clicked", null);
  if (options.bot) event("opened", options.bot);
  return job;
}

/** An email reply to one of the campaign's emails. */
function emailReply(w: Workspace, targetId: string, job: string, daysAgo: number, kind: string | null = "human_reply") {
  db().prepare("INSERT INTO email_replies (id, workspace_id, target_id, from_email, body_text, received_at, in_reply_to_job_id, run_id, classification_json) VALUES (?, ?, ?, 'lead@prospect.test', 'Sure', ?, ?, ?, ?)")
    .run(`detail-er-${++seq}`, w.ws, targetId, ago(daysAgo), job, w.run, kind ? JSON.stringify({ kind }) : null);
  db().prepare("UPDATE targets SET email_replied_at = ?, reply_kind = ? WHERE id = ?").run(ago(daysAgo), kind, targetId);
}

const stage = (funnel: FunnelStage[], key: FunnelStage["key"]) => funnel.find((entry) => entry.key === key)!;

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status IN ('running', 'pending', 'paused') AND id NOT LIKE 'detail-keep-%'").run();
});

describe("a campaign's overview", () => {
  /** Four contacts this fortnight and one the fortnight before, between them touching every figure. */
  function scene() {
    const w = workspace();
    // Invited, accepted, replied on LinkedIn, liked it, and a meeting followed.
    const keen = contact(w, { connected_at: ago(4), last_replied_at: ago(3), reply_kind: "positive" });
    enrol(w, keen, 6, { linkedin: { state: "skipped", note: "Lead replied" }, email: { state: "skipped", note: "Lead replied" } });
    linkedin(w, keen, "connect", 5);
    db().prepare("INSERT INTO meetings (id, workspace_id, target_id, title, starts_at, created_at) VALUES (?, ?, ?, 'Intro call', ?, ?)").run(`detail-mt-${++seq}`, w.ws, keen, ago(-2), ago(2));
    // Invited, and nothing since.
    const quiet = contact(w);
    enrol(w, quiet, 6, { linkedin: { state: "in_progress", step: 1 } });
    linkedin(w, quiet, "connect", 5);
    // Emailed, opened by a person, and answered by an out-of-office.
    const away = contact(w);
    enrol(w, away, 5, { email: { state: "in_progress", step: 1 } });
    emailReply(w, away, email(w, away, 4, { opened: true, bot: "scanner_user_agent" }), 3, "out_of_office");
    // Enrolled and left out: the sequence finished without writing to them.
    const leftOut = contact(w);
    enrol(w, leftOut, 5, { linkedin: { state: "skipped", note: "No LinkedIn profile" }, email: { state: "skipped", note: "No verified email" } });
    // The fortnight before: one invitation, accepted.
    const earlier = contact(w, { connected_at: ago(18) });
    enrol(w, earlier, 20, { linkedin: "completed", email: "completed" });
    linkedin(w, earlier, "connect", 19);
    return { w, keen, quiet, away, leftOut, earlier };
  }

  it("gives each rate for the contacts enrolled in the period, beside the same rate for the period before", () => {
    const { w } = scene();
    const { kpis } = campaignOverview(db(), w.ws, w.workflow, { range: "14d", now: NOW });
    expect(kpis.acceptance).toMatchObject({ part: 1, whole: 2, value: 0.5, previous: 1 });
    // Three were written to; one answered. The out-of-office is not an answer.
    expect(kpis.reply).toMatchObject({ part: 1, whole: 3, previous: 0 });
    expect(kpis.open).toMatchObject({ part: 1, whole: 1, value: 1, previous: null });
    expect(kpis.click).toMatchObject({ part: 0, whole: 1, value: 0 });
    expect(kpis.completion).toMatchObject({ part: 2, whole: 4, value: 0.5, previous: 1 });
    expect(kpis.acceptance.spark).toHaveLength(8);
    expect(kpis.acceptance.spark.filter((value) => value !== null)).toEqual([0.5]);
  });

  it("has nothing to compare with over all time, and counts everyone", () => {
    const { w } = scene();
    const all = campaignOverview(db(), w.ws, w.workflow, { range: "all", now: NOW });
    expect(all.kpis.acceptance).toMatchObject({ part: 2, whole: 3, previous: null });
    expect(all.kpis.completion.whole).toBe(5);
    expect(stage(all.funnel.both, "enrolled").count).toBe(5);
  });

  it("follows contacts down the funnel and says why the ones who dropped out did", () => {
    const { w } = scene();
    const { funnel } = campaignOverview(db(), w.ws, w.workflow, { range: "14d", now: NOW });
    expect(funnel.both.map((entry) => [entry.key, entry.count])).toEqual([["enrolled", 4], ["contacted", 3], ["delivered", 3], ["engaged", 2], ["replied", 1], ["positive", 1], ["meeting", 1]]);
    expect(stage(funnel.both, "contacted").drop).toEqual({ count: 1, reason: "skipped" });
    expect(stage(funnel.both, "engaged").drop).toEqual({ count: 1, reason: "no engagement" });
    expect(stage(funnel.both, "replied").drop).toEqual({ count: 1, reason: "silent" });
    // One channel at a time: the same contacts, counted only for what that channel did.
    expect(funnel.linkedin.map((entry) => entry.count)).toEqual([4, 2, 2, 1, 1, 1, 1]);
    expect(funnel.email.map((entry) => entry.count)).toEqual([4, 1, 1, 1, 0, 0, 0]);
  });

  it("counts a bounced email as not delivered, and someone not reached yet as waiting, not skipped", () => {
    const w = workspace();
    const bounced = contact(w);
    enrol(w, bounced, 3, { email: { state: "skipped", note: "Email bounced — invalid address" } });
    email(w, bounced, 2, { bounced: true });
    const waiting = contact(w);
    enrol(w, waiting, 1, { linkedin: "pending", email: "pending" });
    const { funnel, kpis } = campaignOverview(db(), w.ws, w.workflow, { range: "7d", now: NOW });
    expect(stage(funnel.both, "contacted")).toMatchObject({ count: 1, drop: { count: 1, reason: "not reached yet" } });
    expect(stage(funnel.both, "delivered")).toMatchObject({ count: 0, drop: { count: 1, reason: "bounced" } });
    // A bounced email was never there to be opened.
    expect(kpis.open.whole).toBe(0);
    expect(kpis.open.value).toBeNull();
  });

  it("gives a meeting to the campaign that last wrote to the contact before it was booked", () => {
    const { w, keen } = scene();
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES ('detail-wf-other', 'Another campaign', ?)").run(w.ws);
    // Another campaign wrote to the same contact after this one, and before the meeting.
    linkedin(w, keen, "message", 2.5, "detail-wf-other");
    const overview = campaignOverview(db(), w.ws, w.workflow, { range: "14d", now: NOW });
    expect(stage(overview.funnel.both, "positive").count).toBe(1);
    expect(stage(overview.funnel.both, "meeting").count).toBe(0);
  });

  it("looks at one channel when asked: rates, and the days' sends", () => {
    const { w } = scene();
    const emailOnly = campaignOverview(db(), w.ws, w.workflow, { range: "14d", channel: "email", now: NOW });
    expect(emailOnly.kpis.acceptance).toMatchObject({ whole: 0, value: null });
    expect(emailOnly.kpis.reply).toMatchObject({ part: 0, whole: 1 });
    expect(emailOnly.daily.reduce((sum, day) => sum + day.linkedin, 0)).toBe(0);
    expect(emailOnly.daily.reduce((sum, day) => sum + day.email, 0)).toBe(1);
    const linkedinOnly = campaignOverview(db(), w.ws, w.workflow, { range: "14d", channel: "linkedin", now: NOW });
    expect(linkedinOnly.kpis.open.whole).toBe(0);
    expect(linkedinOnly.variants).toEqual([]);
    expect(linkedinOnly.daily.reduce((sum, day) => sum + day.linkedin, 0)).toBe(2);
  });

  it("charts a fortnight of days, each with what went out and the replies that came in", () => {
    const { w } = scene();
    const { daily } = campaignOverview(db(), w.ws, w.workflow, { range: "14d", now: NOW });
    expect(daily).toHaveLength(14);
    expect(daily.at(-1)!.day).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(daily.reduce((sum, day) => sum + day.linkedin, 0)).toBe(2);
    // The LinkedIn reply counts; the out-of-office does not.
    expect(daily.reduce((sum, day) => sum + day.replies, 0)).toBe(1);
    expect(campaignOverview(db(), w.ws, w.workflow, { range: "30d", now: NOW }).daily).toHaveLength(30);
  });

  it("splits the opens into people and the machines that fetch mail by themselves", () => {
    const w = workspace();
    const reader = contact(w);
    enrol(w, reader, 2, { email: "in_progress" });
    email(w, reader, 2, { opened: true, bot: "scanner_user_agent" });
    email(w, reader, 1, { step: w.steps.e2, bot: "prefetch" });
    email(w, contact(w), 1, { bot: "automation_user_agent" });
    email(w, contact(w), 1, { bot: "known_bot_ip" });
    expect(campaignOverview(db(), w.ws, w.workflow, { now: NOW }).opens).toEqual({ raw: 5, human: 1, scanners: 2, prefetch: 1, automation: 1 });
  });

  /** Send an email's two versions to so many contacts each, with so many of them answering. */
  function abTest(w: Workspace, a: { sent: number; replies: number; opened?: number }, b: { sent: number; replies: number; opened?: number }) {
    for (const [version, variant] of [[a, null], [b, w.variant]] as const) {
      for (let index = 0; index < version.sent; index++) {
        const target = contact(w);
        const job = email(w, target, 3, { variant, opened: index < (version.opened ?? 0) });
        if (index < version.replies) emailReply(w, target, job, 2, index === 0 ? "positive" : "human_reply");
      }
    }
  }

  it("does not call an A/B test before each version has enough sends", () => {
    const w = workspace();
    abTest(w, { sent: 10, replies: 1 }, { sent: 10, replies: 4 });
    const [test] = campaignOverview(db(), w.ws, w.workflow, { now: NOW }).variants;
    expect(test).toMatchObject({ step_id: w.steps.e1, email_number: 1, even_split: true, confidence: null, significant: false, more_sends_needed: null, decided: false });
    expect(test.rows.map((row) => [row.label, row.sent, row.replies, row.positive])).toEqual([["A", 10, 1, 1], ["B", 10, 4, 1]]);
    // B is ahead so far, which is worth saying even before it can be relied on.
    expect(test.leader).toEqual({ variant_id: w.variant, label: "B" });
    expect(test.rows.map((row) => row.status)).toEqual(["control", "leading"]);
  });

  it("says how sure a gap is and how many more sends it needs when it is not yet sure", () => {
    const w = workspace();
    abTest(w, { sent: 40, replies: 4 }, { sent: 40, replies: 6 });
    const [test] = campaignOverview(db(), w.ws, w.workflow, { now: NOW }).variants;
    expect(test.significant).toBe(false);
    expect(test.confidence).toBeGreaterThan(0.45);
    expect(test.confidence).toBeLessThan(0.55);
    // 2 x 0.125 x 0.875 x (1.96 / 0.05)^2 is 337 sends a version; each has had 40.
    expect(test.more_sends_needed).toBe(297);
    expect(test.rows[1]).toMatchObject({ reply_rate: 0.15, status: "leading" });
  });

  it("calls a winner when the gap is more than chance, and shows the test as decided once one is promoted", () => {
    const w = workspace();
    abTest(w, { sent: 40, replies: 2 }, { sent: 40, replies: 10 });
    const [test] = campaignOverview(db(), w.ws, w.workflow, { range: "7d", now: NOW }).variants;
    expect(test).toMatchObject({ significant: true, more_sends_needed: null, leader: { label: "B" }, decided: false });
    expect(test.confidence).toBeGreaterThan(0.95);

    promoteVersion(db(), w.steps.e1, w.variant);
    const [after] = campaignOverview(db(), w.ws, w.workflow, { now: NOW }).variants;
    expect(after).toMatchObject({ decided: true, leader: null });
    expect(after.rows.map((row) => row.status)).toEqual(["paused", "winner"]);
  });

  it("notices when the versions are not sharing the sends equally", () => {
    const w = workspace();
    db().prepare("UPDATE workflow_step_email_variants SET weight = 3 WHERE id = ?").run(w.variant);
    abTest(w, { sent: 2, replies: 0 }, { sent: 2, replies: 0 });
    expect(campaignOverview(db(), w.ws, w.workflow, { now: NOW }).variants[0].even_split).toBe(false);
  });

  it("is read through its route by anyone in the workspace, and by nobody outside it", async () => {
    const { w } = scene();
    const ok = await call(overviewHandler, { method: "GET", query: { id: w.workflow, range: "7d", channel: "linkedin" }, headers: as(w, "viewer") });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.campaign).toMatchObject({ id: w.workflow, name: "Q4 Enterprise", status: "active" });
    expect(ok.body.overview).toMatchObject({ range: "7d", channel: "linkedin" });
    expect((await call(overviewHandler, { method: "GET", query: { id: w.workflow, range: "90d" }, headers: as(w, "viewer") })).statusCode).toBe(400);
    expect((await call(overviewHandler, { method: "GET", query: { id: w.workflow, channel: "fax" }, headers: as(w, "viewer") })).statusCode).toBe(400);
    const stranger = workspace();
    expect((await call(overviewHandler, { method: "GET", query: { id: w.workflow }, headers: as(stranger, "manager") })).statusCode).toBe(404);
  });

  describe("promoting a winner without being asked", () => {
    it("does nothing unless the campaign has it switched on", () => {
      const w = workspace();
      abTest(w, { sent: 40, replies: 2 }, { sent: 40, replies: 10 });
      expect(autoPromote(db())).toEqual([]);
      expect(db().prepare("SELECT email_control_disabled AS off FROM workflow_steps WHERE id = ?").get(w.steps.e1)).toEqual({ off: 0 });
    });

    it("pauses the losing versions once replies separate them, and says so", () => {
      const w = workspace();
      db().prepare("UPDATE workflows SET ab_auto_promote = 1 WHERE id = ?").run(w.workflow);
      abTest(w, { sent: 40, replies: 2 }, { sent: 40, replies: 10 });
      const promoted = autoPromote(db()).filter((entry) => entry.workflow_id === w.workflow);
      expect(promoted).toMatchObject([{ step_id: w.steps.e1, variant_id: w.variant, label: "B" }]);
      expect(db().prepare("SELECT email_control_disabled AS off FROM workflow_steps WHERE id = ?").get(w.steps.e1)).toEqual({ off: 1 });
      expect(db().prepare("SELECT disabled_at FROM workflow_step_email_variants WHERE id = ?").get(w.variant)).toEqual({ disabled_at: null });
      const note = db().prepare("SELECT title, link, kind FROM notifications WHERE workspace_id = ?").get(w.ws) as { title: string; link: string; kind: string };
      expect(note).toMatchObject({ kind: "campaign.ab_promoted", link: `/campaigns/${w.workflow}` });
      expect(note.title).toContain("Version B");
      const audit = db().prepare("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'workflow.ab_winner_chosen'").get(w.ws) as { metadata_json: string };
      expect(JSON.parse(audit.metadata_json)).toMatchObject({ automatic: true, variant_id: w.variant });
      // Decided: nothing left to promote the next time round.
      expect(autoPromote(db()).filter((entry) => entry.workflow_id === w.workflow)).toEqual([]);
    });

    it("does not act on opens alone, or on a campaign that is not running", () => {
      const onOpens = workspace();
      db().prepare("UPDATE workflows SET ab_auto_promote = 1 WHERE id = ?").run(onOpens.workflow);
      abTest(onOpens, { sent: 40, replies: 0, opened: 4 }, { sent: 40, replies: 0, opened: 30 });
      const paused = workspace("paused");
      db().prepare("UPDATE workflows SET ab_auto_promote = 1 WHERE id = ?").run(paused.workflow);
      abTest(paused, { sent: 40, replies: 2 }, { sent: 40, replies: 10 });
      expect(autoPromote(db()).filter((entry) => [onOpens.workflow, paused.workflow].includes(entry.workflow_id))).toEqual([]);
    });
  });
});

describe("a link to a campaign's report", () => {
  it("opens the campaign for whoever holds it, and keeps only a hash of itself", () => {
    const w = workspace();
    const made = createShare(db(), w.ws, w.workflow, w.user);
    if ("error" in made) throw new Error(made.error);
    expect(made.token.length).toBeGreaterThanOrEqual(32);
    expect(made.share).toMatchObject({ hint: made.token.slice(-4), views: 0, revoked_at: null, created_by: { id: w.user, name: "Morgan Hale" } });
    expect(JSON.stringify(db().prepare("SELECT * FROM report_shares WHERE id = ?").get(made.share.id))).not.toContain(made.token);

    expect(openShare(db(), made.token)).toEqual({ workspace_id: w.ws, workflow_id: w.workflow });
    expect(openShare(db(), made.token)).not.toBeNull();
    expect(listShares(db(), w.ws, w.workflow)[0]).toMatchObject({ views: 2 });
    expect(listShares(db(), w.ws, w.workflow)[0].last_viewed_at).toBeTruthy();
    expect(openShare(db(), `${made.token}x`)).toBeNull();
    expect(openShare(db(), "")).toBeNull();
  });

  it("stops working the moment it is switched off, and stays in the list", () => {
    const w = workspace();
    const made = createShare(db(), w.ws, w.workflow, w.user);
    if ("error" in made) throw new Error(made.error);
    expect(revokeShare(db(), w.ws, w.workflow, made.share.id)).toBe(true);
    expect(openShare(db(), made.token)).toBeNull();
    expect(revokeShare(db(), w.ws, w.workflow, made.share.id)).toBe(false);
    expect(listShares(db(), w.ws, w.workflow)).toMatchObject([{ id: made.share.id }]);
    expect(listShares(db(), w.ws, w.workflow)[0].revoked_at).toBeTruthy();
  });

  it("dies with its campaign, and a campaign can only have so many live at once", () => {
    const w = workspace();
    const tokens: string[] = [];
    for (let index = 0; index < MAX_LIVE_SHARES; index++) {
      const made = createShare(db(), w.ws, w.workflow, null);
      if ("error" in made) throw new Error(made.error);
      tokens.push(made.token);
    }
    expect(createShare(db(), w.ws, w.workflow, null)).toMatchObject({ error: expect.stringContaining("10 live links") });
    db().prepare("DELETE FROM runs WHERE workflow_id = ?").run(w.workflow);
    db().prepare("DELETE FROM workflows WHERE id = ?").run(w.workflow);
    expect(openShare(db(), tokens[0])).toBeNull();
  });

  it("is made and switched off by a manager; anyone in the workspace can see which exist", async () => {
    const w = workspace();
    expect((await call(shareHandler, { method: "POST", query: { id: w.workflow }, headers: as(w, "member") })).statusCode).toBe(403);
    const made = await call(shareHandler, { method: "POST", query: { id: w.workflow }, headers: as(w, "manager") });
    expect(made.statusCode).toBe(201);
    expect(made.body.path).toBe(`/r/${made.body.token}`);
    const listed = await call(shareHandler, { method: "GET", query: { id: w.workflow }, headers: as(w, "viewer") });
    expect(listed.body.shares).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.token);

    const stranger = workspace();
    expect((await call(shareHandler, { method: "DELETE", query: { id: w.workflow, share_id: made.body.share.id }, headers: as(stranger, "manager") })).statusCode).toBe(404);
    expect((await call(shareHandler, { method: "DELETE", query: { id: w.workflow, share_id: made.body.share.id }, headers: as(w, "manager") })).statusCode).toBe(200);
    expect(openShare(db(), made.body.token)).toBeNull();
    expect((await call(shareHandler, { method: "DELETE", query: { id: w.workflow, share_id: made.body.share.id }, headers: as(w, "manager") })).statusCode).toBe(404);
    const actions = (db().prepare("SELECT action FROM audit_logs WHERE workspace_id = ? ORDER BY rowid").all(w.ws) as { action: string }[]).map((row) => row.action);
    expect(actions).toEqual(["workflow.report_shared", "workflow.report_share_revoked"]);
  });
});

describe("a campaign's prospects", () => {
  /** One prospect in each state a person looking after the campaign tells apart. */
  function scene() {
    const w = workspace();
    const people = {
      going: contact(w, { full_name: "Avery Going" }), held: contact(w, { full_name: "Blake Held" }), failed: contact(w, { full_name: "Casey Failed" }),
      replied: contact(w, { full_name: "Drew Replied", last_replied_at: ago(1) }), done: contact(w, { full_name: "Emery Done" }), out: contact(w, { full_name: "Finley 100% Out", company: "Hooli" }),
    };
    const ids = {
      going: enrol(w, people.going, 3, { linkedin: { state: "in_progress", step: 2 }, email: { state: "pending", hold: "handover" } }),
      held: enrol(w, people.held, 3, { linkedin: { state: "in_progress", hold: "superseded:some-run" }, email: { state: "pending", hold: "superseded:some-run" } }),
      failed: enrol(w, people.failed, 2, { linkedin: { state: "failed", note: "Profile not found" }, email: "completed" }),
      replied: enrol(w, people.replied, 2, { linkedin: { state: "skipped", note: "Lead replied" }, email: { state: "skipped", note: "Lead replied" } }),
      done: enrol(w, people.done, 1, { linkedin: "completed", email: "completed" }),
      out: enrol(w, people.out, 1, { linkedin: { state: "skipped", note: "Manually unenrolled" } }),
    };
    return { w, people, ids };
  }

  it("tells each prospect's standing apart and counts them across the campaign", () => {
    const { w, ids } = scene();
    const page = campaignProspects(db(), w.ws, w.workflow);
    expect(page.total).toBe(6);
    expect(page.counts).toEqual({ all: 6, active: 1, held: 1, failed: 1, replied: 1, completed: 1, skipped: 1 });
    // Most in need of a look first.
    expect(page.prospects.map((row) => [row.id, row.status])).toEqual([[ids.going, "active"], [ids.held, "held"], [ids.failed, "failed"], [ids.replied, "replied"], [ids.done, "completed"], [ids.out, "skipped"]]);
    const going = page.prospects[0];
    expect(going).toMatchObject({ name: "Avery Going", list: "Enterprise VPs", linkedin_account: "Jordan Mertens" });
    expect(going.mailbox).toContain("@detail.test");
    // On the third LinkedIn step of three; the email track waits to be handed the contact.
    expect(going.linkedin).toMatchObject({ state: "in_progress", position: 3, of: 3, step_id: w.steps.message, step_type: "message", hold: null });
    expect(going.email_track).toMatchObject({ state: "pending", position: 1, of: 3, step_id: w.steps.e1, hold: "handover" });
    expect(page.prospects[1].linkedin).toMatchObject({ hold: "other_campaign" });
    expect(page.prospects[2].linkedin).toMatchObject({ state: "failed", note: "Profile not found", step_id: null });
    expect(page.prospects[3].replied_at).toBeTruthy();
    expect(page.runs).toMatchObject([{ id: w.run, list: "Enterprise VPs", enrolled: 6 }]);
  });

  it("filters by standing, by the step someone is on, and by a search that takes its text literally", () => {
    const { w, ids } = scene();
    const only = (query: Record<string, string>) => campaignProspects(db(), w.ws, w.workflow, query).prospects.map((row) => row.id);
    expect(only({ status: "failed,replied" })).toEqual([ids.failed, ids.replied]);
    expect(only({ status: "nonsense" })).toHaveLength(6);
    expect(only({ step_id: w.steps.message })).toEqual([ids.going]);
    // Standing on the first email: the one waiting for a hand-over, and the one another campaign holds.
    expect(only({ step_id: w.steps.e1 }).sort()).toEqual([ids.going, ids.held].sort());
    expect(only({ step_id: "not-a-step" })).toEqual([]);
    expect(only({ q: "hooli" })).toEqual([ids.out]);
    expect(only({ q: "100%" })).toEqual([ids.out]);
    expect(only({ q: "%" })).toEqual([ids.out]);
    expect(only({ q: "lead" }).length).toBe(6);  // every address has it
    expect(only({ sort: "name:desc", limit: "2" })).toEqual([ids.out, ids.done]);
    expect(only({ sort: "name:desc", limit: "2", page: "3" })).toEqual([ids.held, ids.going]);
    const steps = campaignProspects(db(), w.ws, w.workflow).steps;
    expect(steps.map((step) => [step.track, step.position, step.step_type])).toEqual([["linkedin", 1, "connect"], ["linkedin", 2, "delay"], ["linkedin", 3, "message"], ["email", 1, "email"], ["email", 2, "delay"], ["email", 3, "email"]]);
    expect(Object.fromEntries(steps.filter((step) => step.count > 0).map((step) => [step.id, step.count]))).toEqual({ [w.steps.connect]: 1, [w.steps.message]: 1, [w.steps.e1]: 2 });
  });

  it("retries what failed, unenrols who is still going, and removes an enrolment altogether", () => {
    const { w, ids } = scene();
    // Retrying only touches a failure; the campaign is running, so nothing is left waiting.
    expect(actOnProspects(db(), w.ws, w.workflow, "retry", [ids.failed, ids.done, "someone-elses"])).toEqual({ changed: 1, asked: 3, waiting: false });
    expect(campaignProspects(db(), w.ws, w.workflow, { status: "active" }).prospects.map((row) => row.id).sort()).toEqual([ids.failed, ids.going].sort());

    expect(actOnProspects(db(), w.ws, w.workflow, "unenroll", [ids.going, ids.held, ids.done])).toMatchObject({ changed: 2 });
    const page = campaignProspects(db(), w.ws, w.workflow, { status: "skipped" });
    expect(page.prospects.map((row) => row.id).sort()).toEqual([ids.going, ids.held, ids.out].sort());
    expect(page.prospects.find((row) => row.id === ids.held)!.linkedin).toMatchObject({ state: "skipped", note: "Manually unenrolled", hold: null });

    expect(actOnProspects(db(), w.ws, w.workflow, "remove", [ids.out])).toMatchObject({ changed: 1 });
    expect(campaignProspects(db(), w.ws, w.workflow).counts.all).toBe(5);
    expect(db().prepare("SELECT COUNT(*) AS c FROM run_profile_tracks WHERE run_profile_id = ?").get(ids.out)).toEqual({ c: 0 });
  });

  it("says a retry is waiting when the campaign is not running, and never touches another campaign's prospects", () => {
    const paused = workspace("paused");
    const stuck = enrol(paused, contact(paused), 1, { linkedin: { state: "failed", note: "Timed out" } });
    expect(actOnProspects(db(), paused.ws, paused.workflow, "retry", [stuck])).toEqual({ changed: 1, asked: 1, waiting: true });
    const other = workspace();
    const theirs = enrol(other, contact(other), 1);
    expect(actOnProspects(db(), paused.ws, paused.workflow, "remove", [theirs])).toMatchObject({ changed: 0 });
    expect(actOnProspects(db(), other.ws, paused.workflow, "remove", [stuck])).toMatchObject({ changed: 0 });
    expect(db().prepare("SELECT COUNT(*) AS c FROM run_profiles WHERE id IN (?, ?)").get(theirs, stuck)).toEqual({ c: 2 });
  });

  it("adds a list or named contacts to the run in flight, leaving out whoever the campaign leaves out", () => {
    const w = workspace();
    saveSetup(db(), w.workflow, { exclude: { customers: true, open_deals: false }, email_account_ids: [w.mailbox] });
    const already = contact(w); enrol(w, already, 2);
    const fresh = contact(w);
    const customer = contact(w);
    db().prepare("INSERT INTO opportunities (id, workspace_id, target_id, stage_id, name, closed_at) VALUES (?, ?, ?, ?, 'Deal', ?)").run(`detail-opp-${++seq}`, w.ws, customer, `${w.ws}:stage:won`, ago(30));
    const added = addProspects(db(), w.ws, w.workflow, { list_id: w.list });
    expect(added).toEqual({ ok: true, run_id: w.run, asked: 3, enrolled: 1, already_enrolled: 1, excluded: 1, in_another_campaign: 0 });
    const row = campaignProspects(db(), w.ws, w.workflow, { q: "lead" }).prospects.find((prospect) => prospect.target_id === fresh)!;
    // Both tracks, from the first step, with a mailbox and the run's LinkedIn account.
    expect(row).toMatchObject({ status: "active", linkedin: { state: "pending", position: 1 }, email_track: { state: "pending", position: 1 }, linkedin_account: "Jordan Mertens" });
    expect(row.mailbox).toContain("@detail.test");

    // By name: someone not in any list. Asking twice enrols nobody twice.
    const loose = `detail-loose-${++seq}`;
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, email, email_status) VALUES (?, ?, 'Gray Loose', 'gray@prospect.test', 'verified')").run(loose, w.ws);
    expect(addProspects(db(), w.ws, w.workflow, { target_ids: [loose, loose] })).toMatchObject({ ok: true, asked: 1, enrolled: 1 });
    expect(addProspects(db(), w.ws, w.workflow, { target_ids: [loose] })).toMatchObject({ ok: true, enrolled: 0, already_enrolled: 1 });
  });

  it("refuses to add to a campaign that is not running, a list from elsewhere, or contacts from elsewhere", () => {
    const stopped = workspace("completed");
    expect(addProspects(db(), stopped.ws, stopped.workflow, { list_id: stopped.list })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("not running") });
    const w = workspace();
    const other = workspace();
    expect(addProspects(db(), w.ws, w.workflow, { list_id: other.list })).toMatchObject({ ok: false, status: 404 });
    expect(addProspects(db(), w.ws, w.workflow, { target_ids: [contact(other)] })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("outside this workspace") });
    expect(addProspects(db(), w.ws, w.workflow, {})).toMatchObject({ ok: false, status: 400 });
  });

  it("leaves a contact who is part-way through another campaign where they are", () => {
    const w = workspace();
    const busy = contact(w);
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'The other one', ?)").run(`detail-wf-${++seq}`, w.ws);
    db().prepare("INSERT INTO runs (id, workflow_id, workspace_id, list_id, account_id, status) VALUES (?, ?, ?, ?, ?, 'running')").run(`detail-keep-${seq}`, `detail-wf-${seq}`, w.ws, w.list, w.account);
    enrol(w, busy, 1, { linkedin: "in_progress" }, `detail-keep-${seq}`);
    expect(addProspects(db(), w.ws, w.workflow, { target_ids: [busy] })).toMatchObject({ ok: true, enrolled: 0, in_another_campaign: 1 });
    db().prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(`detail-keep-${seq}`);
  });

  it("is read by anyone in the workspace and changed only by a manager, through its route", async () => {
    const { w, ids } = scene();
    const read = await call(prospectsHandler, { method: "GET", query: { id: w.workflow, status: "failed" }, headers: as(w, "viewer") });
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ total: 1, page: 1, limit: 25, counts: { all: 6 } });
    expect((await call(prospectsHandler, { method: "POST", query: { id: w.workflow }, body: { action: "retry", ids: [ids.failed] }, headers: as(w, "member") })).statusCode).toBe(403);
    expect((await call(prospectsHandler, { method: "POST", query: { id: w.workflow }, body: { action: "launch", ids: [ids.failed] }, headers: as(w, "manager") })).statusCode).toBe(400);
    expect((await call(prospectsHandler, { method: "POST", query: { id: w.workflow }, body: { action: "retry", ids: [] }, headers: as(w, "manager") })).statusCode).toBe(400);
    const retried = await call(prospectsHandler, { method: "POST", query: { id: w.workflow }, body: { action: "retry", ids: [ids.failed] }, headers: as(w, "manager") });
    expect(retried.body).toEqual({ changed: 1, asked: 1, waiting: false });
    const added = await call(prospectsHandler, { method: "POST", query: { id: w.workflow }, body: { action: "add", target_ids: [contact(w)] }, headers: as(w, "manager") });
    expect(added.body).toMatchObject({ run_id: w.run, enrolled: 1 });
    expect(added.body.ok).toBeUndefined();
    const actions = (db().prepare("SELECT action FROM audit_logs WHERE workspace_id = ? ORDER BY rowid").all(w.ws) as { action: string }[]).map((row) => row.action);
    expect(actions).toEqual(["workflow.prospects_retried", "workflow.prospects_added"]);
    const stranger = workspace();
    expect((await call(prospectsHandler, { method: "GET", query: { id: w.workflow }, headers: as(stranger, "manager") })).statusCode).toBe(404);
  });

  it("exports the prospects that were on screen, with their standing", async () => {
    const { w } = scene();
    const file = await call(exportHandler, { method: "GET", query: { resource: "prospects", workflow_id: w.workflow, status: "failed,replied" }, headers: as(w, "manager") });
    expect(file.statusCode).toBe(200);
    const lines = file.text.trim().split(/\r?\n/);
    expect(lines[0]).toContain("Status");
    expect(lines).toHaveLength(3);
    expect(file.text).toContain("Casey Failed");
    expect(file.text).toContain("Drew Replied");
    const onStep = await call(exportHandler, { method: "GET", query: { resource: "prospects", workflow_id: w.workflow, step_id: w.steps.message }, headers: as(w, "manager") });
    expect(onStep.text.trim().split(/\r?\n/)).toHaveLength(2);
    expect(onStep.text).toContain("Avery Going");
  });

  it("keeps a log of what the campaign did, newest first, a page at a time", async () => {
    const w = workspace();
    const who = contact(w, { full_name: "Harper Logged" });
    for (let index = 1; index <= 5; index++) {
      db().prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, ?, ?, ?)").run(`detail-log-${w.run}-${index}`, w.run, index % 2 ? who : null, index === 4 ? "error" : "info", `Entry ${index}`);
    }
    const first = campaignLog(db(), w.ws, w.workflow, { limit: 2 });
    expect(first.entries.map((entry) => entry.message)).toEqual(["Entry 5", "Entry 4"]);
    expect(first.entries[0]).toMatchObject({ contact: "Harper Logged", target_id: who });
    expect(first.more).toBe(true);
    const rest = campaignLog(db(), w.ws, w.workflow, { limit: 10, before: first.entries[1].id });
    expect(rest.entries.map((entry) => entry.message)).toEqual(["Entry 3", "Entry 2", "Entry 1"]);
    expect(rest.more).toBe(false);
    expect(campaignLog(db(), w.ws, w.workflow, { level: "error" }).entries.map((entry) => entry.message)).toEqual(["Entry 4"]);
    const other = workspace();
    expect(campaignLog(db(), other.ws, w.workflow).entries).toEqual([]);
    const viaRoute = await call(logHandler, { method: "GET", query: { id: w.workflow, limit: "1" }, headers: as(w, "viewer") });
    expect(viaRoute.body).toMatchObject({ entries: [{ message: "Entry 5" }], more: true });
  });
});

describe("a campaign's settings", () => {
  it("reads what the campaign is set up with, and what the run in flight is using", () => {
    const w = workspace();
    enrol(w, contact(w), 1);
    const settings = campaignSettings(db(), w.ws, w.workflow)!;
    expect(settings).toMatchObject({
      name: "Q4 Enterprise", owner_id: null, send_in_recipient_tz: false, ab_auto_promote: false, archived: false, enrolled: 1,
      run: { id: w.run, status: "running", in_flight: 1 },
      setup: { account_ids: [w.account], rotation: "round_robin" },
    });
    expect(settings.channels.sort()).toEqual(["email", "linkedin"]);
    expect(settings.tracking).toEqual([
      { step_id: w.steps.e1, email_number: 1, subject: "Intro", opens: false, clicks: false },
      { step_id: w.steps.e2, email_number: 2, subject: "Following up", opens: false, clicks: false },
    ]);
    expect(campaignSettings(db(), "ws-nobody", w.workflow)).toBeNull();
  });

  it("lets a member rename a campaign and hand it on, but not change how a running one sends", async () => {
    const w = workspace();
    enrol(w, contact(w), 1);
    const member = as(w, "member");
    const renamed = await call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body: { name: "  Q4 Enterprise, US  ", description: "VPs of Sales", owner_id: `${w.user}-member` }, headers: member });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.body.settings).toMatchObject({ name: "Q4 Enterprise, US", description: "VPs of Sales", owner_id: `${w.user}-member` });
    expect(renamed.body.members.map((entry: { id: string }) => entry.id)).toContain(`${w.user}-member`);
    expect(renamed.body.campaign).toMatchObject({ name: "Q4 Enterprise, US", owner: { id: `${w.user}-member` } });

    for (const change of [{ send_in_recipient_tz: true }, { ab_auto_promote: true }, { setup: { exclude: { customers: false } } }, { tracking: [{ step_id: w.steps.e1, opens: true }] }]) {
      expect((await call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body: change, headers: member })).statusCode).toBe(403);
    }
    expect((await call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body: { name: "x" }, headers: as(w, "viewer") })).statusCode).toBe(403);
    expect((await call(settingsHandler, { method: "GET", query: { id: w.workflow }, headers: as(w, "viewer") })).statusCode).toBe(200);
  });

  it("lets a member change anything about a campaign nobody is part-way through", async () => {
    const w = workspace("completed");
    const saved = await call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body: { send_in_recipient_tz: true, ab_auto_promote: true, setup: { exclude: { customers: false, open_deals: true } } }, headers: as(w, "member") });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings).toMatchObject({ send_in_recipient_tz: true, ab_auto_promote: true, run: null, setup: { exclude: { customers: false, open_deals: true } } });
  });

  it("refuses what cannot be kept", async () => {
    const w = workspace();
    const other = workspace();
    const put = (body: Record<string, unknown>) => call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body, headers: as(w, "manager") });
    expect((await put({ name: "   " })).statusCode).toBe(400);
    expect((await put({ owner_id: other.user })).body.error).toContain("member of this workspace");
    expect((await put({ setup: { account_ids: [other.account] } })).statusCode).toBe(400);
    expect((await put({ setup: { email_account_ids: [other.mailbox] } })).statusCode).toBe(400);
    // A running campaign with LinkedIn steps cannot be left with no account to run them from.
    expect((await put({ setup: { account_ids: [] } })).body.error).toContain("at least one LinkedIn account");
    expect((await put({ tracking: [{ step_id: w.steps.connect, opens: true }] })).body.error).toContain("not one of this campaign's emails");
    expect((await put({ tracking: "all" })).statusCode).toBe(400);
    expect((await call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body: { name: "Theirs" }, headers: as(other, "manager") })).statusCode).toBe(404);
  });

  it("gives new LinkedIn accounts to the run in flight: who has started stays, who has not is shared out again", async () => {
    const w = workspace();
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Sam Second', 'second@detail.test', 1, ?)").run(`${w.account}-b`, w.ws);
    const started = enrol(w, contact(w), 2, { linkedin: { state: "in_progress", step: 1 } });
    const waiting = [enrol(w, contact(w, { company: "One" }), 1, { linkedin: "pending" }), enrol(w, contact(w, { company: "Two" }), 1, { linkedin: "pending" })];
    const saved = await call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body: { setup: { account_ids: [`${w.account}-b`], rotation: "round_robin" } }, headers: as(w, "manager") });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.pool).toMatchObject({ pool: [`${w.account}-b`], reassigned: 2, finishing_elsewhere: 1 });
    expect(saved.body.settings.setup.account_ids).toEqual([`${w.account}-b`]);
    // An enrolment with no account of its own is worked by the run's.
    const accountOf = (id: string) => (db().prepare("SELECT COALESCE(rp.account_id, r.account_id) AS account_id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE rp.id = ?").get(id) as { account_id: string }).account_id;
    expect(accountOf(started)).toBe(w.account);
    expect(waiting.map(accountOf)).toEqual([`${w.account}-b`, `${w.account}-b`]);
    // Saving the same again changes nothing.
    const again = await call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body: { setup: { account_ids: [`${w.account}-b`] } }, headers: as(w, "manager") });
    expect(again.body.pool).toBeNull();
  });

  it("switches tracking on for an email, sending it as HTML, and keeps an unpublished draft in step", async () => {
    const w = workspace();
    const draftSteps = BOTH.map((step) => ({ ...step, id: step.key ? w.steps[step.key] : undefined, email_track_opens: 0 }));
    saveDraft(db(), w.ws, w.workflow, w.user, { steps: draftSteps as StepInput[], gates: [] });
    const saved = await call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body: { tracking: [{ step_id: w.steps.e1, opens: true, clicks: false }] }, headers: as(w, "manager") });
    expect(saved.body.settings.tracking[0]).toMatchObject({ opens: true, clicks: false });
    expect(saved.body.settings.tracking[1]).toMatchObject({ opens: false, clicks: false });
    expect(db().prepare("SELECT email_delivery_mode AS mode, email_track_opens AS opens FROM workflow_steps WHERE id = ?").get(w.steps.e1)).toEqual({ mode: "enhanced", opens: 1 });
    const inDraft = getDraft(db(), w.workflow)!.draft.steps.find((step) => step.id === w.steps.e1)!;
    expect(inDraft).toMatchObject({ email_track_opens: 1, email_track_clicks: 0, email_delivery_mode: "enhanced" });
    // Switching it off again leaves the email as HTML: that is a choice about how it looks.
    await call(settingsHandler, { method: "PUT", query: { id: w.workflow }, body: { tracking: [{ step_id: w.steps.e1, opens: false, clicks: false }] }, headers: as(w, "manager") });
    expect(db().prepare("SELECT email_delivery_mode AS mode, email_track_opens AS opens FROM workflow_steps WHERE id = ?").get(w.steps.e1)).toEqual({ mode: "enhanced", opens: 0 });
  });

  it("lets a member delete a campaign that never enrolled anyone, and asks for a manager once it has", async () => {
    const draft = workspace("completed");
    expect((await call(workflowHandler, { method: "DELETE", query: { id: draft.workflow }, headers: as(draft, "member") })).statusCode).toBe(200);
    const used = workspace("completed");
    enrol(used, contact(used), 5, { linkedin: "completed" });
    const refused = await call(workflowHandler, { method: "DELETE", query: { id: used.workflow }, headers: as(used, "member") });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.error).toContain("Archive it instead");
    expect((await call(workflowHandler, { method: "DELETE", query: { id: used.workflow }, headers: as(used, "manager") })).statusCode).toBe(200);
    expect(db().prepare("SELECT COUNT(*) AS c FROM workflows WHERE id = ?").get(used.workflow)).toEqual({ c: 0 });
  });
});
