// Follow-up emails in the same conversation: what the campaign runner hands the SMTP send
// for a step marked "same thread", and what a reply written in the inbox carries. Run
// against a real (throwaway) database; the SMTP send is stubbed and records its arguments.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

const smtp = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; messageId: string; inReplyTo?: string; references?: string }> }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, to: string, subject: string, _body: string, options: { messageId: string; inReplyTo?: string; references?: string }) => {
    smtp.sent.push({ to, subject, messageId: options.messageId, inReplyTo: options.inReplyTo, references: options.references });
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
import { jobIdsNamedBy, stripReplyPrefix, threadOnto } from "@/lib/email/threading";
import stepsHandler from "@/pages/api/workflows/[id]/steps";
import inboxReply from "@/pages/api/inbox/reply";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

type EmailStep = { subject: string; inThread?: boolean };

/** A running campaign of email steps with one contact due, sending from one mailbox. */
function campaign(steps: EmailStep[]) {
  const n = ++seq;
  const ws = `ws-thread-${n}`;
  const ids = { ws, run: `thread-run-${n}`, target: `thread-target-${n}`, mailbox: `thread-mailbox-${n}`, workflow: `thread-wf-${n}` };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, 'LinkedIn', ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(`thread-li-${n}`, `thread${n}@example.com`, ws);
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, ?, 'Sender', ?, 'smtp.test.com', 'user', 'pass', 1, 50, 0, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(ids.mailbox, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(ids.workflow, ws);
  steps.forEach((step, i) => {
    db().prepare(`INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body, email_position, email_in_thread)
      VALUES (?, ?, ?, 'email', 'email', 0, ?, 'Hello {{first_name}}', ?, ?)`).run(`thread-step-${n}-${i + 1}`, ids.workflow, i + 1, step.subject, i + 1, step.inThread ? 1 : 0);
  });
  db().prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, 'running', ?)").run(ids.run, ids.workflow, `thread-li-${n}`, ws);
  db().prepare(`INSERT INTO targets (id, workspace_id, full_name, first_name, company, email, email_status, email_verified_at, linkedin_url)
    VALUES (?, ?, 'Lee Lead', 'Lee', 'Initech', ?, 'verified', datetime('now'), ?)`).run(ids.target, ws, `lee${n}@prospect.test`, `https://www.linkedin.com/in/thread-lead-${n}/`);
  db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`thread-rp-${n}`, ids.run, ids.target, ids.mailbox);
  db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'email', 'in_progress', 0)").run(`thread-rt-${n}`, `thread-rp-${n}`);
  return ids;
}

/** Run the engine once, as if a day had passed since the last email: no pacing, step due. */
async function nextDay() {
  db().prepare("UPDATE logs SET created_at = datetime(created_at, '-1 day') WHERE message LIKE 'Email sent%'").run();
  db().prepare("UPDATE run_profile_tracks SET next_step_at = NULL WHERE state = 'in_progress'").run();
  await tick(getDb(), { pace: false });
}

beforeEach(() => {
  db().prepare("UPDATE runs SET status = 'completed' WHERE status = 'running'").run();
  smtp.sent.length = 0;
});

describe("threadOnto", () => {
  it("answers the last email, lists them all, and keeps the first subject", () => {
    expect(threadOnto([{ message_id: "<a@x>", subject: "Quick question" }, { message_id: "<b@x>", subject: "Re: Quick question" }])).toEqual({
      subject: "Re: Quick question", replyToMessageId: "<b@x>", references: ["<a@x>", "<b@x>"],
    });
  });

  it("has nothing to offer when no email went before", () => {
    expect(threadOnto([])).toBeNull();
  });

  it("does not pile up reply prefixes", () => {
    expect(stripReplyPrefix("RE: Re: Fwd: Quick question")).toBe("Quick question");
    expect(threadOnto([{ message_id: "<a@x>", subject: "Re: Quick question" }])?.subject).toBe("Re: Quick question");
  });
});

describe("jobIdsNamedBy", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";

  it("reads our job ids out of a reply's headers, the direct parent first", () => {
    expect(jobIdsNamedBy(`<${b}@acme.test>`, `<${a}@acme.test> <${b}@acme.test>`)).toEqual([b, a]);
    expect(jobIdsNamedBy(undefined, [`<${a}@acme.test>`, `<${b}@acme.test>`])).toEqual([b, a]);
  });

  it("finds nothing in ids that are not ours, or in no headers at all", () => {
    expect(jobIdsNamedBy("<CAF=abc123@mail.gmail.com>", "<x@y> <z@w>")).toEqual([]);
    expect(jobIdsNamedBy(undefined, undefined)).toEqual([]);
  });
});

