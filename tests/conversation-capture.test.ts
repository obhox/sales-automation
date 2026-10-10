// What the mailbox read keeps from a contact who has already replied.
//
// The read used to look only for contacts still awaiting a first reply, so the moment a
// reply was filed the contact dropped out of it and whatever they wrote next was never
// seen here. These run the real sync and the real reply processor (rule-based: no AI key
// is configured, so nothing leaves the machine) against a fake IMAP server.
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
vi.mock("@/lib/email/sender", () => ({ sendEmail: vi.fn(async () => ({ messageId: "<x@test>" })) }));

// Loaded in beforeAll rather than imported: a static import is hoisted above FakeImap, and
// the mock factory would then run before the class it returns exists.
let getDb: typeof import("@/lib/db").getDb;
let syncEmailInbox: typeof import("@/lib/email/inbox").syncEmailInbox;

const WS = "ws-capture";
// Conversations "began" on this database on 10 August: mail dated before it is history.
const BEGAN = "2026-08-10 00:00:00";
const BEFORE = "Fri, 07 Aug 2026 12:00:00 +0000";
const AFTER = (minute: number) => `Thu, 20 Aug 2026 09:${String(minute).padStart(2, "0")}:00 +0000`;

function message(opts: { uid: number; from: string; id: string; body: string; date: string; attachment?: { filename: string; content: string } }): StoredMessage {
  const head = [`From: Lead <${opts.from}>`, "To: me@example.com", "Subject: Re: hello", `Message-ID: <${opts.id}@mail.test>`, `Date: ${opts.date}`, "MIME-Version: 1.0"];
  const raw = opts.attachment
    ? [
      ...head, 'Content-Type: multipart/mixed; boundary="b1"', "",
      "--b1", "Content-Type: text/plain; charset=utf-8", "", opts.body, "",
      "--b1", `Content-Type: application/pdf; name="${opts.attachment.filename}"`, `Content-Disposition: attachment; filename="${opts.attachment.filename}"`, "Content-Transfer-Encoding: base64", "",
      Buffer.from(opts.attachment.content).toString("base64"), "--b1--", "",
    ].join("\r\n")
    : [...head, "Content-Type: text/plain; charset=utf-8", "", opts.body].join("\r\n");
  return { uid: opts.uid, from: `Lead <${opts.from}>`, raw };
}

let seq = 0;
/** A mailbox and one campaign contact who has been emailed from it and has not replied. */
function scenario(messages: (lead: string) => StoredMessage[]) {
  const db = getDb();
  const n = ++seq;
  const ids = { accountId: `capture-acct-${n}`, targetId: `capture-target-${n}`, lead: `lead${n}@capture.test`, user: `mailbox${n}@capture.test`, run: `capture-run-${n}` };
  db.prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, imap_host, username, password) VALUES (?, ?, 'Acc', ?, 'smtp.example.com', 'imap.example.com', ?, 'pw')").run(ids.accountId, WS, ids.user, ids.user);
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES (?, ?, 'Lee Lead', ?)").run(ids.targetId, WS, ids.lead);
  db.prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(`capture-wf-${n}`, WS);
  db.prepare("INSERT INTO runs (id, workflow_id, status, workspace_id) VALUES (?, ?, 'running', ?)").run(ids.run, `capture-wf-${n}`, WS);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`capture-rp-${n}`, ids.run, ids.targetId, ids.accountId);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'email', 'in_progress', 1)").run(`capture-rt-${n}`, `capture-rp-${n}`);
  db.prepare(`INSERT INTO email_jobs (id, workspace_id, email_account_id, target_id, run_id, idempotency_key, source, recipient, subject, body_text, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'campaign', ?, 'hello', 'Body', 'sent', '2026-08-01 09:00:00')`).run(`capture-job-${n}`, WS, ids.accountId, ids.targetId, ids.run, `capture-key-${n}`, ids.lead);
  const mailbox: Mailbox = { uidvalidity: 1, messages: messages(ids.lead), downloads: [] };
  mailboxes.set(ids.user, mailbox);
  return { ...ids, mailbox, n };
}

