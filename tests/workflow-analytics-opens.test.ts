import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { WORKSPACE_HEADER, ROLE_HEADER } from "@/lib/workspace";
import analytics from "@/pages/api/workflows/[id]/analytics";

/**
 * The reported bug: workflow_analytics returned zero opens for a campaign whose pixel was
 * demonstrably firing, with matching email.opened rows in the event stream for the same
 * window. There was no aggregation job filtering them out — the funnel and the daily series
 * simply never read sender_events at all, so opens existed only inside the per-variant A/B
 * panel, which is empty for any step without variants.
 *
 * These tests pin the metric to the same table the tracking pixel writes to, and pin the
 * bot-filtered and raw counts as separate numbers.
 */

const WS = "ws-analytics-0001";
const ACCOUNT = "acct-analytics-0001";
const WORKFLOW = "wf-analytics-0001";
const RUN = "run-analytics-0001";

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown> };

function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as Res;
}

function call(days = 7): Res {
  const req = {
    method: "GET",
    query: { id: WORKFLOW, days: String(days) },
    headers: { [WORKSPACE_HEADER]: WS, [ROLE_HEADER]: "owner" },
  } as unknown as NextApiRequest;
  const res = mockRes();
  analytics(req, res);
  return res;
}

/** Minutes ago, in SQLite's "YYYY-MM-DD HH:MM:SS" UTC shape — how sends are timestamped. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
}

/** Minutes ago as a full ISO string — how the tracking endpoints timestamp a pixel hit. */
function agoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** One contact, one tracked send. Returns the sent_messages id. */
function seedSend(opts: { name: string; sentAt: string; trackOpens?: boolean }): string {
  const db = getDb();
  const targetId = randomUUID();
  const jobId = randomUUID();
  const sentId = randomUUID();
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, email, linkedin_url) VALUES (?, ?, ?, ?, ?)")
    .run(targetId, WS, opts.name, `${opts.name}@example.com`, `https://linkedin.com/in/${opts.name}`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)")
    .run(randomUUID(), RUN, targetId);
  db.prepare("INSERT INTO logs (id, run_id, target_id, message, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), RUN, targetId, `Email sent to ${opts.name}`, opts.sentAt);
  db.prepare(
    `INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, target_id, run_id, recipient, subject, body_text, email_delivery_mode, track_opens, track_clicks, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Subject', 'Body', 'enhanced', ?, 0, 'sent')`,
  ).run(jobId, WS, ACCOUNT, `key-${jobId}`, targetId, RUN, `${opts.name}@example.com`, opts.trackOpens === false ? 0 : 1);
  db.prepare(
    `INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, target_id, run_id, recipient, subject, message_id, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Subject', ?, ?)`,
  ).run(sentId, WS, jobId, ACCOUNT, targetId, RUN, `${opts.name}@example.com`, `<${jobId}@test.local>`, opts.sentAt);
  return sentId;
}

function seedOpen(sentId: string, at: string, isBot: boolean) {
  getDb().prepare(
    `INSERT INTO sender_events (id, workspace_id, email_account_id, sent_message_id, provider, provider_event_id, event_type, occurred_at, is_bot, bot_reason)
     VALUES (?, ?, ?, ?, 'linki', ?, 'opened', ?, ?, ?)`,
  ).run(randomUUID(), WS, ACCOUNT, sentId, randomUUID(), at, isBot ? 1 : 0, isBot ? "prefetch" : null);
}

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Analytics WS", "analytics-ws");
  db.prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(ACCOUNT, WS, "Sender", "sender@test.com", "smtp.test.com", "user", "pass");
  db.prepare("INSERT INTO workflows (id, workspace_id, name) VALUES (?, ?, ?)").run(WORKFLOW, WS, "Enterprise SaaS");
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(RUN, WORKFLOW);

  // Two contacts read the email for real, hours after the send.
  seedOpen(seedSend({ name: "reader-one", sentAt: ago(600) }), agoIso(120), false);
  seedOpen(seedSend({ name: "reader-two", sentAt: ago(600) }), agoIso(90), false);

  // Three contacts sit behind a mail-security gateway that fetched the pixel on delivery.
  for (const name of ["scanned-one", "scanned-two", "scanned-three"]) {
    const sentAt = ago(600);
    seedOpen(seedSend({ name, sentAt }), agoIso(600), true);
  }

  // One contact was emailed with tracking switched off — it can never produce an open, and
  // must not drag the open-rate denominator down.
  seedSend({ name: "untracked-one", sentAt: ago(600), trackOpens: false });
});

describe("workflow analytics — opens", () => {
  it("reports opens instead of silently omitting the metric", () => {
    const res = call();
    expect(res.statusCode).toBe(200);
    const funnel = res.body.funnel as Record<string, number>;
    expect(funnel).toHaveProperty("emails_opened");
    expect(funnel.emails_opened).toBe(2);
    expect(funnel.emails_sent).toBe(6);
  });

  it("separates verified opens from raw pixel hits rather than reporting one number", () => {
    const engagement = call().body.engagement as Record<string, number>;
    expect(engagement.opened).toBe(2);
    expect(engagement.opened_raw).toBe(5);
    expect(engagement.bot_open_hits).toBe(3);
    expect(engagement.human_open_hits).toBe(2);
  });

  it("counts only tracked sends in the open-rate denominator", () => {
    // 6 contacts were emailed; the 7th send had tracking off. An open rate of 2/6 would
    // penalise the campaign for a send that was never instrumented.
    const engagement = call().body.engagement as Record<string, number>;
    expect(engagement.tracked_sends).toBe(5);
    expect(engagement.tracked_click_sends).toBe(0);
  });

  it("puts opens on the daily series, dated by the hit and not the send", () => {
    const activity = call().body.activity as { day: string; emails: number; opens: number; bot_opens: number }[];
    const totals = activity.reduce(
      (acc, d) => ({ opens: acc.opens + d.opens, bot: acc.bot + d.bot_opens }),
      { opens: 0, bot: 0 },
    );
    expect(totals.opens).toBe(2);
    expect(totals.bot).toBe(3);
    expect(activity.every((d) => "opens" in d && "clicks" in d)).toBe(true);
  });

  it("scopes opens to this workflow's runs and no one else's", () => {
    const db = getDb();
    const otherWorkflow = "wf-analytics-other";
    const otherRun = "run-analytics-other";
    db.prepare("INSERT INTO workflows (id, workspace_id, name) VALUES (?, ?, ?)").run(otherWorkflow, WS, "Other");
    db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(otherRun, otherWorkflow);

    const targetId = randomUUID();
    const jobId = randomUUID();
    const sentId = randomUUID();
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, email, linkedin_url) VALUES (?, ?, ?, ?, ?)")
      .run(targetId, WS, "elsewhere", "elsewhere@example.com", "https://linkedin.com/in/elsewhere");
    db.prepare(
      `INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, target_id, run_id, recipient, subject, body_text, email_delivery_mode, track_opens, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'S', 'B', 'enhanced', 1, 'sent')`,
    ).run(jobId, WS, ACCOUNT, `key-${jobId}`, targetId, otherRun, "elsewhere@example.com");
    db.prepare(
      `INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, target_id, run_id, recipient, subject, message_id, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'S', ?, ?)`,
    ).run(sentId, WS, jobId, ACCOUNT, targetId, otherRun, "elsewhere@example.com", `<${jobId}@test.local>`, ago(600));
    seedOpen(sentId, agoIso(60), false);

    expect((call().body.engagement as Record<string, number>).opened).toBe(2);
  });
});