describe("a campaign's follow-up emails", () => {
  it("go out as replies to the earlier ones when the step says same thread", async () => {
    campaign([{ subject: "Quick question about {{company}}" }, { subject: "Following up", inThread: true }, { subject: "Last try", inThread: true }]);

    await nextDay();
    await nextDay();
    await nextDay();

    expect(smtp.sent).toHaveLength(3);
    const [first, second, third] = smtp.sent;
    expect(first).toMatchObject({ subject: "Quick question about Initech", inReplyTo: undefined, references: undefined });
    // The step's own subject gives way: a changed subject would split the conversation.
    expect(second).toMatchObject({ subject: "Re: Quick question about Initech", inReplyTo: first.messageId, references: first.messageId });
    expect(third).toMatchObject({ subject: "Re: Quick question about Initech", inReplyTo: second.messageId, references: `${first.messageId} ${second.messageId}` });
  });

  it("start a conversation of their own when the step does not", async () => {
    campaign([{ subject: "Quick question" }, { subject: "A different angle" }]);

    await nextDay();
    await nextDay();

    expect(smtp.sent[1]).toMatchObject({ subject: "A different angle", inReplyTo: undefined, references: undefined });
  });

  it("do not thread onto an email another mailbox sent", async () => {
    const c = campaign([{ subject: "Quick question" }, { subject: "Following up", inThread: true }]);
    await nextDay();
    db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, active_hours_start, active_hours_end, timezone, working_days)
      VALUES ('thread-other-mailbox', ?, 'Other', 'bea@acme.test', 'smtp.test.com', 'user', 'pass', 1, 50, 0, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(c.ws);
    db().prepare("UPDATE run_profiles SET email_account_id = 'thread-other-mailbox' WHERE run_id = ?").run(c.run);

    await nextDay();

    expect(smtp.sent[1]).toMatchObject({ subject: "Following up", inReplyTo: undefined });
  });

  it("record what they were sent with", async () => {
    const c = campaign([{ subject: "Quick question" }, { subject: "Following up", inThread: true }]);
    await nextDay();
    await nextDay();
    const jobs = db().prepare("SELECT subject, reply_to_message_id, references_header FROM email_jobs WHERE run_id = ? ORDER BY created_at, rowid").all(c.run) as Array<Record<string, string | null>>;
    expect(jobs[1]).toEqual({ subject: "Re: Quick question", reply_to_message_id: smtp.sent[0].messageId, references_header: smtp.sent[0].messageId });
  });
});

describe("saving steps", () => {
  function put(workflowId: string, ws: string, steps: unknown[]) {
    const res: Record<string, unknown> = { statusCode: 200 };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = () => res;
    stepsHandler({ method: "PUT", query: { id: workflowId }, body: { steps }, headers: ctxHeaders(ws) } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return res.statusCode;
  }

  it("keeps the same-thread choice on email steps, and never sets it on anything else", () => {
    const c = campaign([{ subject: "Quick question" }]);
    expect(put(c.workflow, c.ws, [
      { step_type: "message", track: "linkedin", message_body: "Hi", email_in_thread: 1 },
      { step_type: "email", track: "email", email_subject: "Quick question", email_body: "Hello" },
      { step_type: "email", track: "email", email_subject: "Following up", email_body: "Hello again", email_in_thread: 1 },
    ])).toBe(200);
    const saved = db().prepare("SELECT step_type, email_in_thread FROM workflow_steps WHERE workflow_id = ? ORDER BY track, step_order").all(c.workflow);
    expect(saved).toEqual([
      { step_type: "email", email_in_thread: 0 },
      { step_type: "email", email_in_thread: 1 },
      { step_type: "message", email_in_thread: 0 },
    ]);
  });
});

describe("a reply written in the inbox", () => {
  it("names the message it answers, and the email of ours that one answered", async () => {
    const c = campaign([{ subject: "Quick question" }]);
    await nextDay();
    const ours = db().prepare("SELECT id FROM email_jobs WHERE run_id = ?").get(c.run) as { id: string };
    db().prepare(`INSERT INTO email_replies (id, workspace_id, target_id, run_id, email_account_id, from_email, subject, body_text, received_at, message_id, in_reply_to_job_id)
      VALUES ('thread-reply-1', ?, ?, ?, ?, 'lee@prospect.test', 'Re: Quick question', 'Tell me more', datetime('now'), '<their-reply@prospect.test>', ?)`).run(c.ws, c.target, c.run, c.mailbox, ours.id);

    const res: Record<string, unknown> = { statusCode: 200 };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = () => res;
    res.setHeader = () => res;
    await inboxReply({ method: "POST", query: {}, body: { emailAccountId: c.mailbox, to: "lee@prospect.test", subject: "Re: Quick question", body: "Happy to.", replyId: "thread-reply-1" },
      headers: ctxHeaders(c.ws, { userId: "thread-user", role: "member" }) } as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(200);
    expect(smtp.sent[1]).toMatchObject({ inReplyTo: "<their-reply@prospect.test>", references: `${smtp.sent[0].messageId} <their-reply@prospect.test>` });
  });
});
