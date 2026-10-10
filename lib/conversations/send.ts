// Answering a contact from the inbox, on either channel.
//
// An email goes out through the durable mail queue, in the thread of the message it
// answers, with any files added to the draft. A LinkedIn message is put in the outbox and
// sent by the one loop that drives the LinkedIn session, so the answer for it is "queued".
// Either way the conversation has had its answer: nothing is due any more, the draft is
// gone, and it is closed too when asked.
import { createHash } from "crypto";
import type DatabaseType from "better-sqlite3";
import { enqueueEmail, sendEmailDurably } from "@/lib/email/infrastructure";
import { LINKEDIN_MESSAGE_MAX, queueLinkedinMessage } from "@/lib/linkedin/outbox";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { profileVanity } from "@/lib/linkedin/url";
import { loadTargetCustomValues } from "@/lib/outreach/custom-values";
import { renderOutreachTemplate } from "@/lib/outreach/render";
import { findTargetSuppression, isAddressSuppressed } from "@/lib/platform/suppression";
import type { ConversationRow } from "@/lib/conversations/rows";
import { clearDraft, draftAttachments, lockHolder, moveDraftAttachmentsToJob, noteOutbound } from "@/lib/conversations/store";

type DB = DatabaseType.Database;

export interface SendContext { workspaceId: string; userId: string | null }
export type SendResult =
  | { ok: true; channel: "email"; job_id: string; message_id: string | null; to: string; subject: string; status: "sent" | "queued" }
  | { ok: true; channel: "linkedin"; id: string; status: "queued"; account_id: string }
  | { ok: false; status: number; error: string; suppression?: unknown };

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): SendResult => ({ ok: false, status, error, ...extra });

/**
 * The LinkedIn account an answer to this contact goes from: the one the conversation is
 * on, else the one that has written to them, else the one that worked them in their
 * latest campaign (their own account in a campaign with several), else the workspace's
 * only signed-in account. Null when it cannot be told, with every signed-in account offered instead.
 */
