import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { sendEmailDurably } from "@/lib/email/infrastructure";
import { noteOutbound } from "@/lib/conversations/store";
import { storedEmailThread } from "@/lib/conversations/thread";
import { randomUUID } from "crypto";
import { emitDomainEvent } from "@/lib/platform/events";
import { findTargetSuppression } from "@/lib/platform/suppression";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

// Email conversation for one contact, account-resolved automatically so callers (incl. the MCP)
// never need to know the email_account_id.
//   GET  → the email conversation with this contact (sent + received), from what is stored:
//          captured replies and the emails this app sent. No mailbox is opened.
//   POST → send an email to this contact as the Linki sending identity (subject optional → reply).
//
// Account resolution order: explicit email_account_id → the contact's most recent run_profile
// assignment → the single configured account if there's exactly one.

type AccountRow = {
  id: string; from_email: string; from_name: string | null; reply_to: string | null;
  smtp_host: string; smtp_port: number; smtp_secure: number;
  imap_host: string | null; imap_port: number | null;
  username: string; password: string;
  imap_username: string | null; imap_password: string | null;
  allow_self_signed: number;
};

function resolveAccount(db: ReturnType<typeof getDb>, workspaceId: string, targetId: string, explicitId?: string): AccountRow | null {
  const cols = `id, from_email, from_name, reply_to, smtp_host, smtp_port, smtp_secure,
                imap_host, imap_port, username, password, imap_username, imap_password, allow_self_signed`;
  if (explicitId) {
    return (db.prepare(`SELECT ${cols} FROM email_accounts WHERE id = ? AND workspace_id = ?`).get(explicitId, workspaceId) as AccountRow) ?? null;
  }
  const assigned = db.prepare(`
    SELECT rp.email_account_id FROM run_profiles rp
    WHERE rp.target_id = ? AND rp.email_account_id IS NOT NULL
    ORDER BY rp.created_at DESC LIMIT 1
  `).get(targetId) as { email_account_id: string } | undefined;
  if (assigned?.email_account_id) {
    return (db.prepare(`SELECT ${cols} FROM email_accounts WHERE id = ? AND workspace_id = ?`).get(assigned.email_account_id, workspaceId) as AccountRow) ?? null;
  }
  const all = db.prepare(`SELECT ${cols} FROM email_accounts WHERE workspace_id = ?`).all(workspaceId) as AccountRow[];
  return all.length === 1 ? all[0] : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "POST" ? "member" : "viewer");
  if (!ctx) return;
  const db = getDb();
  const targetId = req.query.id as string;

  const target = db.prepare("SELECT id, email FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, ctx.workspaceId) as
    | { id: string; email: string | null } | undefined;
  if (!target) return res.status(404).json({ error: "Contact not found" });
  if (!target.email) return res.status(400).json({ error: "Contact has no email address" });

  // ── Read thread ──
  if (req.method === "GET") {
    const account = resolveAccount(db, ctx.workspaceId, targetId, req.query.email_account_id as string | undefined);
    const messages = storedEmailThread(db, ctx.workspaceId, { targetId }) ?? [];
    return res.json({ email_account_id: account?.id ?? null, contact_email: target.email, messages });
  }

  // ── Send / reply ──
  if (req.method === "POST") {
    const { subject, body, email_account_id } = req.body as {
      subject?: string; body?: string; email_account_id?: string;
    };
    if (!body?.trim()) return res.status(400).json({ error: "body is required" });

    const account = resolveAccount(db, ctx.workspaceId, targetId, email_account_id);
    if (!account) return res.status(400).json({ error: "No email account could be resolved for this contact" });
    const suppression = findTargetSuppression(ctx.workspaceId, targetId);
    if (suppression) return res.status(409).json({ error: "Contact is suppressed", suppression });

    // No subject → treat as a reply: reuse the last subject in the thread (Re: …) or a sane default.
    let finalSubject = subject?.trim();
    let thread: { replyToMessageId: string; references: string[] } | undefined;
    if (!finalSubject) {
      const lastReply = db.prepare(
        "SELECT subject, message_id FROM email_replies WHERE target_id = ? AND subject IS NOT NULL ORDER BY received_at DESC LIMIT 1"
      ).get(targetId) as { subject: string; message_id: string | null } | undefined;
      finalSubject = lastReply?.subject
        ? (/^re:/i.test(lastReply.subject) ? lastReply.subject : `Re: ${lastReply.subject}`)
        : "Re:";
      // A reply names the message it answers, so it is filed in the same conversation.
      if (lastReply?.message_id) thread = { replyToMessageId: lastReply.message_id, references: [lastReply.message_id] };
    }

    try {
      // Route through the durable mail plane so the send is recorded in email_jobs
      // (with target_id + source), which lets the inbox reply-sync detect the reply.
      await sendEmailDurably({
        workspaceId: ctx.workspaceId,
        emailAccountId: account.id,
        idempotencyKey: `contact-thread:${targetId}:${randomUUID()}`,
        source: "contact_thread",
        targetId,
        to: target.email,
        subject: finalSubject,
        body,
        ...thread,
      });
      // If they are in a conversation, this is its latest message and the answer that was due.
      noteOutbound(db, targetId, { answeredBy: ctx.userId });
      const eventId = emitDomainEvent({ workspaceId: ctx.workspaceId, type: "email.sent", entityType: "target", entityId: targetId, payload: { to: target.email, subject: finalSubject, email_account_id: account.id, source: "contact_thread" } });
      recordAudit(ctx, "contact.email_sent", "target", targetId, { event_id: eventId, subject: finalSubject });
      return res.json({ ok: true, email_account_id: account.id, to: target.email, subject: finalSubject });
    } catch (err) {
      console.error("[targets/emails] send failed:", err);
      return res.status(500).json({ error: err instanceof Error ? err.message : "Send failed" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
}