const replies = (targetId: string) => getDb().prepare("SELECT body_text, later, classified_at IS NOT NULL AS classified, json_extract(dispatch_result_json, '$.action') AS action FROM email_replies WHERE target_id = ? ORDER BY imap_uid").all(targetId) as
  Array<{ body_text: string; later: number; classified: number; action: string | null }>;
const conversation = (targetId: string) => getDb().prepare("SELECT status, verdict, temperature, last_message_preview, sla_due_at FROM conversations WHERE target_id = ?").get(targetId) as
  { status: string; verdict: string | null; temperature: string | null; last_message_preview: string | null; sla_due_at: string | null } | undefined;
const trackState = (n: number) => (getDb().prepare("SELECT state FROM run_profile_tracks WHERE id = ?").get(`capture-rt-${n}`) as { state: string }).state;
const todos = (targetId: string) => (getDb().prepare("SELECT COUNT(*) AS c FROM todos WHERE target_id = ?").get(targetId) as { c: number }).c;

beforeAll(async () => {
  ({ getDb } = await import("@/lib/db"));
  ({ syncEmailInbox } = await import("@/lib/email/inbox"));
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, 'Capture', 'capture')").run(WS);
  db.prepare("INSERT OR REPLACE INTO _migration_flags (key, applied_at) VALUES ('conversations_backfilled_at', ?)").run(BEGAN);
});

