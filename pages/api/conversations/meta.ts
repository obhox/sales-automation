// What the inbox screen needs beside the conversations themselves: who can be assigned,
// the tags and saved replies, the merge tags an answer can use, the booking link, and
// which paid capabilities this build has.
//
//   GET /api/conversations/meta
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { inboxCapabilities, type InboxCapabilities } from "@/lib/conversations/capabilities";
import { mergeTagsFor, type MergeTag } from "@/lib/conversations/merge-tags";
import { getBookingUrl } from "@/lib/platform/booking";
import { requireWorkspace } from "@/lib/workspace";
import { nameFromEmail } from "@/pages/api/shell";

export interface InboxMeta {
  /** The member asking. Null for a call made with an API key. */
  me: string | null;
  members: Array<{ id: string; name: string; email: string; role: string }>;
  tags: Array<{ id: string; name: string; color: string; conversations: number }>;
  saved_replies: Array<{ id: string; name: string; body: string }>;
  merge_tags: MergeTag[];
  /** The page a contact is sent to to pick a meeting time. Set by an admin; null until then. */
  booking_url: string | null;
  capabilities: InboxCapabilities;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  const db = getDb();
  const members = (db.prepare(`SELECT u.id, u.name, u.email, wm.role FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? ORDER BY COALESCE(NULLIF(u.name, ''), u.email)`).all(ctx.workspaceId) as Array<{ id: string; name: string | null; email: string; role: string }>)
    .map((member) => ({ ...member, name: member.name?.trim() || nameFromEmail(member.email) }));
  const meta: InboxMeta = {
    me: ctx.userId,
    members,
    tags: db.prepare(`SELECT it.id, it.name, it.color, (SELECT COUNT(*) FROM conversation_tags ct WHERE ct.tag_id = it.id) AS conversations
      FROM inbox_tags it WHERE it.workspace_id = ? ORDER BY it.name`).all(ctx.workspaceId) as InboxMeta["tags"],
    saved_replies: db.prepare("SELECT id, name, body FROM saved_replies WHERE workspace_id = ? ORDER BY name").all(ctx.workspaceId) as InboxMeta["saved_replies"],
    merge_tags: mergeTagsFor(db, ctx.workspaceId),
    booking_url: getBookingUrl(ctx.workspaceId, db),
    capabilities: inboxCapabilities(),
  };
  return res.json(meta);
}
