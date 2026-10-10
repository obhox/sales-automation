// Reports over a period: what a range is, which contacts a period's funnel follows, how a
// campaign's sends split and which send a reply is credited to, and when one email version
// can be called ahead of another. Real (throwaway) database.
import { describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { daysOf, lastDays, parseRange, type ReportRange } from "@/lib/reporting/range";
import { likelyWinner, proportionPValue } from "@/lib/reporting/stats";
import { campaignAnalytics } from "@/lib/reporting/campaign-analytics";
import { campaignBreakdown } from "@/lib/reporting/breakdown";
import analyticsRoute from "@/pages/api/workflows/[id]/analytics";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;
const NOON = Date.parse("2026-10-10T12:00:00Z");
const period = (from: string, to: string) => parseRange({ from, to }, NOON) as ReportRange;
const allTime = () => lastDays(30, NOON);

describe("a range", () => {
  it("is the last thirty days for the charts when nothing is asked for, and names no period", () => {
    expect(parseRange({}, NOON)).toEqual({ fromDay: "2026-09-11", toDay: "2026-10-10", from: "2026-09-11 00:00:00", to: "2026-10-11 00:00:00", explicit: false });
  });

  it("keeps the chart window between a week and ninety days", () => {
    expect(daysOf(parseRange({ days: "3" }, NOON) as ReportRange)).toHaveLength(7);
    expect(daysOf(parseRange({ days: "400" }, NOON) as ReportRange)).toHaveLength(90);
    expect(daysOf(parseRange({ days: "14" }, NOON) as ReportRange)).toHaveLength(14);
  });

  it("covers both of its days when named, and runs to today when only the start is given", () => {
    expect(period("2026-09-01", "2026-09-03")).toEqual({ fromDay: "2026-09-01", toDay: "2026-09-03", from: "2026-09-01 00:00:00", to: "2026-09-04 00:00:00", explicit: true });
    expect(daysOf(period("2026-09-01", "2026-09-03"))).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(parseRange({ from: "2026-10-08" }, NOON)).toMatchObject({ toDay: "2026-10-10", explicit: true });
  });

  it.each([
    [{ from: "last week" }, /from must be a date/], [{ from: "2026-02-30" }, /from must be a date/], [{ from: "2026-09-01", to: "soon" }, /to must be a date/],
    [{ from: "2026-09-10", to: "2026-09-01" }, /not be after/], [{ from: "2024-01-01", to: "2026-01-01" }, /at most 366 days/], [{ to: "2026-09-01" }, /needs a from/],
  ] as Array<[Record<string, string>, RegExp]>)("is refused for %j", (query, reason) => {
    expect(parseRange(query, NOON)).toMatch(reason);
  });
});

describe("telling two rates apart", () => {
  it("sees no difference between equal rates and a clear one between very different rates", () => {
    expect(proportionPValue(10, 100, 10, 100)).toBeCloseTo(1, 5);
    expect(proportionPValue(30, 100, 10, 100)).toBeLessThan(0.001);
    // 12% against 10% on a hundred sends each is well within chance.
    expect(proportionPValue(12, 100, 10, 100)).toBeGreaterThan(0.5);
    expect(proportionPValue(0, 0, 5, 10)).toBe(1);
  });

  it("matches a worked example", () => {
    // 45/200 against 25/200: z = 2.626, two-sided p = 0.0086.
    expect(proportionPValue(45, 200, 25, 200)).toBeCloseTo(0.0086, 3);
  });
});

describe("calling a winner", () => {
  const v = (id: string | null, sent: number, replies: number, opened = 0) => ({ id, sent, replies, opened });

  it("names the version ahead on replies by more than chance", () => {
    expect(likelyWinner([v(null, 200, 10), v("b", 200, 30)])).toMatchObject({ id: "b", metric: "replies" });
    expect(likelyWinner([v(null, 200, 30), v("b", 200, 10)])).toMatchObject({ id: null, metric: "replies" });
  });

  it("names nobody while the gap could be chance", () => {
    expect(likelyWinner([v(null, 100, 10, 40), v("b", 100, 12, 42)])).toBeNull();
  });

  it("names nobody until every version still sending has enough sends", () => {
    expect(likelyWinner([v(null, 200, 10), v("b", 12, 6)])).toBeNull();
    expect(likelyWinner([v(null, 200, 10)])).toBeNull();
    // A version that never sent is not in the test at all.
    expect(likelyWinner([v(null, 200, 10), v("b", 200, 30), v("c", 0, 0)])).toMatchObject({ id: "b" });
  });

  it("has to beat every other version, not only the worst", () => {
    expect(likelyWinner([v(null, 200, 5), v("b", 200, 30), v("c", 200, 28)])).toBeNull();
  });

  it("goes by opens when replies do not separate the versions, and says that it did", () => {
    // Too few replies to say anything.
    expect(likelyWinner([v(null, 200, 1, 40), v("b", 200, 2, 90)])).toMatchObject({ id: "b", metric: "opens" });
    // Plenty of replies, but level.
    expect(likelyWinner([v(null, 200, 20, 40), v("b", 200, 21, 90)])).toMatchObject({ id: "b", metric: "opens" });
    // Replies do separate them: opens pointing the other way do not get a say.
    expect(likelyWinner([v(null, 200, 30, 40), v("b", 200, 10, 90)])).toMatchObject({ id: null, metric: "replies" });
  });
});

/** A campaign with an email step (one variant) and a follow-up, a connect and a message step, a mailbox and a LinkedIn account. */
function campaign() {
  const n = ++seq;
  const ws = `ws-rep-${n}`;
  const c = {
    ws, n, workflow: `rep-wf-${n}`, run: `rep-run-${n}`, mailbox: `rep-mailbox-${n}`, account: `rep-li-${n}`, template: `rep-tmpl-${n}`,
    email1: `rep-email1-${n}`, email2: `rep-email2-${n}`, connect: `rep-connect-${n}`, message: `rep-message-${n}`, variant: `rep-variant-${n}`,
    headers: ctxHeaders(ws),
  };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Ada on LinkedIn', ?, 1, ?)").run(c.account, `rep${n}@example.com`, ws);
  db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, 'Outbound', ?, 'smtp.test.com', 'user', 'pass')").run(c.mailbox, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO templates (id, workspace_id, name, body) VALUES (?, ?, 'Soft opener', 'Hi')").run(c.template, ws);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(c.workflow, ws);
  const step = (id: string, order: number, track: string, type: string, subject: string | null = null) =>
    db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body) VALUES (?, ?, ?, ?, ?, 0, ?, ?)").run(id, c.workflow, order, track, type, subject, subject ? "Body" : null);
  step(c.email1, 1, "email", "email", "Quick question");
  step(c.email2, 2, "email", "email", "Following up");
  step(c.connect, 1, "linkedin", "connect");
  step(c.message, 2, "linkedin", "message");
  db().prepare("INSERT INTO workflow_step_email_variants (id, step_id, subject, body, position) VALUES (?, ?, 'A different question', 'Body', 0)").run(c.variant, c.email1);
  db().prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, 'running', ?)").run(c.run, c.workflow, c.account, ws);

  const contact = (name: string, extra: Record<string, unknown> = {}) => {
    const id = `rep-target-${++seq}`;
    const row: Record<string, unknown> = { id, workspace_id: ws, full_name: name, email: `${id}@prospect.test`, linkedin_url: `https://www.linkedin.com/in/${id}/`, ...extra };
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO targets (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`rp-${id}`, c.run, id, c.mailbox);
    return id;
  };
  /** An email the campaign sent: the job, the sent message, the log line and the send fact, as the engine leaves them. Returns the job id. */
  const email = (target: string, stepId: string, at: string, variantId: string | null = null) => {
    const job = `rep-job-${++seq}`;
    db().prepare(`INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, recipient, subject, body_text, source, target_id, run_id, step_id, variant_id, track_opens, created_at)
      VALUES (?, ?, ?, ?, 'x@prospect.test', 'Quick question', 'Body', 'campaign', ?, ?, ?, ?, 1, ?)`).run(job, ws, c.mailbox, job, target, c.run, stepId, variantId, at);
    db().prepare("INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, target_id, run_id, recipient, subject, message_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?, 'x@prospect.test', 'Quick question', ?, ?)")
      .run(`sm-${job}`, ws, job, c.mailbox, target, c.run, `<${job}@acme.test>`, at);
    db().prepare("INSERT INTO logs (id, run_id, target_id, level, message, created_at) VALUES (?, ?, ?, 'info', 'Email sent to x@prospect.test', ?)").run(`log-${job}`, c.run, target, at);
    db().prepare("INSERT INTO step_sends (id, workspace_id, run_id, workflow_id, step_id, target_id, channel, action, email_account_id, variant_id, email_job_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'email', 'email', ?, ?, ?, ?)")
      .run(`ss-${job}`, ws, c.run, c.workflow, stepId, target, c.mailbox, variantId, job, at);
    return job;
  };
  const linkedin = (target: string, stepId: string | null, action: "connect" | "message" | "visit", at: string, templateId: string | null = null) => {
    const id = `rep-li-send-${++seq}`;
    const line = { connect: "Connection request sent", message: "Message sent", visit: "Visited profile" }[action];
    db().prepare("INSERT INTO logs (id, run_id, target_id, level, message, created_at) VALUES (?, ?, ?, 'info', ?, ?)").run(`log-${id}`, c.run, target, line, at);
    db().prepare("INSERT INTO step_sends (id, workspace_id, run_id, workflow_id, step_id, target_id, channel, action, account_id, template_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'linkedin', ?, ?, ?, ?)")
      .run(id, ws, c.run, c.workflow, stepId, target, action, c.account, templateId, at);
  };
  const reply = (target: string, at: string, extra: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = { id: `rep-reply-${++seq}`, workspace_id: ws, target_id: target, from_email: "x@prospect.test", subject: "Re: Quick question", body_text: "Sure.", received_at: at, run_id: c.run, ...extra };
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO email_replies (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
    db().prepare("UPDATE targets SET email_replied_at = ?, reply_kind = COALESCE(reply_kind, 'positive') WHERE id = ?").run(at, target);
  };
  const opened = (job: string, at: string, bot = 0) =>
    db().prepare("INSERT INTO sender_events (id, workspace_id, email_account_id, sent_message_id, provider, event_type, occurred_at, is_bot) VALUES (?, ?, ?, ?, 'tracking', 'opened', ?, ?)").run(`ev-${++seq}`, ws, c.mailbox, `sm-${job}`, at, bot);
  return { ...c, contact, email, linkedin, reply, opened };
}

