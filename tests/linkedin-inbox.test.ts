// Reading replies from a LinkedIn inbox: what is taken from LinkedIn's own responses, whose
// conversation it is, what counts as a reply, and that the read changes nothing on
// LinkedIn. A real (throwaway) database; the browser is a stand-in that replays the saved
// responses in tests/fixtures/linkedin-messaging (LinkedIn's shape, invented content).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import conversationsFixture from "./fixtures/linkedin-messaging/conversations.json";
import threadFixture from "./fixtures/linkedin-messaging/thread.json";

/** A browser page that behaves like a signed-in LinkedIn page loading its chat overlay. */
const browser = vi.hoisted(() => {
  const state = {
    signedOut: false, list: null as unknown, thread: null as unknown, loads: 0,
    /** The page shows its conversation list from its own cache and fetches nothing. */
    cached: false,
    aborted: [] as string[], allowed: [] as string[], fetched: [] as string[], closed: 0,
  };
  type Listener = (subject: unknown) => unknown;
  function page() {
    const listeners: Record<string, Listener[]> = { request: [], response: [] };
    let gate: ((route: unknown) => unknown) | null = null;
    const request = (method: string, url: string) => ({ method: () => method, url: () => url });
    return {
      route: async (_pattern: string, handler: (route: unknown) => unknown) => { gate = handler; },
      on(event: string, listener: Listener) { listeners[event].push(listener); return this; },
      waitForTimeout: async () => {},
      evaluate: async (_fn: unknown, url: string) => { state.fetched.push(url); return url.includes("queryId=messengerConversations.") ? state.list : state.thread; },
      close: async () => { state.closed++; },
      /** What loading the page sets off: its own requests, each through the gate first. */
      load(listUrl: string, threadUrl: string) {
        state.loads++;
        const own: Array<[string, string]> = [
          ...(state.cached ? [] : [["GET", listUrl], ["GET", threadUrl]] as Array<[string, string]>),
          ["POST", "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessageDeliveryAcknowledgements?action=sendDeliveryAcknowledgement"],
          ["POST", "https://www.linkedin.com/voyager/api/messaging/dash/presenceStatuses"],
          ["POST", "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerConversations?action=markAsRead"],
          ["POST", "https://www.linkedin.com/voyager/api/feed/dash/somethingElse"],
        ];
        for (const [method, url] of own) {
          let passed = false;
          gate?.({ request: () => request(method, url), abort: () => { state.aborted.push(`${method} ${url}`); }, continue: () => { passed = true; state.allowed.push(`${method} ${url}`); } });
          if (passed && method === "GET") listeners.request.forEach((listener) => listener(request(method, url)));
        }
        if (!state.cached) listeners.response.forEach((listener) => listener({ url: () => listUrl, status: () => 200, json: async () => state.list }));
      },
    };
  }
  return { state, page };
});

vi.mock("@/lib/linkedin/session", () => {
  class SessionExpiredError extends Error {}
  return {
    SessionExpiredError,
    getSessionPage: vi.fn(async () => browser.page()),
    getSessionContext: vi.fn(async () => ({})),
    saveSessionState: vi.fn(async () => {}),
    gotoLinkedin: vi.fn(async (page: { load: (a: string, b: string) => void }) => {
      if (browser.state.signedOut) throw new SessionExpiredError("signed out");
      page.load("https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.aaaabbbbccccdddd0000&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3AACoAASelfOwner)",
        "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.1111222233334444ffff&variables=(conversationUrn:x)");
    }),
    markNeedsReauth: vi.fn(async (id: string) => {
      const { getDb } = await import("@/lib/db");
      getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(id);
    }),
  };
});
vi.mock("@/lib/email/sender", () => ({ sendEmail: vi.fn(async () => ({ messageId: "<x@test>" })) }));

