import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { isActivityGroup, listActivity } from "@/lib/pipeline/activity";

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * What has happened in the pipeline, newest first, with who did it.
 *
 *   GET ?group=deals|tasks|meetings|notes &actor=<member id>|me &target_id &opportunity_id &page &limit
 *
 * A note or a call is logged through /api/activity-logs.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  const group = text(req.query.group);
  const actor = text(req.query.actor);
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  return res.json({
    ...listActivity(getDb(), ctx.workspaceId, {
      group: isActivityGroup(group) ? group : null,
      actor: actor === "all" ? null : actor === "me" ? ctx.userId ?? "none" : actor,
      target_id: text(req.query.target_id), opportunity_id: text(req.query.opportunity_id),
    }, { limit, offset: (page - 1) * limit }),
    page, limit,
  });
}
