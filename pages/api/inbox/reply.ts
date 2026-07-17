import type { NextApiRequest, NextApiResponse } from "next";
import { createHash, randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { sendEmailDurably } from "@/lib/email/infrastructure";
import { isAddressSuppressed } from "@/lib/platform/suppression";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;

  const { emailAccountId, to, subject, body, replyId } = req.body as {
    emailAccountId?: string;
    to?: string;
    subject?: string;
    body?: string;
    replyId?: string;
  };

  if (!emailAccountId || !to || !subject || !body) {
    return res.status(400).json({ error: "emailAccountId, to, subject, and body are required" });
  }

  const db = getDb();
  const account = db.prepare(
    "SELECT id, from_email, from_name, reply_to, smtp_host, smtp_port, smtp_secure, username, password FROM email_accounts WHERE id = ? AND workspace_id = ?"
  ).get(emailAccountId, ctx.workspaceId) as {
    id: string; from_email: string; from_name: string | null; reply_to: string | null;
    smtp_host: string; smtp_port: number; smtp_secure: number; username: string; password: string;
  } | undefined;

  if (!account) return res.status(404).json({ error: "Email account not found" });
  if(replyId){
    const reply=db.prepare("SELECT locked_by,locked_at FROM email_replies WHERE id=? AND workspace_id=?").get(replyId,ctx.workspaceId) as {locked_by:string|null;locked_at:string|null}|undefined;
    if(!reply)return res.status(404).json({error:"Inbox reply not found"});
    const fresh=reply.locked_at && Date.now()-Date.parse(reply.locked_at)<15*60_000;
    if(fresh && reply.locked_by && reply.locked_by!==ctx.userId)return res.status(409).json({error:"Reply is being handled by another teammate"});
  }
  const suppression = isAddressSuppressed(ctx.workspaceId, to);
  if (suppression) return res.status(409).json({ error: "Recipient is suppressed", suppression });

  try {
    const digest=createHash("sha256").update(`${to}\n${subject}\n${body}`).digest("hex").slice(0,16);
    const receipt=await sendEmailDurably({workspaceId:ctx.workspaceId,emailAccountId,idempotencyKey:`team-inbox:${replyId??randomUUID()}:${digest}`,source:"team_inbox",to,subject,body});
    recordAudit(ctx, "inbox.reply_sent", "email_job", receipt.jobId, { to, subject, message_id:receipt.messageId });
    return res.json({ ok: true, job_id:receipt.jobId, message_id:receipt.messageId });
  } catch (err) {
    console.error("[inbox/reply] send failed:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Send failed" });
  }
}