import { getDb } from "@/lib/db";
import {
  applyInboxPull, contactFor, inboxSyncDue, parseConversations, parseMessages, readLinkedinThread, syncLinkedinInbox,
  type InboxConversation,
} from "@/lib/linkedin/inbox-sync";
import { applyConnections } from "@/lib/linkedin/sync-accepted";
import { syncDueInboxes } from "@/lib/linkedin/runner";
import { classifyAndDispatch } from "@/lib/community-replies";
import inboxList from "@/pages/api/inbox";
import replyByEmail from "@/pages/api/inbox/reply";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;
const SELF = "urn:li:fsd_profile:ACoAASelfOwner0000000000000000000000000";
const LEE = "ACoAALeeLead00000000000000000000000000";
const MO = "ACoAAMoMail000000000000000000000000000";
const NOW = 1_791_600_000_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A workspace with a signed-in LinkedIn account that may be read at any hour. */
function workspace() {
  const n = ++seq;
  const ws = `ws-liinbox-${n}`;
  const w = { ws, account: `liinbox-acct-${n}`, run: `liinbox-run-${n}`, headers: ctxHeaders(ws) };
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare(`INSERT INTO accounts (id, name, email, is_authenticated, workspace_id, active_hours_start, active_hours_end, timezone, working_days)
    VALUES (?, 'Ada', ?, 1, ?, 0, 24, 'UTC', '1,2,3,4,5,6,7')`).run(w.account, `liinbox${n}@example.com`, ws);
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Campaign', ?)").run(`liinbox-wf-${n}`, ws);
  db().prepare("INSERT INTO runs (id, workflow_id, account_id, status, workspace_id) VALUES (?, ?, ?, 'running', ?)").run(w.run, `liinbox-wf-${n}`, w.account, ws);
  /** A contact in the campaign. `fields` says how (or whether) LinkedIn would know them. */
  const contact = (name: string, fields: Record<string, unknown> = {}) => {
    const id = `liinbox-target-${++seq}`;
    const row: Record<string, unknown> = { id, workspace_id: ws, full_name: name, linkedin_url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\W+/g, "-")}-${seq}/`, ...fields };
    const keys = Object.keys(row);
    db().prepare(`INSERT INTO targets (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`rp-${id}`, w.run, id);
    db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'linkedin', 'in_progress', 1)").run(`rt-${id}`, `rp-${id}`);
    return id;
  };
  return { ...w, contact };
}

/** A conversation as the reader hands it on, with the messages given oldest first. */
function conversation(profileId: string, messages: Array<[at: number, from: "them" | "me", text: string]>, memberUrn: string | null = null): InboxConversation {
  const thread = `2-${profileId.slice(5, 9)}-${++seq}`;
  return {
    urn: `urn:li:msg_conversation:(${SELF},${thread})`, lastActivityAt: Math.max(...messages.map(([at]) => at)), selfUrn: SELF,
    counterpart: { profileId, memberUrn, name: "Somebody" },
    messages: messages.map(([at, from, text], i) => ({ urn: `urn:li:msg_message:(${SELF},${thread}-${i})`, sentAt: at, text, fromSelf: from === "me" })),
  };
}

const replies = (targetId: string) => db().prepare("SELECT id, channel, body_text, received_at, run_id, linkedin_account_id, external_id, from_email FROM email_replies WHERE target_id = ? ORDER BY received_at").all(targetId) as Array<Record<string, string | null>>;
const transcript = (targetId: string) => (db().prepare("SELECT direction, body FROM linkedin_messages WHERE target_id = ? ORDER BY sent_at").all(targetId) as Array<{ direction: string; body: string }>).map((m) => `${m.direction}: ${m.body}`);
const track = (targetId: string) => db().prepare("SELECT state, error_message FROM run_profile_tracks WHERE id = ?").get(`rt-${targetId}`) as { state: string; error_message: string | null };
const contactRow = (id: string) => db().prepare("SELECT last_replied_at, email_replied_at, reply_kind, linkedin_profile_id, unsubscribed_at FROM targets WHERE id = ?").get(id) as Record<string, string | null>;
const received = (ws: string) => (db().prepare("SELECT payload_json FROM domain_events WHERE workspace_id = ? AND type = 'reply.received'").all(ws) as Array<{ payload_json: string }>).map((e) => JSON.parse(e.payload_json));