describe("a campaign's funnel over a period", () => {
  function twoWaves() {
    const c = campaign();
    const early = c.contact("Early Bird");
    const late = c.contact("Late Comer");
    const earlyJob = c.email(early, c.email1, "2026-09-01 10:00:00");
    c.email(early, c.email2, "2026-09-20 10:00:00");       // a follow-up inside the later period
    c.email(late, c.email1, "2026-09-21 10:00:00");
    c.opened(earlyJob, "2026-09-22 09:00:00");
    c.reply(early, "2026-09-22 10:00:00");                  // answered during the later period
    return { c, early, late };
  }

  it("is of everyone, for all time, when no period is named", () => {
    const { c } = twoWaves();
    const data = campaignAnalytics(db(), c.workflow, allTime());
    expect(data.range.explicit).toBe(false);
    expect(data.funnel).toMatchObject({ total: 2, emails_sent: 2, email_replies: 1, emails_opened: 1 });
    expect(data.audience).toMatchObject({ enrolled: 2, contacted: 2, replied: 1 });
  });

  it("follows the contacts first contacted in the period, whenever they answered", () => {
    const { c } = twoWaves();
    const first = campaignAnalytics(db(), c.workflow, period("2026-09-01", "2026-09-14"));
    expect(first.funnel).toMatchObject({ total: 1, emails_sent: 1, email_replies: 1, emails_opened: 1 });
    expect(first.audience).toMatchObject({ enrolled: 1, contacted: 1, replied: 1 });
  });

  it("does not credit a later period with a reply to mail first sent before it", () => {
    const { c } = twoWaves();
    const second = campaignAnalytics(db(), c.workflow, period("2026-09-15", "2026-09-30"));
    // Early Bird got a follow-up and replied in this period, but was first contacted before it.
    expect(second.funnel).toMatchObject({ total: 1, emails_sent: 1, email_replies: 0, emails_opened: 0 });
    expect(second.audience).toMatchObject({ enrolled: 1, replied: 0 });
  });

  it("charts what happened on each day of the period, cohort or not", () => {
    const { c } = twoWaves();
    const second = campaignAnalytics(db(), c.workflow, period("2026-09-15", "2026-09-30"));
    expect(second.activity).toHaveLength(16);
    expect(second.activity.map((day) => day.day).slice(0, 2)).toEqual(["2026-09-15", "2026-09-16"]);
    // Both emails of the period are on the chart, including the follow-up to the earlier contact.
    expect(Object.fromEntries(second.activity.filter((day) => day.emails || day.opens).map((day) => [day.day, [day.emails, day.opens]]))).toEqual({
      "2026-09-20": [1, 0], "2026-09-21": [1, 0], "2026-09-22": [0, 1],
    });
  });

  it("is empty for a period nothing happened in", () => {
    const { c } = twoWaves();
    const data = campaignAnalytics(db(), c.workflow, period("2026-01-01", "2026-01-31"));
    expect(data.funnel).toMatchObject({ total: 0, emails_sent: 0, email_replies: 0 });
    expect(data.activity.every((day) => day.emails === 0)).toBe(true);
  });
});

