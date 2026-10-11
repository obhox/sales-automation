// What a team does to a conversation: who has it, where it stands, when an answer is due,
// what it is filed under, who has read it, and what somebody has typed and not sent.
//
// Every function takes the database handle. The routes and the MCP tools go through
// these, so a rule (a later message reopens, an answer clears the due time) is written once.
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { notify } from "@/lib/platform/notifications";
import { reconcileConversations } from "@/lib/conversations/reconcile";
import { conversationById, conversationOfTarget, ensureConversationForTarget, fileReply, isoOf, nowIso, refreshLastMessage, type ConversationRow, type Filed } from "@/lib/conversations/rows";
import { ANSWER_DUE_HOURS, LOCK_MINUTES, temperatureForVerdict, verdictFrom, type ConversationStatus, type Temperature } from "@/lib/conversations/vocabulary";

type DB = DatabaseType.Database;

const touch = (db: DB, id: string) => db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(nowIso(), id);
const contactName = (db: DB, conversation: Pick<ConversationRow, "target_id" | "address">) =>
  (conversation.target_id ? (db.prepare("SELECT COALESCE(NULLIF(full_name, ''), email) AS name FROM targets WHERE id = ?").get(conversation.target_id) as { name: string | null } | undefined)?.name : null)
  ?? conversation.address ?? "A contact";

// ── Finding one ─────────────────────────────────────────────────────────────────────────

/**
 * The conversation something belongs to: named outright, or by one of its replies, or by
 * its contact. A reply not yet filed is filed on the way, so a reply stored a moment ago
 * (or before conversations existed) can be acted on by its id as it always could.
 */
export function findConversation(db: DB, workspaceId: string, ref: { conversationId?: string | null; replyId?: string | null; targetId?: string | null }): ConversationRow | null {
  if (ref.conversationId) return conversationById(db, workspaceId, ref.conversationId) ?? null;
  if (ref.replyId) {
    const reply = db.prepare("SELECT id, conversation_id FROM email_replies WHERE id = ? AND workspace_id = ?").get(ref.replyId, workspaceId) as { id: string; conversation_id: string | null } | undefined;
    if (!reply) return null;
    const id = reply.conversation_id ?? fileReply(db, reply.id)?.conversation.id;
    return id ? conversationById(db, workspaceId, id) ?? null : null;
  }
  if (ref.targetId) {
    const conversation = conversationOfTarget(db, ref.targetId);
    return conversation && conversation.workspace_id === workspaceId ? conversation : null;
  }
  return null;
}

// ── Keeping the set of conversations true ───────────────────────────────────────────────

const settledAt = new Map<string, number>();
const SETTLE_EVERY_MS = 30_000;

/**
 * Two things that are true by the clock or by other code's doing, brought up to date:
 * snoozed conversations whose time has come open again, and anything stored without a
 * conversation gets one. Asked for by the inbox every time and by the sidebar's count at
 * most twice a minute, so it has to cost nothing when there is nothing to do.
 */
export function settleConversations(db: DB, workspaceId: string, opts: { force?: boolean } = {}): void {
  const last = settledAt.get(workspaceId) ?? 0;
  if (!opts.force && Date.now() - last < SETTLE_EVERY_MS) return;
  settledAt.set(workspaceId, Date.now());
  wakeSnoozed(db, workspaceId);
  reconcileConversations(db, workspaceId);
}

/** Open every snoozed conversation whose time has come. Returns how many. */
export function wakeSnoozed(db: DB, workspaceId?: string, now: string = nowIso()): number {
  const due = db.prepare(`SELECT * FROM conversations WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ? ${workspaceId ? "AND workspace_id = ?" : ""}`)
    .all(...(workspaceId ? [now, workspaceId] : [now])) as ConversationRow[];
  for (const conversation of due) {
    db.prepare("UPDATE conversations SET status = 'open', snoozed_until = NULL, snoozed_by = NULL, updated_at = ? WHERE id = ? AND status = 'snoozed'").run(nowIso(), conversation.id);
    // It comes back as something to look at, for everyone, not as something already seen.
    db.prepare("DELETE FROM conversation_reads WHERE conversation_id = ?").run(conversation.id);
    const who = conversation.snoozed_by ?? conversation.assigned_to;
    notify({
      workspaceId: conversation.workspace_id, kind: "conversation.reopened", title: `${contactName(db, conversation)} is back in the inbox`,
      body: "The snooze you set has ended.", link: `/inbox?c=${conversation.id}`, dedupeKey: `conversation-woke:${conversation.id}:${conversation.snoozed_until}`,
      ...(who ? { userId: who } : {}),
    }, db);
  }
  return due.length;
}

