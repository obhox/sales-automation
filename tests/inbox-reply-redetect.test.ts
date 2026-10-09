// A reply must be announced once — when it is filed — not on every poll afterwards.
//
// The poller's header scan finds the newest message from each contact still awaiting a
// reply. An out-of-office auto-reply leaves its contact awaiting one on purpose (they stay
// enrolled), so that single message came back on every poll: logged as "Reply detected",
// counted as a reply, and downloaded in full, only to be discarded as a duplicate. Production
// reported "1 reply" every five minutes for two months for each of five such contacts.
//
// These run the real sync and the real classifier (rule-based: no AI key is configured, so
// nothing leaves the machine) against a fake IMAP server.
process.env.TZ = "America/Los_Angeles"; // not UTC, so a local-time misread of a stored time shows

import { beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

interface StoredMessage { uid: number; from: string; raw: string }
interface Mailbox { uidvalidity: number; messages: StoredMessage[]; downloads: number[] }

/** One fake mailbox per IMAP user, so each test owns its own. */
const mailboxes = new Map<string, Mailbox>();

class FakeImap extends EventEmitter {
  private box: Mailbox;
  seq = { fetch: () => { const f = new EventEmitter(); setImmediate(() => f.emit("end")); return f; } }; // bounce scan: nothing

  constructor(config: { user: string }) {
    super();
    this.box = mailboxes.get(config.user)!;
  }
  connect() { setImmediate(() => this.emit("ready")); }
  openBox(_name: string, _readOnly: boolean, cb: (err: Error | null, box: unknown) => void) {
    setImmediate(() => cb(null, { messages: { total: this.box.messages.length }, uidvalidity: this.box.uidvalidity }));
  }
  search(_criteria: unknown, cb: (err: Error | null, uids: number[]) => void) {
    setImmediate(() => cb(null, this.box.messages.map((m) => m.uid)));
  }
  fetch(source: number | number[], options: { bodies?: unknown }) {
    const fetch = new EventEmitter();
    const headersOnly = options?.bodies === "HEADER.FIELDS (FROM)";
    const uids = Array.isArray(source) ? source : [source];
    if (!headersOnly) this.box.downloads.push(...uids);

    setImmediate(() => {
      for (const uid of uids) {
        const stored = this.box.messages.find((m) => m.uid === uid);
        if (!stored) continue;
        const msg = new EventEmitter();
        fetch.emit("message", msg);
        const body = new EventEmitter();
        msg.emit("body", body);
        body.emit("data", Buffer.from(headersOnly ? `From: ${stored.from}\r\n\r\n` : stored.raw));
        body.emit("end");
        msg.emit("attributes", { uid }); // node-imap delivers the UID after the body
        msg.emit("end");
      }
      fetch.emit("end");
    });
    return fetch;
  }
  end() { this.emit("end"); }
  destroy() {}
}

vi.mock("imap", () => ({ default: FakeImap }));

// Loaded in beforeAll rather than imported: a static import is hoisted above FakeImap, and
// the mock factory would then run before the class it returns exists.
let getDb: typeof import("@/lib/db").getDb;
let syncEmailInbox: typeof import("@/lib/email/inbox").syncEmailInbox;
let shouldSyncEmailInbox: typeof import("@/lib/email/inbox").shouldSyncEmailInbox;
let outOfOfficeResumeAt: typeof import("@/lib/community-replies").outOfOfficeResumeAt;

const WS = "ws-redetect";
const OUT_OF_OFFICE = "Hello,\n\nI am out of the office until Monday 17th August.\n\nThank you";

function message(opts: { uid: number; from: string; id: string; body: string; warmup?: boolean }): StoredMessage {
  const raw = [
    `From: Lead <${opts.from}>`,
    "To: me@example.com",
    "Subject: Re: hello",
    `Message-ID: <${opts.id}@mail.test>`,
    "Date: Fri, 07 Aug 2026 12:01:50 +0000",
    ...(opts.warmup ? ["X-Linki-Warmup-ID: w1"] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body,
  ].join("\r\n");
  return { uid: opts.uid, from: `Lead <${opts.from}>`, raw };
}

let seq = 0;
/** A mailbox and one campaign contact who has been emailed from it and has not replied. */
function scenario(messages: (lead: string) => StoredMessage[], uidvalidity = 1) {
  const db = getDb();
  const n = ++seq;
  const accountId = `redetect-acct-${n}`;
  const user = `mailbox${n}@example.com`;
  const lead = `lead${n}@example.com`;
  const targetId = `redetect-target-${n}`;
  db.prepare(
    "INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, imap_host, username, password) VALUES (?, ?, 'Acc', ?, 'smtp.example.com', 'imap.example.com', ?, 'pw')"
  ).run(accountId, WS, user, user);
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES (?, ?, 'Lead', ?)").run(targetId, WS, lead);
  db.prepare(
    `INSERT INTO email_jobs (id, workspace_id, email_account_id, target_id, idempotency_key, source, recipient, subject, body_text, status)
     VALUES (?, ?, ?, ?, ?, 'campaign', ?, 'Hi', 'Body', 'sent')`
  ).run(`redetect-job-${n}`, WS, accountId, targetId, `redetect-key-${n}`, lead);

  const mailbox: Mailbox = { uidvalidity, messages: messages(lead), downloads: [] };
  mailboxes.set(user, mailbox);
  return { accountId, targetId, lead, mailbox };
}

const replies = (targetId: string) =>
  getDb().prepare("SELECT id, message_id, imap_uid, imap_uidvalidity, classified_at FROM email_replies WHERE target_id = ? ORDER BY imap_uid").all(targetId) as
    Array<{ id: string; message_id: string; imap_uid: number | null; imap_uidvalidity: number | null; classified_at: string | null }>;
const contact = (targetId: string) =>
  getDb().prepare("SELECT email_replied_at, reply_kind FROM targets WHERE id = ?").get(targetId) as { email_replied_at: string | null; reply_kind: string | null };
const events = (targetId: string) =>
  (getDb().prepare("SELECT COUNT(*) AS c FROM domain_events WHERE type = 'reply.received' AND payload_json LIKE ?").get(`%${targetId}%`) as { c: number }).c;

beforeAll(async () => {
  ({ getDb } = await import("@/lib/db"));
  ({ syncEmailInbox, shouldSyncEmailInbox } = await import("@/lib/email/inbox"));
  ({ outOfOfficeResumeAt } = await import("@/lib/community-replies"));
  getDb().prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, WS, WS);
});

describe("an out-of-office reply", () => {
  it("is reported once, then left alone on every later poll", async () => {
    const s = scenario((lead) => [message({ uid: 7, from: lead, id: "ooo-1", body: OUT_OF_OFFICE })]);

    expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 1, bounces: 0 });
    // The situation that caused the loop: filed and classified, yet still awaiting a reply.
    expect(contact(s.targetId)).toEqual({ email_replied_at: null, reply_kind: "out_of_office" });
    const [stored] = replies(s.targetId);
    expect(stored).toMatchObject({ message_id: "<ooo-1@mail.test>", imap_uid: 7, imap_uidvalidity: 1 });
    expect(s.mailbox.downloads).toEqual([7]);

    for (let poll = 0; poll < 3; poll++) {
      expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 0, bounces: 0 });
    }
    expect(s.mailbox.downloads).toEqual([7]);                    // never downloaded again
    expect(replies(s.targetId)).toEqual([stored]);               // one row, classified once
    expect(events(s.targetId)).toBe(1);                          // one reply.received event
  });

  it("does not hide a real reply that arrives afterwards", async () => {
    const s = scenario((lead) => [message({ uid: 7, from: lead, id: "ooo-2", body: OUT_OF_OFFICE })]);
    await syncEmailInbox(s.accountId);

    s.mailbox.messages.push(message({ uid: 12, from: s.lead, id: "real-2", body: "Not interested, thanks." }));
    expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 1, bounces: 0 });

    expect(replies(s.targetId).map((r) => r.imap_uid)).toEqual([7, 12]);
    expect(contact(s.targetId).reply_kind).toBe("negative");
    expect(contact(s.targetId).email_replied_at).not.toBeNull();
  });
});

