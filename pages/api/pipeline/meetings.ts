import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { recordAudit, requireWorkspace } from "@/lib/workspace";
import { calendarOAuthAvailability } from "@/lib/platform/calendar-oauth";
import { linkMeeting, listCalendars, listMeetings, meetingCounts } from "@/lib/pipeline/meetings";

/**
 * Meetings for the pipeline screen, and the calendars they come from.
 *
 *   GET    ?when=upcoming|past &match=matched|unmatched|all &page &limit
 *   PATCH  { id, target_id }   say which contact a meeting is with
 *
 * A calendar feed is added, read again and removed through /api/platform/connections; a
 * Google or Microsoft calendar is connected by signing in, from /api/platform/calendar-oauth.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();

  if (req.method === "GET") {
    const when = req.query.when === "past" ? "past" : "upcoming";
    const match = req.query.match === "unmatched" || req.query.match === "all" ? req.query.match : "matched";
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const now = new Date();
    return res.json({
      ...listMeetings(db, ctx.workspaceId, { when, match }, { limit, offset: (page - 1) * limit }, now),
      counts: meetingCounts(db, ctx.workspaceId, now),
      calendars: listCalendars(db, ctx.workspaceId),
      // Whether this server has an app registered with each provider. Without one there is nothing to sign in to.
      sign_in: calendarOAuthAvailability(),
      page, limit,
    });
  }

  if (req.method === "PATCH") {
    const { id, target_id } = (req.body ?? {}) as { id?: unknown; target_id?: unknown };
    if (typeof id !== "string" || !id || typeof target_id !== "string" || !target_id) return res.status(400).json({ error: "id and target_id are required" });
    if (!db.prepare("SELECT 1 FROM targets WHERE id = ? AND workspace_id = ?").get(target_id, ctx.workspaceId)) return res.status(404).json({ error: "Contact not found" });
    if (!linkMeeting(db, ctx.workspaceId, id, target_id)) return res.status(404).json({ error: "Meeting not found" });
    recordAudit(ctx, "meeting.linked", "meeting", id, { target_id });
    return res.json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "PATCH"]);
  return res.status(405).end();
}
