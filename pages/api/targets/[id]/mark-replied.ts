import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { stopAutomation } from "@/lib/community-replies";
import { emitDomainEvent } from "@/lib/platform/events";
import { recordAudit, requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";
import { markRepliedSchema, firstIssue } from "@/lib/validation";

// Record that a contact replied, WITHOUT performing any LinkedIn or IMAP traffic.
//
// LinkedIn reply detection is a premium capability (lib/community-replies.ts stubs
// syncAccountInbox to a no-op), so nothing in this edition ever writes
// targets.last_replied_at. This route lets a human - or an external integration -
// report the reply instead.
//
// Writing last_replied_at is exactly what the runner's pre-step guard checks, so the
// contact is unenrolled from every track on the next tick. We also stop them right
// here so the effect is immediate and the UI is consistent straight away.
//
//   POST /api/targets/{id}/mark-replied   { channel?: "linkedin" | "email", replied_at?: ISO }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;

  const targetId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "targets", targetId)) return;

  const parsed = markRepliedSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
  const { channel, replied_at } = parsed.data;

  const when = replied_at ? new Date(replied_at).toISOString() : new Date().toISOString();
  // Safe interpolation: `channel` is a zod enum, so this resolves to one of two literals.
  const column = channel === "email" ? "email_replied_at" : "last_replied_at";

  const db = getDb();
  // COALESCE so a manual mark never overwrites an earlier, genuine reply timestamp.
  db.prepare(`UPDATE targets SET ${column} = COALESCE(${column}, ?) WHERE id = ? AND workspace_id = ?`)
    .run(when, targetId, ctx.workspaceId);

  stopAutomation(targetId, `Replied on ${channel} - automation stopped`);

  const eventId = emitDomainEvent({
    workspaceId: ctx.workspaceId,
    type: "reply.received",
    entityType: "target",
    entityId: targetId,
    payload: { channel, replied_at: when, source: "manual" },
  });
  recordAudit(ctx, "contact.marked_replied", "target", targetId, { channel, replied_at: when });

  const contact = db
    .prepare("SELECT id, full_name, last_replied_at, email_replied_at FROM targets WHERE id = ? AND workspace_id = ?")
    .get(targetId, ctx.workspaceId);
  const stopped = db
    .prepare(
      `SELECT COUNT(*) AS c FROM run_profile_tracks WHERE state = 'skipped'
         AND run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)`,
    )
    .get(targetId) as { c: number };

  return res.json({ ok: true, channel, event_id: eventId, contact, skipped_tracks: stopped.c });
}