describe("a reply stored before its mailbox position was tracked", () => {
  it("is recognised by Message-ID once, remembered, and not counted as new", async () => {
    // Every reply already in production: stored, but with no UID on the row.
    const s = scenario((lead) => [message({ uid: 7, from: lead, id: "legacy-1", body: OUT_OF_OFFICE })]);
    getDb().prepare(
      "INSERT INTO email_replies (id, workspace_id, target_id, email_account_id, from_email, subject, body_text, received_at, message_id) VALUES ('legacy-row', ?, ?, ?, ?, 'Re: hello', 'stored earlier', '2026-08-07T12:01:50.000Z', '<legacy-1@mail.test>')"
    ).run(WS, s.targetId, s.accountId, s.lead);

    expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 0, bounces: 0 }); // not a new reply
    expect(s.mailbox.downloads).toEqual([7]);                                       // looked at once…
    expect(replies(s.targetId)).toMatchObject([{ id: "legacy-row", imap_uid: 7, imap_uidvalidity: 1 }]);

    await syncEmailInbox(s.accountId);
    expect(s.mailbox.downloads).toEqual([7]);                                       // …and never again
    expect(replies(s.targetId)).toHaveLength(1);
  });

  it("is looked up again, not trusted, when the mailbox's UIDs are renumbered", async () => {
    const s = scenario((lead) => [message({ uid: 7, from: lead, id: "renumber-1", body: OUT_OF_OFFICE })]);
    await syncEmailInbox(s.accountId);

    // UIDVALIDITY changed: UID 7 may now be a different message altogether.
    s.mailbox.uidvalidity = 2;
    s.mailbox.messages = [message({ uid: 7, from: s.lead, id: "renumber-other", body: "Not interested, thanks." })];
    expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 1, bounces: 0 });
    expect(replies(s.targetId)).toHaveLength(2);
  });
});

