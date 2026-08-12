import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db";
import { enqueueEmail, recordInboundBounce } from "@/lib/email/infrastructure";
import { isAddressSuppressed } from "@/lib/platform/suppression";

const WS = "ws-bounce-0001";
const ACCOUNT = "acct-bounce-0001";

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Bounce WS", "bounce-ws");
  db.prepare(
    "INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(ACCOUNT, WS, "Sender", "sender@test.com", "smtp.test.com", "user", "pass");
});

function bounce(recipient: string, dedupeKey: string) {
  return recordInboundBounce({ workspaceId: WS, emailAccountId: ACCOUNT, recipient, dedupeKey });
}

describe("IMAP-detected bounces", () => {
  it("records a sender_event so the account's bounce rate and auto-pause can see it", () => {
    const result = bounce("dead@example.com", "dsn-1");
    expect(result.recorded).toBe(true);

    const row = getDb()
      .prepare("SELECT event_type, recipient, provider FROM sender_events WHERE email_account_id = ? AND recipient = ?")
      .get(ACCOUNT, "dead@example.com") as { event_type: string; recipient: string; provider: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.event_type).toBe("bounced");
    expect(row!.provider).toBe("imap");
  });

  it("suppresses the address, so a re-import cannot send to it again", () => {
    bounce("gone@example.com", "dsn-2");
    const suppression = isAddressSuppressed(WS, "gone@example.com");
    expect(suppression).not.toBeNull();
    expect(suppression!.kind).toBe("email");
  });

  it("normalises case so the suppression matches however the address is written", () => {
    bounce("MixedCase@Example.com", "dsn-3");
    expect(isAddressSuppressed(WS, "mixedcase@example.com")).not.toBeNull();
    expect(isAddressSuppressed(WS, "MIXEDCASE@EXAMPLE.COM")).not.toBeNull();
  });

  it("is idempotent — re-reading the same DSN does not inflate the bounce count", () => {
    // The inbox sweep re-reads the last 50 messages on every poll, so the same DSN is seen
    // repeatedly. Without deduping, one bounce would eventually auto-pause a healthy mailbox.
    expect(bounce("repeat@example.com", "dsn-repeat").recorded).toBe(true);
    expect(bounce("repeat@example.com", "dsn-repeat").duplicate).toBe(true);
    expect(bounce("repeat@example.com", "dsn-repeat").duplicate).toBe(true);

    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM sender_events WHERE recipient = ? AND event_type = 'bounced'")
      .get("repeat@example.com") as { n: number };
    expect(count.n).toBe(1);
  });

  it("records the bounce even when no contact row matches the address", () => {
    // This is the case the old code dropped entirely: it only acted when it could find a
    // `targets` row, so a bounce for a deleted or re-imported contact left no trace at all.
    const result = bounce("no-such-contact@example.com", "dsn-orphan");
    expect(result.recorded).toBe(true);
    expect(isAddressSuppressed(WS, "no-such-contact@example.com")).not.toBeNull();
  });

  it("links the bounce to the message that caused it when one is on record", () => {
    const db = getDb();
    const job = enqueueEmail({ workspaceId: WS, emailAccountId: ACCOUNT, idempotencyKey: "bounce-tracked", to: "tracked@example.com", subject: "Hi", body: "Hello" });
    db.prepare(
      `INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, recipient, subject, message_id, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sm-1", WS, job.id, ACCOUNT, "tracked@example.com", "Hi", "<msg-1@test>", "smtp");

    bounce("tracked@example.com", "dsn-tracked");

    const sent = db.prepare("SELECT status, bounced_at FROM sent_messages WHERE id = ?").get("sm-1") as { status: string; bounced_at: string | null };
    expect(sent.status).toBe("bounced");
    expect(sent.bounced_at).not.toBeNull();

    const event = db.prepare("SELECT sent_message_id FROM sender_events WHERE recipient = ?").get("tracked@example.com") as { sent_message_id: string | null };
    expect(event.sent_message_id).toBe("sm-1");
  });
});