export function linkedinAccountFor(db: DB, workspaceId: string, targetId: string): { account: { id: string; name: string } | null; choices: Array<{ id: string; name: string }> } {
  const signedIn = db.prepare("SELECT id, name FROM accounts WHERE workspace_id = ? AND is_authenticated = 1 ORDER BY created_at").all(workspaceId) as Array<{ id: string; name: string }>;
  const pick = (id: string | null | undefined) => signedIn.find((account) => account.id === id) ?? null;
  const spoken = db.prepare("SELECT account_id FROM linkedin_messages WHERE target_id = ? AND workspace_id = ? AND account_id IS NOT NULL ORDER BY sent_at DESC LIMIT 1").get(targetId, workspaceId) as { account_id: string } | undefined;
  const wrote = db.prepare("SELECT linkedin_account_id AS account_id FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, workspaceId) as { account_id: string | null } | undefined;
  const campaigned = db.prepare(`SELECT COALESCE(rp.account_id, r.account_id) AS account_id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
    WHERE rp.target_id = ? AND r.workspace_id = ? AND COALESCE(rp.account_id, r.account_id, '') != '' ORDER BY r.created_at DESC LIMIT 1`).get(targetId, workspaceId) as { account_id: string } | undefined;
  return { account: pick(spoken?.account_id) ?? pick(wrote?.account_id) ?? pick(campaigned?.account_id) ?? (signedIn.length === 1 ? signedIn[0] : null), choices: signedIn };
}

/** Put a LinkedIn answer in the outbox. The checks a person's own message still has to pass are here, once. */
export function queueLinkedinAnswer(db: DB, ctx: SendContext, input: { targetId: string; text: string; accountId?: string | null }): SendResult {
  const text = input.text.trim();
  const contact = db.prepare("SELECT id, linkedin_url FROM targets WHERE id = ? AND workspace_id = ?").get(input.targetId, ctx.workspaceId) as { id: string; linkedin_url: string | null } | undefined;
  if (!contact) return refuse(404, "Contact not found");
  if (!text) return refuse(400, "Write a message first");
  if (text.length > LINKEDIN_MESSAGE_MAX) return refuse(400, `A LinkedIn message can be at most ${LINKEDIN_MESSAGE_MAX} characters`);
  if (!profileVanity(contact.linkedin_url)) return refuse(400, "This contact has no LinkedIn profile address");

  const { account, choices } = linkedinAccountFor(db, ctx.workspaceId, input.targetId);
  const from = input.accountId ? choices.find((choice) => choice.id === input.accountId) ?? null : account;
  if (!from) return refuse(400, input.accountId ? "That LinkedIn account is not signed in" : choices.length ? "Say which LinkedIn account to send from" : "No LinkedIn account is signed in");

  // Someone on the do-not-contact list is not written to, by a person either.
  const suppression = findTargetSuppression(ctx.workspaceId, input.targetId);
  if (suppression) return refuse(409, "This contact is on the do-not-contact list", { suppression });
  // The same words already waiting for the same person: a double click, not a second message.
  const waiting = db.prepare("SELECT id FROM linkedin_messages WHERE target_id = ? AND account_id = ? AND status IN ('queued', 'sending') AND body = ?").get(input.targetId, from.id, text.replace(/\r\n?/g, "\n")) as { id: string } | undefined;
  if (waiting) return { ok: true, channel: "linkedin", id: waiting.id, status: "queued", account_id: from.id };

  const id = queueLinkedinMessage(db, { workspaceId: ctx.workspaceId, accountId: from.id, targetId: input.targetId, text, createdBy: ctx.userId });
  ensureGlobalRunnerStarted();
  return { ok: true, channel: "linkedin", id, status: "queued", account_id: from.id };
}

/** Fill the merge tags a person put in their answer ({{first_name}} and the rest). Nothing else in what they typed is touched. */
export function fillMergeTags(db: DB, workspaceId: string, targetId: string | null, text: string): string {
  if (!targetId || !text.includes("{{")) return text;
  const target = db.prepare("SELECT first_name, last_name, full_name, company, title, location FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, workspaceId) as Record<string, string | null> | undefined;
  if (!target) return text;
  const custom = loadTargetCustomValues(db, workspaceId, targetId);
  // One tag at a time: the renderer also picks between {a|b} alternatives, which is for
  // templates and must not rewrite braces a person typed on purpose.
  return text.replace(/\{\{[^{}]*\}\}/g, (tag) => (/^\{\{\s*unsubscribe\b/i.test(tag) ? tag : renderOutreachTemplate(tag, target, custom)));
}

export interface SendInput {
  channel: "email" | "linkedin";
  body: string;
  subject?: string | null;
  emailAccountId?: string | null;
  linkedinAccountId?: string | null;
  /** Close the conversation once the answer has gone. */
  close?: boolean;
}

/**
 * The mailbox an email answer goes from: the one named, else the one their latest email
 * reply came to, else the one their campaign used, else the workspace's only mailbox.
 */
export function mailboxFor(db: DB, workspaceId: string, conversation: Pick<ConversationRow, "id" | "target_id">, explicitId?: string | null): { id: string; name: string; from_email: string } | null {
  const byId = (id: string | null | undefined) => (id ? db.prepare("SELECT id, name, from_email FROM email_accounts WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as { id: string; name: string; from_email: string } | undefined : undefined) ?? null;
  if (explicitId) return byId(explicitId);
  const replied = db.prepare("SELECT email_account_id FROM email_replies WHERE conversation_id = ? AND channel = 'email' AND email_account_id IS NOT NULL ORDER BY datetime(received_at) DESC LIMIT 1").get(conversation.id) as { email_account_id: string } | undefined;
  const assigned = conversation.target_id
    ? db.prepare("SELECT email_account_id FROM run_profiles WHERE target_id = ? AND email_account_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(conversation.target_id) as { email_account_id: string } | undefined
    : undefined;
  const found = byId(replied?.email_account_id) ?? byId(assigned?.email_account_id);
  if (found) return found;
  const all = db.prepare("SELECT id, name, from_email FROM email_accounts WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as Array<{ id: string; name: string; from_email: string }>;
  return all.length === 1 ? all[0] : null;
}

/** Send an answer in a conversation. See the note at the top of this file for what follows from it. */
export async function sendFromInbox(db: DB, ctx: SendContext, conversation: ConversationRow, input: SendInput): Promise<SendResult> {
  const held = lockHolder(conversation);
  if (held && held.userId !== ctx.userId) return refuse(409, "A teammate is answering this conversation right now");
  const body = fillMergeTags(db, ctx.workspaceId, conversation.target_id, input.body ?? "").trim();
  if (!body) return refuse(400, "Write a message first");

  if (input.channel === "linkedin") {
    if (!conversation.target_id) return refuse(400, "This conversation has no contact, so there is nobody to message on LinkedIn");
    if (ctx.userId && draftAttachments(db, conversation.id, ctx.userId).length) return refuse(400, "Files cannot be sent on LinkedIn. Remove them, or answer by email.");
    const queued = queueLinkedinAnswer(db, ctx, { targetId: conversation.target_id, text: body, accountId: input.linkedinAccountId });
    if (!queued.ok) return queued;
    finish(db, ctx, conversation, input.close);
    return queued;
  }

  const to = conversation.target_id
    ? (db.prepare("SELECT email FROM targets WHERE id = ? AND workspace_id = ?").get(conversation.target_id, ctx.workspaceId) as { email: string | null } | undefined)?.email ?? null
    : conversation.address?.includes("@") ? conversation.address : null;
  if (!to) return refuse(400, "There is no email address to answer");
  const mailbox = mailboxFor(db, ctx.workspaceId, conversation, input.emailAccountId);
  if (!mailbox) return refuse(400, input.emailAccountId ? "That mailbox was not found" : "Say which mailbox to send from");
  const suppression = conversation.target_id ? findTargetSuppression(ctx.workspaceId, conversation.target_id) : isAddressSuppressed(ctx.workspaceId, to);
  if (suppression) return refuse(409, "This contact is on the do-not-contact list", { suppression });

  // Answering their latest email: name it (and the email of ours it answered), so their
  // mail client files this under the same conversation, and carry its subject.
  const last = db.prepare(`SELECT er.subject, er.message_id, sm.message_id AS answered_message_id FROM email_replies er
    LEFT JOIN sent_messages sm ON sm.job_id = er.in_reply_to_job_id
    WHERE er.conversation_id = ? AND er.channel = 'email' ORDER BY datetime(er.received_at) DESC LIMIT 1`).get(conversation.id) as { subject: string | null; message_id: string | null; answered_message_id: string | null } | undefined;
  const thread = last?.message_id ? { replyToMessageId: last.message_id, references: [last.answered_message_id, last.message_id].filter((id): id is string => Boolean(id)) } : {};
  const subject = input.subject?.trim() || (last?.subject ? (/^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`) : "");
  if (!subject) return refuse(400, "Give the email a subject");

  const files = ctx.userId ? draftAttachments(db, conversation.id, ctx.userId) : [];
  // The same words to the same person within the same minute is a double click.
  const digest = createHash("sha256").update(`${to}\n${subject}\n${body}\n${files.map((file) => file.id).join(",")}`).digest("hex").slice(0, 16);
  const job = {
    workspaceId: ctx.workspaceId, emailAccountId: mailbox.id, idempotencyKey: `inbox:${conversation.id}:${digest}:${Math.floor(Date.now() / 60_000)}`,
    source: "team_inbox", ...(conversation.target_id ? { targetId: conversation.target_id } : {}), to, subject, body, ...thread,
  };
  const queued = enqueueEmail(job);
  if (ctx.userId && files.length) moveDraftAttachmentsToJob(db, conversation.id, ctx.userId, queued.id);
  try {
    const receipt = await sendEmailDurably(job);
    finish(db, ctx, conversation, input.close);
    return { ok: true, channel: "email", job_id: receipt.jobId, message_id: receipt.messageId, to, subject, status: "sent" };
  } catch (error) {
    const state = db.prepare("SELECT status FROM email_jobs WHERE id = ?").get(queued.id) as { status: string } | undefined;
    // The mail server could not be reached just now and the queue will try again by
    // itself: the answer is on its way, not lost, and must not be written a second time.
    if (state && ["pending", "leased", "sending"].includes(state.status)) {
      finish(db, ctx, conversation, input.close);
      return { ok: true, channel: "email", job_id: queued.id, message_id: null, to, subject, status: "queued" };
    }
    // It did not go and will not be tried again. What was typed stays in the draft, with
    // its files; the failed email shows in the thread with the reason.
    if (state?.status === "failed" && ctx.userId) db.prepare("UPDATE conversation_attachments SET draft_user_id = ?, email_job_id = NULL WHERE email_job_id = ?").run(ctx.userId, queued.id);
    noteOutbound(db, conversation.target_id);
    return refuse(502, error instanceof Error ? error.message : "The email could not be sent");
  }
}

function finish(db: DB, ctx: SendContext, conversation: ConversationRow, close: boolean | undefined): void {
  if (ctx.userId) clearDraft(db, conversation.id, ctx.userId);
  if (conversation.target_id) noteOutbound(db, conversation.target_id, { answeredBy: ctx.userId, close });
  else if (close) db.prepare("UPDATE conversations SET status = 'closed', closed_at = ?, sla_due_at = NULL, snoozed_until = NULL WHERE id = ?").run(new Date().toISOString(), conversation.id);
}
