// Conversations: one row per contact who has written back, holding what a team decides
// about the exchange. Real routes and a real (throwaway) database. Nothing leaves the
// machine: the SMTP send is stubbed, no mailbox and no LinkedIn session is opened, and no
// model is asked anything (no AI key is configured, so replies are read by the fixed rules).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const smtp = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; body: string; inReplyTo?: string; references?: string; attachments?: Array<{ filename: string; content: Buffer }> }>,
  fail: null as Error | null,
}));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, to: string, subject: string, body: string, options: { messageId: string; inReplyTo?: string; references?: string; attachments?: Array<{ filename: string; content: Buffer }> }) => {
    if (smtp.fail) throw smtp.fail;
    smtp.sent.push({ to, subject, body, inReplyTo: options.inReplyTo, references: options.references, attachments: options.attachments });
    return { messageId: options.messageId };
  },
}));
// Opening a mailbox is what reading a thread must no longer do.
vi.mock("imap", () => ({ default: class { constructor() { throw new Error("a mailbox was opened"); } } }));
vi.mock("@/lib/linkedin/runner", async (original) => ({ ...(await original<typeof import("@/lib/linkedin/runner")>()), ensureGlobalRunnerStarted: vi.fn() }));

import { getDb, migrateDatabase } from "@/lib/db";
import { classifyAndDispatch, fileLaterReply } from "@/lib/community-replies";
import { reconcileConversations } from "@/lib/conversations/reconcile";
import { conversationOfTarget, type ConversationRow } from "@/lib/conversations/rows";
import { isLaterMessage, receiveReply, setStatus, storeCampaignMessage, storeReplyAttachments, wakeSnoozed } from "@/lib/conversations/store";
import { readThread } from "@/lib/conversations/thread";
import { applyInboxPull, type InboxConversation } from "@/lib/linkedin/inbox-sync";
import { addSuppression } from "@/lib/platform/suppression";
import conversationsList from "@/pages/api/conversations";
import markAllReadRoute from "@/pages/api/conversations/read";
import conversationRoute from "@/pages/api/conversations/[id]";
import draftRoute from "@/pages/api/conversations/[id]/draft";
import attachRoute from "@/pages/api/conversations/[id]/attachments";
import sendRoute from "@/pages/api/conversations/[id]/send";
import attachmentRoute from "@/pages/api/conversations/attachments/[attachmentId]";
import inboxList, { type InboxReply } from "@/pages/api/inbox";
import inboxReply from "@/pages/api/inbox/reply";
import emailThread from "@/pages/api/inbox/thread";
import contactEmails from "@/pages/api/targets/[id]/emails";
import markReplied from "@/pages/api/targets/[id]/mark-replied";
import teamInbox from "@/pages/api/platform/inbox";
import shell from "@/pages/api/shell";
import type { ConversationsResponse } from "@/pages/api/conversations";
import type { ConversationDetail } from "@/lib/conversations/detail";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
async function call(handler: Handler, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.send = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = (name: string, value: string) => { (res.headers as Record<string, string>)[name] = value; return res; };
  await handler({ query: {}, body: {}, headers: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown>; headers: Record<string, string> };
}

/** A workspace with three members and a viewer, a mailbox, a signed-in LinkedIn account and a campaign. */
function workspace() {
  const n = ++seq;
  const ws = `ws-conv-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const ids = { ada: `conv-ada-${n}`, ben: `conv-ben-${n}`, vi: `conv-viewer-${n}`, mailbox: `conv-mailbox-${n}`, account: `conv-li-${n}`, workflow: `conv-wf-${n}`, run: `conv-run-${n}` };
  const w = {
    ws, n, ...ids,
    asAda: ctxHeaders(ws, { userId: ids.ada, role: "member" }),
    asBen: ctxHeaders(ws, { userId: ids.ben, role: "admin" }),
    asViewer: ctxHeaders(ws, { userId: ids.vi, role: "viewer" }),
  };
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, from_name, smtp_host, username, password, is_verified) VALUES (?, ?, 'Sales', ?, 'Ada Lovelace', 'smtp.test.com', 'user', 'pass', 1)`).run(ids.mailbox, ws, `ada${n}@acme.test`);
  db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Ada on LinkedIn', ?, 1, ?)").run(ids.account, `conv-li-${n}@example.com`, ws);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Founders outreach', ?)").run(ids.workflow, ws);
  ["email", "delay", "email", "email"].forEach((type, i) => db().prepare(`INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds) VALUES (?, ?, ?, 'email', ?, 0)`).run(`${ids.workflow}-e${i + 1}`, ids.workflow, i + 1, type));
  db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds) VALUES (?, ?, 1, 'linkedin', 'message', 0)").run(`${ids.workflow}-l1`, ids.workflow);
  db().prepare("INSERT INTO runs (id, workflow_id, account_id, email_account_id, status, workspace_id) VALUES (?, ?, ?, ?, 'running', ?)").run(ids.run, ids.workflow, ids.account, ids.mailbox, ws);

  /** A contact enrolled in the campaign, with an email track in progress. */
  const contact = (name: string, fields: Record<string, unknown> = {}) => {
    const id = `conv-target-${++seq}`;
    const row: Record<string, unknown> = {
      id, workspace_id: ws, full_name: name, first_name: name.split(" ")[0], company: "Initech", title: "Head of Ops",
      email: `${name.toLowerCase().replace(/\W+/g, ".")}.${seq}@prospect.test`, linkedin_url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\W+/g, "-")}-${seq}/`, ...fields,
    };
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO targets (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`rp-${id}`, ids.run, id, ids.mailbox);
    db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'email', 'in_progress', 1)").run(`rt-${id}`, `rp-${id}`);
    return id;
  };
  /** A reply as the mailbox read stores it. Not filed: that is what is under test. */
  const reply = (target: string | null, body: string, extra: Record<string, unknown> = {}) => {
    const id = `conv-reply-${++seq}`;
    const from = target ? (db().prepare("SELECT email FROM targets WHERE id = ?").get(target) as { email: string }).email : "gone@nowhere.test";
    const row: Record<string, unknown> = { id, workspace_id: ws, target_id: target, run_id: ids.run, email_account_id: ids.mailbox, from_email: from, subject: "Re: Quick question", body_text: body, received_at: new Date().toISOString(), message_id: `<${id}@mail.test>`, ...extra };
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO email_replies (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
    return id;
  };
  /** An email this app sent the contact, as the mail queue records it. */
  const sentEmail = (target: string, subject: string, body: string, at: string, extra: Record<string, unknown> = {}) => {
    const id = `conv-job-${++seq}`;
    const to = (db().prepare("SELECT email FROM targets WHERE id = ?").get(target) as { email: string }).email;
    const row: Record<string, unknown> = { id, workspace_id: ws, email_account_id: ids.mailbox, idempotency_key: id, source: "campaign", target_id: target, run_id: ids.run, step_id: `${ids.workflow}-e1`, recipient: to, subject, body_text: body, status: "sent", created_at: at, ...extra };
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO email_jobs (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
    db().prepare("INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, target_id, run_id, recipient, subject, message_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`sm-${id}`, ws, id, ids.mailbox, row.target_id, ids.run, to, subject, `<${id}@acme.test>`, at);
    return id;
  };
  return { ...w, contact, reply, sentEmail };
}
type W = ReturnType<typeof workspace>;

const conv = (target: string) => conversationOfTarget(db(), target)!;
const convOfReply = (replyId: string) => db().prepare("SELECT c.* FROM conversations c JOIN email_replies er ON er.conversation_id = c.id WHERE er.id = ?").get(replyId) as ConversationRow;
const tagsOf = (conversationId: string) => (db().prepare("SELECT it.name FROM conversation_tags ct JOIN inbox_tags it ON it.id = ct.tag_id WHERE ct.conversation_id = ? ORDER BY it.name").all(conversationId) as Array<{ name: string }>).map((row) => row.name);
const track = (target: string) => db().prepare("SELECT state, error_message FROM run_profile_tracks WHERE id = ?").get(`rt-${target}`) as { state: string; error_message: string | null };
const todos = (target: string) => (db().prepare("SELECT COUNT(*) AS c FROM todos WHERE target_id = ?").get(target) as { c: number }).c;
const notices = (ws: string, kind: string) => db().prepare("SELECT user_id, title FROM notifications WHERE workspace_id = ? AND kind = ? ORDER BY created_at, rowid").all(ws, kind) as Array<{ user_id: string | null; title: string }>;
const tag = (w: W, name: string) => { const id = `conv-tag-${++seq}`; db().prepare("INSERT INTO inbox_tags (id, workspace_id, name) VALUES (?, ?, ?)").run(id, w.ws, name); return id; };

const list = async (w: W, query: Record<string, string> = {}, headers = w.asAda) => (await call(conversationsList, { method: "GET", query, headers })).body as unknown as ConversationsResponse;
const open = async (w: W, id: string, headers = w.asAda) => (await call(conversationRoute, { method: "GET", query: { id }, headers })).body as unknown as ConversationDetail;
const patch = (w: W, id: string, body: Record<string, unknown>, headers = w.asAda) => call(conversationRoute, { method: "PATCH", query: { id }, body, headers });
const send = (w: W, id: string, body: Record<string, unknown>, headers = w.asAda) => call(sendRoute, { method: "POST", query: { id }, body, headers });
const legacyList = async (w: W, query: Record<string, string> = {}, headers = w.asAda) => ((await call(inboxList, { method: "GET", query, headers })).body.replies as InboxReply[]);
const act = (w: W, body: Record<string, unknown>, headers = w.asAda) => call(teamInbox, { method: "POST", body, headers });

beforeEach(() => { getDb(); smtp.sent.length = 0; smtp.fail = null; });

// ── What a conversation starts from ─────────────────────────────────────────────────────
describe("the replies stored before conversations existed", () => {
  it("become one conversation per contact, starting from what the replies said", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const pricing = tag(w, "Pricing"), urgent = tag(w, "Urgent");
    // An older reply somebody was handling, then a newer one that arrived bare: the state
    // the old inbox showed was the newer one's, and the assignee and the tag were gone.
    const first = w.reply(lee, "Sounds interesting, tell me more.", { received_at: ago(48 * HOUR), assigned_to: w.ada, inbox_status: "resolved", sentiment: "positive", classified_at: ago(48 * HOUR), classification_json: JSON.stringify({ kind: "positive", summary: "Interested" }) });
    const second = w.reply(lee, "Any news on pricing?", { received_at: ago(2 * HOUR) });
    db().prepare("INSERT INTO email_reply_tags (reply_id, tag_id) VALUES (?, ?), (?, ?)").run(first, pricing, second, urgent);

    expect(reconcileConversations(db(), w.ws)).toBe(1);
    const c = conv(lee);
    expect(c).toMatchObject({ status: "open", assigned_to: w.ada, temperature: "hot", verdict: "positive", last_reply_id: second, last_message_direction: "in", last_message_channel: "email", last_message_preview: "Any news on pricing?" });
    expect(tagsOf(c.id)).toEqual(["Pricing", "Urgent"]);
    expect(db().prepare("SELECT COUNT(*) AS c FROM email_replies WHERE conversation_id = ?").get(c.id)).toEqual({ c: 2 });
    // Asking again makes nothing new.
    expect(reconcileConversations(db(), w.ws)).toBe(0);
  });

  it("read a status and a sentiment written in the old words", () => {
    const w = workspace();
    const waiting = w.contact("Wes Waiting"), done = w.contact("Dee Done");
    w.reply(waiting, "Let me check with my team.", { inbox_status: "pending", sentiment: "neutral" });
    w.reply(done, "Not for us, thanks.", { inbox_status: "resolved", sentiment: "negative" });
    reconcileConversations(db(), w.ws);
    expect(conv(waiting)).toMatchObject({ status: "snoozed", snoozed_until: null, temperature: "warm" });
    expect(conv(done)).toMatchObject({ status: "closed", temperature: "cold" });
  });

  it("are filed once on upgrade, after the database has been copied", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linki-conv-"));
    const file = path.join(dir, "upgrade.db");
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    migrateDatabase(old);
    // Put it back to how a database looks before this release: replies, and no conversations.
    old.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('w', 'W', 'w')").run();
    old.prepare("INSERT INTO companies (id, workspace_id, name) VALUES ('co', 'w', 'Initech')").run();
    old.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES ('t1', 'w', 'Lee Lead', 'lee@prospect.test')").run();
    old.prepare("INSERT INTO targets (id, workspace_id, full_name, last_replied_at) VALUES ('t2', 'w', 'Lin Linked', '2026-09-01 09:00:00')").run();
    old.prepare("INSERT INTO email_replies (id, workspace_id, target_id, from_email, body_text, received_at, inbox_status) VALUES ('r1', 'w', 't1', 'lee@prospect.test', 'Yes please', '2026-09-02T10:00:00.000Z', 'closed')").run();
    old.prepare("DELETE FROM _migration_flags WHERE key LIKE 'conversations_%'").run();
    const copies = () => fs.readdirSync(dir).filter((name) => name.includes(".before-conversations-"));

    migrateDatabase(old);
    expect(copies()).toHaveLength(1);
    expect(old.prepare("SELECT target_id, status FROM conversations ORDER BY target_id").all()).toEqual([{ target_id: "t1", status: "closed" }, { target_id: "t2", status: "open" }]);
    expect(old.prepare("SELECT conversation_id IS NOT NULL AS filed FROM email_replies WHERE id = 'r1'").get()).toEqual({ filed: 1 });
    // The copy is the database as it was: no conversations in it.
    const copy = new Database(path.join(dir, copies()[0]), { readonly: true });
    expect(copy.prepare("SELECT COUNT(*) AS c FROM conversations").get()).toEqual({ c: 0 });
    copy.close();

    // Once: a second start copies nothing and changes nothing.
    old.prepare("UPDATE conversations SET status = 'snoozed' WHERE target_id = 't1'").run();
    migrateDatabase(old);
    expect(copies()).toHaveLength(1);
    expect(old.prepare("SELECT status FROM conversations WHERE target_id = 't1'").get()).toEqual({ status: "snoozed" });
    old.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── A new message ───────────────────────────────────────────────────────────────────────
describe("a new message from a contact already in a conversation", () => {
  function handled() {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const first = w.reply(lee, "Sounds interesting, tell me more.", { received_at: ago(30 * HOUR) });
    receiveReply(db(), first);
    const urgent = tag(w, "Urgent");
    return { w, lee, first, urgent, id: conv(lee).id };
  }

  it("opens it again and leaves who has it, how warm it is and its tags alone", async () => {
    const { w, lee, urgent, id } = handled();
    expect((await patch(w, id, { assigned_to: w.ben, temperature: "hot", add_tags: [urgent], status: "closed" })).statusCode).toBe(200);
    expect(conv(lee)).toMatchObject({ status: "closed", assigned_to: w.ben, temperature: "hot", sla_due_at: null });

    const filed = receiveReply(db(), w.reply(lee, "Actually, can we talk this week?"));
    expect(filed).toMatchObject({ created: false, reopened: true });
    expect(conv(lee)).toMatchObject({ status: "open", assigned_to: w.ben, temperature: "hot", last_message_preview: "Actually, can we talk this week?" });
    expect(tagsOf(id)).toEqual(["Urgent"]);
    // An answer is due again, and whoever has the conversation is told.
    expect(Date.parse(conv(lee).sla_due_at!)).toBeGreaterThan(Date.now() + 3 * HOUR);
    expect(notices(w.ws, "conversation.reply")).toEqual([{ user_id: w.ben, title: "Lee Lead wrote again" }]);
  });

  it("wakes a snoozed one, whenever the snooze was due to end", async () => {
    const { w, lee, id } = handled();
    await patch(w, id, { status: "snoozed", snoozed_until: new Date(Date.now() + 72 * HOUR).toISOString() });
    expect(conv(lee)).toMatchObject({ status: "snoozed", snoozed_by: w.ada });
    receiveReply(db(), w.reply(lee, "Back early. Shall we?"));
    expect(conv(lee)).toMatchObject({ status: "open", snoozed_until: null, snoozed_by: null });
  });

  it("keeps the time an answer was already due", async () => {
    const { w, lee, id } = handled();
    const due = new Date(Date.now() + HOUR).toISOString();
    await patch(w, id, { sla_due_at: due });
    receiveReply(db(), w.reply(lee, "Hello? Still there?"));
    expect(conv(lee).sla_due_at).toBe(due);
  });

  it("takes its place quietly when it is old news only now being stored", async () => {
    const { w, lee, id } = handled();
    await patch(w, id, { status: "closed", assigned_to: w.ben });
    const filed = receiveReply(db(), w.reply(lee, "PS: forgot to attach the deck.", { received_at: ago(HOUR) }), { history: true });
    expect(filed).toMatchObject({ reopened: false });
    expect(conv(lee)).toMatchObject({ status: "closed", last_message_preview: "PS: forgot to attach the deck." });
    expect(notices(w.ws, "conversation.reply")).toEqual([]);
  });

  it("is filed even when whatever stored it did not file it", async () => {
    const { w, lee, id } = handled();
    await patch(w, id, { status: "closed" });
    const stray = w.reply(lee, "One more thing.");
    // The inbox asks for everything to be filed each time it is opened.
    const rows = await legacyList(w);
    expect(rows.find((row) => row.id === lee)).toMatchObject({ reply_id: stray, inbox_status: "open", conversation_id: id });
  });
});

// ── Not starting the automation over ────────────────────────────────────────────────────
describe("a later message", () => {
  /** A contact whose first reply has been read and acted on. */
  async function replied(body = "Sounds interesting, tell me more.") {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const first = w.reply(lee, body, { received_at: ago(5 * HOUR) });
    receiveReply(db(), first);
    await classifyAndDispatch(first);
    return { w, lee, first };
  }

  it("is told apart from a first reply by whether an earlier one settled the campaigns", async () => {
    const { w, lee, first } = await replied();
    expect(track(lee).state).toBe("skipped");
    expect(todos(lee)).toBe(1);
    expect(isLaterMessage(db(), lee, first)).toBe(false);
    expect(isLaterMessage(db(), lee, w.reply(lee, "Any update?"))).toBe(true);
  });

  it("is kept and shown, and unenrols, schedules and announces nothing a second time", async () => {
    const { w, lee } = await replied();
    const positives = notices(w.ws, "reply.positive").length;
    const emails = smtp.sent.length;                         // the owner was told of the first reply
    // Somebody put the contact back into a campaign after the first reply.
    db().prepare("UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL WHERE id = ?").run(`rt-${lee}`);
    await patch(w, conv(lee).id, { status: "closed" });

    const later = w.reply(lee, "Great, send me the details please.");
    fileLaterReply(later);

    expect(db().prepare("SELECT later, dispatched_at IS NOT NULL AS dispatched, json_extract(dispatch_result_json, '$.action') AS action FROM email_replies WHERE id = ?").get(later)).toEqual({ later: 1, dispatched: 1, action: "none" });
    expect(track(lee).state).toBe("in_progress");
    expect(todos(lee)).toBe(1);
    expect(notices(w.ws, "reply.positive")).toHaveLength(positives);
    expect(smtp.sent).toHaveLength(emails);                  // and is not told again
    expect(conv(lee)).toMatchObject({ status: "open", verdict: "positive", temperature: "hot" });
  });

  it("still honours an explicit request to stop being contacted", async () => {
    const { w, lee } = await replied();
    const email = (db().prepare("SELECT email FROM targets WHERE id = ?").get(lee) as { email: string }).email;
    fileLaterReply(w.reply(lee, "Please remove me from your list."));
    expect(db().prepare("SELECT reason FROM suppressions WHERE workspace_id = ? AND value = ?").get(w.ws, email)).toEqual({ reason: "unsubscribe" });
    expect(db().prepare("SELECT unsubscribed_at IS NOT NULL AS out FROM targets WHERE id = ?").get(lee)).toEqual({ out: 1 });
    expect(conv(lee)).toMatchObject({ verdict: "unsubscribe", temperature: "cold" });
  });

  it("does not undo an opt-out an earlier reply made", async () => {
    const { w, lee } = await replied("Please remove me from your list.");
    const email = (db().prepare("SELECT email FROM targets WHERE id = ?").get(lee) as { email: string }).email;
    fileLaterReply(w.reply(lee, "Thanks."));
    expect(db().prepare("SELECT COUNT(*) AS c FROM suppressions WHERE workspace_id = ? AND value = ?").get(w.ws, email)).toEqual({ c: 1 });
  });

  it("is not what follows an out-of-office reply: that one only held the campaign", async () => {
    const { w, lee } = await replied("I am out of the office until Monday.");
    expect(track(lee).state).toBe("in_progress");
    const real = w.reply(lee, "Back now. Sounds interesting, let's talk.");
    expect(isLaterMessage(db(), lee, real)).toBe(false);
    receiveReply(db(), real);
    await classifyAndDispatch(real);
    expect(track(lee).state).toBe("skipped");
    expect(todos(lee)).toBe(1);
  });

  it("is read again, and still not acted on, when a person asks for it to be reclassified", async () => {
    const { w, lee } = await replied();
    const later = w.reply(lee, "ok");
    fileLaterReply(later);
    db().prepare("UPDATE run_profile_tracks SET state = 'in_progress' WHERE id = ?").run(`rt-${lee}`);
    await classifyAndDispatch(later, "negative");
    expect(track(lee).state).toBe("in_progress");
    expect(todos(lee)).toBe(1);
    expect(conv(lee)).toMatchObject({ verdict: "negative", temperature: "cold" });
  });
});

// ── A verdict ───────────────────────────────────────────────────────────────────────────
describe("the verdict on a reply", () => {
  it("sets how warm the conversation is and when an answer is due", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const first = w.reply(lee, "Sounds interesting, tell me more.");
    receiveReply(db(), first);
    expect(conv(lee)).toMatchObject({ temperature: null, sla_due_at: null, verdict: null });
    await classifyAndDispatch(first);
    const c = conv(lee);
    expect(c).toMatchObject({ temperature: "hot", verdict: "positive", status: "open" });
    expect(Date.parse(c.sla_due_at!) - Date.now()).toBeGreaterThan(3.9 * HOUR);
  });

  it("does not overrule a temperature a person set by hand, until they hand it back", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const first = w.reply(lee, "Not interested, thanks.");
    receiveReply(db(), first);
    await patch(w, conv(lee).id, { temperature: "warm" });
    await classifyAndDispatch(first);
    expect(conv(lee)).toMatchObject({ verdict: "negative", temperature: "warm" });

    await patch(w, conv(lee).id, { temperature: null });
    expect(conv(lee).temperature).toBeNull();
    await classifyAndDispatch(first, "positive");
    expect(conv(lee)).toMatchObject({ verdict: "positive", temperature: "hot" });
  });
});

// ── Read state ──────────────────────────────────────────────────────────────────────────
describe("whether a conversation has been read", () => {
  it("is kept per member, and a new message makes it unread again", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    receiveReply(db(), w.reply(lee, "Hello", { received_at: ago(HOUR) }));
    const id = conv(lee).id;
    const unreadFor = async (headers: Record<string, string>) => (await list(w, {}, headers)).conversations[0].unread;

    expect([await unreadFor(w.asAda), await unreadFor(w.asBen)]).toEqual([true, true]);
    await patch(w, id, { read: true });
    expect([await unreadFor(w.asAda), await unreadFor(w.asBen)]).toEqual([false, true]);
    expect((await list(w, { view: "unread" })).total).toBe(0);
    expect((await list(w, { view: "unread" }, w.asBen)).total).toBe(1);

    receiveReply(db(), w.reply(lee, "Hello again"));
    expect(await unreadFor(w.asAda)).toBe(true);
    await patch(w, id, { read: true });
    await patch(w, id, { read: false });
    expect(await unreadFor(w.asAda)).toBe(true);
  });

  it("is what the sidebar counts, and 'mark all read' clears it for that member only", async () => {
    const w = workspace();
    for (const name of ["Lee Lead", "Mo Mail", "Cy Closed"]) receiveReply(db(), w.reply(w.contact(name), "Hi"));
    const cy = (db().prepare("SELECT id FROM targets WHERE workspace_id = ? AND full_name = 'Cy Closed'").get(w.ws) as { id: string }).id;
    setStatus(db(), conv(cy), "closed");
    const badge = async (headers: Record<string, string>) => ((await call(shell, { method: "GET", headers })).body.counts as { inbox: number }).inbox;

    // A closed conversation is dealt with; it is not something unread.
    expect(await badge(w.asAda)).toBe(2);
    expect((await list(w)).facets).toMatchObject({ total: 3, unread: 2 });
    expect((await call(markAllReadRoute, { method: "POST", headers: w.asAda })).body).toEqual({ ok: true, marked: 2 });
    expect(await badge(w.asAda)).toBe(0);
    expect(await badge(w.asBen)).toBe(2);
    // A viewer reads the inbox; they have no read state to change.
    expect((await call(markAllReadRoute, { method: "POST", headers: w.asViewer })).statusCode).toBe(403);
  });
});

// ── Snooze ──────────────────────────────────────────────────────────────────────────────
describe("a snoozed conversation", () => {
  it("opens again by itself when its time comes, unread, and says so to whoever snoozed it", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    receiveReply(db(), w.reply(lee, "Call me next month."));
    const id = conv(lee).id;
    await patch(w, id, { read: true });
    const until = new Date(Date.now() + 2 * HOUR).toISOString();
    expect((await patch(w, id, { status: "snoozed", snoozed_until: until })).statusCode).toBe(200);
    expect((await list(w, { status: "snoozed" })).conversations.map((c) => [c.id, c.snoozed_until, c.unread])).toEqual([[id, until, false]]);

    expect(wakeSnoozed(db(), w.ws)).toBe(0);
    expect(wakeSnoozed(db(), w.ws, new Date(Date.now() + 3 * HOUR).toISOString())).toBe(1);
    expect(conv(lee)).toMatchObject({ status: "open", snoozed_until: null });
    expect((await list(w)).conversations[0].unread).toBe(true);
    expect(notices(w.ws, "conversation.reopened")).toEqual([{ user_id: w.ada, title: "Lee Lead is back in the inbox" }]);
  });

  it("is opened by the inbox itself once the time has passed", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    receiveReply(db(), w.reply(lee, "Later."));
    db().prepare("UPDATE conversations SET status = 'snoozed', snoozed_until = ? WHERE id = ?").run(ago(HOUR), conv(lee).id);
    expect((await list(w)).conversations[0].status).toBe("open");
  });

  it("refuses a time that is not one, or is already past", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    receiveReply(db(), w.reply(lee, "Later."));
    const id = conv(lee).id;
    expect((await patch(w, id, { status: "snoozed", snoozed_until: "sometime" })).statusCode).toBe(400);
    expect((await patch(w, id, { status: "snoozed", snoozed_until: ago(HOUR) })).statusCode).toBe(400);
    expect(conv(lee).status).toBe("open");
    // With no time it waits for the contact.
    expect((await patch(w, id, { status: "snoozed" })).statusCode).toBe(200);
    expect(conv(lee)).toMatchObject({ status: "snoozed", snoozed_until: null });
  });
});

// ── The list ────────────────────────────────────────────────────────────────────────────
describe("GET /api/conversations", () => {
  function inbox() {
    const w = workspace();
    const make = (name: string, body: string, minutesAgo: number, state: Partial<ConversationRow> = {}) => {
      const target = w.contact(name);
      receiveReply(db(), w.reply(target, body, { received_at: ago(minutesAgo * 60_000) }));
      const keys = Object.keys(state);
      if (keys.length) db().prepare(`UPDATE conversations SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE target_id = ?`).run(...keys.map((key) => (state as Record<string, unknown>)[key]), target);
      return target;
    };
    const lee = make("Lee Lead", "Yes, let's talk", 5, { verdict: "positive", temperature: "hot", assigned_to: w.ada, sla_due_at: ago(HOUR) });
    const mo = make("Mo Mail", "Who handles this?", 10, { verdict: "human_review", temperature: "warm", assigned_to: w.ben, sla_due_at: new Date(Date.now() + 60_000).toISOString() });
    const ned = make("Ned Negative", "Not for us", 20, { verdict: "negative", temperature: "cold", status: "closed" });
    const una = make("Una Unread", "Hmm", 30);
    return { w, lee, mo, ned, una };
  }

  it("lists a page of conversations, newest first, with the contact and the state of each", async () => {
    const { w, lee, mo, ned, una } = inbox();
    const page = await list(w);
    expect(page).toMatchObject({ total: 4, page: 1, per: 25 });
    expect(page.conversations.map((c) => c.target_id)).toEqual([lee, mo, ned, una]);
    expect(page.conversations[0]).toMatchObject({
      name: "Lee Lead", title: "Head of Ops", company: "Initech", detached: false, status: "open", temperature: "hot", verdict: "positive", overdue: true, unread: true,
      assignee: { id: w.ada }, last_message_preview: "Yes, let's talk", last_message_channel: "email", last_message_direction: "in", tags: [],
    });
    expect((await list(w, { per: "2", page: "2" })).conversations.map((c) => c.target_id)).toEqual([ned, una]);
    expect((await list(w, { sort: "oldest" })).conversations[0].target_id).toBe(una);
    expect((await list(w, { sort: "due" })).conversations.map((c) => c.target_id).slice(0, 2)).toEqual([lee, mo]);
  });

  it("filters by verdict, status, temperature, who has it, what is due, tag and search", async () => {
    const { w, lee, mo, ned, una } = inbox();
    const ids = async (query: Record<string, string>) => (await list(w, query)).conversations.map((c) => c.target_id);
    expect(await ids({ verdict: "positive,negative" })).toEqual([lee, ned]);
    // No verdict yet is something a person has to read.
    expect(await ids({ verdict: "human_review" })).toEqual([mo, una]);
    expect(await ids({ status: "closed" })).toEqual([ned]);
    expect(await ids({ status: "resolved" })).toEqual([ned]);            // the old word
    expect(await ids({ temperature: "hot,warm" })).toEqual([lee, mo]);
    expect(await ids({ sentiment: "positive" })).toEqual([lee]);         // the old word
    expect(await ids({ assignee: "none" })).toEqual([ned, una]);
    expect(await ids({ assignee: `${w.ben},none` })).toEqual([mo, ned, una]);
    expect(await ids({ assignee: "me" })).toEqual([lee]);
    expect(await ids({ view: "mine" })).toEqual([lee]);
    expect(await ids({ sla: "overdue" })).toEqual([lee]);
    expect(await ids({ sla: "today" })).toEqual([mo]);
    expect(await ids({ q: "mo mail" })).toEqual([mo]);
    expect(await ids({ q: "not for" })).toEqual([ned]);
    expect(await ids({ campaign: w.workflow, verdict: "negative" })).toEqual([ned]);
    const urgent = tag(w, "Urgent");
    await patch(w, conv(una).id, { add_tags: [urgent] });
    expect(await ids({ tag: urgent })).toEqual([una]);
    expect((await list(w, { tag: urgent })).conversations[0].tags).toEqual([{ id: urgent, name: "Urgent", color: "#64748b" }]);
  });

  it("counts what is beside each filter with the other filters applied and its own left out", async () => {
    const { w } = inbox();
    const all = (await list(w)).facets;
    expect(all).toMatchObject({ total: 4, unread: 3, mine: 1, overdue: 1, due_today: 1 });
    expect(all.verdict).toEqual({ positive: 1, human_review: 2, out_of_office: 0, negative: 1, unsubscribe: 0 });
    expect(all.status).toEqual({ open: 3, snoozed: 0, closed: 1 });
    expect(all.temperature).toEqual({ hot: 1, warm: 1, cold: 1 });
    expect(all.assignee).toEqual({ [w.ada]: 1, [w.ben]: 1, none: 2 });
    // Choosing a verdict narrows the other groups and leaves the verdict counts as they were.
    const picked = (await list(w, { verdict: "positive" })).facets;
    expect(picked.verdict).toEqual(all.verdict);
    expect(picked.status).toEqual({ open: 1, snoozed: 0, closed: 0 });
    expect(picked.total).toBe(1);
  });

  it("is this workspace's only, and a viewer may read it and change nothing", async () => {
    const { w, lee } = inbox();
    const other = workspace();
    expect((await list(other)).total).toBe(0);
    expect((await call(conversationRoute, { method: "GET", query: { id: conv(lee).id }, headers: other.asAda })).statusCode).toBe(404);
    expect((await patch(other, conv(lee).id, { status: "closed" })).statusCode).toBe(404);

    expect((await list(w, {}, w.asViewer)).total).toBe(4);
    expect((await open(w, conv(lee).id, w.asViewer)).conversation.name).toBe("Lee Lead");
    expect((await patch(w, conv(lee).id, { status: "closed" }, w.asViewer)).statusCode).toBe(403);
    expect((await send(w, conv(lee).id, { channel: "email", body: "Hi" }, w.asViewer)).statusCode).toBe(403);
    expect(conv(lee).status).toBe("open");
  });
});

// ── Changing one ────────────────────────────────────────────────────────────────────────
describe("PATCH /api/conversations/:id", () => {
  function one() {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    receiveReply(db(), w.reply(lee, "Hello"));
    return { w, lee, id: conv(lee).id };
  }

  it("changes nothing when any one value is wrong", async () => {
    const { w, lee, id } = one();
    for (const body of [{ status: "archived" }, { temperature: "tepid" }, { assigned_to: "nobody-here" }, { sla_due_at: "soon" }, { add_tags: ["no-such-tag"] }]) {
      expect((await patch(w, id, { assigned_to: w.ben, ...body })).statusCode).toBe(400);
    }
    expect(conv(lee).assigned_to).toBeNull();
  });

  it("takes the old words for a status and a temperature", async () => {
    const { w, lee, id } = one();
    await patch(w, id, { status: "resolved", temperature: "positive" });
    expect(conv(lee)).toMatchObject({ status: "closed", temperature: "hot" });
    await patch(w, id, { status: "pending" });
    expect(conv(lee).status).toBe("snoozed");
  });

  it("tells a member a conversation is theirs when a teammate assigns it", async () => {
    const { w, lee, id } = one();
    await patch(w, id, { assigned_to: w.ada });                      // taking it yourself says nothing
    expect(notices(w.ws, "conversation.assigned")).toEqual([]);
    await patch(w, id, { assigned_to: w.ben });
    expect(notices(w.ws, "conversation.assigned")).toEqual([{ user_id: w.ben, title: "Lee Lead's conversation was assigned to you" }]);
    expect(conv(lee).assigned_to).toBe(w.ben);
  });

  it("holds a lock for the member answering, which a teammate cannot take and an admin can lift", async () => {
    const { w, lee, id } = one();
    expect((await patch(w, id, { lock: true })).statusCode).toBe(200);
    expect((await open(w, id, w.asBen)).conversation.lock).toMatchObject({ user_id: w.ada });
    expect((await patch(w, id, { lock: true }, w.asBen)).statusCode).toBe(409);
    expect((await send(w, id, { channel: "email", body: "Hi" }, w.asBen)).statusCode).toBe(409);
    // A lock nobody has renewed for a quarter of an hour no longer holds.
    db().prepare("UPDATE conversations SET locked_at = ? WHERE id = ?").run(ago(16 * 60_000), id);
    expect((await open(w, id, w.asBen)).conversation.lock).toBeNull();
    expect((await patch(w, id, { lock: true }, w.asBen)).statusCode).toBe(200);
    await patch(w, id, { lock: false }, w.asBen);
    expect(conv(lee).locked_by).toBeNull();
  });
});

// ── The thread ──────────────────────────────────────────────────────────────────────────
describe("a conversation's messages", () => {
  it("are read from what is stored, both ways and on both channels, with the campaign step that sent each", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const first = w.sentEmail(lee, "Quick question", "Hi Lee, worth a chat?", ago(72 * HOUR));
    w.sentEmail(lee, "Re: Quick question", "Following up.", ago(48 * HOUR), { step_id: `${w.workflow}-e3` });
    db().prepare("INSERT INTO sender_events (id, workspace_id, email_account_id, sent_message_id, provider, provider_event_id, event_type, occurred_at, is_bot) VALUES (?, ?, ?, ?, 'pixel', ?, 'opened', ?, 0), (?, ?, ?, ?, 'pixel', ?, 'opened', ?, 1)")
      .run(`ev-${seq}-a`, w.ws, w.mailbox, `sm-${first}`, `e-${seq}-a`, ago(70 * HOUR), `ev-${seq}-b`, w.ws, w.mailbox, `sm-${first}`, `e-${seq}-b`, ago(71 * HOUR));
    storeCampaignMessage(db(), { workspaceId: w.ws, accountId: w.account, targetId: lee, text: "Hi Lee, thanks for connecting.", runId: w.run, stepId: `${w.workflow}-l1` });
    db().prepare("UPDATE linkedin_messages SET sent_at = ? WHERE target_id = ?").run(ago(40 * HOUR), lee);
    const reply = w.reply(lee, "Sounds interesting, tell me more.", { received_at: ago(24 * HOUR), in_reply_to_job_id: first });
    receiveReply(db(), reply);
    await classifyAndDispatch(reply);
    // An answer through the route the old inbox used goes out without naming the contact; it is found by its address.
    smtp.sent.length = 0;
    const to = (db().prepare("SELECT email FROM targets WHERE id = ?").get(lee) as { email: string }).email;
    expect((await call(inboxReply, { method: "POST", body: { emailAccountId: w.mailbox, to, subject: "Re: Quick question", body: "Happy to. Tuesday?", replyId: reply }, headers: w.asAda })).statusCode).toBe(200);
    expect(db().prepare("SELECT target_id FROM email_jobs WHERE source = 'team_inbox' AND recipient = ?").get(to)).toEqual({ target_id: null });

    const detail = await open(w, conv(lee).id);
    expect(detail.messages.map((m) => [m.direction, m.channel, m.body])).toEqual([
      ["out", "email", "Hi Lee, worth a chat?"],
      ["out", "email", "Following up."],
      ["out", "linkedin", "Hi Lee, thanks for connecting."],
      ["in", "email", "Sounds interesting, tell me more."],
      ["out", "email", "Happy to. Tuesday?"],
    ]);
    // Waits are not steps a contact sees: the third email step is "2 of 3".
    expect(detail.messages[0]).toMatchObject({ author: { kind: "mailbox", name: "Ada Lovelace", via: `ada${w.n}@acme.test` }, campaign: { name: "Founders outreach", step: 1, steps: 3 }, opens: 1, status: "delivered" });
    expect(detail.messages[1].campaign).toMatchObject({ step: 2, steps: 3 });
    expect(detail.messages[2]).toMatchObject({ author: { kind: "linkedin_account", name: "Ada on LinkedIn" }, campaign: { name: "Founders outreach", step: 1, steps: 1 }, sent_here: false, kind: "message" });
    expect(detail.messages[3]).toMatchObject({ author: { kind: "contact", name: "Lee Lead" }, reply: { id: reply, verdict: "positive", later: false } });
    expect(detail.messages[4]).toMatchObject({ campaign: null, sent_here: true });
    expect(detail.verdict_reply).toMatchObject({ id: reply, verdict: "positive", summary: "Prospect expressed interest" });
    // Answering it gave the conversation its latest message and cleared the answer that was due.
    expect(detail.conversation).toMatchObject({ last_message_direction: "out", last_message_preview: "Happy to. Tuesday?", sla_due_at: null, campaigns: [{ id: w.workflow, name: "Founders outreach" }] });
  });

  it("show a message from LinkedIn once, though it is stored as a message and as a reply", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: "ACoAALeeConv", message_sent_at: ago(72 * HOUR) });
    const SELF = "urn:li:fsd_profile:ACoAASelf";
    const thread: InboxConversation = {
      urn: `urn:li:msg_conversation:(${SELF},2-lee-${w.n})`, lastActivityAt: Date.now() - HOUR, selfUrn: SELF, counterpart: { profileId: "ACoAALeeConv", memberUrn: null, name: "Lee Lead" },
      messages: [
        { urn: `urn:li:msg_message:(${SELF},a-${w.n})`, sentAt: Date.now() - 50 * HOUR, text: "Hi Lee, thanks for connecting.", fromSelf: true },
        { urn: `urn:li:msg_message:(${SELF},b-${w.n})`, sentAt: Date.now() - HOUR, text: "Thanks. What does it cost?", fromSelf: false },
      ],
    };
    db().prepare("UPDATE accounts SET inbox_synced_through_ms = ? WHERE id = ?").run(Date.now() - 10 * HOUR, w.account);
    const pull = applyInboxPull(db(), w.account, [thread]);
    expect(pull.replies).toHaveLength(1);

    const c = conv(lee);
    expect(c).toMatchObject({ status: "open", last_message_channel: "linkedin", last_message_direction: "in", last_message_preview: "Thanks. What does it cost?" });
    const messages = readThread(db(), c);
    expect(messages.map((m) => [m.direction, m.source, m.body])).toEqual([["out", "linkedin", "Hi Lee, thanks for connecting."], ["in", "linkedin", "Thanks. What does it cost?"]]);
    expect(messages[1].reply).toMatchObject({ id: pull.replies[0].replyId });
  });

  it("show a contact marked as replied by hand, with no message to show", async () => {
    const w = workspace();
    const lin = w.contact("Lin Linked");
    expect((await call(markReplied, { method: "POST", query: { id: lin }, body: { channel: "linkedin" }, headers: w.asAda })).statusCode).toBe(200);
    const c = conv(lin);
    expect(c).toMatchObject({ status: "open", last_message_channel: "linkedin", last_message_direction: "in", last_message_preview: null });
    expect((await open(w, c.id)).messages).toMatchObject([{ source: "marker", channel: "linkedin", direction: "in", body: "" }]);
    expect((await list(w)).conversations.map((item) => item.name)).toEqual(["Lin Linked"]);
  });
});

// ── A campaign's LinkedIn messages ──────────────────────────────────────────────────────
describe("a LinkedIn message a campaign sends", () => {
  const SELF = "urn:li:fsd_profile:ACoAASelf";
  const transcript = (target: string) => db().prepare("SELECT direction, body, kind, subject, run_id, step_id, message_urn, created_by FROM linkedin_messages WHERE target_id = ? ORDER BY datetime(sent_at), rowid").all(target) as Array<Record<string, string | null>>;

  it("is stored when it goes, with the campaign and step, and counts as nobody's typed reply", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    storeCampaignMessage(db(), { workspaceId: w.ws, accountId: w.account, targetId: lee, text: "  Hi Lee,\r\nthanks for connecting.  ", runId: w.run, stepId: `${w.workflow}-l1` });
    storeCampaignMessage(db(), { workspaceId: w.ws, accountId: w.account, targetId: lee, text: "Worth a look?", subject: "An idea for Initech", kind: "inmail", runId: w.run });
    storeCampaignMessage(db(), { workspaceId: w.ws, accountId: w.account, targetId: lee, text: "   ", runId: w.run });       // nothing to keep
    expect(transcript(lee)).toEqual([
      { direction: "out", body: "Hi Lee,\nthanks for connecting.", kind: "message", subject: null, run_id: w.run, step_id: `${w.workflow}-l1`, message_urn: null, created_by: null },
      { direction: "out", body: "Worth a look?", kind: "inmail", subject: "An idea for Initech", run_id: w.run, step_id: null, message_urn: null, created_by: null },
    ]);
    // Somebody with no conversation yet does not get one from being written to.
    expect(conversationOfTarget(db(), lee)).toBeUndefined();
  });

  it("is recognised when the inbox read meets it, instead of being stored a second time", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: `ACoAALee${w.n}` });
    storeCampaignMessage(db(), { workspaceId: w.ws, accountId: w.account, targetId: lee, text: "Hi Lee,\n\nthanks for connecting.", runId: w.run, stepId: `${w.workflow}-l1` });
    storeCampaignMessage(db(), { workspaceId: w.ws, accountId: w.account, targetId: lee, text: "One more thought.", runId: w.run });
    const sentAt = Date.now() - 2 * HOUR;
    applyInboxPull(db(), w.account, [{
      urn: `urn:li:msg_conversation:(${SELF},2-${w.n})`, lastActivityAt: sentAt + 1000, selfUrn: SELF, counterpart: { profileId: `ACoAALee${w.n}`, memberUrn: null, name: "Lee Lead" },
      messages: [
        // LinkedIn has tidied the blank line away; it is still the same message.
        { urn: `urn:li:msg_message:(${SELF},a-${w.n})`, sentAt, text: "Hi Lee,\nthanks for connecting.", fromSelf: true },
        { urn: `urn:li:msg_message:(${SELF},b-${w.n})`, sentAt: sentAt + 1000, text: "One more thought.", fromSelf: true },
      ],
    }]);
    const rows = transcript(lee);
    expect(rows.map((row) => [row.body, row.message_urn !== null, row.run_id])).toEqual([["Hi Lee,\n\nthanks for connecting.", true, w.run], ["One more thought.", true, w.run]]);
  });
});

// ── Drafts and files ────────────────────────────────────────────────────────────────────
describe("a draft", () => {
  function one() {
    const w = workspace();
    const lee = w.contact("Lee Lead", { first_name: "Lee" });
    const first = w.sentEmail(lee, "Quick question", "Hi Lee, worth a chat?", ago(72 * HOUR));
    const reply = w.reply(lee, "Sounds interesting, tell me more.", { received_at: ago(2 * HOUR), in_reply_to_job_id: first });
    receiveReply(db(), reply);
    return { w, lee, first, reply, id: conv(lee).id };
  }
  const draft = (w: W, id: string, body: Record<string, unknown>, headers = w.asAda) => call(draftRoute, { method: "PUT", query: { id }, body, headers });
  const attach = (w: W, id: string, filename: string, content: Buffer, headers = w.asAda) =>
    call(attachRoute, { method: "POST", query: { id, filename }, body: content as never, headers: { ...headers, "content-type": "application/pdf" } });

  it("is kept per member as they type, and is theirs alone", async () => {
    const { w, id } = one();
    expect((await draft(w, id, { channel: "email", body: "Hi Lee, happy to" })).statusCode).toBe(200);
    await draft(w, id, { channel: "email", body: "Hi Lee, happy to. Tuesday?", subject: "Re: Quick question", email_account_id: w.mailbox });
    expect((await open(w, id)).draft).toMatchObject({ channel: "email", body: "Hi Lee, happy to. Tuesday?", subject: "Re: Quick question", email_account_id: w.mailbox, attachments: [] });
    expect((await open(w, id, w.asBen)).draft).toBeNull();
    // Emptied, it is gone; and it can be thrown away outright.
    await draft(w, id, { channel: "email", body: "  " });
    expect((await open(w, id)).draft).toBeNull();
    await draft(w, id, { channel: "linkedin", body: "x" });
    expect((await call(draftRoute, { method: "DELETE", query: { id }, headers: w.asAda })).statusCode).toBe(204);
    expect((await open(w, id)).draft).toBeNull();
    expect((await draft(w, id, { channel: "email", body: "x" }, w.asViewer)).statusCode).toBe(403);
  });

  it("carries files, which only its workspace can download and only its author can remove", async () => {
    const { w, id } = one();
    const other = workspace();
    const added = await attach(w, id, "../../etc/Pricing 2026.pdf", Buffer.from("%PDF-1.7 pricing"));
    expect(added.statusCode).toBe(201);
    const file = added.body.attachment as { id: string; filename: string; size_bytes: number; kept: boolean };
    expect(file).toMatchObject({ filename: "Pricing 2026.pdf", size_bytes: 16, kept: true });
    expect((await open(w, id)).draft?.attachments).toEqual([expect.objectContaining({ id: file.id })]);

    const download = await call(attachmentRoute, { method: "GET", query: { attachmentId: file.id }, headers: w.asViewer });
    expect(download.statusCode).toBe(200);
    expect(String(download.body)).toBe("%PDF-1.7 pricing");
    // Handed over as a download, never as something the page would show or run.
    expect(download.headers).toMatchObject({ "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    expect(download.headers["Content-Disposition"]).toMatch(/^attachment; filename\*=UTF-8''Pricing%202026\.pdf$/);
    expect((await call(attachmentRoute, { method: "GET", query: { attachmentId: file.id }, headers: other.asAda })).statusCode).toBe(404);

    expect((await call(attachmentRoute, { method: "DELETE", query: { attachmentId: file.id }, headers: w.asBen })).statusCode).toBe(404);
    expect((await call(attachmentRoute, { method: "DELETE", query: { attachmentId: file.id }, headers: w.asAda })).statusCode).toBe(204);
    expect((await open(w, id)).draft).toBeNull();
  });

  it("refuses an empty file and one that is too large", async () => {
    const { w, id } = one();
    expect((await attach(w, id, "empty.txt", Buffer.alloc(0))).statusCode).toBe(400);
    expect((await attach(w, id, "huge.bin", Buffer.alloc(10 * 1024 * 1024 + 1))).statusCode).toBe(400);
    expect(db().prepare("SELECT COUNT(*) AS c FROM conversation_attachments WHERE conversation_id = ?").get(id)).toEqual({ c: 0 });
  });

  it("is sent as an email in the thread of the reply it answers, with its files, and then it is gone", async () => {
    const { w, lee, first, reply, id } = one();
    await patch(w, id, { sla_due_at: new Date(Date.now() + HOUR).toISOString(), lock: true });
    await draft(w, id, { channel: "email", body: "Hi {{first_name}}, here is the deck. Use {this|that} as you like." });
    await attach(w, id, "deck.pdf", Buffer.from("deck"));

    const sent = await send(w, id, { channel: "email", body: "Hi {{first_name}}, here is the deck. Use {this|that} as you like." });
    expect(sent.statusCode).toBe(200);
    expect(sent.body.sent).toMatchObject({ channel: "email", status: "sent" });
    // Merge tags are filled; braces a person typed are theirs and stay as typed.
    expect(smtp.sent).toMatchObject([{ subject: "Re: Quick question", body: "Hi Lee, here is the deck. Use {this|that} as you like.", inReplyTo: `<${reply}@mail.test>`, references: `<${first}@acme.test> <${reply}@mail.test>` }]);
    expect(smtp.sent[0].attachments?.map((file) => [file.filename, file.content.toString()])).toEqual([["deck.pdf", "deck"]]);

    const detail = sent.body as unknown as ConversationDetail;
    expect(detail.draft).toBeNull();
    const last = detail.messages[detail.messages.length - 1];
    expect(last).toMatchObject({ direction: "out", channel: "email", sent_here: true, status: "delivered", attachments: [expect.objectContaining({ filename: "deck.pdf" })] });
    // The answer that was due has been given, the lock is let go, and the member has read it.
    expect(conv(lee)).toMatchObject({ status: "open", sla_due_at: null, locked_by: null, last_message_direction: "out" });
    expect(detail.conversation.unread).toBe(false);
  });

  it("can close the conversation as it is sent", async () => {
    const { w, lee, id } = one();
    expect((await send(w, id, { channel: "email", body: "Thanks, speak soon.", close: true })).statusCode).toBe(200);
    expect(conv(lee)).toMatchObject({ status: "closed" });
    expect(conv(lee).closed_at).not.toBeNull();
  });

  it("stays, with its files, when the email does not go and will not be tried again", async () => {
    const { w, id } = one();
    await draft(w, id, { channel: "email", body: "Here you go." });
    await attach(w, id, "deck.pdf", Buffer.from("deck"));
    // A mailbox that signs in with Google cannot send files yet: refused outright, not retried.
    db().prepare("UPDATE email_accounts SET provider = 'gmail' WHERE id = ?").run(w.mailbox);
    const failed = await send(w, id, { channel: "email", body: "Here you go." });
    expect(failed.statusCode).toBe(502);
    expect(String(failed.body.error)).toMatch(/cannot send files yet/);
    const detail = await open(w, id);
    expect(detail.draft).toMatchObject({ body: "Here you go.", attachments: [expect.objectContaining({ filename: "deck.pdf" })] });
    // What was tried shows in the thread, with why it did not go.
    expect(detail.messages[detail.messages.length - 1]).toMatchObject({ direction: "out", status: "failed", body: "Here you go." });
    expect(detail.conversation.last_message_direction).toBe("in");
  });

  it("is on its way, and not to be written again, when the mail queue will try again by itself", async () => {
    const { w, lee, id } = one();
    await draft(w, id, { channel: "email", body: "Here you go." });
    smtp.fail = new Error("421 Service not available, try again later");
    const queued = await send(w, id, { channel: "email", body: "Here you go." });
    expect(queued.statusCode).toBe(202);
    expect(queued.body.sent).toMatchObject({ channel: "email", status: "queued" });
    const detail = queued.body as unknown as ConversationDetail;
    expect(detail.draft).toBeNull();
    expect(detail.messages[detail.messages.length - 1]).toMatchObject({ direction: "out", status: "queued", body: "Here you go." });
    expect(db().prepare("SELECT status FROM email_jobs WHERE target_id = ? AND source = 'team_inbox'").get(lee)).toEqual({ status: "pending" });
  });

  it("is not sent to someone on the do-not-contact list, or without anything written", async () => {
    const { w, lee, id } = one();
    expect((await send(w, id, { channel: "email", body: "   " })).statusCode).toBe(400);
    expect((await send(w, id, { channel: "sms", body: "Hi" })).statusCode).toBe(400);
    const email = (db().prepare("SELECT email FROM targets WHERE id = ?").get(lee) as { email: string }).email;
    addSuppression({ workspaceId: w.ws, kind: "email", value: email, reason: "unsubscribe", source: "manual" });
    expect((await send(w, id, { channel: "email", body: "Hi" })).statusCode).toBe(409);
    expect((await open(w, id)).answer.email).toMatchObject({ can: false, why_not: "This contact is on the do-not-contact list" });
    expect(smtp.sent).toHaveLength(0);
  });

  it("goes to the LinkedIn outbox when that is the channel, and files cannot go that way", async () => {
    const { w, lee, id } = one();
    expect((await open(w, id)).answer.linkedin).toMatchObject({ can: true, default_account_id: w.account });
    await attach(w, id, "deck.pdf", Buffer.from("deck"));
    expect((await send(w, id, { channel: "linkedin", body: "Hi Lee" })).statusCode).toBe(400);
    await call(draftRoute, { method: "DELETE", query: { id }, headers: w.asAda });

    const queued = await send(w, id, { channel: "linkedin", body: "Hi {{first_name}}, shall we talk?" });
    expect(queued.statusCode).toBe(202);
    expect(queued.body.sent).toMatchObject({ channel: "linkedin", status: "queued", account_id: w.account });
    expect(db().prepare("SELECT body, status, created_by FROM linkedin_messages WHERE target_id = ?").get(lee)).toEqual({ body: "Hi Lee, shall we talk?", status: "queued", created_by: w.ada });
    // It is not the latest message until it has been delivered, and it shows as waiting.
    const detail = queued.body as unknown as ConversationDetail;
    expect(detail.messages[detail.messages.length - 1]).toMatchObject({ status: "queued", sent_here: true, channel: "linkedin" });
    expect(conv(lee).last_message_direction).toBe("in");
  });
});

describe("files that come with a reply", () => {
  it("are kept with it, and one too large to keep is recorded by name", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const reply = w.reply(lee, "Our requirements are attached.");
    receiveReply(db(), reply);
    expect(storeReplyAttachments(db(), { id: reply, workspaceId: w.ws }, [
      { filename: "requirements.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: Buffer.from("docx") },
      { filename: "video.mov", contentType: "video/quicktime", content: Buffer.alloc(10 * 1024 * 1024 + 1) },
    ])).toBe(1);
    const message = (await open(w, conv(lee).id)).messages[0];
    expect(message.attachments.map((file) => [file.filename, file.kept])).toEqual([["requirements.docx", true], ["video.mov", false]]);
    expect((await call(attachmentRoute, { method: "GET", query: { attachmentId: message.attachments[1].id }, headers: w.asAda })).statusCode).toBe(404);
  });
});

// ── The routes that were there before ───────────────────────────────────────────────────
describe("the inbox routes that existed before conversations", () => {
  it("act on the conversation when given one of its replies, so a newer reply no longer undoes it", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const first = w.reply(lee, "Sounds interesting, tell me more.", { received_at: ago(5 * HOUR) });
    const urgent = tag(w, "Urgent");
    await act(w, { action: "assign", reply_id: first, assigned_to: w.ben });
    await act(w, { action: "tag", reply_id: first, tag_id: urgent });
    await act(w, { action: "set_sentiment", reply_id: first, sentiment: "positive" });
    expect((await act(w, { action: "status", reply_id: first, status: "pending" })).body).toMatchObject({ ok: true, updated: 1 });

    const second = w.reply(lee, "Any update?");
    receiveReply(db(), second);
    const row = (await legacyList(w)).find((item) => item.id === lee)!;
    expect(row).toMatchObject({ reply_id: second, assigned_to: w.ben, sentiment: "hot", inbox_status: "open", tags: [{ id: urgent, name: "Urgent", color: "#64748b" }], detached: false, unread: true });
    // And either reply names the same conversation.
    await act(w, { action: "status", reply_id: first, status: "resolved" });
    expect((await legacyList(w, { status: "closed" })).map((item) => item.reply_id)).toEqual([second]);
    expect((await legacyList(w, { status: "resolved" })).map((item) => item.id)).toEqual([lee]);
  });

  it("keep a conversation's state when its contact is deleted and made again", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const email = (db().prepare("SELECT email FROM targets WHERE id = ?").get(lee) as { email: string }).email;
    const first = w.reply(lee, "Sounds interesting.");
    receiveReply(db(), first);
    const urgent = tag(w, "Urgent");
    await patch(w, conv(lee).id, { assigned_to: w.ben, add_tags: [urgent] });

    db().prepare("DELETE FROM run_profile_tracks WHERE run_profile_id = ?").run(`rp-${lee}`);
    db().prepare("DELETE FROM run_profiles WHERE target_id = ?").run(lee);
    db().prepare("DELETE FROM targets WHERE id = ?").run(lee);
    const detached = convOfReply(first);
    expect(detached).toMatchObject({ target_id: null, address: email, assigned_to: w.ben });
    expect((await list(w)).conversations[0]).toMatchObject({ detached: true, name: email, email });

    const again = w.contact("Lee Lead", { email });
    expect((await act(w, { action: "relink", reply_ids: [first] })).body).toMatchObject({ relinked: 1 });
    expect(conv(again)).toMatchObject({ id: detached.id, assigned_to: w.ben });
    expect(tagsOf(detached.id)).toEqual(["Urgent"]);
    expect(db().prepare("SELECT COUNT(*) AS c FROM conversations WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 1 });
  });

  it("read a contact's email thread from stored rows, without opening a mailbox", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const email = (db().prepare("SELECT email FROM targets WHERE id = ?").get(lee) as { email: string }).email;
    const job = w.sentEmail(lee, "Quick question", "Hi Lee, worth a chat?", ago(72 * HOUR));
    const reply = w.reply(lee, "Sounds interesting.", { received_at: ago(2 * HOUR), imap_uid: 41 });
    receiveReply(db(), reply);

    const thread = await call(emailThread, { method: "GET", query: { targetId: lee, emailAccountId: w.mailbox }, headers: w.asViewer });
    expect(thread.statusCode).toBe(200);
    expect(thread.body.messages).toEqual([
      expect.objectContaining({ uid: 0, from: `"Ada Lovelace" <ada${w.n}@acme.test>`, to: email, subject: "Quick question", text: "Hi Lee, worth a chat?", html: null, messageId: `<${job}@acme.test>` }),
      expect.objectContaining({ uid: 41, from: email, subject: "Re: Quick question", text: "Sounds interesting.", messageId: `<${reply}@mail.test>` }),
    ]);
    // The mailbox need not be named any more, and a reply with no contact is found by itself.
    expect((await call(emailThread, { method: "GET", query: { targetId: lee }, headers: w.asAda })).statusCode).toBe(200);
    const gone = w.reply(null, "Who is this?");
    expect(((await call(emailThread, { method: "GET", query: { replyId: gone }, headers: w.asAda })).body.messages as unknown[])).toHaveLength(1);
    expect((await call(emailThread, { method: "GET", query: {}, headers: w.asAda })).statusCode).toBe(400);
    expect((await call(emailThread, { method: "GET", query: { targetId: "nobody" }, headers: w.asAda })).statusCode).toBe(404);

    const contact = await call(contactEmails, { method: "GET", query: { id: lee }, headers: w.asViewer });
    expect(contact.body).toMatchObject({ email_account_id: w.mailbox, contact_email: email });
    expect((contact.body.messages as unknown[])).toHaveLength(2);
  });
});
