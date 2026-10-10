import type { NextApiRequest, NextApiResponse } from "next";
import { listNotifications, markNotificationsRead, unreadNotificationCount } from "@/lib/platform/notifications";
import { requireWorkspace } from "@/lib/workspace";

// The list behind the bell, for the signed-in member in the current workspace.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  if (!ctx.userId) return res.status(403).json({ error: "Notifications are for signed-in members" });

  if (req.method === "GET") {
    return res.json({
      notifications: listNotifications(ctx.workspaceId, ctx.userId, ctx.role),
      unread: unreadNotificationCount(ctx.workspaceId, ctx.userId, ctx.role),
    });
  }

  // Marking as read changes nothing but the member's own view, so a viewer may do it too.
  if (req.method === "POST") {
    const body = (req.body ?? {}) as { action?: string; id?: string };
    if (body.action === "read_all") {
      markNotificationsRead(ctx.workspaceId, ctx.userId, ctx.role);
    } else if (body.action === "read" && typeof body.id === "string" && body.id) {
      markNotificationsRead(ctx.workspaceId, ctx.userId, ctx.role, body.id);
    } else {
      return res.status(400).json({ error: 'action must be "read" (with an id) or "read_all"' });
    }
    return res.json({ unread: unreadNotificationCount(ctx.workspaceId, ctx.userId, ctx.role) });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
}
