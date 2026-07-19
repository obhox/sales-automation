import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db";
import { enqueueEmail, recoverStaleEmailJobs, acquireWorkerLease } from "@/lib/email/infrastructure";

const WS = "ws-test-0001";
const ACCOUNT = "acct-test-0001";

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Test WS", "test-ws");
  db.prepare(
    "INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(ACCOUNT, "Test", "from@test.com", "smtp.test.com", "user", "pass");
});

function baseJob(idempotencyKey: string) {
  return {
    workspaceId: WS,
    emailAccountId: ACCOUNT,
    idempotencyKey,
    to: "lead@example.com",
    subject: "Hi",
    body: "Hello there",
  };
}

describe("email queue idempotency", () => {
  it("returns the same job when the idempotency key repeats (no double-send)", () => {
    const first = enqueueEmail(baseJob("key-dupe"));
    const second = enqueueEmail(baseJob("key-dupe"));
    expect(second.id).toBe(first.id);
    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM email_jobs WHERE workspace_id = ? AND idempotency_key = ?")
      .get(WS, "key-dupe") as { n: number };
    expect(count.n).toBe(1);
  });

  it("creates distinct jobs for distinct idempotency keys", () => {
    const a = enqueueEmail(baseJob("key-a"));
    const b = enqueueEmail(baseJob("key-b"));
    expect(a.id).not.toBe(b.id);
  });
});

describe("recoverStaleEmailJobs", () => {
  it("requeues an expired lease and quarantines an in-flight handoff as uncertain", () => {
    const db = getDb();
    const leased = enqueueEmail(baseJob("key-leased")).id;
    const sending = enqueueEmail(baseJob("key-sending")).id;

    // Simulate a worker that died holding these jobs (lease already expired).
    db.prepare(
      "UPDATE email_jobs SET status='leased', lease_owner='dead', lease_expires_at=datetime('now','-5 minutes') WHERE id=?",
    ).run(leased);
    db.prepare(
      "UPDATE email_jobs SET status='sending', lease_owner='dead', lease_expires_at=datetime('now','-5 minutes') WHERE id=?",
    ).run(sending);

    recoverStaleEmailJobs();

    const leasedRow = db.prepare("SELECT status FROM email_jobs WHERE id=?").get(leased) as { status: string };
    const sendingRow = db.prepare("SELECT status FROM email_jobs WHERE id=?").get(sending) as { status: string };
    // A leased job is safe to retry; an in-flight provider handoff must NOT auto-retry.
    expect(leasedRow.status).toBe("pending");
    expect(sendingRow.status).toBe("uncertain");
  });
});

describe("acquireWorkerLease", () => {
  it("grants to the first owner and blocks a different owner until expiry", () => {
    expect(acquireWorkerLease("test-loop", "owner-A", 60)).toBe(true);
    expect(acquireWorkerLease("test-loop", "owner-B", 60)).toBe(false);
    // Same owner can renew its own lease.
    expect(acquireWorkerLease("test-loop", "owner-A", 60)).toBe(true);
  });
});