describe("mail from a contact who has already replied", () => {
  it("is captured, every message in order, and starts nothing over", async () => {
    const s = scenario((lead) => [message({ uid: 5, from: lead, id: "first", body: "Sounds interesting, tell me more.", date: AFTER(1) })]);
    expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 1, bounces: 0 });
    expect(replies(s.targetId)).toEqual([{ body_text: "Sounds interesting, tell me more.", later: 0, classified: 1, action: "unenrolled_and_task_created" }]);
    expect(trackState(s.n)).toBe("skipped");
    expect(todos(s.targetId)).toBe(1);
    const db = getDb();
    // The team dealt with it: closed, and the contact put back in a campaign by hand.
    db.prepare("UPDATE conversations SET status = 'closed', sla_due_at = NULL WHERE target_id = ?").run(s.targetId);
    db.prepare("UPDATE run_profile_tracks SET state = 'in_progress' WHERE id = ?").run(`capture-rt-${s.n}`);

    // Two more arrive before the next read. Before, neither would ever have been seen.
    s.mailbox.messages.push(
      message({ uid: 8, from: s.lead, id: "second", body: "Also, what does onboarding look like?", date: AFTER(20) }),
      message({ uid: 9, from: s.lead, id: "third", body: "And can you send pricing?", date: AFTER(30), attachment: { filename: "requirements.pdf", content: "%PDF requirements" } }),
    );
    s.mailbox.downloads.length = 0;
    expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 2, bounces: 0 });
    expect(s.mailbox.downloads).toEqual([8, 9]);
    expect(replies(s.targetId).map((r) => [r.body_text, r.later, r.action])).toEqual([
      ["Sounds interesting, tell me more.", 0, "unenrolled_and_task_created"],
      ["Also, what does onboarding look like?", 1, "none"],
      ["And can you send pricing?", 1, "none"],
    ]);
    // The conversation is open again with the newest message; the campaign and the task list are untouched.
    expect(conversation(s.targetId)).toMatchObject({ status: "open", verdict: "positive", temperature: "hot", last_message_preview: "And can you send pricing?" });
    expect(conversation(s.targetId)!.sla_due_at).not.toBeNull();
    expect(trackState(s.n)).toBe("in_progress");
    expect(todos(s.targetId)).toBe(1);
    // The file that came with the third is kept with it.
    expect(db.prepare(`SELECT a.filename, a.content_type, CAST(a.content AS TEXT) AS content FROM conversation_attachments a JOIN email_replies er ON er.id = a.reply_id WHERE er.target_id = ?`).all(s.targetId))
      .toEqual([{ filename: "requirements.pdf", content_type: "application/pdf", content: "%PDF requirements" }]);

    // And nothing is downloaded, counted or announced again on the reads after that.
    s.mailbox.downloads.length = 0;
    expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 0, bounces: 0 });
    expect(s.mailbox.downloads).toEqual([]);
    expect(replies(s.targetId)).toHaveLength(3);
  });

  it("is still read when the mailbox has nobody left awaiting a first reply", async () => {
    const s = scenario((lead) => [message({ uid: 1, from: lead, id: "only-first", body: "Not interested, thanks.", date: AFTER(2) })]);
    await syncEmailInbox(s.accountId);
    expect(getDb().prepare("SELECT email_replied_at IS NOT NULL AS replied FROM targets WHERE id = ?").get(s.targetId)).toEqual({ replied: 1 });
    s.mailbox.messages.push(message({ uid: 2, from: s.lead, id: "only-second", body: "On reflection, send me something to read.", date: AFTER(40) }));
    expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 1, bounces: 0 });
    expect(replies(s.targetId).map((r) => r.later)).toEqual([0, 1]);
  });

  it("honours 'unsubscribe' in a later message", async () => {
    const s = scenario((lead) => [message({ uid: 1, from: lead, id: "opt-first", body: "Not a priority right now.", date: AFTER(3) })]);
    await syncEmailInbox(s.accountId);
    s.mailbox.messages.push(message({ uid: 2, from: s.lead, id: "opt-second", body: "Please unsubscribe me.", date: AFTER(50) }));
    await syncEmailInbox(s.accountId);
    expect(replies(s.targetId).map((r) => [r.later, r.action])).toEqual([[0, "unenrolled"], [1, "suppressed_and_unenrolled"]]);
    expect(getDb().prepare("SELECT reason FROM suppressions WHERE workspace_id = ? AND value = ?").get(WS, s.lead)).toEqual({ reason: "unsubscribe" });
  });

  it("is history, and reopens nothing, when it is older than conversations here and only now being stored", async () => {
    const s = scenario((lead) => [message({ uid: 3, from: lead, id: "hist-first", body: "Sounds good, let's talk.", date: AFTER(4) })]);
    await syncEmailInbox(s.accountId);
    getDb().prepare("UPDATE conversations SET status = 'closed' WHERE target_id = ?").run(s.targetId);
    // An older message from them, still in the mailbox, that the read never used to keep.
    s.mailbox.messages.unshift(message({ uid: 1, from: s.lead, id: "hist-old", body: "Who is this?", date: BEFORE }));
    expect(await syncEmailInbox(s.accountId)).toEqual({ replies: 1, bounces: 0 });
    expect(replies(s.targetId).map((r) => [r.body_text, r.later])).toEqual([["Who is this?", 1], ["Sounds good, let's talk.", 0]]);
    expect(conversation(s.targetId)).toMatchObject({ status: "closed", last_message_preview: "Sounds good, let's talk." });
  });
});

describe("a contact still awaiting a first reply", () => {
  it("is handled as before: the newest message is read, classified and acted on", async () => {
    const s = scenario((lead) => [
      message({ uid: 1, from: lead, id: "ooo", body: "I am out of the office until Monday.", date: AFTER(5) }),
    ]);
    await syncEmailInbox(s.accountId);
    expect(replies(s.targetId).map((r) => [r.later, r.action])).toEqual([[0, "rescheduled"]]);
    expect(trackState(s.n)).toBe("in_progress");
    // The reply that follows an away message is the first real one: it stops the campaign.
    s.mailbox.messages.push(message({ uid: 2, from: s.lead, id: "real", body: "Back. Sounds interesting, tell me more.", date: AFTER(55) }));
    await syncEmailInbox(s.accountId);
    expect(replies(s.targetId).map((r) => [r.later, r.action])).toEqual([[0, "rescheduled"], [0, "unenrolled_and_task_created"]]);
    expect(trackState(s.n)).toBe("skipped");
    expect(todos(s.targetId)).toBe(1);
  });
});