// ── A message arrives, a verdict is given, an answer goes ───────────────────────────────

/**
 * File a stored reply and tell whoever has the conversation that the contact wrote
 * again. The first reply from a contact is announced by the classifier (a positive one
 * goes to the whole workspace); this is for the ones after it.
 */
export function receiveReply(db: DB, replyId: string, opts: { history?: boolean } = {}): Filed | null {
  const filed = fileReply(db, replyId, opts);
  if (filed?.reopened && filed.conversation.assigned_to) {
    notify({
      workspaceId: filed.conversation.workspace_id, kind: "conversation.reply", userId: filed.conversation.assigned_to,
      title: `${contactName(db, filed.conversation)} wrote again`, body: filed.conversation.last_message_preview ?? undefined,
      link: `/inbox?c=${filed.conversation.id}`, dedupeKey: `conversation-reply:${replyId}`,
    }, db);
  }
  return filed;
}

/**
 * Has an earlier reply already settled this contact's campaigns? If so a new message is a
 * later one in the same conversation: it is kept, it reopens the conversation, and nothing
 * is unenrolled, scheduled or announced a second time. An out-of-office reply settles
 * nothing (the campaign was only held), so the reply after it is still the first.
 */
export function isLaterMessage(db: DB, targetId: string, replyId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM email_replies WHERE target_id = ? AND id != ? AND dispatched_at IS NOT NULL
    AND COALESCE(json_extract(dispatch_result_json, '$.action'), '') != 'rescheduled' LIMIT 1`).get(targetId, replyId));
}

/** Recompute the conversation's verdict: the one on the latest of its replies that has one. */
function refreshVerdict(db: DB, conversationId: string): string | null {
  const row = db.prepare(`SELECT classification_json FROM email_replies WHERE conversation_id = ? AND classified_at IS NOT NULL AND classification_json IS NOT NULL
    ORDER BY datetime(received_at) DESC, rowid DESC LIMIT 1`).get(conversationId) as { classification_json: string } | undefined;
  let verdict: string | null = null;
  try { verdict = row ? verdictFrom((JSON.parse(row.classification_json) as { kind?: unknown }).kind) : null; } catch { /* unreadable: no verdict */ }
  db.prepare("UPDATE conversations SET verdict = ? WHERE id = ?").run(verdict, conversationId);
  return verdict;
}

/**
 * A reply has been given a verdict (or had it corrected). The conversation takes it: its
 * temperature follows unless a person set one by hand, and an answer becomes due if the
 * contact is the one waiting and no time is set yet.
 */
export function noteClassified(db: DB, replyId: string): void {
  const filed = fileReply(db, replyId);
  if (!filed) return;
  const conversation = filed.conversation;
  const verdict = refreshVerdict(db, conversation.id);
  if (!conversation.temperature_by) {
    const temperature = temperatureForVerdict(verdict);
    if (temperature) db.prepare("UPDATE conversations SET temperature = ? WHERE id = ?").run(temperature, conversation.id);
  }
  if (!conversation.sla_due_at && conversation.status === "open" && conversation.last_message_direction !== "out") {
    db.prepare("UPDATE conversations SET sla_due_at = ? WHERE id = ?").run(new Date(Date.now() + ANSWER_DUE_HOURS * 3_600_000).toISOString(), conversation.id);
  }
  touch(db, conversation.id);
}

/** The verdict on a reply was wiped (before classifying it again): the conversation's follows. */
export function noteVerdictCleared(db: DB, replyId: string): void {
  const reply = db.prepare("SELECT conversation_id FROM email_replies WHERE id = ?").get(replyId) as { conversation_id: string | null } | undefined;
  if (reply?.conversation_id) refreshVerdict(db, reply.conversation_id);
}

/**
 * Something was sent to (or stored for) a contact: bring their conversation's latest
 * message up to date. When a person answered, the answer that was due is no longer due
 * and their lock on the conversation is let go; with `close` it is closed as well.
 */
export function noteOutbound(db: DB, targetId: string | null | undefined, opts: { answeredBy?: string | null; close?: boolean } = {}): ConversationRow | null {
  if (!targetId) return null;
  const conversation = conversationOfTarget(db, targetId);
  if (!conversation) return null;
  refreshLastMessage(db, conversation.id);
  if (opts.answeredBy !== undefined) {
    db.prepare("UPDATE conversations SET sla_due_at = NULL, locked_by = CASE WHEN locked_by IS ? THEN NULL ELSE locked_by END, locked_at = CASE WHEN locked_by IS ? THEN NULL ELSE locked_at END, updated_at = ? WHERE id = ?")
      .run(opts.answeredBy, opts.answeredBy, nowIso(), conversation.id);
    if (opts.answeredBy) markRead(db, conversation.id, opts.answeredBy);
  }
  if (opts.close) setStatus(db, conversation, "closed", { userId: opts.answeredBy ?? null });
  return conversationById(db, conversation.workspace_id, conversation.id) ?? null;
}

/**
 * Keep a LinkedIn message a campaign has just sent: a message step, an InMail, or the
 * note on a connection request. Until now these were only known once the account's inbox
 * was next read, and an InMail or a note never was. When the inbox read does meet the
 * message, it recognises this row by its words and gives it LinkedIn's id rather than
 * storing a second copy (lib/linkedin/inbox-sync.ts).
 *
 * Never throws: a campaign step that went through must not fail over its own record.
 */
export function storeCampaignMessage(db: DB, sent: { workspaceId: string | null | undefined; accountId: string; targetId: string; text: string; runId?: string | null; stepId?: string | null; kind?: "message" | "inmail" | "note"; subject?: string | null }): void {
  try {
    const body = sent.text.replace(/\r\n?/g, "\n").trim();
    if (!sent.workspaceId || !body) return;
    db.prepare(`INSERT INTO linkedin_messages (id, workspace_id, account_id, target_id, direction, body, sent_at, status, created_by, run_id, step_id, kind, subject)
      VALUES (?, ?, ?, ?, 'out', ?, ?, 'delivered', NULL, ?, ?, ?, ?)`).run(randomUUID(), sent.workspaceId, sent.accountId, sent.targetId, body, nowIso(), sent.runId ?? null, sent.stepId ?? null, sent.kind ?? "message", sent.subject?.trim() || null);
    noteOutbound(db, sent.targetId);
  } catch (error) {
    console.warn("[conversations] a campaign's LinkedIn message was sent but could not be stored:", error instanceof Error ? error.message : error);
  }
}

/** A contact was marked as having replied, with no message to store. They get a conversation so a person can pick it up. */
export function noteMarkedReplied(db: DB, targetId: string): ConversationRow | null {
  const found = ensureConversationForTarget(db, targetId);
  if (!found) return null;
  if (!found.created) refreshLastMessage(db, found.conversation.id);
  return conversationOfTarget(db, targetId) ?? null;
}

// ── Triage ──────────────────────────────────────────────────────────────────────────────

/**
 * Open, snooze or close. A snooze takes the time it ends (`until`); without one the
 * conversation waits until the contact next writes. Closing or snoozing clears the answer
 * that was due: the team has said it is dealt with, or is to wait.
 */
export function setStatus(db: DB, conversation: Pick<ConversationRow, "id">, status: ConversationStatus, opts: { until?: string | null; userId?: string | null } = {}): void {
  const until = status === "snoozed" ? isoOf(opts.until ?? null) : null;
  db.prepare(`UPDATE conversations SET status = ?, snoozed_until = ?, snoozed_by = ?, closed_at = ?,
    sla_due_at = CASE WHEN ? IN ('closed', 'snoozed') THEN NULL ELSE sla_due_at END, updated_at = ? WHERE id = ?`)
    .run(status, until, status === "snoozed" ? opts.userId ?? null : null, status === "closed" ? nowIso() : null, status, nowIso(), conversation.id);
}

export function assignConversation(db: DB, conversation: ConversationRow, assignee: string | null, by?: string | null): void {
  db.prepare("UPDATE conversations SET assigned_to = ?, updated_at = ? WHERE id = ?").run(assignee, nowIso(), conversation.id);
  if (assignee && assignee !== by && assignee !== conversation.assigned_to) {
    notify({
      workspaceId: conversation.workspace_id, kind: "conversation.assigned", userId: assignee, title: `${contactName(db, conversation)}'s conversation was assigned to you`,
      body: conversation.last_message_preview ?? undefined, link: `/inbox?c=${conversation.id}`, dedupeKey: `conversation-assigned:${conversation.id}:${assignee}:${nowIso().slice(0, 13)}`,
    }, db);
  }
}

