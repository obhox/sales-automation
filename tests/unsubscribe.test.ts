// One-click unsubscribe: which emails carry the header, what the address in it does, and
// that opting out by reply ends up in the same place. Run against a real (throwaway)
// database; the only thing stubbed is the SMTP send, which records what it was handed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

const smtp = vi.hoisted(() => ({ sent: [] as Array<{ to: string; body: string; html?: string; headers: Record<string, string> }> }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, to: string, _subject: string, body: string, options: { messageId: string; headers?: Record<string, string>; html?: string }) => {
    smtp.sent.push({ to, body, html: options.html, headers: options.headers ?? {} });
    return { messageId: options.messageId };
  },
}));

import { getDb } from "@/lib/db";
import { sendEmailDurably, type QueueEmailInput } from "@/lib/email/infrastructure";
import { trackingOpenUrl } from "@/lib/email/content";
import { isExplicitOptOut, subjectIsOptOut } from "@/lib/email/opt-out";
import { classifyAndDispatch } from "@/lib/community-replies";
import unsubscribeHandler from "@/pages/api/t/u/[token]";

process.env.NEXTAUTH_SECRET ||= "test-secret-for-unsubscribe";
const BASE = "https://linki.example";

const db = () => getDb();
let seq = 0;

/** A contact partway through a campaign, and a mailbox to write to them from. */
function enrolled() {
  const n = ++seq;
  const ws = `ws-unsub-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, from_name, smtp_host, username, password) VALUES (?, ?, 'Sender', ?, 'Ada at Acme', 'smtp.test.com', 'user', 'pass')")
    .run(`unsub-mailbox-${n}`, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, email, email_status, linkedin_url) VALUES (?, ?, ?, ?, 'verified', ?)")
    .run(`unsub-target-${n}`, ws, `Lead ${n}`, `lead${n}@prospect.test`, `https://www.linkedin.com/in/unsub-lead-${n}/`);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(`unsub-wf-${n}`, ws);
  db().prepare("INSERT INTO runs (id, workflow_id, status, workspace_id) VALUES (?, ?, 'running', ?)").run(`unsub-run-${n}`, `unsub-wf-${n}`, ws);
  db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`unsub-rp-${n}`, `unsub-run-${n}`, `unsub-target-${n}`);
  for (const track of ["linkedin", "email"]) {
    db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, ?, 'in_progress', 1)").run(`unsub-rt-${n}-${track}`, `unsub-rp-${n}`, track);
  }
  const send = (extra: Partial<QueueEmailInput> = {}) => sendEmailDurably({
    workspaceId: ws, emailAccountId: `unsub-mailbox-${n}`, idempotencyKey: `unsub-key-${++seq}`, targetId: `unsub-target-${n}`, runId: `unsub-run-${n}`,
    to: `lead${n}@prospect.test`, subject: "Quick question", body: "Hello,\n\nWorth a chat?\n\nAda", unsubscribe: true, ...extra,
  });
  return { ws, targetId: `unsub-target-${n}`, email: `lead${n}@prospect.test`, send };
}

const lastSent = () => smtp.sent[smtp.sent.length - 1];
/** The token in the List-Unsubscribe header of the last email sent. */
const lastToken = () => lastSent().headers["List-Unsubscribe"].slice(`<${BASE}/api/t/u/`.length, -1);

async function visit(method: "GET" | "POST", token: string) {
  const res: Record<string, unknown> = { statusCode: 200, body: "" };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.send = (payload: string) => { res.body = payload; return res; };
  res.setHeader = () => res;
  res.end = () => res;
  await unsubscribeHandler({ method, query: { token }, body: method === "POST" ? { "List-Unsubscribe": "One-Click" } : {}, headers: {} } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: string };
}

const tracks = (targetId: string) =>
  (db().prepare(`SELECT rt.state, rt.error_message FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id WHERE rp.target_id = ?`).all(targetId) as Array<{ state: string; error_message: string | null }>);
