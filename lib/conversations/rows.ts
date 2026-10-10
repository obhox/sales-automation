// Conversation rows: making one, filing a reply under it, and keeping its "latest
// message" fields true. Everything here takes the database handle it should use and
// imports nothing that opens one, because lib/db.ts runs the backfill through this file.
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { ANSWER_DUE_HOURS, statusFrom, temperatureFrom, verdictFrom, type ConversationStatus, type Temperature } from "@/lib/conversations/vocabulary";

type DB = DatabaseType.Database;

export interface ConversationRow {
  id: string;
  workspace_id: string;
  target_id: string | null;
  address: string | null;
  status: ConversationStatus;
  snoozed_until: string | null;
  snoozed_by: string | null;
  assigned_to: string | null;
  temperature: Temperature | null;
  temperature_by: string | null;
  sla_due_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  verdict: string | null;
  last_reply_id: string | null;
  last_message_at: string | null;
  last_message_direction: "in" | "out" | null;
  last_message_channel: "email" | "linkedin" | null;
  last_message_preview: string | null;
  last_inbound_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReplyRow {
  id: string;
  workspace_id: string | null;
  target_id: string | null;
  conversation_id: string | null;
  channel: string;
  from_email: string;
  conversation_urn: string | null;
  body_text: string;
  received_at: string;
  classification_json: string | null;
  classified_at: string | null;
  assigned_to: string | null;
  inbox_status: string | null;
  sentiment: string | null;
  sla_due_at: string | null;
}

const REPLY_COLUMNS = "id, workspace_id, target_id, conversation_id, channel, from_email, conversation_urn, body_text, received_at, classification_json, classified_at, assigned_to, inbox_status, sentiment, sla_due_at";

/** Emails this app sends that are part of a conversation with a contact (not warm-up, tests or notices to the team). */
export const CORRESPONDENCE = "('campaign', 'contact_thread', 'team_inbox', 'public_api')";

/** A stored time as ISO 8601 in UTC. The database holds both that and SQLite's "YYYY-MM-DD HH:MM:SS", which is UTC too. */
export function isoOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(text);
  const ms = Date.parse(zoned || !/[ T]\d/.test(text) ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export const nowIso = () => new Date().toISOString();

let sinceCache: { db: DB; at: string | null } | null = null;

/**
 * When conversations began on this database: the moment the one-time backfill ran. Mail
 * older than this that is only being captured now (a contact's second and third messages
 * were not kept before) is history, not news. Null on a database that never had a backfill
 * to do, where nothing is older than conversations.
 */
export function conversationsSince(db: DB): string | null {
  if (sinceCache?.db === db) return sinceCache.at;
  let at: string | null = null;
  try {
    const row = db.prepare("SELECT applied_at FROM _migration_flags WHERE key = 'conversations_backfilled_at'").get() as { applied_at: string | null } | undefined;
    at = isoOf(row?.applied_at);
  } catch { /* no flags table: a database with nothing in it */ }
  sinceCache = { db, at };
  return at;
}

/** The first lines of a message, for a list: what they wrote, without the quoted chain under it. */
export function previewOf(body: string | null | undefined): string | null {
  if (!body) return null;
  const own = body.replace(/\r/g, "").split("\n").filter((line) => !line.trim().startsWith(">"));
  // "On Tue, 7 Oct, Jordan wrote:" opens the quoted chain in most mail clients.
  const cut = own.findIndex((line) => /^On .{4,80} wrote:\s*$/.test(line.trim()));
  const text = (cut > 0 ? own.slice(0, cut) : own).join(" ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : null;
}

function verdictOf(classificationJson: string | null): string | null {
  if (!classificationJson) return null;
  try { return verdictFrom((JSON.parse(classificationJson) as { kind?: unknown }).kind); } catch { return null; }
}

export function conversationById(db: DB, workspaceId: string, id: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as ConversationRow | undefined;
}

export function conversationOfTarget(db: DB, targetId: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE target_id = ?").get(targetId) as ConversationRow | undefined;
}

/**
 * The conversation with a contact, made if there is none yet.
 *
 * A new one starts from what the contact's replies already say, because until now that
 * is where a team's decisions were kept: the status of the latest reply, the last person
 * anything was assigned to, the last sentiment given, every tag any of the replies wore.
 */
export function ensureConversationForTarget(db: DB, targetId: string): { conversation: ConversationRow; created: boolean } | null {
  const existing = conversationOfTarget(db, targetId);
  if (existing) return { conversation: existing, created: false };
  const target = db.prepare("SELECT id, workspace_id, email, email_replied_at, last_replied_at FROM targets WHERE id = ?").get(targetId) as
    | { id: string; workspace_id: string | null; email: string | null; email_replied_at: string | null; last_replied_at: string | null } | undefined;
  if (!target?.workspace_id) return null;

  const replies = db.prepare(`SELECT ${REPLY_COLUMNS} FROM email_replies WHERE target_id = ? ORDER BY datetime(received_at), rowid`).all(targetId) as ReplyRow[];
  const latest = replies[replies.length - 1];
  const newestFirst = [...replies].reverse();
  const id = randomUUID();
  const started = [isoOf(replies[0]?.received_at), isoOf(target.email_replied_at), isoOf(target.last_replied_at)].filter((value): value is string => Boolean(value)).sort()[0] ?? nowIso();
  const status = statusFrom(latest?.inbox_status) ?? "open";
  db.prepare(`INSERT INTO conversations (id, workspace_id, target_id, address, status, assigned_to, temperature, sla_due_at, verdict, last_reply_id, closed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, target.workspace_id, targetId, target.email?.toLowerCase() ?? null, status,
    newestFirst.find((reply) => reply.assigned_to)?.assigned_to ?? null,
    temperatureFrom(newestFirst.find((reply) => reply.sentiment)?.sentiment),
    isoOf(latest?.sla_due_at),
    verdictOf(newestFirst.find((reply) => reply.classified_at && reply.classification_json)?.classification_json ?? null),
    latest?.id ?? null, status === "closed" ? nowIso() : null, started, nowIso(),
  );
  if (replies.length) {
    db.prepare("UPDATE email_replies SET conversation_id = ? WHERE target_id = ? AND conversation_id IS NULL").run(id, targetId);
    db.prepare(`INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id)
      SELECT ?, ert.tag_id FROM email_reply_tags ert JOIN email_replies er ON er.id = ert.reply_id WHERE er.target_id = ?`).run(id, targetId);
  }
  refreshLastMessage(db, id);
  return { conversation: conversationOfTarget(db, targetId)!, created: true };
}

/** What a reply with no contact is filed under: who sent it. */
function addressOf(reply: Pick<ReplyRow, "id" | "channel" | "from_email" | "conversation_urn">): string {
  if (reply.channel !== "linkedin" && reply.from_email) return reply.from_email.toLowerCase();
  return reply.conversation_urn ?? `reply:${reply.id}`;
}

/** The conversation for a reply whose contact is gone, made if there is none yet. */
function ensureDetachedConversation(db: DB, reply: ReplyRow): { conversation: ConversationRow; created: boolean } | null {
  if (!reply.workspace_id) return null;
  const address = addressOf(reply);
  const existing = db.prepare("SELECT * FROM conversations WHERE workspace_id = ? AND target_id IS NULL AND address = ? ORDER BY created_at LIMIT 1").get(reply.workspace_id, address) as ConversationRow | undefined;
  if (existing) return { conversation: existing, created: false };
  const id = randomUUID();
  const status = statusFrom(reply.inbox_status) ?? "open";
  db.prepare(`INSERT INTO conversations (id, workspace_id, target_id, address, status, assigned_to, temperature, sla_due_at, verdict, last_reply_id, closed_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, reply.workspace_id, address, status, reply.assigned_to, temperatureFrom(reply.sentiment), isoOf(reply.sla_due_at),
    verdictOf(reply.classified_at ? reply.classification_json : null), reply.id, status === "closed" ? nowIso() : null, isoOf(reply.received_at) ?? nowIso(), nowIso(),
  );
  db.prepare("INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) SELECT ?, tag_id FROM email_reply_tags WHERE reply_id = ?").run(id, reply.id);
  return { conversation: db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow, created: true };
}

export interface Filed {
  conversation: ConversationRow;
  /** The conversation did not exist before this reply. */
  created: boolean;
  /** The reply is newer than anything the contact had written before, in a conversation that already existed. */
  reopened: boolean;
  /** What the conversation was before this reply touched it. */
  before: ConversationRow;
}

/**
 * File a stored reply under its conversation.
 *
 * In a conversation that already exists, a message newer than the contact's last one
 * opens it again: whatever it was (snoozed, closed), somebody has to look. Who has it, how
 * warm it is and its tags are left alone. An answer becomes due if none already is.
 * Filing the same reply twice changes nothing.
 *
 * `history` is for a message that is only now being stored but is old news: it takes its
 * place in the conversation and reopens nothing.
 */
export function fileReply(db: DB, replyId: string, opts: { history?: boolean } = {}): Filed | null {
  const reply = db.prepare(`SELECT ${REPLY_COLUMNS} FROM email_replies WHERE id = ?`).get(replyId) as ReplyRow | undefined;
  if (!reply) return null;
  if (reply.conversation_id) {
    const current = db.prepare("SELECT * FROM conversations WHERE id = ?").get(reply.conversation_id) as ConversationRow | undefined;
    // Same contact (or still none): already filed. A reply whose contact has changed is filed again below.
    if (current && current.target_id === reply.target_id) return { conversation: current, created: false, reopened: false, before: current };
  }
  const found = reply.target_id ? ensureConversationForTarget(db, reply.target_id) : ensureDetachedConversation(db, reply);
  if (!found) return null;
  const before = found.conversation;
  db.prepare("UPDATE email_replies SET conversation_id = ? WHERE id = ?").run(before.id, reply.id);
  if (reply.conversation_id && reply.conversation_id !== before.id) removeIfEmpty(db, reply.conversation_id);

  const receivedAt = isoOf(reply.received_at);
  const reopened = !found.created && !opts.history && Boolean(receivedAt) && (!before.last_inbound_at || receivedAt! > before.last_inbound_at);
  if (reopened) {
    db.prepare(`UPDATE conversations SET status = 'open', snoozed_until = NULL, snoozed_by = NULL, closed_at = NULL,
      sla_due_at = COALESCE(sla_due_at, ?), updated_at = ? WHERE id = ?`).run(new Date(Date.now() + ANSWER_DUE_HOURS * 3_600_000).toISOString(), nowIso(), before.id);
  }
  refreshLastMessage(db, before.id);
  return { conversation: db.prepare("SELECT * FROM conversations WHERE id = ?").get(before.id) as ConversationRow, created: found.created, reopened, before };
}

/** A conversation with no contact and no replies left is nothing; remove it. */
export function removeIfEmpty(db: DB, conversationId: string): void {
  db.prepare("DELETE FROM conversations WHERE id = ? AND target_id IS NULL AND NOT EXISTS (SELECT 1 FROM email_replies WHERE conversation_id = conversations.id)").run(conversationId);
}

/**
 * Replies that have just been given a contact (their own was deleted and has been made
 * again, or a person chose one) move to that contact's conversation. When the contact has
 * none and every reply in the old conversation is moving, the old conversation simply
 * becomes the contact's, keeping who had it and its tags.
 */
export function refileReplies(db: DB, replyIds: string[]): void {
  for (const replyId of replyIds) {
    const reply = db.prepare("SELECT id, target_id, conversation_id FROM email_replies WHERE id = ?").get(replyId) as { id: string; target_id: string | null; conversation_id: string | null } | undefined;
    if (!reply?.target_id) continue;
    const old = reply.conversation_id ? db.prepare("SELECT * FROM conversations WHERE id = ?").get(reply.conversation_id) as ConversationRow | undefined : undefined;
    if (old?.target_id === reply.target_id) continue;
    if (old && old.target_id === null && !conversationOfTarget(db, reply.target_id)
      && !db.prepare("SELECT 1 FROM email_replies WHERE conversation_id = ? AND target_id IS NOT ?").get(old.id, reply.target_id)) {
      const email = db.prepare("SELECT email FROM targets WHERE id = ?").get(reply.target_id) as { email: string | null } | undefined;
      db.prepare("UPDATE conversations SET target_id = ?, address = COALESCE(?, address), updated_at = ? WHERE id = ?").run(reply.target_id, email?.email?.toLowerCase() ?? null, nowIso(), old.id);
      refreshLastMessage(db, old.id);
      continue;
    }
    fileReply(db, reply.id);
    if (old) {
      // What the team had decided about it comes along, where the contact's own conversation says nothing.
      const now = conversationOfTarget(db, reply.target_id);
      if (now) {
        db.prepare("UPDATE conversations SET assigned_to = COALESCE(assigned_to, ?), temperature = COALESCE(temperature, ?) WHERE id = ?").run(old.assigned_to, old.temperature, now.id);
        db.prepare("INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) SELECT ?, tag_id FROM conversation_tags WHERE conversation_id = ?").run(now.id, old.id);
      }
      removeIfEmpty(db, old.id);
    }
  }
}

export interface SentEmailRow {
  id: string; source: string; subject: string; body_text: string; status: string; last_error: string | null; run_id: string | null; step_id: string | null;
  email_account_id: string; created_at: string; sent_message_id: string | null; accepted_at: string | null; bounced_at: string | null;
}

/**
 * The emails this app has sent a contact, newest first: campaign steps and what people
 * wrote by hand. One sent without naming the contact (an answer from the old inbox, the
 * public API) is found by the address it went to. From the inbox and the contact page,
 * one that has not gone (still queued, or failed) is included, so it is seen where it was written.
 */
export function sentEmailsOf(db: DB, workspaceId: string, targetId: string, email: string | null, limit = 200): SentEmailRow[] {
  const columns = `j.id, j.source, j.subject, j.body_text, j.status, j.last_error, j.run_id, j.step_id, j.email_account_id, j.created_at,
    sm.id AS sent_message_id, sm.accepted_at, sm.bounced_at`;
  const shown = `j.source IN ${CORRESPONDENCE} AND (j.status = 'sent' OR (j.source != 'campaign' AND j.status IN ('failed', 'uncertain', 'pending', 'leased', 'sending')))`;
  const rows = db.prepare(`SELECT ${columns} FROM email_jobs j LEFT JOIN sent_messages sm ON sm.job_id = j.id
    WHERE j.target_id = ? AND j.workspace_id = ? AND ${shown} ORDER BY j.created_at DESC LIMIT ?`).all(targetId, workspaceId, limit) as SentEmailRow[];
  if (email) {
    rows.push(...db.prepare(`SELECT ${columns} FROM email_jobs j LEFT JOIN sent_messages sm ON sm.job_id = j.id
      WHERE j.workspace_id = ? AND j.recipient = ? AND j.target_id IS NULL AND ${shown} ORDER BY j.created_at DESC LIMIT ?`).all(workspaceId, email.toLowerCase().trim(), limit) as SentEmailRow[]);
  }
  const when = (row: SentEmailRow) => isoOf(row.accepted_at ?? row.created_at) ?? "";
  return rows.sort((a, b) => when(b).localeCompare(when(a))).slice(0, limit);
}

interface Latest { at: string; direction: "in" | "out"; channel: "email" | "linkedin"; body: string | null }

/**
 * Work out a conversation's latest message from what is stored (replies, LinkedIn
 * messages both ways, emails this app sent) and write it down. Called after anything
 * that stores a message, so the list never has to work it out row by row.
 */
export function refreshLastMessage(db: DB, conversationId: string): void {
  const conversation = db.prepare("SELECT id, workspace_id, target_id FROM conversations WHERE id = ?").get(conversationId) as { id: string; workspace_id: string; target_id: string | null } | undefined;
  if (!conversation) return;
  const found: Latest[] = [];
  const push = (at: string | null | undefined, direction: Latest["direction"], channel: Latest["channel"], body: string | null) => {
    const iso = isoOf(at);
    if (iso) found.push({ at: iso, direction, channel, body });
  };

  const reply = db.prepare("SELECT id, channel, body_text, received_at FROM email_replies WHERE conversation_id = ? ORDER BY datetime(received_at) DESC, rowid DESC LIMIT 1").get(conversationId) as
    | { id: string; channel: string; body_text: string; received_at: string } | undefined;
  if (reply) push(reply.received_at, "in", reply.channel === "linkedin" ? "linkedin" : "email", reply.body_text);

  if (conversation.target_id) {
    const target = db.prepare("SELECT email, email_replied_at, last_replied_at FROM targets WHERE id = ?").get(conversation.target_id) as { email: string | null; email_replied_at: string | null; last_replied_at: string | null } | undefined;
    for (const direction of ["in", "out"] as const) {
      const message = db.prepare("SELECT body, sent_at FROM linkedin_messages WHERE target_id = ? AND direction = ? AND status = 'delivered' ORDER BY datetime(sent_at) DESC, rowid DESC LIMIT 1").get(conversation.target_id, direction) as { body: string; sent_at: string } | undefined;
      if (message) push(message.sent_at, direction, "linkedin", message.body);
    }
    for (const sent of sentEmailsOf(db, conversation.workspace_id, conversation.target_id, target?.email ?? null, 5)) {
      if (sent.status === "sent") { push(sent.accepted_at ?? sent.created_at, "out", "email", sent.body_text); break; }
    }
    // A contact known to have answered with no message on record: marked by hand, or
    // noticed by a campaign when it went to write to them.
    if (!found.some((item) => item.direction === "in")) {
      push(target?.email_replied_at, "in", "email", null);
      push(target?.last_replied_at, "in", "linkedin", null);
    }
  }

  found.sort((a, b) => a.at.localeCompare(b.at));
  const last = found[found.length - 1];
  const lastIn = [...found].reverse().find((item) => item.direction === "in");
  db.prepare(`UPDATE conversations SET last_message_at = ?, last_message_direction = ?, last_message_channel = ?, last_message_preview = ?,
    last_inbound_at = ?, last_reply_id = COALESCE(?, last_reply_id), updated_at = ? WHERE id = ?`).run(
    last?.at ?? null, last?.direction ?? null, last?.channel ?? null, previewOf(last?.body), lastIn?.at ?? null, reply?.id ?? null, nowIso(), conversationId,
  );
}

/** Refresh the latest-message fields of a contact's conversation, if they have one. */
export function refreshForTarget(db: DB, targetId: string | null | undefined): ConversationRow | undefined {
  if (!targetId) return undefined;
  const conversation = conversationOfTarget(db, targetId);
  if (conversation) refreshLastMessage(db, conversation.id);
  return conversation;
}