/** Set how warm it is by hand. Null hands it back to the verdict, which sets it the next time one is given. */
export function setTemperature(db: DB, conversation: Pick<ConversationRow, "id">, temperature: Temperature | null, by: string | null): void {
  db.prepare("UPDATE conversations SET temperature = ?, temperature_by = ?, updated_at = ? WHERE id = ?").run(temperature, temperature ? by ?? "someone" : null, nowIso(), conversation.id);
}

export function setAnswerDue(db: DB, conversation: Pick<ConversationRow, "id">, dueAt: string | null): void {
  db.prepare("UPDATE conversations SET sla_due_at = ?, updated_at = ? WHERE id = ?").run(dueAt ? isoOf(dueAt) : null, nowIso(), conversation.id);
}

/** Who is answering right now, if their lock still holds. */
export function lockHolder(conversation: Pick<ConversationRow, "locked_by" | "locked_at">, now = Date.now()): { userId: string; at: string } | null {
  if (!conversation.locked_by || !conversation.locked_at) return null;
  const at = Date.parse(isoOf(conversation.locked_at) ?? "");
  return Number.isFinite(at) && now - at < LOCK_MINUTES * 60_000 ? { userId: conversation.locked_by, at: conversation.locked_at } : null;
}

/** Take (or renew) the lock. False when a teammate holds it. */
export function lockConversation(db: DB, conversation: ConversationRow, userId: string): boolean {
  const held = lockHolder(conversation);
  if (held && held.userId !== userId) return false;
  db.prepare("UPDATE conversations SET locked_by = ?, locked_at = ? WHERE id = ?").run(userId, nowIso(), conversation.id);
  return true;
}