beforeEach(() => {
  Object.assign(browser.state, { signedOut: false, cached: false, list: conversationsFixture, thread: threadFixture, loads: 0, aborted: [], allowed: [], fetched: [], closed: 0 });
});

describe("LinkedIn's conversation list", () => {
  const parsed = parseConversations(conversationsFixture);

  it("is reduced to one-to-one conversations with a person, and the rest is counted", () => {
    expect(parsed.conversations.map((c) => c.counterpart.name)).toEqual(["Lee Lead", "Mo Mail", "Sam Stranger", "Una Attach"]);
    expect(parsed.skipped).toEqual({ sponsored: 1, group: 1, organisation: 1, unreadable: 0 });
  });

  it("names each person by their member ids, and says which side wrote last", () => {
    const [lee, mo] = parsed.conversations;
    expect(lee.counterpart).toEqual({ profileId: LEE, memberUrn: "urn:li:member:1001", name: "Lee Lead" });
    expect(lee.selfUrn).toBe(SELF);
    expect(lee.messages).toEqual([expect.objectContaining({ fromSelf: false, text: "Sounds interesting. Can you send over some details?" })]);
    expect(mo.messages[0]).toMatchObject({ fromSelf: true, text: "Thanks Mo, speak next week." });
  });

  it("keeps a message that has no words, as what it was", () => {
    expect(parsed.conversations[3].messages[0].text).toMatch(/^\[Sent something other than text/);
  });

  it("knows how far back the list reaches", () => {
    expect(parsed.newestActivity! - parsed.oldestActivity!).toBe(6 * DAY);
  });

  it("reads nothing from something that is not a list", () => {
    expect(parseConversations({ errors: [{ message: "nope" }] }).conversations).toEqual([]);
    expect(parseConversations(null).conversations).toEqual([]);
  });
});

describe("one conversation's messages", () => {
  it("come oldest first, each on its side", () => {
    expect(parseMessages(threadFixture, SELF).map((m) => [m.fromSelf, m.text.slice(0, 12)])).toEqual([
      [false, "Great talk a"], [true, "Hi Lee, I he"], [false, "Thanks for r"], [false, "Sounds inter"],
    ]);
  });

  it("are left out when they belong to a conversation other than the one asked for", () => {
    expect(parseMessages(threadFixture, SELF, `urn:li:msg_conversation:(${SELF},2-lee)`)).toHaveLength(4);
    expect(parseMessages(threadFixture, SELF, `urn:li:msg_conversation:(${SELF},2-mo)`)).toEqual([]);
  });
});

describe("whose conversation it is", () => {
  const who = (profileId: string, memberUrn: string | null = null) => ({ profileId, memberUrn, name: "Lee Lead" });

  it("is the contact with that member id, however it was learned", () => {
    const w = workspace();
    const byProfile = w.contact("Lee One", { linkedin_profile_id: "ACoAAOne" });
    const byNumber = w.contact("Lee Two", { linkedin_member_urn: "urn:li:member:42" });
    const byAddress = w.contact("Lee Three", { linkedin_url: "https://www.linkedin.com/in/ACoAAThree" });
    const bySlash = w.contact("Lee Four", { linkedin_url: "https://www.linkedin.com/in/ACoAAFour/" });
    expect(contactFor(db(), w.ws, who("ACoAAOne"))).toBe(byProfile);
    expect(contactFor(db(), w.ws, who("ACoAAUnknown", "urn:li:member:42"))).toBe(byNumber);
    expect(contactFor(db(), w.ws, who("ACoAAThree"))).toBe(byAddress);
    expect(contactFor(db(), w.ws, who("ACoAAFour"))).toBe(bySlash);
  });

  it("is never decided by name, and never another workspace's contact", () => {
    const w = workspace();
    const other = workspace();
    w.contact("Lee Lead");
    other.contact("Lee Elsewhere", { linkedin_profile_id: LEE });
    expect(contactFor(db(), w.ws, who(LEE))).toBeNull();
  });

  it("is learned for a contact when the account's connections are read", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_url: "https://www.linkedin.com/in/lee-lead-xyz/", connection_requested_at: iso(NOW - 9 * DAY) });
    applyConnections(db(), w.account, [{ memberUrn: `urn:li:fsd_profile:${LEE}`, createdAt: NOW - 8 * DAY, vanity: "lee-lead-xyz" }], { unmarkAbsent: false });
    expect(contactRow(lee).linkedin_profile_id).toBe(LEE);
    expect(contactFor(db(), w.ws, who(LEE))).toBe(lee);
  });
});