describe("crediting a reply to a send", () => {
  const row = (rows: Array<{ label: string }>, label: RegExp) => rows.find((entry) => label.test(entry.label));

  it("goes to the email it names, not the last one sent", () => {
    const c = campaign();
    const lee = c.contact("Lee");
    const first = c.email(lee, c.email1, "2026-09-01 10:00:00");
    c.email(lee, c.email2, "2026-09-05 10:00:00");
    c.reply(lee, "2026-09-06 10:00:00", { in_reply_to_job_id: first });
    const { rows } = campaignBreakdown(db(), c.workflow, "step", allTime());
    expect(row(rows, /Email step 1/)).toMatchObject({ sent: 1, contacts: 1, replied: 1 });
    expect(row(rows, /Email step 2/)).toMatchObject({ sent: 1, replied: 0 });
  });

  it("goes to the last email before it when it names none of ours", () => {
    const c = campaign();
    const lee = c.contact("Lee");
    c.email(lee, c.email1, "2026-09-01 10:00:00");
    c.email(lee, c.email2, "2026-09-05 10:00:00");
    c.reply(lee, "2026-09-06 10:00:00");
    c.reply(lee, "2026-09-03 10:00:00");   // one that arrived between the two
    const { rows } = campaignBreakdown(db(), c.workflow, "step", allTime());
    expect(row(rows, /Email step 1/)?.replied).toBe(1);
    expect(row(rows, /Email step 2/)?.replied).toBe(1);
  });

  it("does not count an out-of-office, a reply that came before any send, or one filed under another campaign", () => {
    const c = campaign();
    const other = campaign();
    const lee = c.contact("Lee");
    c.email(lee, c.email1, "2026-09-02 10:00:00");
    c.reply(lee, "2026-09-03 10:00:00", { classification_json: JSON.stringify({ kind: "out_of_office" }) });
    c.reply(lee, "2026-09-01 10:00:00");
    c.reply(lee, "2026-09-04 10:00:00", { run_id: other.run });
    c.reply(lee, "2026-09-05 10:00:00", { classification_json: "not json" });   // unreadable verdict: still a reply
    expect(row(campaignBreakdown(db(), c.workflow, "step", allTime()).rows, /Email step 1/)).toMatchObject({ sent: 1, replied: 1 });
    expect(campaignBreakdown(db(), other.workflow, "step", allTime()).rows).toEqual([]);
  });

  it("credits a LinkedIn reply to the last request or message before it, and counts accepted requests", () => {
    const c = campaign();
    const lee = c.contact("Lee", { last_replied_at: "2026-09-07 10:00:00", connected_at: "2026-09-03 10:00:00" });
    const mo = c.contact("Mo");
    c.linkedin(lee, c.connect, "connect", "2026-09-02 10:00:00");
    c.linkedin(lee, c.message, "message", "2026-09-06 10:00:00", c.template);
    c.linkedin(lee, c.message, "message", "2026-09-08 10:00:00");   // after the reply
    c.linkedin(mo, c.connect, "connect", "2026-09-02 11:00:00");
    const { rows } = campaignBreakdown(db(), c.workflow, "step", allTime());
    expect(row(rows, /LinkedIn step 1 · Connect/)).toMatchObject({ channel: "linkedin", sent: 2, contacts: 2, requests: 2, accepted: 1, replied: 0 });
    expect(row(rows, /LinkedIn step 2 · Message/)).toMatchObject({ sent: 2, contacts: 1, replied: 1 });
  });
});

