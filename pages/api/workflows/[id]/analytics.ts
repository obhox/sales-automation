import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";
import { analyticsDays, campaignAnalytics } from "@/lib/reporting/campaign-analytics";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx=requireWorkspace(req,res); if(!ctx)return;
  if (req.method !== "GET") return res.status(405).end();

  try {
    const workflowId = req.query.id as string;
    if(!requireWorkspaceEntity(res,ctx,"workflows",workflowId))return;
    res.json(campaignAnalytics(getDb(), workflowId, analyticsDays(req.query.days)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load analytics" });
  }
}