const suppression = (ws: string, email: string) =>
  db().prepare("SELECT reason, source FROM suppressions WHERE workspace_id = ? AND kind = 'email' AND value = ?").get(ws, email) as { reason: string; source: string } | undefined;
const contact = (id: string) =>
  db().prepare("SELECT unsubscribed_at, email_status FROM targets WHERE id = ?").get(id) as { unsubscribed_at: string | null; email_status: string | null };
const events = (ws: string, type: string) =>
  (db().prepare("SELECT COUNT(*) c FROM domain_events WHERE workspace_id = ? AND type = ?").get(ws, type) as { c: number }).c;

beforeEach(() => {
  process.env.EMAIL_TRACKING_BASE_URL = BASE;
  smtp.sent.length = 0;
});

describe("the header", () => {
  it("goes on a campaign email, and adds nothing to what the recipient reads", async () => {
    const { send } = enrolled();
    await send();
    expect(lastSent().headers["List-Unsubscribe"]).toMatch(new RegExp(`^<${BASE}/api/t/u/[^>]+>$`));
    expect(lastSent().headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(lastSent().body).toBe("Hello,\n\nWorth a chat?\n\nAda");

    await send({ deliveryMode: "enhanced" });
    expect(lastSent().headers["List-Unsubscribe"]).toBeTruthy();
    expect(lastSent().body).toBe("Hello,\n\nWorth a chat?\n\nAda");
    expect(lastSent().html).not.toMatch(/unsubscribe/i);
  });

  it("stays off mail that is not a campaign's", async () => {
    const { send } = enrolled();
    await send({ unsubscribe: false, source: "team_inbox" });
    expect(lastSent().headers).not.toHaveProperty("List-Unsubscribe");
    expect(lastSent().headers).not.toHaveProperty("List-Unsubscribe-Post");
  });

  it("is left out when there is no https address for a mail client to call", async () => {
    const { send } = enrolled();
    process.env.EMAIL_TRACKING_BASE_URL = "http://localhost:3000";
    await send();
    expect(lastSent().headers).not.toHaveProperty("List-Unsubscribe");
  });

  it("no longer tells recipients which workspace and job an email came from", async () => {
    const { send } = enrolled();
    await send();
    expect(Object.keys(lastSent().headers).filter((name) => /^x-linki-/i.test(name))).toEqual([]);
  });
});

describe("the address in the header", () => {
  it("unsubscribes on POST: the address is suppressed and the contact leaves every sequence", async () => {
    const { ws, targetId, email, send } = enrolled();
    await send();

    const res = await visit("POST", lastToken());

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("You are unsubscribed");
    expect(suppression(ws, email)).toMatchObject({ reason: "unsubscribed" });
    expect(tracks(targetId)).toEqual([{ state: "skipped", error_message: "Unsubscribed" }, { state: "skipped", error_message: "Unsubscribed" }]);
    expect(contact(targetId).unsubscribed_at).not.toBeNull();
    expect(events(ws, "email.unsubscribed")).toBe(1);
    // Opting out says nothing about whether the address works.
    expect(contact(targetId).email_status).toBe("verified");
  });

  it("can be called again without doing anything twice", async () => {
    const { ws, targetId, send } = enrolled();
    await send();
    const token = lastToken();
    await visit("POST", token);
    const first = contact(targetId).unsubscribed_at;

    expect((await visit("POST", token)).statusCode).toBe(200);
    expect(events(ws, "email.unsubscribed")).toBe(1);
    expect(contact(targetId).unsubscribed_at).toBe(first);
  });

  it("changes nothing on GET, so a link scanner cannot unsubscribe anyone", async () => {
    const { ws, targetId, email, send } = enrolled();
    await send();

    const res = await visit("GET", lastToken());

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form method="post">');
    expect(res.body).toContain(email);
    expect(res.body).toContain("Ada at Acme");
    expect(suppression(ws, email)).toBeUndefined();
    expect(tracks(targetId).every((track) => track.state === "in_progress")).toBe(true);
  });

  it("refuses a token that was altered, and one made for something else", async () => {
    const { ws, email, send } = enrolled();
    const { jobId } = await send();
    const token = lastToken();
    const altered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    const openToken = trackingOpenUrl(jobId)!.split("/api/t/o/")[1];

    expect((await visit("POST", altered)).statusCode).toBe(404);
    expect((await visit("POST", openToken)).statusCode).toBe(404);
    expect((await visit("POST", "not-a-token")).statusCode).toBe(404);
    expect(suppression(ws, email)).toBeUndefined();
  });

  it("stops the next campaign email to that address from being sent at all", async () => {
    const { send } = enrolled();
    await send();
    await visit("POST", lastToken());
    const before = smtp.sent.length;

    await expect(send()).rejects.toThrow(/suppressed/i);
    expect(smtp.sent).toHaveLength(before);
  });
});

describe("opting out by reply", () => {
  function reply(c: { ws: string; targetId: string; email: string }, subject: string, body: string) {
    const id = `unsub-reply-${++seq}`;
    db().prepare(`INSERT INTO email_replies (id, workspace_id, target_id, from_email, subject, body_text, received_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(id, c.ws, c.targetId, c.email, subject, body);
    return id;
  }

  it("counts a reply whose whole subject is the request, with nothing in the body", async () => {
    const c = enrolled();
    await classifyAndDispatch(reply(c, "Unsubscribe", ""));
    expect(suppression(c.ws, c.email)).toMatchObject({ reason: "unsubscribe", source: "reply_classifier" });
    expect(contact(c.targetId).unsubscribed_at).not.toBeNull();
    expect(tracks(c.targetId).every((track) => track.state === "skipped")).toBe(true);
    expect(events(c.ws, "email.unsubscribed")).toBe(1);
  });

  it("is undone when someone corrects the verdict", async () => {
    const c = enrolled();
    const id = reply(c, "Re: Quick question", "Please remove me from your list.");
    await classifyAndDispatch(id);
    expect(contact(c.targetId).unsubscribed_at).not.toBeNull();

    await classifyAndDispatch(id, "positive");
    expect(suppression(c.ws, c.email)).toBeUndefined();
    expect(contact(c.targetId).unsubscribed_at).toBeNull();
  });

  it("does not undo a one-click unsubscribe when a reply is reclassified", async () => {
    const c = enrolled();
    await c.send();
    const token = lastToken();
    const id = reply(c, "Re: Quick question", "Please remove me from your list.");
    await classifyAndDispatch(id);
    await visit("POST", token);

    await classifyAndDispatch(id, "positive");
    expect(suppression(c.ws, c.email)).toMatchObject({ reason: "unsubscribed" });
    expect(contact(c.targetId).unsubscribed_at).not.toBeNull();
  });
});

describe("what counts as an explicit opt-out", () => {
  it("takes a subject only when it is the request and nothing else", () => {
    for (const subject of ["Unsubscribe", "unsubscribe me", "Re: UNSUBSCRIBE", "RE: Fwd: remove me please", "STOP", "Opt out.", "please unsubscribe"]) {
      expect(subjectIsOptOut(subject), subject).toBe(true);
    }
    // Our own subject lines coming back in a reply.
    for (const subject of ["Re: Stop guessing your pipeline", "Re: Quick question", "Re: How to opt out of busywork", "Re: Unsubscribe rates in SaaS", "", null]) {
      expect(subjectIsOptOut(subject), String(subject)).toBe(false);
    }
  });

  it("takes plain words in the body", () => {
    expect(isExplicitOptOut("Re: Quick question", "Take me off this list")).toBe(true);
    expect(isExplicitOptOut("Re: Quick question", "Thanks, I have replied to your colleague.")).toBe(false);
    expect(isExplicitOptOut("Re: Stop guessing your pipeline", "Sounds interesting, tell me more")).toBe(false);
  });
});