describe("splitting a campaign's sends", () => {
  function mixed() {
    const c = campaign();
    const lee = c.contact("Lee");
    const mo = c.contact("Mo");
    const control = c.email(lee, c.email1, "2026-09-01 10:00:00");
    const variant = c.email(mo, c.email1, "2026-09-10 10:00:00", c.variant);
    c.opened(variant, "2026-09-10 12:00:00");
    c.opened(variant, "2026-09-10 13:00:00");       // a second look is still one email opened
    c.opened(control, "2026-09-01 10:00:05", 1);    // a scanner
    c.reply(mo, "2026-09-11 10:00:00", { in_reply_to_job_id: variant });
    c.linkedin(lee, c.message, "message", "2026-09-02 10:00:00", c.template);
    c.linkedin(mo, c.message, "message", "2026-09-12 10:00:00");
    c.linkedin(mo, null, "visit", "2026-08-01 10:00:00");   // history from before steps were recorded
    return c;
  }

  it("by step, in the campaign's order, with unrecorded history kept apart", () => {
    const c = mixed();
    const { rows } = campaignBreakdown(db(), c.workflow, "step", allTime());
    expect(rows.map((entry) => entry.label)).toEqual(["LinkedIn step 2 · Message", "Email step 1 · Email", "Profile visits, step not recorded"]);
    expect(rows[1]).toMatchObject({ sent: 2, contacts: 2, opened: 1, replied: 1 });
  });

  it("by mailbox and by LinkedIn account, each with only its own channel", () => {
    const c = mixed();
    expect(campaignBreakdown(db(), c.workflow, "sender", allTime()).rows).toEqual([expect.objectContaining({ key: c.mailbox, label: "Outbound", detail: `ada${c.n}@acme.test`, channel: "email", sent: 2, opened: 1, replied: 1 })]);
    expect(campaignBreakdown(db(), c.workflow, "linkedin_account", allTime()).rows).toEqual([expect.objectContaining({ key: c.account, label: "Ada on LinkedIn", channel: "linkedin", sent: 3 })]);
  });

  it("by message template, with messages written in the step as their own row", () => {
    const c = mixed();
    const { rows } = campaignBreakdown(db(), c.workflow, "template", allTime());
    expect(rows.map((entry) => [entry.label, entry.sent]).sort()).toEqual([["Soft opener", 1], ["Written in the step", 1]]);
  });

  it("by email version, lettered as the campaign shows them", () => {
    const c = mixed();
    const { rows } = campaignBreakdown(db(), c.workflow, "variant", allTime());
    expect(rows.map((entry) => [entry.label, entry.detail, entry.sent, entry.opened, entry.replied, entry.paused])).toEqual([
      ["Email step 1 · Email · A", "Quick question", 1, 0, 0, false],
      ["Email step 1 · Email · B", "A different question", 1, 1, 1, false],
    ]);
  });

  it("counts only the sends of the period when one is named", () => {
    const c = mixed();
    const { rows } = campaignBreakdown(db(), c.workflow, "step", period("2026-09-09", "2026-09-30"));
    expect(rows.map((entry) => [entry.label, entry.sent, entry.replied])).toEqual([["LinkedIn step 2 · Message", 1, 0], ["Email step 1 · Email", 1, 1]]);
  });
});

