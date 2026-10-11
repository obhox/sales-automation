// What the inbox screen leans on beside the conversations themselves: the route that says
// what it can offer, "check replies now", and the screen's own wording and small decisions
// (its model, which has no React in it). Real routes, throwaway database; no mailbox and
// no LinkedIn session is opened, and no model is asked anything.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

vi.mock("@/lib/linkedin/runner", async (original) => ({ ...(await original<typeof import("@/lib/linkedin/runner")>()), ensureGlobalRunnerStarted: vi.fn() }));
vi.mock("imap", () => ({ default: class { constructor() { throw new Error("a mailbox was opened"); } } }));

import { getDb } from "@/lib/db";
import { receiveReply } from "@/lib/conversations/store";
import { REWRITE_ROUTE } from "@/lib/conversations/capabilities";
import conversationsList, { type ConversationsResponse } from "@/pages/api/conversations";
import metaRoute, { type InboxMeta } from "@/pages/api/conversations/meta";
import syncRoute, { type InboxSyncStatus } from "@/pages/api/conversations/sync";
import teamInbox from "@/pages/api/platform/inbox";
import bookingLink from "@/pages/api/platform/booking-link";
import {
  FILTER_DEFAULTS, appendReply, campaignLine, dispatchLine, dueLabel, fileSize, hasPending, insertAt, lockLabel, sameView, snoozeChoices, snoozeLabel, split, summaryOf, toggled, verdictOf,
  type ConversationDetail, type ThreadMessage, type ThreadReply,
} from "@/components/inbox/model";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
async function call(handler: Handler, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, headers: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

function workspace() {
  const n = ++seq;
  const ws = `ws-inboxscreen-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const ids = { ada: `is-ada-${n}`, ben: `is-ben-${n}`, vi: `is-viewer-${n}` };
  const w = { ws, n, ...ids, asAda: ctxHeaders(ws, { userId: ids.ada, role: "member" }), asBen: ctxHeaders(ws, { userId: ids.ben, role: "admin" }), asViewer: ctxHeaders(ws, { userId: ids.vi, role: "viewer" }) };
  db().prepare("UPDATE users SET name = 'Ada Lovelace' WHERE id = ?").run(ids.ada);
  const contact = (name: string) => {
    const id = `is-target-${++seq}`;
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES (?, ?, ?, ?)").run(id, ws, name, `${name.toLowerCase().replace(/\W+/g, ".")}.${seq}@prospect.test`);
    return id;
  };
  const reply = (target: string, body: string) => {
    const id = `is-reply-${++seq}`;
    db().prepare("INSERT INTO email_replies (id, workspace_id, target_id, from_email, body_text, received_at) VALUES (?, ?, ?, 'x@prospect.test', ?, ?)").run(id, ws, target, body, new Date().toISOString());
    receiveReply(db(), id);
    return id;
  };
  return { ...w, contact, reply };
}

beforeEach(() => { getDb(); });

// ── What the screen can offer ───────────────────────────────────────────────────────────
describe("GET /api/conversations/meta", () => {
  it("lists who can be assigned, the tags with how many conversations wear each, saved replies, merge tags and the booking link", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead");
    const first = w.reply(lee, "Hello");
    const act = (body: Record<string, unknown>) => call(teamInbox, { method: "POST", body, headers: w.asAda });
    const tagId = String((await act({ action: "create_tag", name: "Pricing", color: "#b4690e" })).body.id);
    await act({ action: "create_tag", name: "Unused" });
    await act({ action: "tag", reply_id: first, tag_id: tagId });
    const savedId = String((await act({ action: "create_saved_reply", name: "Two times", body: "Would Tuesday or Wednesday work?" })).body.id);
    db().prepare("INSERT INTO custom_field_definitions (id, workspace_id, key, name) VALUES (?, ?, 'renewal_month', 'Renewal month')").run(`cf-${w.n}`, w.ws);
    expect((await call(bookingLink, { method: "PUT", body: { url: "https://cal.com/acme/intro" }, headers: w.asBen })).statusCode).toBe(200);

    const meta = (await call(metaRoute, { method: "GET", headers: w.asAda })).body as unknown as InboxMeta;
    expect(meta.me).toBe(w.ada);
    expect(meta.members.map((member) => [member.id, member.name, member.role])).toEqual(expect.arrayContaining([[w.ada, "Ada Lovelace", "member"], [w.ben, expect.any(String), "admin"], [w.vi, expect.any(String), "viewer"]]));
    expect(meta.tags).toEqual([{ id: tagId, name: "Pricing", color: "#b4690e", conversations: 1 }, expect.objectContaining({ name: "Unused", conversations: 0 })]);
    expect(meta.saved_replies).toEqual([{ id: savedId, name: "Two times", body: "Would Tuesday or Wednesday work?" }]);
    expect(meta.merge_tags.map((tag) => tag.tag)).toEqual(["first_name", "last_name", "full_name", "company", "title", "location", "renewal_month"]);
    expect(meta.merge_tags[6]).toEqual({ tag: "renewal_month", label: "Renewal month", group: "Custom fields" });
    expect(meta.booking_url).toBe("https://cal.com/acme/intro");

    // A saved reply can be changed, and only from its own workspace.
    expect((await act({ action: "update_saved_reply", id: savedId, body: "Would Thursday work?" })).statusCode).toBe(200);
    expect((await act({ action: "update_saved_reply", id: savedId, name: "  " })).statusCode).toBe(400);
    const other = workspace();
    expect((await call(teamInbox, { method: "POST", body: { action: "update_saved_reply", id: savedId, name: "Theirs" }, headers: other.asAda })).statusCode).toBe(404);
    expect(db().prepare("SELECT name, body FROM saved_replies WHERE id = ?").get(savedId)).toEqual({ name: "Two times", body: "Would Thursday work?" });
  });

  it("says plainly which paid capabilities this build has: replies are read, drafts are not rewritten", async () => {
    const w = workspace();
    const meta = (await call(metaRoute, { method: "GET", headers: w.asViewer })).body as unknown as InboxMeta;
    expect(meta.capabilities).toEqual({ classify: true, rewrite: false, rewrite_route: null });
    // The route a rewrite would go to is one constant, for whoever merges the branch that adds it.
    expect(REWRITE_ROUTE).toBeNull();
    expect(meta.booking_url).toBeNull();
  });

  it("only an admin sets the booking link, and it has to be a web address", async () => {
    const w = workspace();
    expect((await call(bookingLink, { method: "PUT", body: { url: "https://cal.com/x" }, headers: w.asAda })).statusCode).toBe(403);
    expect((await call(bookingLink, { method: "PUT", body: { url: "javascript:alert(1)" }, headers: w.asBen })).statusCode).toBe(400);
    expect((await call(bookingLink, { method: "PUT", body: { url: "" }, headers: w.asBen })).body).toEqual({ url: null });
  });
});

// ── The list, as the screen asks for it ─────────────────────────────────────────────────
describe("the list as the screen asks for it", () => {
  it("takes the page size as `limit`, and counts the whole workspace beside what the filters leave", async () => {
    const w = workspace();
    for (const name of ["Lee Lead", "Mo Mail", "Ned Neg"]) w.reply(w.contact(name), "Hi");
    db().prepare("UPDATE conversations SET status = 'closed' WHERE workspace_id = ? AND target_id IN (SELECT id FROM targets WHERE full_name = 'Ned Neg')").run(w.ws);
    db().prepare("UPDATE conversations SET sla_due_at = ? WHERE workspace_id = ? AND target_id IN (SELECT id FROM targets WHERE full_name = 'Lee Lead')").run(new Date(Date.now() - 3_600_000).toISOString(), w.ws);

    const page = (await call(conversationsList, { method: "GET", query: { limit: "2", sort: "recent:desc", status: "closed" }, headers: w.asAda })).body as unknown as ConversationsResponse;
    expect(page).toMatchObject({ total: 1, per: 2, totals: { unread: 2, overdue: 1 } });
    expect(page.facets).toMatchObject({ total: 1, unread: 0, overdue: 0 });
  });
});

// ── Check replies now ───────────────────────────────────────────────────────────────────
describe("/api/conversations/sync", () => {
  function accounts(w: ReturnType<typeof workspace>) {
    db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, inbox_synced_at) VALUES (?, ?, 'No IMAP', ?, 'smtp.test', 'u', 'p', NULL)").run(`is-mb-${w.n}`, w.ws, `sales${w.n}@acme.test`);
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, inbox_synced_at) VALUES (?, 'Ada', ?, 1, ?, '2026-10-01 09:00:00')").run(`is-li-${w.n}`, `is-li-${w.n}@example.com`, w.ws);
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Signed out', ?, 0, ?)").run(`is-li-out-${w.n}`, `is-li-out-${w.n}@example.com`, w.ws);
  }

  it("says when replies were last looked for, and asks every signed-in LinkedIn account to be read", async () => {
    const w = workspace();
    accounts(w);
    const before = (await call(syncRoute, { method: "GET", headers: w.asViewer })).body as unknown as InboxSyncStatus;
    expect(before).toMatchObject({ last_checked_at: "2026-10-01T09:00:00.000Z", email: { mailboxes: 0, without_imap: 1 }, linkedin: { accounts: 1, requested: 0 } });

    expect((await call(syncRoute, { method: "POST", headers: w.asViewer })).statusCode).toBe(403);
    const started = await call(syncRoute, { method: "POST", headers: w.asAda });
    expect(started.statusCode).toBe(202);
    expect(started.body).toMatchObject({ started: true, linkedin: { accounts: 1, requested: 1 } });
    expect(db().prepare("SELECT id FROM accounts WHERE workspace_id = ? AND inbox_sync_requested_at IS NOT NULL").all(w.ws)).toEqual([{ id: `is-li-${w.n}` }]);
  });

  it("stops saying a LinkedIn read is on its way when nothing has picked it up", async () => {
    const w = workspace();
    accounts(w);
    // Asked five minutes ago, and the loop that reads LinkedIn is not running.
    db().prepare("UPDATE accounts SET inbox_sync_requested_at = datetime('now', '-5 minutes') WHERE id = ?").run(`is-li-${w.n}`);
    expect(((await call(syncRoute, { method: "GET", headers: w.asAda })).body as unknown as InboxSyncStatus).linkedin.requested).toBe(0);
  });
});

// ── The screen's own wording and decisions ──────────────────────────────────────────────
describe("the inbox screen's model", () => {
  const reply = (over: Partial<ThreadReply>): ThreadReply => ({ id: "r", verdict: "positive", summary: "Wants a call", confidence: 0.94, suggested_action: "human_followup", classified_at: "x", classification_error: null, dispatch: null, later: false, ...over });

  it("keeps several values in one filter, and tells whether what is on screen is a saved view", () => {
    expect(toggled("", "positive")).toBe("positive");
    expect(toggled("positive", "negative")).toBe("positive,negative");
    expect(toggled("positive,negative", "positive")).toBe("negative");
    expect(split(" a, ,b ")).toEqual(["a", "b"]);
    const filters = { ...FILTER_DEFAULTS, assignee: "none", verdict: "negative,positive" };
    expect(sameView({ filters: { verdict: "positive,negative", assignee: "none" } }, filters, "recent:desc", "")).toBe(true);
    expect(sameView({ filters: { verdict: "positive" } }, filters, "recent:desc", "")).toBe(false);
    expect(sameView({ filters: { verdict: "positive,negative", assignee: "none" }, sort: "due:asc" }, filters, "recent:desc", "")).toBe(false);
    expect(sameView({ filters: { verdict: "positive,negative", assignee: "none" } }, filters, "recent:desc", "acme")).toBe(false);
  });

  it("says when an answer is due, only for a conversation that is open", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(dueLabel("2026-10-10T15:00:00Z", "open", now)).toEqual({ text: "Due in 3h", overdue: false });
    expect(dueLabel("2026-10-10T11:15:00Z", "open", now)).toEqual({ text: "Overdue 45m", overdue: true });
    expect(dueLabel("2026-10-07T12:00:00Z", "open", now)).toEqual({ text: "Overdue 3d", overdue: true });
    expect(dueLabel("2026-10-10T11:15:00Z", "snoozed", now)).toBeNull();
    expect(dueLabel(null, "open", now)).toBeNull();
    expect(lockLabel({ name: "Priya Raghavan", at: "2026-10-10T11:58:00Z" }, now)).toBe("Priya Raghavan is replying · 2m");
    expect(snoozeLabel(null)).toBe("Snoozed until they write");
    expect(snoozeLabel("2026-10-14T09:00:00Z")).toMatch(/^Snoozed until \w{3}, \w{3} 14, /);
  });

  it("offers times to snooze to that are all in the future, and one with no end", () => {
    const now = new Date("2026-10-09T16:30:00");            // a Friday afternoon
    const choices = snoozeChoices(now);
    expect(choices.map((choice) => choice.key)).toEqual(["later", "tomorrow", "monday", "reply"]);
    for (const choice of choices.slice(0, 3)) expect(Date.parse(choice.until()!)).toBeGreaterThan(now.getTime());
    expect(new Date(choices[2].until()!).getDay()).toBe(1);
    expect(choices[3].until()).toBeNull();
  });

  it("puts a reply's verdict into two lines, with how sure it is and what to do next", () => {
    expect(summaryOf(reply({}))).toEqual({ title: "Classified positive · 94% confidence", detail: "Wants a call. Suggested next step: answer them personally." });
    // A model writes its own sentence for the next step; it is shown as it is.
    expect(summaryOf(reply({ suggested_action: "Offer two times and attach the case study." })).detail).toBe("Wants a call. Suggested next step: Offer two times and attach the case study.");
    // A verdict a person set carries no confidence.
    expect(summaryOf(reply({ verdict: "negative", summary: "Manually reclassified", confidence: 1, suggested_action: "manual" }))).toEqual({ title: "Marked negative", detail: "Set by a person." });
    expect(verdictOf(null).label).toBe("Needs review");
    expect(dispatchLine(reply({ dispatch: { action: "unenrolled_and_task_created" } }))).toBe("Their campaigns were stopped and a follow-up task was made.");
    expect(dispatchLine(reply({ dispatch: { action: "none" } }))).toBe("");
    expect(dispatchLine(reply({ dispatch: { kind: "cancelled" } }))).toMatch(/was cancelled/);
  });

  it("says which campaign step sent a message, and knows when something is still on its way", () => {
    const message = (over: Partial<ThreadMessage>) => ({ campaign: { workflow_id: "w", name: "Q4 Logistics Ops", step: 2, steps: 5 }, opens: 4, kind: null, status: "delivered", ...over }) as ThreadMessage;
    expect(campaignLine(message({}))).toBe("Q4 Logistics Ops · Step 2 of 5 · Opened 4×");
    expect(campaignLine(message({ kind: "note", opens: null }))).toBe("Q4 Logistics Ops · Note with the connection request · Step 2 of 5");
    expect(campaignLine(message({ campaign: null }))).toBeNull();
    expect(hasPending({ messages: [message({}), message({ status: "queued" })] } as ConversationDetail)).toBe(true);
    expect(hasPending({ messages: [message({}), message({ status: "failed" })] } as ConversationDetail)).toBe(false);
    expect(hasPending(undefined)).toBe(false);
    expect([fileSize(900), fileSize(21_000), fileSize(48_300_000)]).toEqual(["900 B", "21 KB", "46.1 MB"]);
  });

  it("puts a merge tag where the cursor is, and a saved reply under what is already written", () => {
    expect(insertAt("Hi , thanks", 3, 3, "{{first_name}}")).toEqual({ text: "Hi {{first_name}}, thanks", cursor: 17 });
    expect(insertAt("Hi NAME, thanks", 3, 7, "{{first_name}}")).toEqual({ text: "Hi {{first_name}}, thanks", cursor: 17 });
    expect(insertAt("Hi", 99, 99, "!")).toEqual({ text: "Hi!", cursor: 3 });
    expect(appendReply("", "Would Tuesday work?")).toBe("Would Tuesday work?");
    expect(appendReply("Thanks.\n\n", "Would Tuesday work?")).toBe("Thanks.\n\nWould Tuesday work?");
  });
});