describe("storing what a read found", () => {
  it("keeps only conversations with contacts of the workspace", () => {
    const w = workspace();
    const result = applyInboxPull(db(), w.account, [conversation("ACoAANobodyWeKnow", [[NOW, "them", "Private, and none of this app's business."]])], { now: NOW });
    expect(result).toMatchObject({ matched: 0, stored: 0, replies: [] });
    expect(db().prepare("SELECT COUNT(*) c FROM linkedin_messages WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
    expect(db().prepare("SELECT COUNT(*) c FROM email_replies WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
  });

  it("on a first read, files what a contact wrote after this app wrote to them, and stops their campaign quietly", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE, message_sent_at: iso(NOW - 3 * DAY) });
    const result = applyInboxPull(db(), w.account, [conversation(LEE, [
      [NOW - 400 * DAY, "them", "Great talk at the conference last year!"],
      [NOW - 3 * DAY, "me", "Hi Lee, worth a chat?"],
      [NOW - 1 * DAY, "them", "Sounds interesting."],
    ])], { now: NOW });

    expect(result).toMatchObject({ matched: 1, stored: 3 });
    expect(transcript(lee)).toEqual(["in: Great talk at the conference last year!", "out: Hi Lee, worth a chat?", "in: Sounds interesting."]);
    // Last year's note is in the conversation but is nobody's reply.
    expect(replies(lee)).toEqual([expect.objectContaining({ channel: "linkedin", body_text: "Sounds interesting.", run_id: w.run, linkedin_account_id: w.account, from_email: "" })]);
    expect(result.replies).toEqual([expect.objectContaining({ targetId: lee, fresh: false })]);
    expect(contactRow(lee).last_replied_at).toBe(iso(NOW - 1 * DAY));
    expect(track(lee)).toEqual({ state: "skipped", error_message: "Lead replied" });
    expect(received(w.ws)).toEqual([]);
  });

  it("does not stop a campaign over something a contact wrote before it began", () => {
    const w = workspace();
    const old = w.contact("Old Friend", { linkedin_profile_id: LEE, message_sent_at: iso(NOW - 2 * DAY) });
    const never = w.contact("Never Written To", { linkedin_profile_id: MO });
    applyInboxPull(db(), w.account, [
      conversation(LEE, [[NOW - 90 * DAY, "them", "Happy new job!"], [NOW - 2 * DAY, "me", "Hi, worth a chat?"]]),
      conversation(MO, [[NOW - 30 * DAY, "them", "Are you coming to the meetup?"]]),
    ], { now: NOW });
    for (const id of [old, never]) {
      expect(replies(id)).toEqual([]);
      expect(track(id).state).toBe("in_progress");
      expect(contactRow(id).last_replied_at).toBeNull();
    }
    expect(transcript(old)).toHaveLength(2);
  });

  it("announces a reply that arrived since the last read, and leaves stopping the campaign to its verdict", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE, message_sent_at: iso(NOW - 3 * DAY) });
    db().prepare("UPDATE accounts SET inbox_synced_through_ms = ? WHERE id = ?").run(NOW - DAY, w.account);
    const result = applyInboxPull(db(), w.account, [conversation(LEE, [[NOW - 3 * DAY, "me", "Hi Lee."], [NOW, "them", "Yes, let's talk."]])]);

    expect(result.replies).toEqual([expect.objectContaining({ targetId: lee, fresh: true })]);
    expect(received(w.ws)).toEqual([expect.objectContaining({ channel: "linkedin", source: "inbox_sync", account_id: w.account, reply_id: result.replies[0].replyId, run_id: w.run })]);
    expect(track(lee).state).toBe("in_progress");
  });

  it("counts a fresh message from a contact as a reply even if this app never wrote first", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE });
    db().prepare("UPDATE accounts SET inbox_synced_through_ms = ? WHERE id = ?").run(NOW - DAY, w.account);
    expect(applyInboxPull(db(), w.account, [conversation(LEE, [[NOW, "them", "Saw your post, can we talk?"]])]).replies).toHaveLength(1);
    expect(replies(lee)).toHaveLength(1);
  });

  it("stores each message once, however often the same list is read", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE, message_sent_at: iso(NOW - 3 * DAY) });
    const seen = [conversation(LEE, [[NOW - 3 * DAY, "me", "Hi Lee."], [NOW - DAY, "them", "Hello."]])];
    applyInboxPull(db(), w.account, seen, { now: NOW });
    const again = applyInboxPull(db(), w.account, seen, { now: NOW });
    expect(again).toMatchObject({ matched: 1, stored: 0, replies: [] });
    expect(transcript(lee)).toHaveLength(2);
    expect(replies(lee)).toHaveLength(1);
  });

  it("does not take the account owner's own message for a reply", () => {
    const w = workspace();
    const mo = w.contact("Mo Mail", { linkedin_profile_id: MO, message_sent_at: iso(NOW - 3 * DAY) });
    applyInboxPull(db(), w.account, [conversation(MO, [[NOW - DAY, "me", "Thanks Mo, speak next week."]])], { now: NOW });
    expect(transcript(mo)).toEqual(["out: Thanks Mo, speak next week."]);
    expect(replies(mo)).toEqual([]);
    expect(track(mo).state).toBe("in_progress");
  });

  it("remembers the member id of a contact it matched another way", () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_member_urn: "urn:li:member:1001" });
    applyInboxPull(db(), w.account, [conversation(LEE, [[NOW, "me", "Hi."]], "urn:li:member:1001")], { now: NOW });
    expect(contactRow(lee).linkedin_profile_id).toBe(LEE);
  });
});