describe("a message that is not a reply", () => {
  it("is examined once and then neither counted nor downloaded again", async () => {
    const s = scenario((lead) => [message({ uid: 4, from: lead, id: "warmup-1", body: "warmup chatter", warmup: true })]);

    for (let poll = 0; poll < 3; poll++) {
      expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 0, bounces: 0 });
    }
    expect(s.mailbox.downloads).toEqual([4]);
    expect(replies(s.targetId)).toEqual([]);
  });
});

describe("the poll throttle", () => {
  const setLast = (accountId: string, modifier: string) =>
    getDb().prepare("UPDATE email_accounts SET inbox_synced_at = datetime('now', ?) WHERE id = ?").run(modifier, accountId);

  it("reads the stored time as UTC whatever timezone the host is in", () => {
    // datetime('now') carries no zone. Read as local time on this (UTC-7/8) clock it lands
    // hours in the past, so every mailbox looked overdue on every pass.
    const s = scenario(() => []);
    setLast(s.accountId, "-1 minutes");
    expect(shouldSyncEmailInbox(s.accountId)).toBe(false);
    setLast(s.accountId, "-6 minutes");
    expect(shouldSyncEmailInbox(s.accountId)).toBe(true);
  });
});

describe("when to resume after an out-of-office", () => {
  const now = Date.parse("2026-08-10T20:12:40.000Z");
  const DAY = 86_400_000;

  it("uses a return date that is still ahead", () => {
    expect(outOfOfficeResumeAt("2026-08-17", now)).toBe("2026-08-17T00:00:00.000Z");
  });

  it("never schedules into the past", () => {
    // What production did: "hasta el 17 de agosto" came back as 2024, and the follow-up
    // was "rescheduled" to a moment two years gone — so it went out on the next tick.
    expect(outOfOfficeResumeAt("2024-08-17T00:00:00.000Z", now)).toBe(new Date(now + 7 * DAY).toISOString());
  });

  it("gives someone who has just come back a day", () => {
    expect(outOfOfficeResumeAt("2026-08-09", now)).toBe(new Date(now + DAY).toISOString());
  });

  it("waits a week when there is no usable date", () => {
    for (const missing of [null, undefined, "", "soon"]) {
      expect(outOfOfficeResumeAt(missing, now)).toBe(new Date(now + 7 * DAY).toISOString());
    }
  });
});
