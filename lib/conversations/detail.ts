// One conversation as the inbox opens it: its row, every message, what the member has
// typed and not sent, and what they can answer with.
import type DatabaseType from "better-sqlite3";
import { profileVanity } from "@/lib/linkedin/url";
import { findTargetSuppression, isAddressSuppressed } from "@/lib/platform/suppression";
import { listConversations, type ConversationItem } from "@/lib/conversations/list";
import type { ConversationRow } from "@/lib/conversations/rows";
import { linkedinAccountFor, mailboxFor } from "@/lib/conversations/send";
import { draftAttachments, getDraft, type AttachmentInfo, type DraftRow } from "@/lib/conversations/store";
import { readThread, type ThreadMessage, type ThreadReply } from "@/lib/conversations/thread";

type DB = DatabaseType.Database;

export interface ConversationDetail {
  conversation: ConversationItem & { created_at: string; closed_at: string | null; campaigns: Array<{ id: string; name: string }> };
  messages: ThreadMessage[];
  /** The reply the conversation's verdict comes from: the latest that has one. */
  verdict_reply: ThreadReply | null;
  /** The latest reply of all, which is the one a verdict is corrected on. */
  latest_reply: ThreadReply | null;
  /** A campaign follow-up put back for a contact who was away, still waiting to go. */
  followup: { reply_id: string; scheduled_for: string | null } | null;
  draft: (Pick<DraftRow, "channel" | "subject" | "body" | "email_account_id" | "linkedin_account_id" | "updated_at"> & { attachments: AttachmentInfo[] }) | null;
  answer: {
    default_channel: "email" | "linkedin";
    email: { can: boolean; why_not: string | null; to: string | null; subject: string; mailboxes: Array<{ id: string; name: string; from_email: string }>; default_mailbox_id: string | null };
    linkedin: { can: boolean; why_not: string | null; accounts: Array<{ id: string; name: string }>; default_account_id: string | null; last_read_at: string | null; reading: boolean };
  };
}

export function conversationDetail(db: DB, ctx: { workspaceId: string; userId: string | null }, row: ConversationRow): ConversationDetail {
  const item = listConversations(db, ctx, { id: row.id }, { limit: 1, offset: 0 }).conversations[0];
  const messages = readThread(db, row);
  const replies = messages.map((message) => message.reply).filter((reply): reply is ThreadReply => reply !== null);
  const latestReply = replies[replies.length - 1] ?? null;
  const verdictReply = [...replies].reverse().find((reply) => reply.verdict) ?? null;

  const campaigns = row.target_id
    ? db.prepare(`SELECT DISTINCT w.id, w.name FROM run_profiles rp JOIN runs r ON r.id = rp.run_id JOIN workflows w ON w.id = r.workflow_id
        WHERE rp.target_id = ? AND r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 5`).all(row.target_id, ctx.workspaceId) as Array<{ id: string; name: string }>
    : [];

  // A follow-up held for someone who was away: still on its way while their email track is waiting.
  const held = [...replies].reverse().find((reply) => reply.dispatch?.action === "rescheduled");
  const waiting = held && row.target_id
    ? db.prepare(`SELECT rt.next_step_at FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id
        WHERE rp.target_id = ? AND rt.state IN ('pending', 'in_progress') AND rt.pending_reply_context IS NOT NULL ORDER BY rt.next_step_at LIMIT 1`).get(row.target_id) as { next_step_at: string | null } | undefined
    : undefined;

  const draft = ctx.userId ? getDraft(db, row.id, ctx.userId) : null;
  const files = ctx.userId ? draftAttachments(db, row.id, ctx.userId) : [];

  // ── What they can be answered with ─────────────────────────────────────────────────────
  const contact = row.target_id ? db.prepare("SELECT email, linkedin_url FROM targets WHERE id = ?").get(row.target_id) as { email: string | null; linkedin_url: string | null } | undefined : undefined;
  const to = contact ? contact.email : row.address?.includes("@") ? row.address : null;
  const mailboxes = db.prepare("SELECT id, name, from_email FROM email_accounts WHERE workspace_id = ? ORDER BY name").all(ctx.workspaceId) as Array<{ id: string; name: string; from_email: string }>;
  const suppression = row.target_id ? findTargetSuppression(ctx.workspaceId, row.target_id) : to ? isAddressSuppressed(ctx.workspaceId, to) : null;
  const lastEmail = [...messages].reverse().find((message) => message.channel === "email" && message.subject);
  const emailWhyNot = suppression ? "This contact is on the do-not-contact list" : !to ? "There is no email address to answer" : mailboxes.length === 0 ? "No mailbox is connected" : null;

  const linkedin = row.target_id ? linkedinAccountFor(db, ctx.workspaceId, row.target_id) : { account: null, choices: [] };
  const linkedinWhyNot = suppression ? "This contact is on the do-not-contact list"
    : !row.target_id ? "This conversation has no contact"
    : !profileVanity(contact?.linkedin_url) ? "This contact has no LinkedIn profile address"
    : linkedin.choices.length === 0 ? "No LinkedIn account is signed in"
    : null;
  const read = linkedin.account ? db.prepare("SELECT inbox_synced_at, sync_inbox FROM accounts WHERE id = ?").get(linkedin.account.id) as { inbox_synced_at: string | null; sync_inbox: number } | undefined : undefined;

  const lastIn = [...messages].reverse().find((message) => message.direction === "in");
  const wanted = draft?.channel ?? lastIn?.channel ?? row.last_message_channel ?? "email";
  const defaultChannel = wanted === "linkedin" ? (linkedinWhyNot && !emailWhyNot ? "email" : "linkedin") : emailWhyNot && !linkedinWhyNot ? "linkedin" : "email";

  return {
    conversation: { ...item, created_at: row.created_at, closed_at: row.closed_at, campaigns },
    messages,
    verdict_reply: verdictReply,
    latest_reply: latestReply,
    followup: held && waiting ? { reply_id: held.id, scheduled_for: waiting.next_step_at } : null,
    draft: draft || files.length ? {
      channel: draft?.channel ?? defaultChannel, subject: draft?.subject ?? null, body: draft?.body ?? "", email_account_id: draft?.email_account_id ?? null,
      linkedin_account_id: draft?.linkedin_account_id ?? null, updated_at: draft?.updated_at ?? row.updated_at, attachments: files,
    } : null,
    answer: {
      default_channel: defaultChannel,
      email: {
        can: emailWhyNot === null, why_not: emailWhyNot, to,
        subject: lastEmail?.subject ? (/^re:/i.test(lastEmail.subject) ? lastEmail.subject : `Re: ${lastEmail.subject}`) : "",
        mailboxes, default_mailbox_id: mailboxFor(db, ctx.workspaceId, row)?.id ?? null,
      },
      linkedin: {
        can: linkedinWhyNot === null, why_not: linkedinWhyNot, accounts: linkedin.choices, default_account_id: linkedin.account?.id ?? null,
        last_read_at: read?.inbox_synced_at ?? null, reading: Boolean(read?.sync_inbox),
      },
    },
  };
}
