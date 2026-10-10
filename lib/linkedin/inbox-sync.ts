// Reading replies from a LinkedIn account's inbox.
//
// How it reads. Every signed-in LinkedIn page loads the account's conversation list for
// the chat overlay in its corner. This opens an ordinary page, takes that list as the page
// itself fetched it, and asks for a few threads the same way the page would. It never
// opens the messaging page: doing that opens the top conversation, and LinkedIn marks an
// opened conversation as read (seen happen on a live account, 2026-10-10).
//
// What it must never do is change anything. While it works, every request to LinkedIn's
// messaging endpoints that is not a plain read is dropped before it leaves the browser:
// the read receipts and "delivered" acknowledgements the page would otherwise send by
// itself. Reading a thread this way leaves it unread (also checked on a live account).
//
// What it keeps. An inbox is mostly not about campaigns. Only a conversation with someone
// who is a contact in the workspace is stored; everything else is counted and dropped.
import { randomUUID } from "crypto";
import type { Page } from "playwright";
import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { getSessionPage, gotoLinkedin, markNeedsReauth, SessionExpiredError } from "@/lib/linkedin/session";
import { canonicalLinkedinUrl, profileVanity } from "@/lib/linkedin/url";
import { emitDomainEvent } from "@/lib/platform/events";
import { classifyAndDispatch, stopAutomation } from "@/lib/community-replies";

type DB = DatabaseType.Database;

// ── What LinkedIn sends (only the parts this reads) ─────────────────────────────────────

interface RawParticipant {
  hostIdentityUrn?: string | null;
  backendUrn?: string | null;
  participantType?: {
    member?: { profileUrl?: string | null; firstName?: { text?: string | null } | null; lastName?: { text?: string | null } | null; distance?: string | null } | null;
  } | null;
}
interface RawMessage {
  entityUrn?: string | null;
  deliveredAt?: number | null;
  body?: { text?: string | null } | null;
  sender?: RawParticipant | null;
  actor?: RawParticipant | null;
  renderContent?: unknown[] | null;
  conversation?: { entityUrn?: string | null } | null;
}
interface RawConversation {
  entityUrn?: string | null;
  lastActivityAt?: number | null;
  groupChat?: boolean | null;
  conversationParticipants?: RawParticipant[] | null;
  contentMetadata?: { conversationAdContent?: unknown } | null;
  messages?: { elements?: RawMessage[] | null } | null;
}

// ── What it is turned into ──────────────────────────────────────────────────────────────

export interface InboxMessage {
  /** LinkedIn's own id for the message. Reading it twice stores it once. */
  urn: string;
  sentAt: number;
  text: string;
  /** Written by the account's owner rather than the other person. */
  fromSelf: boolean;
}

export interface InboxConversation {
  urn: string;
  lastActivityAt: number;
  /** The account owner's own id, which is how a message's side is told. */
  selfUrn: string;
  counterpart: {
    /** The opaque member id (ACoAA…) messaging knows a person by. */
    profileId: string;
    /** urn:li:member:<number>, which a contact imported from Sales Navigator carries. */
    memberUrn: string | null;
    name: string;
  };
  /** Oldest first. From the list, only the latest; a thread read adds the rest. */
  messages: InboxMessage[];
}

export interface ParsedInbox {
  conversations: InboxConversation[];
  /** What was in the list and is none of this app's business, by kind. */
  skipped: { sponsored: number; group: number; organisation: number; unreadable: number };
  /** Activity times of the newest and oldest conversation in the list. */
  newestActivity: number | null;
  oldestActivity: number | null;
}

const lastSegment = (urn: string | null | undefined) => (urn ? urn.slice(urn.lastIndexOf(":") + 1) : "");
const ATTACHMENT_ONLY = "[Sent something other than text: an attachment, a voice note or a shared post]";

