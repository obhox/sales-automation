import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { campaignOverview, isOverviewChannel, isOverviewRange, OVERVIEW_CHANNELS, OVERVIEW_RANGES } from "@/lib/campaigns/overview";
import { campaignSummaries } from "@/lib/campaigns/summary";
import { requireWorkspace } from "@/lib/workspace";

/**
 * GET: a campaign's Overview tab.
 *   ?range=7d|14d|30d|all (default 14d)   what was sent in that time, and what came of it
 *   ?channel=both|linkedin|email (default both)
 *
 * Five rates, each with the same rate for the period before; sends and replies by day;
 * the funnel for both channels and for each; every email's A/B versions with how sure the
 * gap between the best two is and how many sends it still needs; and the opens split into
 * people and machines. A reply counts for the period of the message it answers. The
 * funnel and the A/B versions are for the whole campaign, whatever the period.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const db = getDb();
  const id = req.query.id as string;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const range = one(req.query.range) ?? "14d";
  const channel = one(req.query.channel) ?? "both";
  if (!isOverviewRange(range)) return res.status(400).json({ error: `range must be one of ${OVERVIEW_RANGES.join(", ")}` });
  if (!isOverviewChannel(channel)) return res.status(400).json({ error: `channel must be one of ${OVERVIEW_CHANNELS.join(", ")}` });
  const campaign = campaignSummaries(db, ctx.workspaceId).find((candidate) => candidate.id === id);
  if (!campaign) return res.status(404).json({ error: "Resource not found" });
  return res.json({ campaign, overview: campaignOverview(db, ctx.workspaceId, id, { range, channel }) });
}
