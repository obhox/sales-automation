import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { classifyAndDispatch } from "@/lib/community-replies";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const replyId = req.query.replyId as string;
  const reply = getDb().prepare("SELECT id FROM email_replies WHERE id = ? AND workspace_id = ?").get(replyId, ctx.workspaceId);
  if (!reply) return res.status(404).json({ error: "Reply not found" });
  getDb().prepare("UPDATE email_replies SET classified_at = NULL, classification_json = NULL, classification_error = NULL, dispatched_at = NULL, dispatch_result_json = NULL WHERE id = ?").run(replyId);
  await classifyAndDispatch(replyId);
  recordAudit(ctx, "reply.reclassified", "email_reply", replyId);
  return res.json(getDb().prepare("SELECT * FROM email_replies WHERE id = ?").get(replyId));
}
