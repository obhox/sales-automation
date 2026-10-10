// Mark conversations as read by the member asking: all the unread ones, or those named.
//
//   POST /api/conversations/read { conversation_ids?: string[] }   → { ok, marked }
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { markAllRead } from "@/lib/conversations/store";
import { requireWorkspace } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  // Read state is the member's own, so a viewer may clear theirs too.
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  if (!ctx.userId) return res.status(403).json({ error: "Read state is kept per member" });
  const ids = Array.isArray((req.body as { conversation_ids?: unknown } | undefined)?.conversation_ids)
    ? ((req.body as { conversation_ids: unknown[] }).conversation_ids).map(String).slice(0, 500)
    : undefined;
  return res.json({ ok: true, marked: markAllRead(getDb(), ctx.workspaceId, ctx.userId, ids) });
}
