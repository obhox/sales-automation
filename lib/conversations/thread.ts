// A conversation as a person reads it: every message with a contact, both ways and on
// both channels, oldest first, from what is stored. Nothing here opens a mailbox or a
// LinkedIn session; what was not stored is not shown.
import type DatabaseType from "better-sqlite3";
import { isoOf, sentEmailsOf, type ConversationRow } from "@/lib/conversations/rows";
import type { AttachmentInfo } from "@/lib/conversations/store";

type DB = DatabaseType.Database;

export interface ThreadReply {
  id: string;
  verdict: string | null;
  summary: string | null;
  confidence: number | null;
  suggested_action: string | null;
  classified_at: string | null;
  classification_error: string | null;
  /** What was done about it: unenrolled, a task made, a follow-up put back, and so on. */
  dispatch: Record<string, unknown> | null;
  /** It arrived after an earlier reply had settled the contact's campaigns. */
  later: boolean;
}

export interface ThreadMessage {
  /** Stable across reads: "reply:…", "email:…", "linkedin:…" or "mark:…". */
  id: string;
  source: "reply" | "sent_email" | "linkedin" | "marker";
  channel: "email" | "linkedin";
  direction: "in" | "out";
  at: string;
  subject: string | null;
  body: string;
  status: "delivered" | "queued" | "sending" | "failed" | "uncertain";
  error: string | null;
  /** Who it is from: the contact, or the mailbox or LinkedIn account it went out as. */
  author: { kind: "contact" | "mailbox" | "linkedin_account"; name: string | null; via: string | null };
  /** The campaign step that sent it, when one did. */
  campaign: { workflow_id: string; name: string; step: number | null; steps: number | null } | null;
  /** Opens by a person (not a scanner), for an email that was tracked. */
  opens: number | null;
  reply: ThreadReply | null;
  attachments: AttachmentInfo[];
  /** A LinkedIn message somebody typed here; while it has not gone it can be sent again or discarded by this id. */
  linkedin_message_id: string | null;
  sent_here: boolean;
  /** 'message', 'inmail' or 'note' for LinkedIn. */
  kind: string | null;
}

interface ReplyRecord {
  id: string; channel: string; from_email: string; subject: string | null; body_text: string; received_at: string; external_id: string | null;
  classified_at: string | null; classification_json: string | null; classification_error: string | null; dispatch_result_json: string | null; later: number;
  email_account_id: string | null;
}

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try { return JSON.parse(json) as T; } catch { return null; }
}

function replyInfo(row: ReplyRecord): ThreadReply {
  const verdict = parse<{ kind?: string; summary?: string; confidence?: number; suggested_action?: string }>(row.classification_json);
  return {
    id: row.id, verdict: verdict?.kind ?? null, summary: verdict?.summary ?? null,
    confidence: typeof verdict?.confidence === "number" ? verdict.confidence : null, suggested_action: verdict?.suggested_action ?? null,
    classified_at: row.classified_at, classification_error: row.classification_error, dispatch: parse<Record<string, unknown>>(row.dispatch_result_json), later: row.later === 1,
  };
}

/** Where a step sits among the steps of its track that do something (waits are not counted). */
function stepPlace(db: DB, stepId: string | null): { workflow_id: string; step: number; steps: number } | null {
  if (!stepId) return null;
  const step = db.prepare("SELECT workflow_id, track, step_order FROM workflow_steps WHERE id = ?").get(stepId) as { workflow_id: string; track: string; step_order: number } | undefined;
  if (!step) return null;
  const counts = db.prepare(`SELECT COUNT(*) AS steps, SUM(CASE WHEN step_order <= ? THEN 1 ELSE 0 END) AS step FROM workflow_steps
    WHERE workflow_id = ? AND track = ? AND step_type != 'delay'`).get(step.step_order, step.workflow_id, step.track) as { steps: number; step: number | null };
  return { workflow_id: step.workflow_id, step: counts.step ?? 1, steps: counts.steps };
}

