import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { storedEmailThread, type StoredEmail } from "@/lib/conversations/thread";

export type EmailMessage = StoredEmail;

/**
 * The email conversation with a contact (targetId), or with the sender of a reply whose
 * contact was deleted (replyId), oldest first.
 *
 * Read from what is stored: the replies captured from the mailbox and the emails this app
 * sent. It used to open the mailbox and search it on every request. `emailAccountId` was
 * needed for that and is still accepted, but no mailbox is opened any more.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res);
  if (!ctx) return;

  const { targetId, replyId } = req.query as { targetId?: string; replyId?: string };
  if (!targetId && !replyId) return res.status(400).json({ error: "targetId or replyId is required" });

  const db = getDb();
  if (targetId) {
    const contact = db.prepare("SELECT email FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, ctx.workspaceId) as { email: string | null } | undefined;
    if (!contact?.email) return res.status(404).json({ error: "Target has no email" });
  }
  const messages = storedEmailThread(db, ctx.workspaceId, { targetId, replyId });
  if (!messages) return res.status(404).json({ error: targetId ? "Target has no email" : "Reply not found" });
  return res.json({ messages });
}
