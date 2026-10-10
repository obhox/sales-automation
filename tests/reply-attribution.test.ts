// Which of our emails a reply answers. A raw message goes through the real reply reader
// (mailparser and all) from a stand-in mailbox; what is checked is the row it stores.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type Imap from "imap";
import { getDb } from "@/lib/db";

vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, _to: string, _subject: string, _body: string, options: { messageId: string }) => ({ messageId: options.messageId }),
}));

import { sendEmailDurably } from "@/lib/email/infrastructure";
import { captureReplyBody } from "@/lib/email/inbox";

const db = () => getDb();
let seq = 0;

/** A mailbox that hands over one raw message when asked for it. */
function mailboxHolding(raw: string): Imap {
  return {
    fetch: () => {
      const fetch = new EventEmitter();
      setImmediate(() => {
        const message = new EventEmitter();
        fetch.emit("message", message);
        const body = new EventEmitter();
        message.emit("body", body);
        body.emit("data", Buffer.from(raw));
        fetch.emit("end");
      });
      return fetch;
    },
  } as unknown as Imap;
}

function rawReply(opts: { from: string; subject: string; body: string; inReplyTo?: string; references?: string }) {
  return [
    `From: Lee Lead <${opts.from}>`,
    "To: Ada <ada@acme.test>",
    `Subject: ${opts.subject}`,
    `Message-ID: <reply-${++seq}@prospect.test>`,
    `Date: ${new Date().toUTCString()}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body,
    "",
  ].join("\r\n");
}

/** A contact a campaign has emailed twice. */
async function emailedTwice(runStatus: "running" | "completed" = "running") {
  const n = ++seq;
  const ws = `ws-attr-${n}`;
  const c = { ws, run: `attr-run-${n}`, target: `attr-target-${n}`, mailbox: `attr-mailbox-${n}`, email: `lee${n}@prospect.test` };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, 'Sender', 'ada@acme.test', 'smtp.test.com', 'user', 'pass')").run(c.mailbox, ws);
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, email, linkedin_url) VALUES (?, ?, 'Lee Lead', ?, ?)").run(c.target, ws, c.email, `https://www.linkedin.com/in/attr-lead-${n}/`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(`attr-wf-${n}`, ws);
  db().prepare("INSERT INTO runs (id, workflow_id, status, workspace_id) VALUES (?, ?, 'running', ?)").run(c.run, `attr-wf-${n}`, ws);
  db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`attr-rp-${n}`, c.run, c.target, c.mailbox);
  const send = (which: string) => sendEmailDurably({
    workspaceId: ws, emailAccountId: c.mailbox, idempotencyKey: `attr-${n}-${which}`, source: "campaign", targetId: c.target, runId: c.run,
    to: c.email, subject: "Quick question", body: "Hello",
  });
  const first = await send("first");
  const second = await send("second");
  db().prepare("UPDATE runs SET status = ? WHERE id = ?").run(runStatus, c.run);
  return { ...c, first, second };
}

async function receive(c: { target: string; mailbox: string; email: string }, raw: string) {
  const result = await captureReplyBody(mailboxHolding(raw), getDb(), c.target, c.email, ++seq, c.mailbox);
  expect(result.status).toBe("captured");
  return db().prepare("SELECT run_id, in_reply_to_job_id FROM email_replies WHERE id = ?").get((result as { replyId: string }).replyId) as { run_id: string | null; in_reply_to_job_id: string | null };
}

beforeEach(() => { getDb(); });

describe("a reply that names the email it answers", () => {
  it("is tied to that email, the direct parent winning over the rest of the thread", async () => {
    const c = await emailedTwice();
    const reply = await receive(c, rawReply({ from: c.email, subject: "Re: Quick question", body: "Sounds good.",
      inReplyTo: c.second.messageId, references: `${c.first.messageId} ${c.second.messageId}` }));
    expect(reply).toEqual({ run_id: c.run, in_reply_to_job_id: c.second.jobId });
  });

  it("is tied to the first email when that is the one answered", async () => {
    const c = await emailedTwice();
    const reply = await receive(c, rawReply({ from: c.email, subject: "Re: Quick question", body: "Sounds good.", inReplyTo: c.first.messageId }));
    expect(reply.in_reply_to_job_id).toBe(c.first.jobId);
  });

  it("is filed under that email's campaign even after the campaign has finished", async () => {
    const c = await emailedTwice("completed");
    const reply = await receive(c, rawReply({ from: c.email, subject: "Re: Quick question", body: "Sorry for the delay, yes.", inReplyTo: c.second.messageId }));
    expect(reply).toEqual({ run_id: c.run, in_reply_to_job_id: c.second.jobId });
  });
});

describe("a reply that names nothing of ours", () => {
  it("is not tied to an email, but still goes to the contact's running campaign", async () => {
    const c = await emailedTwice();
    const reply = await receive(c, rawReply({ from: c.email, subject: "Hello", body: "Got your note, call me." }));
    expect(reply).toEqual({ run_id: c.run, in_reply_to_job_id: null });
  });

  it("goes to the campaign that last emailed them when none is running any more", async () => {
    // This used to be stored with no campaign at all.
    const c = await emailedTwice("completed");
    const reply = await receive(c, rawReply({ from: c.email, subject: "Hello", body: "Got your note, call me." }));
    expect(reply).toEqual({ run_id: c.run, in_reply_to_job_id: null });
  });

  it("is not tied to an email sent to someone else, whatever its headers claim", async () => {
    const c = await emailedTwice();
    const other = await emailedTwice();
    const reply = await receive(c, rawReply({ from: c.email, subject: "Re: Quick question", body: "Sounds good.", inReplyTo: other.second.messageId }));
    expect(reply).toEqual({ run_id: c.run, in_reply_to_job_id: null });
  });

  it("ignores message ids from other mail systems", async () => {
    const c = await emailedTwice();
    const reply = await receive(c, rawReply({ from: c.email, subject: "Re: Quick question", body: "Sounds good.", inReplyTo: "<CAF=abc123@mail.gmail.com>" }));
    expect(reply.in_reply_to_job_id).toBeNull();
  });
});