/** Every message stored for a conversation, oldest first. */
export function readThread(db: DB, conversation: Pick<ConversationRow, "id" | "workspace_id" | "target_id" | "address">): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  const target = conversation.target_id
    ? db.prepare("SELECT id, full_name, email, email_replied_at, last_replied_at FROM targets WHERE id = ?").get(conversation.target_id) as { id: string; full_name: string | null; email: string | null; email_replied_at: string | null; last_replied_at: string | null } | undefined
    : undefined;
  const contact = { kind: "contact" as const, name: target?.full_name ?? null, via: null as string | null };

  const campaignOf = new Map<string, ThreadMessage["campaign"]>();
  const campaign = (runId: string | null, stepId: string | null): ThreadMessage["campaign"] => {
    const key = `${runId ?? ""}|${stepId ?? ""}`;
    if (campaignOf.has(key)) return campaignOf.get(key)!;
    const place = stepPlace(db, stepId);
    const workflow = (place
      ? db.prepare("SELECT id, name FROM workflows WHERE id = ?").get(place.workflow_id)
      : runId ? db.prepare("SELECT w.id, w.name FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?").get(runId) : undefined) as { id: string; name: string } | undefined;
    const found = workflow ? { workflow_id: workflow.id, name: workflow.name, step: place?.step ?? null, steps: place?.steps ?? null } : null;
    campaignOf.set(key, found);
    return found;
  };

  const attachmentsFor = (column: "reply_id" | "email_job_id", ids: string[]): Map<string, AttachmentInfo[]> => {
    const byOwner = new Map<string, AttachmentInfo[]>();
    if (!ids.length) return byOwner;
    const rows = db.prepare(`SELECT ${column} AS owner, id, filename, content_type, size_bytes, content IS NOT NULL AS kept FROM conversation_attachments
      WHERE ${column} IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, rowid`).all(...ids) as Array<{ owner: string; id: string; filename: string; content_type: string; size_bytes: number; kept: number }>;
    for (const { owner, kept, ...file } of rows) byOwner.set(owner, [...(byOwner.get(owner) ?? []), { ...file, kept: Boolean(kept) }]);
    return byOwner;
  };

  // ── What the contact wrote, as the inbox filed it ──────────────────────────────────────
  const replies = db.prepare(`SELECT id, channel, from_email, subject, body_text, received_at, external_id, classified_at, classification_json, classification_error,
      dispatch_result_json, later, email_account_id FROM email_replies WHERE conversation_id = ? ORDER BY datetime(received_at), rowid`).all(conversation.id) as ReplyRecord[];
  const replyFiles = attachmentsFor("reply_id", replies.map((reply) => reply.id));
  const linkedinReplies = new Map(replies.filter((reply) => reply.channel === "linkedin" && reply.external_id).map((reply) => [reply.external_id!, reply]));

  // ── LinkedIn, both ways ────────────────────────────────────────────────────────────────
  const shownAsMessage = new Set<string>();
  if (target) {
    const rows = db.prepare(`SELECT m.id, m.direction, m.body, m.sent_at, m.status, m.error, m.message_urn, m.created_by, m.run_id, m.step_id, m.kind, m.subject, a.name AS account_name
      FROM linkedin_messages m LEFT JOIN accounts a ON a.id = m.account_id WHERE m.target_id = ? AND m.workspace_id = ? ORDER BY datetime(m.sent_at), m.rowid`).all(target.id, conversation.workspace_id) as Array<{
      id: string; direction: "in" | "out"; body: string; sent_at: string; status: string; error: string | null; message_urn: string | null; created_by: string | null;
      run_id: string | null; step_id: string | null; kind: string | null; subject: string | null; account_name: string | null;
    }>;
    for (const row of rows) {
      const reply = row.direction === "in" && row.message_urn ? linkedinReplies.get(row.message_urn) : undefined;
      if (reply) shownAsMessage.add(reply.id);
      messages.push({
        id: `linkedin:${row.id}`, source: "linkedin", channel: "linkedin", direction: row.direction, at: isoOf(row.sent_at) ?? row.sent_at, subject: row.subject, body: row.body,
        status: (["queued", "sending", "failed", "uncertain"].includes(row.status) ? row.status : "delivered") as ThreadMessage["status"], error: row.error,
        author: row.direction === "in" ? contact : { kind: "linkedin_account", name: row.account_name, via: null },
        campaign: row.direction === "out" && (row.run_id || row.step_id) ? campaign(row.run_id, row.step_id) : null, opens: null,
        reply: reply ? replyInfo(reply) : null, attachments: [], linkedin_message_id: row.id, sent_here: row.direction === "out" && row.created_by !== null, kind: row.kind ?? "message",
      });
    }
  }

  for (const reply of replies) {
    if (shownAsMessage.has(reply.id)) continue;
    const onLinkedin = reply.channel === "linkedin";
    messages.push({
      id: `reply:${reply.id}`, source: "reply", channel: onLinkedin ? "linkedin" : "email", direction: "in", at: isoOf(reply.received_at) ?? reply.received_at,
      subject: reply.subject, body: reply.body_text, status: "delivered", error: null,
      author: { ...contact, via: onLinkedin ? null : reply.from_email || null },
      campaign: null, opens: null, reply: replyInfo(reply), attachments: replyFiles.get(reply.id) ?? [], linkedin_message_id: null, sent_here: false, kind: onLinkedin ? "message" : null,
    });
  }

  // ── Emails this app sent them ──────────────────────────────────────────────────────────
  if (target) {
    const sent = sentEmailsOf(db, conversation.workspace_id, target.id, target.email);
    const jobFiles = attachmentsFor("email_job_id", sent.map((row) => row.id));
    const mailboxes = new Map<string, { name: string | null; from_email: string } | undefined>();
    const opened = db.prepare("SELECT COUNT(*) AS c FROM sender_events WHERE sent_message_id = ? AND event_type = 'opened' AND is_bot = 0");
    for (const row of sent) {
      if (!mailboxes.has(row.email_account_id)) mailboxes.set(row.email_account_id, db.prepare("SELECT COALESCE(NULLIF(from_name, ''), name) AS name, from_email FROM email_accounts WHERE id = ?").get(row.email_account_id) as { name: string | null; from_email: string } | undefined);
      const mailbox = mailboxes.get(row.email_account_id);
      const went = row.status === "sent";
      messages.push({
        id: `email:${row.id}`, source: "sent_email", channel: "email", direction: "out", at: isoOf(row.accepted_at ?? row.created_at) ?? row.created_at,
        subject: row.subject, body: row.body_text,
        status: went ? (row.bounced_at ? "failed" : "delivered") : row.status === "uncertain" ? "uncertain" : row.status === "failed" ? "failed" : "queued",
        error: went ? (row.bounced_at ? "This email bounced" : null) : row.status === "failed" || row.status === "uncertain" ? row.last_error : null,
        author: { kind: "mailbox", name: mailbox?.name ?? null, via: mailbox?.from_email ?? null },
        campaign: row.source === "campaign" ? campaign(row.run_id, row.step_id) : null,
        opens: went && row.sent_message_id ? (opened.get(row.sent_message_id) as { c: number }).c : null,
        reply: null, attachments: jobFiles.get(row.id) ?? [], linkedin_message_id: null, sent_here: row.source !== "campaign", kind: null,
      });
    }
  }

  // ── Known to have answered, with no message on record ──────────────────────────────────
  if (target && !messages.some((message) => message.direction === "in")) {
    for (const [channel, at] of [["email", target.email_replied_at], ["linkedin", target.last_replied_at]] as const) {
      const when = isoOf(at);
      if (when) messages.push({
        id: `mark:${channel}`, source: "marker", channel, direction: "in", at: when, subject: null, body: "", status: "delivered", error: null,
        author: contact, campaign: null, opens: null, reply: null, attachments: [], linkedin_message_id: null, sent_here: false, kind: null,
      });
    }
  }

  return messages.sort((a, b) => a.at.localeCompare(b.at));
}

