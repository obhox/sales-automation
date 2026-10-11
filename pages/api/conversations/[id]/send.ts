// Answer a contact from their conversation, by email or on LinkedIn.
//
//   POST /api/conversations/:id/send { channel, body, subject?, email_account_id?, linkedin_account_id?, close? }
//
// An email is sent now and the answer says so. A LinkedIn message is put in line and sent
// by the loop that drives the LinkedIn session, so the answer for it is 202 "queued"; the
// conversation shows what became of it. With `close` the conversation is closed as well.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { conversationDetail } from "@/lib/conversations/detail";
import { conversationById } from "@/lib/conversations/rows";
import { sendFromInbox } from "@/lib/conversations/send";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();
  const id = String(req.query.id ?? "");
  const conversation = conversationById(db, ctx.workspaceId, id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.channel !== "email" && body.channel !== "linkedin") return res.status(400).json({ error: "channel must be email or linkedin" });
  const result = await sendFromInbox(db, ctx, conversation, {
    channel: body.channel, body: typeof body.body === "string" ? body.body : "", subject: typeof body.subject === "string" ? body.subject : null,
    emailAccountId: typeof body.email_account_id === "string" && body.email_account_id ? body.email_account_id : null,
    linkedinAccountId: typeof body.linkedin_account_id === "string" && body.linkedin_account_id ? body.linkedin_account_id : null,
    close: body.close === true,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.suppression ? { suppression: result.suppression } : {}) });

  if (result.channel === "email") recordAudit(ctx, "inbox.reply_sent", "email_job", result.job_id, { to: result.to, subject: result.subject, message_id: result.message_id, conversation_id: id, closed: body.close === true });
  else recordAudit(ctx, "linkedin.reply_queued", "target", conversation.target_id ?? undefined, { account_id: result.account_id, conversation_id: id, closed: body.close === true });
  const sent = result.channel === "email" ? { channel: "email", status: result.status, job_id: result.job_id, message_id: result.message_id } : { channel: "linkedin", status: result.status, id: result.id, account_id: result.account_id };
  return res.status(result.channel === "linkedin" || result.status === "queued" ? 202 : 200).json({ ok: true, sent, ...conversationDetail(db, ctx, conversationById(db, ctx.workspaceId, id)!) });
}
