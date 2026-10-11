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
import { recordAudit, requireWorkspace } from "@/lib/workspace";
import { queueLinkedinAnswer } from "@/lib/conversations/send";
import { findConversation, lockHolder, noteOutbound } from "@/lib/conversations/store";

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
    noteOutbound(db, message.target_id);
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
  if (body.reply_id) {
    // The lock is on the conversation: a teammate answering any of this contact's messages holds it.
    const conversation = findConversation(db, ctx.workspaceId, { replyId: String(body.reply_id) });
    if (!conversation && db.prepare("SELECT 1 FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, ctx.workspaceId)) return res.status(404).json({ error: "Inbox reply not found" });
    const held = conversation ? lockHolder(conversation) : null;
    if (held && held.userId !== ctx.userId) return res.status(409).json({ error: "Reply is being handled by another teammate" });
  }
  const before = (db.prepare("SELECT COUNT(*) AS c FROM linkedin_messages WHERE target_id = ?").get(targetId) as { c: number }).c;
  const queued = queueLinkedinAnswer(db, ctx, { targetId, text: typeof body.text === "string" ? body.text : "", accountId: body.account_id ? String(body.account_id) : null });
  if (!queued.ok) return res.status(queued.status).json({ error: queued.error, ...(queued.suppression ? { suppression: queued.suppression } : {}) });
  if (queued.channel !== "linkedin") return res.status(500).end();
  // A double click finds the message already waiting and adds nothing.
  if ((db.prepare("SELECT COUNT(*) AS c FROM linkedin_messages WHERE target_id = ?").get(targetId) as { c: number }).c > before) {
    recordAudit(ctx, "linkedin.reply_queued", "target", targetId, { account_id: queued.account_id, length: String(body.text ?? "").trim().length });
    // An answer has been written, so none is due; it becomes the latest message once it is delivered.
    noteOutbound(db, targetId, { answeredBy: ctx.userId });
  }
  return res.status(202).json({ id: queued.id, status: "queued", account_id: queued.account_id });
}