describe("acting on a LinkedIn reply", () => {
  function fresh(text: string, fields: Record<string, unknown> = {}) {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE, message_sent_at: iso(NOW - 3 * DAY), ...fields });
    db().prepare("UPDATE accounts SET inbox_synced_through_ms = ? WHERE id = ?").run(NOW - DAY, w.account);
    const [reply] = applyInboxPull(db(), w.account, [conversation(LEE, [[NOW, "them", text]])]).replies;
    return { w, lee, replyId: reply.replyId };
  }

  it("stops the contact's campaign and marks them as having replied on LinkedIn, not by email", async () => {
    const { lee, replyId } = fresh("Could you tell me more about pricing?");
    await classifyAndDispatch(replyId);
    expect(track(lee).state).toBe("skipped");
    expect(contactRow(lee)).toMatchObject({ email_replied_at: null, reply_kind: null });
    expect(contactRow(lee).last_replied_at).toBeTruthy();
    expect(db().prepare("SELECT classified_at IS NOT NULL done, inbox_status FROM email_replies WHERE id = ?").get(replyId)).toEqual({ done: 1, inbox_status: "open" });
  });

  it("closes LinkedIn and email both when they ask to be left alone", async () => {
    const { w, lee, replyId } = fresh("Please stop messaging me.", { email: "lee@prospect.test", linkedin_url: "https://www.linkedin.com/in/lee-optout/" });
    await classifyAndDispatch(replyId, "unsubscribe");
    const kinds = (db().prepare("SELECT kind FROM suppressions WHERE workspace_id = ? ORDER BY kind").all(w.ws) as Array<{ kind: string }>).map((row) => row.kind);
    expect(kinds).toEqual(["email", "linkedin"]);
    expect(contactRow(lee).unsubscribed_at).toBeTruthy();

    // Corrected: both are lifted again.
    await classifyAndDispatch(replyId, "positive");
    expect(db().prepare("SELECT COUNT(*) c FROM suppressions WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
  });
});