describe("the analytics route", () => {
  async function get(c: { workflow: string; headers: Record<string, string> }, query: Record<string, string>, headers = c.headers) {
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    res.end = () => res;
    await analyticsRoute({ method: "GET", query: { id: c.workflow, ...query }, headers } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return res as unknown as { statusCode: number; body: Record<string, unknown> };
  }

  it("answers as before when asked for nothing new, and adds a breakdown when asked", async () => {
    const c = campaign();
    c.email(c.contact("Lee"), c.email1, "2026-09-01 10:00:00");
    const plain = await get(c, {});
    expect(plain.body).toMatchObject({ range: { explicit: false }, funnel: { total: 1, emails_sent: 1 } });
    expect(plain.body.breakdown).toBeUndefined();
    expect((plain.body.activity as unknown[]).length).toBe(30);

    const split = await get(c, { from: "2026-09-01", to: "2026-09-30", breakdown: "step" });
    expect(split.body).toMatchObject({ range: { from: "2026-09-01", to: "2026-09-30", explicit: true }, breakdown: { by: "step" } });
    expect((split.body.activity as unknown[]).length).toBe(30);
  });

  it("refuses a range or a breakdown it does not know, and another workspace's campaign", async () => {
    const c = campaign();
    const other = campaign();
    expect((await get(c, { from: "yesterday" })).statusCode).toBe(400);
    expect((await get(c, { breakdown: "mood" })).statusCode).toBe(400);
    expect((await get(c, {}, other.headers)).statusCode).toBe(404);
  });

  it("lists every version of a tested step, with what it is credited with and whether it is paused", async () => {
    const c = campaign();
    const lee = c.contact("Lee");
    const job = c.email(lee, c.email1, "2026-09-01 10:00:00", c.variant);
    c.opened(job, "2026-09-01 11:00:00");
    c.reply(lee, "2026-09-02 10:00:00", { in_reply_to_job_id: job });
    db().prepare("UPDATE workflow_steps SET email_control_disabled = 1 WHERE id = ?").run(c.email1);
    const step = ((await get(c, {})).body.emailVariants as Array<Record<string, unknown>>)[0];
    expect(step).toMatchObject({ step_id: c.email1, control_paused: true, likely_winner: null });
    expect(step.variants).toEqual([
      expect.objectContaining({ variant_id: null, label: "A", subject: "Quick question", sent: 0, replies: 0, paused: true }),
      expect.objectContaining({ variant_id: c.variant, label: "B", subject: "A different question", sent: 1, opened_sends: 1, replies: 1, paused: false }),
    ]);
  });
});
