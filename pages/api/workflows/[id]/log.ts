import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { campaignLog } from "@/lib/campaigns/prospects";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

/**
 * GET: what a campaign has done, newest first: every send, skip, wait and failure the
 * runner wrote down, with the contact it was about.
 *   ?limit=50 (up to 200)   ?before={id of the last entry shown}   ?level=warn|error
 * → { entries: [{ id, level, message, created_at, target_id, contact }], more }
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return res.json(campaignLog(db, ctx.workspaceId, workflowId, { limit: Number(one(req.query.limit)) || undefined, before: one(req.query.before), level: one(req.query.level) }));
}
