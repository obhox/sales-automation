import { describe, it, expect, vi, beforeAll } from "vitest";
import { EventEmitter } from "events";
import os from "os";
import path from "path";

// node-imap emits a message's `attributes` -- the event carrying the UID -- AFTER its body
// stream has ended. The header scan read `uid` when the body stream ended, so it read 0, and
// every capture then asked for UID 0. node-imap rejects that outright ("UID/seqno must be
// greater than zero"), so in production every reply was detected and none was ever stored.
//
// The fake below reproduces that ordering exactly: body data, body end, THEN attributes.

const capturedFetchUids: unknown[] = [];

class FakeFetch extends EventEmitter {}

class FakeImap extends EventEmitter {
  // The bounce scan fetches by sequence number; it has nothing to find here.
  seq = {
    fetch: () => {
      const fetch = new FakeFetch();
      setImmediate(() => fetch.emit("end"));
      return fetch;
    },
  };

  constructor(_config: unknown) {
    super();
  }

  connect() {
    setImmediate(() => this.emit("ready"));
  }

  openBox(_name: string, _readOnly: boolean, cb: (err: Error | null, box: unknown) => void) {
    setImmediate(() => cb(null, { messages: { total: 1 } }));
  }

  search(_criteria: unknown, cb: (err: Error | null, uids: number[]) => void) {
    setImmediate(() => cb(null, [7]));
  }

  fetch(source: unknown, options: { bodies?: unknown }) {
    capturedFetchUids.push(source);
    const fetch = new FakeFetch();
    const isHeaderScan = options?.bodies === "HEADER.FIELDS (FROM)";

    setImmediate(() => {
      if (isHeaderScan) {
        const msg = new EventEmitter();
        fetch.emit("message", msg);

        const body = new EventEmitter();
        msg.emit("body", body);
        body.emit("data", Buffer.from("From: Lead <lead@example.com>\r\n\r\n"));
        body.emit("end");

        // The UID arrives only now -- after the body stream is done.
        msg.emit("attributes", { uid: 7 });
        msg.emit("end");
      }
      fetch.emit("end");
    });

    return fetch;
  }

  end() {
    this.emit("end");
  }

  destroy() {}
}

vi.mock("imap", () => ({ default: FakeImap }));

describe("header scan UID handling", () => {
  beforeAll(() => {
    process.env.LINKI_DB_PATH = path.join(
      os.tmpdir(),
      `linki-uid-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
  });

  it("hands capture the message's real UID, not zero", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();

    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws1', 'Test', 'test')").run();
    db.prepare(`
      INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, imap_host, username, password)
      VALUES ('acc1', 'ws1', 'Acc', 'me@example.com', 'smtp.example.com', 'imap.example.com', 'me@example.com', 'pw')
    `).run();
    db.prepare("INSERT INTO targets (id, workspace_id, email) VALUES ('t1', 'ws1', 'lead@example.com')").run();
    db.prepare(`
      INSERT INTO email_jobs (id, workspace_id, email_account_id, target_id, idempotency_key,
                              source, recipient, subject, body_text, status)
      VALUES ('j1', 'ws1', 'acc1', 't1', 'k1', 'campaign', 'lead@example.com', 'Hi', 'Body', 'sent')
    `).run();

    const { syncEmailInbox } = await import("@/lib/email/inbox");
    await syncEmailInbox("acc1");

    // The first fetch is the header scan (an array of UIDs). The capture fetch that follows
    // must carry the real UID; 0 is what the race produced and what node-imap rejects.
    const captureUid = capturedFetchUids.find((u) => typeof u === "number");
    expect(captureUid).toBe(7);
    expect(captureUid).not.toBe(0);
  });
});
