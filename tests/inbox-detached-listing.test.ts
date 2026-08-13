import { describe, it, expect, beforeAll } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import inboxList, { type InboxReply } from "@/pages/api/inbox";
import platformInbox from "@/pages/api/platform/inbox";

// The inbox list is rooted at `targets`, so a reply with no contact row was invisible to it —
// which is how a captured reply disappeared the moment someone deleted the contact. These
// exercise the real handlers (and therefore the real SQL) rather than re-stating the queries.

const WS = "ws-inbox-det-1";
const ACCOUNT = "acct-inbox-det-1";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

function req(method: string, extra: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method,
    query: {},
    body: {},
    headers: { "x-workspace-id": WS, "x-user-id": "user-inbox-det", "x-workspace-role": "owner" },
    ...extra,
  } as unknown as NextApiRequest;
}

function list(query: Record<string, string> = {}): InboxReply[] {
  const res = mockRes();
  inboxList(req("GET", { query }), res);
  expect(res.statusCode).toBe(200);
  return (res.body as { replies: InboxReply[] }).replies;
}

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Inbox Det", "inbox-det");
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run("user-inbox-det", "det@test.com", "x");
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(WS, "user-inbox-det");
  db.prepare(
    "INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(ACCOUNT, WS, "Joy", "joy@det.test", "smtp.test", "u", "p");

  // A normal reply, still attached to its contact.
  db.prepare("INSERT INTO targets (id, workspace_id, email, full_name, email_replied_at) VALUES (?,?,?,?,?)")
    .run("tgt-attached", WS, "attached@det.test", "Attached Lead", "2026-08-12T10:00:00.000Z");
  db.prepare(
    `INSERT INTO email_replies (id, workspace_id, target_id, email_account_id, from_email, subject, body_text, received_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("rep-attached", WS, "tgt-attached", ACCOUNT, "attached@det.test", "Re: hi", "sure", "2026-08-12T10:00:00.000Z");

  // A reply whose contact was deleted.
  db.prepare(
    `INSERT INTO email_replies (id, workspace_id, target_id, email_account_id, from_email, subject, body_text, received_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("rep-detached", WS, null, ACCOUNT, "ayan@det.test", "Re: pitch", "Interested", "2026-08-13T00:12:24.000Z");
});

describe("GET /api/inbox", () => {
  it("lists a reply whose contact was deleted, flagged and identified by sender", () => {
    const replies = list();
    const detached = replies.find((r) => r.reply_id === "rep-detached");

    expect(detached).toBeDefined();
    expect(detached!.detached).toBe(true);
    expect(detached!.email).toBe("ayan@det.test");
    expect(detached!.reply_body).toBe("Interested");
    expect(detached!.email_account_from).toBe("joy@det.test");
    // No contact to key on, so the reply's own id stands in as the row identity.
    expect(detached!.id).toBe("rep-detached");
  });

  it("still lists ordinary replies, and does not mark them detached", () => {
    const attached = list().find((r) => r.reply_id === "rep-attached");
    expect(attached).toBeDefined();
    expect(attached!.detached).toBe(false);
    expect(attached!.full_name).toBe("Attached Lead");
  });

  it("sorts detached and attached replies together, newest first", () => {
    const ids = list().map((r) => r.reply_id);
    expect(ids.indexOf("rep-detached")).toBeLessThan(ids.indexOf("rep-attached"));
  });

  it("excludes detached replies from the linkedin channel, which has no email side", () => {
    expect(list({ channel: "linkedin" }).some((r) => r.detached)).toBe(false);
  });

  it("applies status filters to detached replies too", () => {
    expect(list({ status: "open" }).some((r) => r.reply_id === "rep-detached")).toBe(true);
    expect(list({ status: "closed" }).some((r) => r.reply_id === "rep-detached")).toBe(false);
  });

  it("never leaks another workspace's detached replies", () => {
    const db = getDb();
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)").run("ws-inbox-det-2", "Other", "inbox-det-2");
    db.prepare(
      `INSERT INTO email_replies (id, workspace_id, target_id, email_account_id, from_email, subject, body_text, received_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("rep-other-ws", "ws-inbox-det-2", null, null, "someone@other.test", "s", "b", "2026-08-13T02:00:00.000Z");

    expect(list().some((r) => r.reply_id === "rep-other-ws")).toBe(false);
  });
});

describe("POST /api/platform/inbox {action:'relink'}", () => {
  it("reports no match when nothing shares the sender's address", () => {
    const res = mockRes();
    platformInbox(req("POST", { body: { action: "relink", reply_ids: ["rep-detached"] } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ relinked: 0, unmatched: 1 });
  });

  it("attaches the reply to a recreated contact with the same address", () => {
    getDb().prepare("INSERT INTO targets (id, workspace_id, email, full_name) VALUES (?,?,?,?)")
      .run("tgt-recreated", WS, "ayan@det.test", "Ayan");

    const res = mockRes();
    platformInbox(req("POST", { body: { action: "relink", reply_ids: ["rep-detached"] } }), res);
    expect(res.body).toMatchObject({ relinked: 1 });

    // It is no longer detached, and now rides on its contact's row.
    const replies = list();
    expect(replies.some((r) => r.reply_id === "rep-detached" && r.detached)).toBe(false);
    expect(replies.find((r) => r.reply_id === "rep-detached")!.full_name).toBe("Ayan");
  });

  it("refuses an explicit contact from another workspace", () => {
    const db = getDb();
    db.prepare("INSERT INTO targets (id, workspace_id, email, full_name) VALUES (?,?,?,?)")
      .run("tgt-foreign", "ws-inbox-det-2", "x@other.test", "Foreign");
    db.prepare(
      `INSERT INTO email_replies (id, workspace_id, target_id, email_account_id, from_email, subject, body_text, received_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("rep-detached-2", WS, null, ACCOUNT, "nobody@det.test", "s", "b", "2026-08-13T03:00:00.000Z");

    const res = mockRes();
    platformInbox(req("POST", { body: { action: "relink", reply_ids: ["rep-detached-2"], target_id: "tgt-foreign" } }), res);
    expect(res.statusCode).toBe(400);
  });
});