describe("a read of the inbox", () => {
  function known() {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE, message_sent_at: iso(NOW - 3 * DAY) });
    const mo = w.contact("Mo Mail", { linkedin_profile_id: MO, message_sent_at: iso(NOW - 3 * DAY) });
    return { w, lee, mo };
  }

  it("stops every write the page tries to make to messaging, and lets its reads through", async () => {
    const { w } = known();
    const read = await syncLinkedinInbox(w.account, { dryRun: true });
    expect(browser.state.aborted.map((line) => line.split("/voyager/api/")[1])).toEqual([
      "voyagerMessagingDashMessengerMessageDeliveryAcknowledgements?action=sendDeliveryAcknowledgement",
      "messaging/dash/presenceStatuses",
      "voyagerMessagingDashMessengerConversations?action=markAsRead",
    ]);
    expect(read.writes_blocked).toBe(3);
    // Reads go through, and so does a write that has nothing to do with messaging.
    expect(browser.state.allowed.map((line) => line.split(" ")[0])).toEqual(["GET", "GET", "POST"]);
    expect(browser.state.closed).toBe(1);
  });

  it("as a dry run, reports the contacts it found and stores nothing", async () => {
    const { w, lee, mo } = known();
    const read = await syncLinkedinInbox(w.account, { dryRun: true });
    expect(read).toMatchObject({ dry_run: true, conversations: 4, matched: 2, skipped: { sponsored: 1, group: 1, organisation: 1 }, signedOut: false });
    expect(read.with_contacts.map((c) => [c.contact_id, c.name, c.latest_from])).toEqual([[lee, "Lee Lead", "contact"], [mo, "Mo Mail", "account"]]);
    // Nobody else in the inbox is named.
    expect(JSON.stringify(read)).not.toMatch(/Stranger|Una|Theo|Example/);
    expect(db().prepare("SELECT COUNT(*) c FROM linkedin_messages WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
    expect(db().prepare("SELECT inbox_synced_at FROM accounts WHERE id = ?").get(w.account)).toEqual({ inbox_synced_at: null });
  });

  it("reads the whole thread of a contact's conversation that has something new, using the query name the page itself used", async () => {
    const { w, lee, mo } = known();
    const read = await syncLinkedinInbox(w.account);
    // Two threads read: Lee's and Mo's both have a latest message not seen before. (The
    // stand-in answers both with Lee's thread; Mo's read drops it as not his.)
    expect(browser.state.fetched).toHaveLength(2);
    expect(browser.state.fetched[0]).toContain("queryId=messengerMessages.1111222233334444ffff");
    expect(browser.state.fetched[0]).toContain("%28urn%3Ali%3Afsd_profile%3AACoAASelfOwner0000000000000000000000000%2C2-lee%29");
    expect(transcript(lee)).toHaveLength(4);
    expect(read).toMatchObject({ dry_run: false, matched: 2 });
    // The two after this app's message are replies; the one from long before is not.
    expect(replies(lee).map((r) => r.body_text)).toEqual(["Thanks for reaching out.", "Sounds interesting. Can you send over some details?"]);
    expect(track(lee).state).toBe("skipped");
    expect(track(mo).state).toBe("in_progress");
    expect(JSON.parse((db().prepare("SELECT inbox_query_ids q FROM accounts WHERE id = ?").get(w.account) as { q: string }).q)).toEqual({ messengerConversations: "aaaabbbbccccdddd0000", messengerMessages: "1111222233334444ffff", mailboxUrn: "urn:li:fsd_profile:ACoAASelfOwner" });
  });

  it("does not read a thread again when nothing in it is new", async () => {
    const { w } = known();
    await syncLinkedinInbox(w.account);
    browser.state.fetched.length = 0;
    const again = await syncLinkedinInbox(w.account);
    expect(browser.state.fetched).toEqual([]);
    expect(again).toMatchObject({ stored: 0, replies: [] });
  });

  it("classifies a reply that is new since the last read, which is what stops the campaign", async () => {
    const { w, lee } = known();
    // A read long ago: everything in the list is newer than it.
    db().prepare("UPDATE accounts SET inbox_synced_through_ms = ? WHERE id = ?").run(NOW - 10 * DAY, w.account);
    const read = await syncLinkedinInbox(w.account);
    expect(read.replies.filter((r) => r.fresh).length).toBeGreaterThan(0);
    expect(received(w.ws).every((event) => event.channel === "linkedin")).toBe(true);
    expect(track(lee).state).toBe("skipped");
    expect(db().prepare("SELECT COUNT(*) c FROM email_replies WHERE target_id = ? AND classified_at IS NOT NULL").get(lee)).toEqual({ c: replies(lee).length });
  });

  it("marks the account as needing sign-in when LinkedIn shows a login page, and stores nothing", async () => {
    const { w } = known();
    browser.state.signedOut = true;
    const read = await syncLinkedinInbox(w.account);
    expect(read).toMatchObject({ signedOut: true, matched: 0 });
    expect(db().prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(w.account)).toEqual({ is_authenticated: 0 });
    expect(browser.state.closed).toBe(1);
  });

  it("asks for the list itself when the page shows it from its own cache and fetches nothing", async () => {
    const { w, lee } = known();
    await syncLinkedinInbox(w.account);            // a first read learns the query's name and the mailbox
    db().prepare("DELETE FROM linkedin_messages WHERE workspace_id = ?").run(w.ws);
    browser.state.cached = true;
    browser.state.fetched.length = 0;
    const read = await syncLinkedinInbox(w.account);
    expect(browser.state.fetched[0]).toContain("queryId=messengerConversations.aaaabbbbccccdddd0000&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3AACoAASelfOwner)");
    expect(read).toMatchObject({ conversations: 4, matched: 2 });
    expect(transcript(lee)).toHaveLength(4);
  });

  it("has nothing to fall back on the very first time, and says so", async () => {
    const { w } = known();
    browser.state.cached = true;
    await expect(syncLinkedinInbox(w.account)).rejects.toThrow(/did not load its conversation list/);
  });

  it("fails plainly when the page never loads its conversation list", async () => {
    const { w } = known();
    browser.state.list = null;
    await expect(syncLinkedinInbox(w.account)).rejects.toThrow(/did not load its conversation list/);
    expect(browser.state.closed).toBe(1);
  });
});

