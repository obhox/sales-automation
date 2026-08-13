import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db";
import { relinkDetachedReplies } from "@/lib/email/inbox";

// A reply is the durable record of a conversation. Deleting the contact it was filed under
// used to destroy it outright (target_id was NOT NULL ... ON DELETE CASCADE), and recreating
// the contact could not bring it back — the row was gone, and the inbox, which reads from
// `targets`, had nothing to show either way.

const WS = "ws-detach-0001";
const ACCOUNT = "acct-detach-0001";
const EMAIL = "ayan@example-detach.com";

function insertContact(id: string, email: string) {
  getDb().prepare("INSERT INTO targets (id, workspace_id, email, full_name) VALUES (?, ?, ?, ?)")
    .run(id, WS, email, "Test Contact");
}

function insertReply(id: string, targetId: string | null, fromEmail = EMAIL) {
  getDb().prepare(
    `INSERT INTO email_replies (id, workspace_id, target_id, email_account_id, from_email, subject, body_text, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, WS, targetId, ACCOUNT, fromEmail, "Re: pitch", "Interested, let's talk.", "2026-08-13T00:12:24.000Z");
}

function replyRow(id: string) {
  return getDb().prepare("SELECT id, target_id, body_text FROM email_replies WHERE id = ?")
    .get(id) as { id: string; target_id: string | null; body_text: string } | undefined;
}

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Detach WS", "detach-ws");
  db.prepare(
    "INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(ACCOUNT, WS, "Sender", "joy@example-detach.com", "smtp.test.com", "user", "pass");
});

describe("replies survive their contact", () => {
  it("detaches instead of deleting when the contact is bulk-deleted", () => {
    const db = getDb();
    insertContact("tgt-detach-a", EMAIL);
    insertReply("reply-detach-a", "tgt-detach-a");

    // Mirrors the bulk delete in /api/targets: dependants cleared, then the contact.
    db.prepare("DELETE FROM run_profiles WHERE target_id = ?").run("tgt-detach-a");
    db.prepare("DELETE FROM logs WHERE target_id = ?").run("tgt-detach-a");
    db.prepare("DELETE FROM targets WHERE id = ?").run("tgt-detach-a");

    const row = replyRow("reply-detach-a");
    expect(row).toBeDefined();                       // the reply itself is still here
    expect(row!.target_id).toBeNull();               // it just has no contact any more
    expect(row!.body_text).toBe("Interested, let's talk.");
  });

  it("re-links a detached reply to a recreated contact with the same address", () => {
    insertContact("tgt-detach-a2", EMAIL);           // recreated — new id, same address

    expect(relinkDetachedReplies(WS)).toBe(1);
    expect(replyRow("reply-detach-a")!.target_id).toBe("tgt-detach-a2");
  });

  it("leaves a detached reply alone when no contact matches its sender", () => {
    insertReply("reply-detach-b", null, "nobody@example-detach.com");

    expect(relinkDetachedReplies(WS)).toBe(0);
    expect(replyRow("reply-detach-b")!.target_id).toBeNull();
  });

  it("never re-links across workspaces", () => {
    const db = getDb();
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run("ws-detach-0002", "Other", "other-detach");
    db.prepare("INSERT INTO targets (id, workspace_id, email, full_name) VALUES (?, ?, ?, ?)")
      .run("tgt-other-ws", "ws-detach-0002", "nobody@example-detach.com", "Someone Else");

    // The only contact holding this address lives in another workspace.
    expect(relinkDetachedReplies(WS)).toBe(0);
    expect(replyRow("reply-detach-b")!.target_id).toBeNull();
  });

  it("matches the sender address case-insensitively", () => {
    insertReply("reply-detach-c", null, "AYAN@Example-Detach.com");

    expect(relinkDetachedReplies(WS)).toBe(1);
    expect(replyRow("reply-detach-c")!.target_id).toBe("tgt-detach-a2");
  });
});

describe("dedupe identifies the message, not the contact", () => {
  it("keys on Message-ID so the same mail is not stored twice under a new contact id", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO email_replies (id, workspace_id, target_id, email_account_id, from_email, subject, body_text, received_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("reply-msgid-a", WS, null, ACCOUNT, EMAIL, "Re: pitch", "body", "2026-08-13T01:04:32.000Z", "<abc@mail.example.com>");

    // This is the lookup captureReplyBody performs before inserting.
    const found = db.prepare("SELECT id, target_id FROM email_replies WHERE email_account_id = ? AND message_id = ?")
      .get(ACCOUNT, "<abc@mail.example.com>") as { id: string; target_id: string | null } | undefined;

    expect(found?.id).toBe("reply-msgid-a");
    expect(found?.target_id).toBeNull();  // detached → captureReplyBody re-links rather than skipping
  });
});