/** Let go of the lock: your own, or anyone's for an admin. */
export function unlockConversation(db: DB, conversation: ConversationRow, userId: string | null, role: string): void {
  if (conversation.locked_by === userId || role === "admin" || role === "owner") db.prepare("UPDATE conversations SET locked_by = NULL, locked_at = NULL WHERE id = ?").run(conversation.id);
}

export function tagConversation(db: DB, conversationId: string, tagId: string): void {
  db.prepare("INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)").run(conversationId, tagId);
  touch(db, conversationId);
}

export function untagConversation(db: DB, conversationId: string, tagId: string): void {
  db.prepare("DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?").run(conversationId, tagId);
  touch(db, conversationId);
}

// ── Read state, per member ──────────────────────────────────────────────────────────────

/** SQL for "this member has not read the contact's latest message", for a conversation aliased `c`. Takes the member's id once. */
export const UNREAD_SQL = `(c.status = 'open' AND c.last_inbound_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversation_reads cr WHERE cr.conversation_id = c.id AND cr.user_id = ? AND cr.read_at >= c.last_inbound_at))`;

export function markRead(db: DB, conversationId: string, userId: string): void {
  db.prepare(`INSERT INTO conversation_reads (conversation_id, user_id, read_at) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET read_at = excluded.read_at`).run(conversationId, userId, nowIso());
}

export function markUnread(db: DB, conversationId: string, userId: string): void {
  db.prepare("DELETE FROM conversation_reads WHERE conversation_id = ? AND user_id = ?").run(conversationId, userId);
}

