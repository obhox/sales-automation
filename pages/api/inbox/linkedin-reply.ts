// Answering a contact on LinkedIn from the inbox. The message is queued and sent by the
// one loop that drives the LinkedIn session, so the answer here is "queued", not "sent";
// the conversation shows what became of it.
//
//   POST   /api/inbox/linkedin-reply { target_id, text, account_id?, reply_id? }   202 { id, status: "queued" }
//   POST   /api/inbox/linkedin-reply { retry_id, confirm? }                        send one that failed again
//   DELETE /api/inbox/linkedin-reply?id=…                                          discard one that has not gone
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { LINKEDIN_MESSAGE_MAX, queueLinkedinMessage } from "@/lib/linkedin/outbox";
import { profileVanity } from "@/lib/linkedin/url";
import { findTargetSuppression } from "@/lib/platform/suppression";
import { recordAudit, requireWorkspace } from "@/lib/workspace";
import { linkedinAccountFor } from "@/pages/api/inbox/linkedin-thread";

type Stored = { id: string; target_id: string; account_id: string | null; status: string; body: string };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();
  const mine = (id: unknown) => db.prepare("SELECT id, target_id, account_id, status, body FROM linkedin_messages WHERE id = ? AND workspace_id = ? AND direction = 'out' AND created_by IS NOT NULL")
    .get(String(id ?? ""), ctx.workspaceId) as Stored | undefined;

  if (req.method === "DELETE") {
    const message = mine(req.query.id);
    if (!message) return res.status(404).json({ error: "Message not found" });
    // One the browser has, or that reached LinkedIn, is not this app's to take back.
    if (!["queued", "failed", "uncertain"].includes(message.status)) return res.status(409).json({ error: message.status === "sending" ? "This message is being sent right now" : "This message has been delivered" });
    db.prepare("DELETE FROM linkedin_messages WHERE id = ? AND status IN ('queued', 'failed', 'uncertain')").run(message.id);
    recordAudit(ctx, "linkedin.reply_discarded", "target", message.target_id, { status: message.status });
    return res.status(204).end();
  }

  if (req.method !== "POST") { res.setHeader("Allow", ["POST", "DELETE"]); return res.status(405).end(); }
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (body.retry_id !== undefined) {
    const message = mine(body.retry_id);
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.status !== "failed" && message.status !== "uncertain") return res.status(409).json({ error: "Only a message that failed, or could not be confirmed, can be sent again" });
    // An unconfirmed message may have gone. A person has to say they looked.
    if (message.status === "uncertain" && body.confirm !== true) return res.status(400).json({ error: "This message may already have been delivered. Check the conversation on LinkedIn, then send again with confirm" });
    db.prepare("UPDATE linkedin_messages SET status = 'queued', error = NULL WHERE id = ?").run(message.id);
    recordAudit(ctx, "linkedin.reply_requeued", "target", message.target_id, { was: message.status });
    ensureGlobalRunnerStarted();
    return res.status(202).json({ id: message.id, status: "queued" });
  }

  const targetId = String(body.target_id ?? "");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const contact = db.prepare("SELECT id, linkedin_url FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, ctx.workspaceId) as { id: string; linkedin_url: string | null } | undefined;
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  if (!text) return res.status(400).json({ error: "Write a message first" });
  if (text.length > LINKEDIN_MESSAGE_MAX) return res.status(400).json({ error: `A LinkedIn message can be at most ${LINKEDIN_MESSAGE_MAX} characters` });
  if (!profileVanity(contact.linkedin_url)) return res.status(400).json({ error: "This contact has no LinkedIn profile address" });

  const { account, choices } = linkedinAccountFor(db, ctx, targetId);
  const from = body.account_id ? choices.find((choice) => choice.id === body.account_id) ?? null : account;
  if (!from) return res.status(400).json({ error: body.account_id ? "That LinkedIn account is not signed in" : choices.length ? "Say which LinkedIn account to send from" : "No LinkedIn account is signed in" });

  if (body.reply_id) {
    const reply = db.prepare("SELECT locked_by, locked_at FROM email_replies WHERE id = ? AND workspace_id = ?").get(String(body.reply_id), ctx.workspaceId) as { locked_by: string | null; locked_at: string | null } | undefined;
    if (!reply) return res.status(404).json({ error: "Inbox reply not found" });
    const held = reply.locked_at && Date.now() - Date.parse(reply.locked_at) < 15 * 60_000;
    if (held && reply.locked_by && reply.locked_by !== ctx.userId) return res.status(409).json({ error: "Reply is being handled by another teammate" });
  }
  // Someone on the do-not-contact list is not written to, by a person either.
  const suppression = findTargetSuppression(ctx.workspaceId, targetId);
  if (suppression) return res.status(409).json({ error: "This contact is on the do-not-contact list", suppression });
  // The same words already waiting for the same person: a double click, not a second message.
  const waiting = db.prepare("SELECT id FROM linkedin_messages WHERE target_id = ? AND account_id = ? AND status IN ('queued', 'sending') AND body = ?").get(targetId, from.id, text.replace(/\r\n?/g, "\n")) as { id: string } | undefined;
  if (waiting) return res.status(202).json({ id: waiting.id, status: "queued", account_id: from.id });

  const id = queueLinkedinMessage(db, { workspaceId: ctx.workspaceId, accountId: from.id, targetId, text, createdBy: ctx.userId });
  recordAudit(ctx, "linkedin.reply_queued", "target", targetId, { account_id: from.id, length: text.length });
  ensureGlobalRunnerStarted();
  return res.status(202).json({ id, status: "queued", account_id: from.id });
}