describe("reading one contact's conversation on demand", () => {
  it("returns the thread, both sides, and stores nothing", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE });
    const read = await readLinkedinThread(w.account, lee);
    expect(read).toMatchObject({ found: true, signedOut: false });
    expect(read.messages.map((m) => m.direction)).toEqual(["in", "out", "in", "in"]);
    expect(db().prepare("SELECT COUNT(*) c FROM linkedin_messages WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
    expect(browser.state.aborted).toHaveLength(3);
  });

  it("says so when the account has no conversation with them", async () => {
    const w = workspace();
    const nobody = w.contact("No Conversation", { linkedin_profile_id: "ACoAANotInTheList" });
    expect(await readLinkedinThread(w.account, nobody)).toMatchObject({ found: false, messages: [] });
  });
});

describe("when an inbox is read", () => {
  const due = (w: { account: string }) => inboxSyncDue(db(), w.account);
  const set = (w: { account: string }, sql: string) => db().prepare(`UPDATE accounts SET ${sql} WHERE id = ?`).run(w.account);

  it("is when it never has been, when the interval has passed, or when someone asks", () => {
    const w = workspace();
    expect(due(w)).toBe(true);
    set(w, "inbox_synced_at = datetime('now')");
    expect(due(w)).toBe(false);
    set(w, "inbox_synced_at = datetime('now', '-16 minutes')");
    expect(due(w)).toBe(true);
    set(w, "inbox_synced_at = datetime('now'), inbox_sync_requested_at = datetime('now')");
    expect(due(w)).toBe(true);
  });

  it("is never for an account that is signed out or has reading switched off", () => {
    const off = workspace();
    set(off, "sync_inbox = 0");
    expect(due(off)).toBe(false);
    const out = workspace();
    set(out, "is_authenticated = 0");
    expect(due(out)).toBe(false);
  });

  it("happens on the runner's pass with no campaign running, inside working hours only unless asked", async () => {
    db().prepare("UPDATE accounts SET sync_inbox = 0").run();   // every earlier test's account sits this one out
    const w = workspace();
    db().prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(w.run);
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE, message_sent_at: iso(NOW - 3 * DAY) });

    // Closed today: nothing is read.
    const today = String(((new Date().getUTCDay() + 6) % 7) + 1);
    set(w, `working_days = '${["1", "2", "3", "4", "5", "6", "7"].filter((d) => d !== today).join(",")}'`);
    await syncDueInboxes(db());
    expect(browser.state.loads).toBe(0);

    // Asked for by hand: read anyway.
    set(w, "inbox_sync_requested_at = datetime('now')");
    await syncDueInboxes(db());
    expect(browser.state.loads).toBe(1);
    expect(replies(lee).length).toBeGreaterThan(0);
    expect(db().prepare("SELECT inbox_sync_requested_at r, inbox_synced_at IS NOT NULL s FROM accounts WHERE id = ?").get(w.account)).toEqual({ r: null, s: 1 });

    // And not again thirty seconds later.
    set(w, "working_days = '1,2,3,4,5,6,7'");
    await syncDueInboxes(db());
    expect(browser.state.loads).toBe(1);
  });

  it("does not come straight back to an inbox it failed to read", async () => {
    db().prepare("UPDATE accounts SET sync_inbox = 0").run();
    workspace();
    browser.state.list = null;
    await syncDueInboxes(db());
    await syncDueInboxes(db());
    expect(browser.state.loads).toBe(1);
  });
});