/** Mark every open conversation in the workspace (or just the ones named) as read by this member. Returns how many were unread. */
export function markAllRead(db: DB, workspaceId: string, userId: string, conversationIds?: string[]): number {
  const named = conversationIds?.length ? `AND c.id IN (${conversationIds.map(() => "?").join(",")})` : "";
  const unread = db.prepare(`SELECT c.id FROM conversations c WHERE c.workspace_id = ? AND ${UNREAD_SQL} ${named}`).all(workspaceId, userId, ...(conversationIds ?? [])) as Array<{ id: string }>;
  db.transaction(() => { for (const row of unread) markRead(db, row.id, userId); })();
  return unread.length;
}

export function unreadCount(db: DB, workspaceId: string, userId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM conversations c WHERE c.workspace_id = ? AND ${UNREAD_SQL}`).get(workspaceId, userId) as { c: number }).c;
}

// ── Drafts ──────────────────────────────────────────────────────────────────────────────

export interface DraftRow { conversation_id: string; user_id: string; channel: "email" | "linkedin"; subject: string | null; body: string; email_account_id: string | null; linkedin_account_id: string | null; updated_at: string }

export function getDraft(db: DB, conversationId: string, userId: string): DraftRow | null {
  return (db.prepare("SELECT * FROM conversation_drafts WHERE conversation_id = ? AND user_id = ?").get(conversationId, userId) as DraftRow | undefined) ?? null;
}

/** Keep what a member has typed. An empty draft with no files attached is removed instead of kept. */
export function saveDraft(db: DB, conversationId: string, userId: string, draft: { channel: "email" | "linkedin"; subject?: string | null; body: string; email_account_id?: string | null; linkedin_account_id?: string | null }): DraftRow | null {
  const hasFiles = db.prepare("SELECT 1 FROM conversation_attachments WHERE conversation_id = ? AND draft_user_id = ? LIMIT 1").get(conversationId, userId);
  if (!draft.body.trim() && !draft.subject?.trim() && !hasFiles) {
    db.prepare("DELETE FROM conversation_drafts WHERE conversation_id = ? AND user_id = ?").run(conversationId, userId);
    return null;
  }
  db.prepare(`INSERT INTO conversation_drafts (conversation_id, user_id, channel, subject, body, email_account_id, linkedin_account_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET channel = excluded.channel, subject = excluded.subject, body = excluded.body,
      email_account_id = excluded.email_account_id, linkedin_account_id = excluded.linkedin_account_id, updated_at = excluded.updated_at`)
    .run(conversationId, userId, draft.channel, draft.subject?.trim() || null, draft.body, draft.email_account_id ?? null, draft.linkedin_account_id ?? null, nowIso());
  return getDraft(db, conversationId, userId);
}

/** Throw a draft away, with any files added to it that were never sent. */
export function clearDraft(db: DB, conversationId: string, userId: string): void {
  db.prepare("DELETE FROM conversation_drafts WHERE conversation_id = ? AND user_id = ?").run(conversationId, userId);
  db.prepare("DELETE FROM conversation_attachments WHERE conversation_id = ? AND draft_user_id = ?").run(conversationId, userId);
}

// ── Attachments ─────────────────────────────────────────────────────────────────────────

/** The largest single file kept, and the most that goes out with one email. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE_BYTES = 20 * 1024 * 1024;

export interface AttachmentInfo { id: string; filename: string; content_type: string; size_bytes: number; kept: boolean }

const ATTACHMENT_INFO = "id, filename, content_type, size_bytes, content IS NOT NULL AS kept";
const asInfo = (row: Omit<AttachmentInfo, "kept"> & { kept: number }): AttachmentInfo => ({ ...row, kept: Boolean(row.kept) });

/** A file name safe to show and to offer as a download: no path, no control characters. */
export function safeFilename(name: string | null | undefined): string {
  const base = (name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop()?.trim() ?? "";
  return (base || "attachment").slice(0, 180);
}

/** Add a file to a member's draft. Throws with a plain reason when it cannot be taken. */
export function addDraftAttachment(db: DB, conversation: Pick<ConversationRow, "id" | "workspace_id">, userId: string, file: { filename: string; contentType: string; content: Buffer }): AttachmentInfo {
  if (file.content.length === 0) throw new Error("That file is empty");
  if (file.content.length > ATTACHMENT_MAX_BYTES) throw new Error(`A file can be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
  const already = (db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM conversation_attachments WHERE conversation_id = ? AND draft_user_id = ?").get(conversation.id, userId) as { total: number }).total;
  if (already + file.content.length > ATTACHMENTS_PER_MESSAGE_BYTES) throw new Error(`The files on one email can add up to at most ${ATTACHMENTS_PER_MESSAGE_BYTES / 1024 / 1024} MB`);
  const id = randomUUID();
  db.prepare(`INSERT INTO conversation_attachments (id, workspace_id, conversation_id, draft_user_id, filename, content_type, size_bytes, content, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, conversation.workspace_id, conversation.id, userId, safeFilename(file.filename), file.contentType || "application/octet-stream", file.content.length, file.content, userId);
  return asInfo(db.prepare(`SELECT ${ATTACHMENT_INFO} FROM conversation_attachments WHERE id = ?`).get(id) as Omit<AttachmentInfo, "kept"> & { kept: number });
}

export function draftAttachments(db: DB, conversationId: string, userId: string): AttachmentInfo[] {
  return (db.prepare(`SELECT ${ATTACHMENT_INFO} FROM conversation_attachments WHERE conversation_id = ? AND draft_user_id = ? ORDER BY created_at, rowid`).all(conversationId, userId) as Array<Omit<AttachmentInfo, "kept"> & { kept: number }>).map(asInfo);
}

export function removeDraftAttachment(db: DB, workspaceId: string, attachmentId: string, userId: string): boolean {
  return db.prepare("DELETE FROM conversation_attachments WHERE id = ? AND workspace_id = ? AND draft_user_id = ?").run(attachmentId, workspaceId, userId).changes > 0;
}

/** The files on a member's draft now belong to the email that carried them. */
export function moveDraftAttachmentsToJob(db: DB, conversationId: string, userId: string, emailJobId: string): void {
  db.prepare("UPDATE conversation_attachments SET email_job_id = ?, draft_user_id = NULL WHERE conversation_id = ? AND draft_user_id = ?").run(emailJobId, conversationId, userId);
}

/** Keep the files that came with a reply. One too large to keep is recorded by name and size only. */
export function storeReplyAttachments(db: DB, reply: { id: string; workspaceId: string }, files: Array<{ filename?: string | null; contentType?: string | null; content: Buffer; size?: number }>): number {
  const insert = db.prepare(`INSERT INTO conversation_attachments (id, workspace_id, conversation_id, reply_id, filename, content_type, size_bytes, content)
    VALUES (?, ?, (SELECT conversation_id FROM email_replies WHERE id = ?), ?, ?, ?, ?, ?)`);
  let kept = 0;
  for (const file of files.slice(0, 20)) {
    const size = file.content?.length ?? file.size ?? 0;
    const keep = size > 0 && size <= ATTACHMENT_MAX_BYTES;
    insert.run(randomUUID(), reply.workspaceId, reply.id, reply.id, safeFilename(file.filename), file.contentType || "application/octet-stream", size, keep ? file.content : null);
    if (keep) kept++;
  }
  return kept;
}

/** One file with its bytes, for a download. Null when it is not this workspace's, or was not kept. */
export function readAttachment(db: DB, workspaceId: string, attachmentId: string): { filename: string; content_type: string; content: Buffer } | null {
  const row = db.prepare("SELECT filename, content_type, content FROM conversation_attachments WHERE id = ? AND workspace_id = ?").get(attachmentId, workspaceId) as { filename: string; content_type: string; content: Buffer | null } | undefined;
  return row?.content ? { filename: row.filename, content_type: row.content_type, content: row.content } : null;
}

/** The files that go out with an email job, for the sender. */
export function jobAttachments(db: DB, emailJobId: string): Array<{ filename: string; contentType: string; content: Buffer }> {
  return (db.prepare("SELECT filename, content_type, content FROM conversation_attachments WHERE email_job_id = ? AND content IS NOT NULL ORDER BY created_at, rowid").all(emailJobId) as Array<{ filename: string; content_type: string; content: Buffer }>)
    .map((row) => ({ filename: row.filename, contentType: row.content_type, content: row.content }));
}
