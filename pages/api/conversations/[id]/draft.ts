// What a member has typed in a conversation and not sent. One per member and conversation,
// saved as they type so it is there when they come back.
//
//   PUT    /api/conversations/:id/draft { channel, body, subject?, email_account_id?, linkedin_account_id? }
//   DELETE /api/conversations/:id/draft     throw it away, with any files added to it
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { conversationById } from "@/lib/conversations/rows";
import { clearDraft, draftAttachments, saveDraft } from "@/lib/conversations/store";
import { requireWorkspace } from "@/lib/workspace";

const MAX_DRAFT = 50_000;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PUT" && req.method !== "DELETE") {
    res.setHeader("Allow", ["PUT", "DELETE"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  if (!ctx.userId) return res.status(403).json({ error: "A draft belongs to a member" });
  const db = getDb();
  const conversation = conversationById(db, ctx.workspaceId, String(req.query.id ?? ""));
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  if (req.method === "DELETE") {
    clearDraft(db, conversation.id, ctx.userId);
    return res.status(204).end();
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = typeof body.body === "string" ? body.body : "";
  if (text.length > MAX_DRAFT) return res.status(400).json({ error: "That is too long to keep as a draft" });
  const draft = saveDraft(db, conversation.id, ctx.userId, {
    channel: body.channel === "linkedin" ? "linkedin" : "email", body: text, subject: typeof body.subject === "string" ? body.subject.slice(0, 500) : null,
    email_account_id: typeof body.email_account_id === "string" ? body.email_account_id : null,
    linkedin_account_id: typeof body.linkedin_account_id === "string" ? body.linkedin_account_id : null,
  });
  return res.json({ draft: draft ? { ...draft, attachments: draftAttachments(db, conversation.id, ctx.userId) } : null });
}