describe("a LinkedIn reply in the inbox", () => {
  async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    res.end = () => res;
    res.setHeader = () => res;
    await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return res as unknown as { statusCode: number; body: Record<string, unknown> };
  }

  it("is listed with what they wrote, under LinkedIn, and can be filtered to", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE, message_sent_at: iso(NOW - 3 * DAY), email: "lee@prospect.test" });
    applyInboxPull(db(), w.account, [conversation(LEE, [[NOW - 3 * DAY, "me", "Hi Lee."], [NOW - DAY, "them", "Sounds interesting."]])], { now: NOW });

    const all = ((await call(inboxList, { method: "GET", headers: w.headers })).body.replies as Array<Record<string, unknown>>);
    expect(all).toEqual([expect.objectContaining({ id: lee, channel: "linkedin", reply_channel: "linkedin", reply_body: "Sounds interesting." })]);
    expect(((await call(inboxList, { method: "GET", headers: w.headers, query: { channel: "linkedin" } })).body.replies as unknown[])).toHaveLength(1);
    expect(((await call(inboxList, { method: "GET", headers: w.headers, query: { channel: "email" } })).body.replies as unknown[])).toHaveLength(0);
  });

  it("is not answered by an email", async () => {
    const w = workspace();
    const lee = w.contact("Lee Lead", { linkedin_profile_id: LEE, message_sent_at: iso(NOW - 3 * DAY), email: "lee@prospect.test" });
    applyInboxPull(db(), w.account, [conversation(LEE, [[NOW - DAY, "them", "Sounds interesting."]])], { now: NOW });
    db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, 'Sender', 'ada@acme.test', 'smtp.test.com', 'user', 'pass')").run(`mb-${w.ws}`, w.ws);
    const res = await call(replyByEmail, { method: "POST", headers: w.headers, body: { replyId: replies(lee)[0].id, emailAccountId: `mb-${w.ws}`, to: "lee@prospect.test", subject: "Re", body: "Hello" } });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/LinkedIn/);
  });
});