/** The first collection in a response, whatever LinkedIn calls its query this month. */
function elementsOf<T>(payload: unknown): T[] {
  const data = (payload as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return [];
  for (const value of Object.values(data)) {
    const elements = (value as { elements?: unknown } | null)?.elements;
    if (Array.isArray(elements)) return elements as T[];
  }
  return [];
}

function parseMessage(raw: RawMessage, selfUrn: string): InboxMessage | null {
  const urn = raw.entityUrn ?? "";
  const from = raw.sender?.hostIdentityUrn ?? raw.actor?.hostIdentityUrn ?? "";
  if (!urn || !from || typeof raw.deliveredAt !== "number") return null;
  const text = (raw.body?.text ?? "").trim();
  if (!text && !(raw.renderContent?.length)) return null;
  return { urn, sentAt: raw.deliveredAt, text: text || ATTACHMENT_ONLY, fromSelf: from === selfUrn };
}

/**
 * The conversation list as LinkedIn sends it, reduced to one-to-one conversations with a
 * person. Sponsored messages, group chats and company pages are counted and left out.
 */
export function parseConversations(payload: unknown): ParsedInbox {
  const parsed: ParsedInbox = { conversations: [], skipped: { sponsored: 0, group: 0, organisation: 0, unreadable: 0 }, newestActivity: null, oldestActivity: null };
  for (const raw of elementsOf<RawConversation>(payload)) {
    const activity = typeof raw.lastActivityAt === "number" ? raw.lastActivityAt : null;
    if (activity !== null) {
      parsed.newestActivity = Math.max(parsed.newestActivity ?? activity, activity);
      parsed.oldestActivity = Math.min(parsed.oldestActivity ?? activity, activity);
    }
    if (raw.contentMetadata?.conversationAdContent) { parsed.skipped.sponsored++; continue; }
    const participants = raw.conversationParticipants ?? [];
    if (raw.groupChat || participants.length !== 2) { parsed.skipped.group++; continue; }
    const self = participants.find((p) => p.participantType?.member?.distance === "SELF");
    const other = participants.find((p) => p !== self);
    if (!self?.hostIdentityUrn || !other) { parsed.skipped.unreadable++; continue; }
    const member = other.participantType?.member;
    if (!member) { parsed.skipped.organisation++; continue; }
    const profileId = lastSegment(other.hostIdentityUrn) || (profileVanity(member.profileUrl) ?? "");
    if (!raw.entityUrn || !profileId || activity === null) { parsed.skipped.unreadable++; continue; }
    const selfUrn = self.hostIdentityUrn;
    parsed.conversations.push({
      urn: raw.entityUrn,
      lastActivityAt: activity,
      selfUrn,
      counterpart: {
        profileId,
        memberUrn: other.backendUrn?.startsWith("urn:li:member:") ? other.backendUrn : null,
        name: [member.firstName?.text, member.lastName?.text].filter(Boolean).join(" ").trim(),
      },
      messages: (raw.messages?.elements ?? []).map((m) => parseMessage(m, selfUrn)).filter((m): m is InboxMessage => m !== null).sort((a, b) => a.sentAt - b.sentAt),
    });
  }
  return parsed;
}

/**
 * One thread's messages as LinkedIn sends them, oldest first. Given the conversation that
 * was asked for, a message that says it belongs to another one is left out: an answer to
 * the wrong question must not put one person's words in another's conversation.
 */
export function parseMessages(payload: unknown, selfUrn: string, conversationUrn?: string): InboxMessage[] {
  return elementsOf<RawMessage>(payload)
    .filter((m) => !conversationUrn || !m.conversation?.entityUrn || m.conversation.entityUrn === conversationUrn)
    .map((m) => parseMessage(m, selfUrn)).filter((m): m is InboxMessage => m !== null).sort((a, b) => a.sentAt - b.sentAt);
}

// ── Whose conversation it is ────────────────────────────────────────────────────────────

/**
 * The contact a conversation is with, by who they are on LinkedIn and never by name: the
 * member id learned when the account's connections were read, the numeric member id a
 * Sales Navigator import carries, or a profile address stored in its member-id form. Two
 * people can share a name; a reply filed under the wrong one stops the wrong campaign.
 */
export function contactFor(db: DB, workspaceId: string, counterpart: InboxConversation["counterpart"]): string | null {
  const address = canonicalLinkedinUrl(`https://www.linkedin.com/in/${counterpart.profileId}`);
  const row = db.prepare(`SELECT id FROM targets WHERE workspace_id = ? AND (
      linkedin_profile_id = ? OR (? IS NOT NULL AND linkedin_member_urn = ?) OR linkedin_url IN (?, ?))
    ORDER BY created_at LIMIT 1`).get(workspaceId, counterpart.profileId, counterpart.memberUrn, counterpart.memberUrn, address, address.replace(/\/$/, "")) as { id: string } | undefined;
  return row?.id ?? null;
}

// ── Writing down what was read ──────────────────────────────────────────────────────────

export interface InboxPullResult {
  /** Conversations in the list that are with a contact of this workspace. */
  matched: number;
  /** Messages not seen before, both directions. */
  stored: number;
  /** Replies not seen before. `fresh` ones arrived since the last read and are acted on. */
  replies: Array<{ replyId: string; targetId: string; fresh: boolean }>;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** A stored time, which is either ISO or SQLite's "YYYY-MM-DD HH:MM:SS" in UTC. */
function storedTime(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Store what a read found. Every message is kept once, by LinkedIn's own id for it, so
 * reading the same list again changes nothing.
 *
 * A message from the contact is also a reply: a row beside the email replies, so the team
 * inbox, assignment, tags and due times work on it as they are. One that arrived since the
 * previous read is `fresh`: the caller has it classified, which is what stops the
 * contact's campaign (or holds it, for an away message). An older one, found the first
 * time an account is read or once a contact can finally be matched, is history. History
 * is a reply only if it came after this app first wrote to the contact on LinkedIn: then
 * it is recorded and the campaign stopped, with nothing announced about a message that
 * may be months old. Anything they wrote before that is kept in the conversation and is
 * nobody's reply: a note from last year must not stop a campaign that started last week.
 */
export function applyInboxPull(db: DB, accountId: string, conversations: InboxConversation[], opts: { now?: number } = {}): InboxPullResult {
  const account = db.prepare("SELECT workspace_id, inbox_synced_through_ms FROM accounts WHERE id = ?").get(accountId) as { workspace_id: string | null; inbox_synced_through_ms: number | null } | undefined;
  const result: InboxPullResult = { matched: 0, stored: 0, replies: [] };
  if (!account?.workspace_id) return result;
  const workspaceId = account.workspace_id;
  // Nothing before the first read is news.
  const freshAfter = account.inbox_synced_through_ms ?? opts.now ?? Date.now();

  const known = db.prepare("SELECT 1 FROM linkedin_messages WHERE workspace_id = ? AND message_urn = ?");
  const own = db.prepare("UPDATE targets SET linkedin_account_id = ? WHERE id = ? AND linkedin_account_id IS NULL");
  const keep = db.prepare(`INSERT OR IGNORE INTO linkedin_messages (id, workspace_id, account_id, target_id, conversation_urn, message_urn, direction, body, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // A message this app sent has no LinkedIn id until it is read back. When it is, the row
  // that was waiting takes the id instead of a second copy being stored, and a send that
  // could not be confirmed is confirmed.
  const claim = db.prepare(`UPDATE linkedin_messages SET message_urn = ?, conversation_urn = ?, sent_at = ?, status = 'delivered', error = NULL
    WHERE id = (SELECT id FROM linkedin_messages WHERE workspace_id = ? AND target_id = ? AND direction = 'out' AND message_urn IS NULL
      AND status IN ('delivered', 'uncertain', 'sending') AND body = ? ORDER BY created_at LIMIT 1)`);
  const file = db.prepare(`INSERT OR IGNORE INTO email_replies (id, workspace_id, target_id, run_id, from_email, subject, body_text, received_at, channel, linkedin_account_id, conversation_urn, external_id)
    VALUES (?, ?, ?, ?, '', NULL, ?, ?, 'linkedin', ?, ?, ?)`);
  // The campaign the reply belongs to: one this account is running for the contact if
  // there is one, otherwise the latest they were in.
  const runOf = db.prepare(`SELECT r.id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
    WHERE rp.target_id = ? AND r.status IN ('running','paused','completed')
    ORDER BY (COALESCE(rp.account_id, r.account_id) = ?) DESC, r.created_at DESC LIMIT 1`);
  const outreachOf = db.prepare("SELECT connection_requested_at, message_sent_at, inmail_sent_at FROM targets WHERE id = ?");
  /** When this app first wrote to the contact on LinkedIn, or null if it never has. */
  const firstOutreach = (targetId: string): number | null => {
    const row = outreachOf.get(targetId) as Record<string, string | null>;
    const times = Object.values(row).map(storedTime).filter((ms): ms is number => ms !== null);
    return times.length ? Math.min(...times) : null;
  };

  db.transaction(() => {
    for (const conversation of conversations) {
      const targetId = contactFor(db, workspaceId, conversation.counterpart);
      if (!targetId) continue;
      result.matched++;
      db.prepare("UPDATE targets SET linkedin_profile_id = COALESCE(linkedin_profile_id, ?) WHERE id = ?").run(conversation.counterpart.profileId, targetId);
      let history = false;
      const outreach = firstOutreach(targetId);
      for (const message of conversation.messages) {
        if (known.get(workspaceId, message.urn)) continue;
        if (message.fromSelf && claim.run(message.urn, conversation.urn, iso(message.sentAt), workspaceId, targetId, message.text).changes) continue;
        keep.run(randomUUID(), workspaceId, accountId, targetId, conversation.urn, message.urn, message.fromSelf ? "out" : "in", message.text, iso(message.sentAt));
        // A conversation in this account's inbox: if no account is on record for the
        // contact yet, it is this one. One already on record is not overruled by a read.
        own.run(accountId, targetId);
        result.stored++;
        if (message.fromSelf) continue;
        if (message.sentAt <= freshAfter && (outreach === null || message.sentAt <= outreach)) continue;
        const replyId = randomUUID();
        const run = runOf.get(targetId, accountId) as { id: string } | undefined;
        if (!file.run(replyId, workspaceId, targetId, run?.id ?? null, message.text, iso(message.sentAt), accountId, conversation.urn, message.urn).changes) continue;
        const fresh = message.sentAt > freshAfter;
        result.replies.push({ replyId, targetId, fresh });
        db.prepare("UPDATE targets SET last_replied_at = COALESCE(last_replied_at, ?) WHERE id = ?").run(iso(message.sentAt), targetId);
        if (!fresh) history = true;
      }
      if (history) stopAutomation(targetId, "Lead replied");
    }
  })();

  for (const reply of result.replies.filter((r) => r.fresh)) {
    const row = db.prepare("SELECT received_at, run_id FROM email_replies WHERE id = ?").get(reply.replyId) as { received_at: string; run_id: string | null };
    emitDomainEvent({ workspaceId, type: "reply.received", entityType: "target", entityId: reply.targetId, payload: { channel: "linkedin", reply_id: reply.replyId, replied_at: row.received_at, source: "inbox_sync", account_id: accountId, run_id: row.run_id } });
  }
  return result;
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────

/** How often an account's inbox is read. */
export const INBOX_SYNC_INTERVAL_MIN = 15;
// Any signed-in page will do; this one is light, and the connection sync already uses it.
const HOST_PAGE = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const GRAPHQL = "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql";
// The messages query as it was named on 2026-10-10. Only a starting point: whichever name
// the page is last seen using is kept on the account and used instead.
const MESSAGES_QUERY_SEEN_WORKING = "5846eeb71c981f11e0134cb6626cc314";
/** Threads read in full on one pass. A reply shows in the list regardless; this is for the messages before it. */
const MAX_THREADS_PER_PASS = 8;

export interface InboxSyncResult extends InboxPullResult {
  /** One-to-one conversations with a person in the list LinkedIn returned (the twenty most recent). */
  conversations: number;
  skipped: ParsedInbox["skipped"];
  /** Matched conversations, for a dry run: who, and where the conversation stands. Never anyone else's. */
  with_contacts: Array<{ contact_id: string; name: string; last_activity: string; latest_from: "contact" | "account" | null; messages_read: number }>;
  /** Every conversation in the list was newer than the last read, so some activity may lie beyond it. */
  window_overflowed: boolean;
  /** Requests the page tried to send that would have changed something, and were stopped. */
  writes_blocked: number;
  signedOut: boolean;
  dry_run: boolean;
}

/** Drop every request to a messaging endpoint that is not a plain read. Returns a counter. */
async function blockMessagingWrites(page: Page): Promise<{ count: number }> {
  const blocked = { count: 0 };
  await page.route("**/voyager/api/**", (route) => {
    const request = route.request();
    if (request.method() !== "GET" && /messag|messenger/i.test(request.url())) { blocked.count++; return route.abort(); }
    return route.continue();
  });
  return blocked;
}

// Parentheses are structure in LinkedIn's query syntax, so the ones inside a value are escaped too.
const queryValue = (raw: string) => encodeURIComponent(raw).replace(/\(/g, "%28").replace(/\)/g, "%29");

/** Ask LinkedIn for something the way the page does: a plain read, with the session's own token. */
function askAsPage(page: Page, url: string): Promise<unknown | null> {
  return page.evaluate(async (target: string): Promise<unknown | null> => {
    const session = (document.cookie.split("; ").find((c) => c.startsWith("JSESSIONID=")) ?? "").slice("JSESSIONID=".length).replace(/"/g, "");
    try {
      const r = await fetch(target, { headers: { "csrf-token": session, accept: "application/graphql", "x-restli-protocol-version": "2.0.0" }, credentials: "include" });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }, url);
}

const readThread = (page: Page, queryId: string, conversationUrn: string) =>
  askAsPage(page, `${GRAPHQL}?queryId=messengerMessages.${queryId}&variables=(conversationUrn:${queryValue(conversationUrn)})`);

/** How long to wait for the page to fetch its own list before asking for it. */
const OWN_LIST_WAIT_MS = 8_000;

/**
 * Open an ordinary signed-in page, with messaging writes blocked, and come back with the
 * account's conversation list.
 *
 * Normally the page fetches the list itself for its chat overlay and that response is
 * taken as it passes. But a page that loaded the list moments ago shows it from its own
 * cache and fetches nothing (seen on a live account, reading straight after a send). Then
 * the list is asked for the way the page would have, using the query name and mailbox the
 * page was last seen using, which are kept on the account for exactly this.
 *
 * `queryIds` is updated in place with whatever names the page is seen using.
 */
async function openInbox(page: Page, queryIds: Record<string, string>, deadline: number): Promise<{ list: unknown; blocked: { count: number } }> {
  const blocked = await blockMessagingWrites(page);
  let list: unknown = null;
  page.on("request", (request) => {
    const url = request.url();
    const seen = url.match(/queryId=(messengerConversations|messengerMessages)\.([0-9a-f]{16,})/);
    // The plain forms only: the page also has paged variants under other names.
    if (!seen || /lastUpdatedBefore|deliveredAt|countBefore/.test(url)) return;
    queryIds[seen[1]] = seen[2];
    const mailbox = seen[1] === "messengerConversations" ? decodeURIComponent(url).match(/mailboxUrn:(urn:li:fsd_profile:[A-Za-z0-9_-]+)/) : null;
    if (mailbox) queryIds.mailboxUrn = mailbox[1];
  });
  page.on("response", async (response) => {
    if (list || response.status() !== 200 || !/queryId=messengerConversations\./.test(response.url()) || /lastUpdatedBefore/.test(response.url())) return;
    try { list = await response.json(); } catch { /* the page moved on */ }
  });

  await gotoLinkedin(page, HOST_PAGE, 35_000);
  for (let waited = 0; !list && waited < OWN_LIST_WAIT_MS && Date.now() < deadline; waited += 500) await page.waitForTimeout(500);
  if (!list && queryIds.messengerConversations && queryIds.mailboxUrn) {
    list = await askAsPage(page, `${GRAPHQL}?queryId=messengerConversations.${queryIds.messengerConversations}&variables=(mailboxUrn:${queryValue(queryIds.mailboxUrn)})`);
  }
  if (!list) throw new Error("LinkedIn did not load its conversation list on this page");
  return { list, blocked };
}

/**
 * Read one account's inbox. With `dryRun` nothing is stored and nobody's campaign is
 * touched: the result says what a real read would have found.
 */
export async function syncLinkedinInbox(accountId: string, opts: { dryRun?: boolean; budgetMs?: number } = {}): Promise<InboxSyncResult> {
  const db = getDb();
  const dryRun = Boolean(opts.dryRun);
  const result: InboxSyncResult = {
    matched: 0, stored: 0, replies: [], conversations: 0, skipped: { sponsored: 0, group: 0, organisation: 0, unreadable: 0 },
    with_contacts: [], window_overflowed: false, writes_blocked: 0, signedOut: false, dry_run: dryRun,
  };
  const account = db.prepare("SELECT workspace_id, inbox_synced_through_ms, inbox_query_ids FROM accounts WHERE id = ?").get(accountId) as
    | { workspace_id: string | null; inbox_synced_through_ms: number | null; inbox_query_ids: string | null } | undefined;
  if (!account?.workspace_id) return result;
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  let queryIds: Record<string, string> = {};
  try { queryIds = JSON.parse(account.inbox_query_ids ?? "{}") as Record<string, string>; } catch { /* start again */ }

  let page: Page | null = null;
  try {
    page = await getSessionPage(accountId);
    const { list, blocked } = await openInbox(page, queryIds, deadline);
    result.writes_blocked = blocked.count;

    const parsed = parseConversations(list);
    result.conversations = parsed.conversations.length;
    result.skipped = parsed.skipped;
    result.window_overflowed = account.inbox_synced_through_ms !== null && parsed.oldestActivity !== null && parsed.oldestActivity > account.inbox_synced_through_ms
      && parsed.conversations.length + parsed.skipped.sponsored + parsed.skipped.group + parsed.skipped.organisation >= 20;

    // For a contact's conversation with something new in it, read the thread, so the
    // messages before the latest one are kept as well.
    const messagesQuery = queryIds.messengerMessages ?? MESSAGES_QUERY_SEEN_WORKING;
    const stored = db.prepare("SELECT 1 FROM linkedin_messages WHERE workspace_id = ? AND message_urn = ?");
    let threads = 0;
    for (const conversation of parsed.conversations) {
      const contactId = contactFor(db, account.workspace_id, conversation.counterpart);
      if (!contactId) continue;
      const latest = conversation.messages[conversation.messages.length - 1];
      const news = latest && !stored.get(account.workspace_id, latest.urn);
      if (news && threads < MAX_THREADS_PER_PASS && Date.now() < deadline) {
        threads++;
        // Paced like a person clicking through, not fired in a burst.
        await page.waitForTimeout(400 + Math.random() * 700);
        const thread = parseMessages(await readThread(page, messagesQuery, conversation.urn), conversation.selfUrn, conversation.urn);
        const have = new Set(conversation.messages.map((m) => m.urn));
        conversation.messages = [...conversation.messages, ...thread.filter((m) => !have.has(m.urn))].sort((a, b) => a.sentAt - b.sentAt);
      }
      const last = conversation.messages[conversation.messages.length - 1];
      result.with_contacts.push({
        contact_id: contactId, name: conversation.counterpart.name, last_activity: iso(conversation.lastActivityAt),
        latest_from: last ? (last.fromSelf ? "account" : "contact") : null, messages_read: conversation.messages.length,
      });
    }
    result.writes_blocked = blocked.count;

    if (dryRun) {
      result.matched = result.with_contacts.length;
      return result;
    }
    Object.assign(result, applyInboxPull(db, accountId, parsed.conversations));
    db.prepare("UPDATE accounts SET inbox_synced_at = datetime('now'), inbox_sync_requested_at = NULL, inbox_query_ids = ?, inbox_synced_through_ms = MAX(COALESCE(inbox_synced_through_ms, 0), ?) WHERE id = ?")
      .run(JSON.stringify(queryIds), parsed.newestActivity ?? Date.now(), accountId);
    // The page is done with; what follows is this app's own work on what it read.
    await page.close().catch(() => {});
    page = null;
    for (const reply of result.replies.filter((r) => r.fresh)) {
      // Reads the reply and acts on it: stops the contact's campaign, or holds it for an
      // away message. If it cannot, it still stops the campaign before giving up.
      try { await classifyAndDispatch(reply.replyId); }
      catch (error) { console.warn(`[inbox-sync] LinkedIn reply ${reply.replyId} was stored but could not be classified:`, error instanceof Error ? error.message : error); }
    }
    return result;
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      await markNeedsReauth(accountId);
      result.signedOut = true;
      return result;
    }
    throw error;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

export interface ThreadRead {
  signedOut: boolean;
  /** False when the account has no conversation with this contact in reach. */
  found: boolean;
  conversation_urn: string | null;
  /** Oldest first: the most recent messages of the conversation, as LinkedIn returns them. */
  messages: Array<{ direction: "in" | "out"; sent_at: string; text: string }>;
}

/**
 * Read one contact's conversation, live, and store nothing. The conversation is found in
 * what has been stored for the contact, or failing that in the account's recent list.
 */
export async function readLinkedinThread(accountId: string, contactId: string): Promise<ThreadRead> {
  const db = getDb();
  const read: ThreadRead = { signedOut: false, found: false, conversation_urn: null, messages: [] };
  const account = db.prepare("SELECT workspace_id, inbox_query_ids FROM accounts WHERE id = ?").get(accountId) as { workspace_id: string | null; inbox_query_ids: string | null } | undefined;
  if (!account?.workspace_id) return read;
  let queryIds: Record<string, string> = {};
  try { queryIds = JSON.parse(account.inbox_query_ids ?? "{}") as Record<string, string>; } catch { /* start again */ }

  let page: Page | null = null;
  try {
    page = await getSessionPage(accountId);
    const { list } = await openInbox(page, queryIds, Date.now() + 30_000);

    // The list also says who the account's owner is, which is how a message's side is told.
    const parsed = parseConversations(list);
    const inList = parsed.conversations.find((conversation) => contactFor(db, account.workspace_id!, conversation.counterpart) === contactId);
    const stored = db.prepare("SELECT conversation_urn FROM linkedin_messages WHERE target_id = ? AND account_id = ? AND conversation_urn IS NOT NULL ORDER BY sent_at DESC LIMIT 1").get(contactId, accountId) as { conversation_urn: string } | undefined;
    const urn = inList?.urn ?? stored?.conversation_urn ?? null;
    const selfUrn = inList?.selfUrn ?? parsed.conversations[0]?.selfUrn ?? null;
    if (!urn || !selfUrn) return read;
    read.found = true;
    read.conversation_urn = urn;
    const thread = parseMessages(await readThread(page, queryIds.messengerMessages ?? MESSAGES_QUERY_SEEN_WORKING, urn), selfUrn, urn);
    const messages = thread.length ? thread : inList?.messages ?? [];
    read.messages = messages.map((message) => ({ direction: message.fromSelf ? "out" : "in", sent_at: iso(message.sentAt), text: message.text }));
    return read;
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      await markNeedsReauth(accountId);
      read.signedOut = true;
      return read;
    }
    throw error;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** Is it time to read this account's inbox? Either someone asked, or the interval has passed. */
export function inboxSyncDue(db: DB, accountId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM accounts WHERE id = ? AND is_authenticated = 1 AND sync_inbox = 1
    AND (inbox_sync_requested_at IS NOT NULL OR inbox_synced_at IS NULL OR inbox_synced_at <= datetime('now', ?))`).get(accountId, `-${INBOX_SYNC_INTERVAL_MIN} minutes`);
  return Boolean(row);
}