/** One email of a thread, in the shape the mailbox read used to return. */
export interface StoredEmail {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  text: string;
  html: string | null;
  messageId: string | null;
  /** 'in' for what the contact wrote, 'out' for what this app sent. */
  direction: "in" | "out";
}

/**
 * The email side of a conversation from stored rows: what the contact wrote (as captured)
 * and what this app sent them (campaign steps and answers), oldest first.
 *
 * This is what GET /api/inbox/thread and GET /api/targets/:id/emails return. They used to
 * open the mailbox and search it, which was slow, failed whenever the mailbox did, and
 * showed nothing this app had sent (sent mail is not in the inbox folder).
 */
export function storedEmailThread(db: DB, workspaceId: string, who: { targetId?: string | null; replyId?: string | null }): StoredEmail[] | null {
  let targetId = who.targetId ?? null;
  let address: string | null = null;
  let conversationId: string | null = null;
  if (targetId) {
    const target = db.prepare("SELECT email FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, workspaceId) as { email: string | null } | undefined;
    if (!target) return null;
    address = target.email;
  } else if (who.replyId) {
    const reply = db.prepare("SELECT target_id, from_email, conversation_id FROM email_replies WHERE id = ? AND workspace_id = ?").get(who.replyId, workspaceId) as { target_id: string | null; from_email: string; conversation_id: string | null } | undefined;
    if (!reply) return null;
    targetId = reply.target_id;
    address = reply.from_email || null;
    conversationId = reply.conversation_id;
  } else return null;

  const mailboxOf = new Map<string, string>();
  const mailbox = (id: string | null): string => {
    if (!id) return "";
    if (!mailboxOf.has(id)) {
      const row = db.prepare("SELECT from_name, from_email FROM email_accounts WHERE id = ?").get(id) as { from_name: string | null; from_email: string } | undefined;
      mailboxOf.set(id, row ? (row.from_name ? `"${row.from_name}" <${row.from_email}>` : row.from_email) : "");
    }
    return mailboxOf.get(id)!;
  };

  const replies = (targetId
    ? db.prepare("SELECT from_email, subject, body_text, received_at, message_id, imap_uid, email_account_id FROM email_replies WHERE target_id = ? AND workspace_id = ? AND channel = 'email'").all(targetId, workspaceId)
    : conversationId
      ? db.prepare("SELECT from_email, subject, body_text, received_at, message_id, imap_uid, email_account_id FROM email_replies WHERE conversation_id = ? AND workspace_id = ? AND channel = 'email'").all(conversationId, workspaceId)
      : db.prepare("SELECT from_email, subject, body_text, received_at, message_id, imap_uid, email_account_id FROM email_replies WHERE id = ? AND workspace_id = ?").all(who.replyId, workspaceId)
  ) as Array<{ from_email: string; subject: string | null; body_text: string; received_at: string; message_id: string | null; imap_uid: number | null; email_account_id: string | null }>;

  const emails: StoredEmail[] = replies.map((reply) => ({
    uid: reply.imap_uid ?? 0, from: reply.from_email, to: mailbox(reply.email_account_id), subject: reply.subject ?? "(no subject)",
    date: isoOf(reply.received_at) ?? reply.received_at, text: reply.body_text, html: null, messageId: reply.message_id, direction: "in",
  }));
  if (targetId) {
    const messageIds = db.prepare("SELECT message_id FROM sent_messages WHERE job_id = ?");
    for (const sent of sentEmailsOf(db, workspaceId, targetId, address)) {
      if (sent.status !== "sent") continue;
      emails.push({
        uid: 0, from: mailbox(sent.email_account_id), to: address ?? "", subject: sent.subject, date: isoOf(sent.accepted_at ?? sent.created_at) ?? sent.created_at,
        text: sent.body_text, html: null, messageId: (messageIds.get(sent.id) as { message_id: string } | undefined)?.message_id ?? null, direction: "out",
      });
    }
  }
  return emails.sort((a, b) => a.date.localeCompare(b.date));
}
