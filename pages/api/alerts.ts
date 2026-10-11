import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { currentAlerts } from "@/lib/platform/alerts";
import { requireWorkspace } from "@/lib/workspace";

/**
 * GET: what needs attention in the workspace right now, worst first.
 * → { alerts: [{ id, kind, tone: "bad" | "warn", title, detail, action: { label, href } }] }
 *
 * An alert is read from how things stand (a mailbox that paused itself, a LinkedIn account
 * signed out or near its weekly limit, stalled background work, an AI budget used up, DNS
 * failing on a sending domain, prospects stuck on a failed step). It is there while the
 * problem is and gone when it is not; nothing is marked as read.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  return res.json({ alerts: currentAlerts(getDb(), ctx.workspaceId, ctx.role) });
}
