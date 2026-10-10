import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";
import { campaignAnalytics } from "@/lib/reporting/campaign-analytics";
import { BREAKDOWNS, campaignBreakdown, isBreakdown } from "@/lib/reporting/breakdown";
import { parseRange } from "@/lib/reporting/range";

// ?from=&to= (YYYY-MM-DD) name a period; without them the report is for all time and
// ?days= sets how far back its charts go. ?breakdown= adds the sends split by step,
// sender, linkedin_account, template or variant.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx=requireWorkspace(req,res); if(!ctx)return;
  if (req.method !== "GET") return res.status(405).end();

  try {
    const workflowId = req.query.id as string;
    if(!requireWorkspaceEntity(res,ctx,"workflows",workflowId))return;
    const range = parseRange(req.query);
    if (typeof range === "string") return res.status(400).json({ error: range });
    const by = req.query.breakdown;
    if (by !== undefined && by !== "" && !isBreakdown(by)) return res.status(400).json({ error: `breakdown must be one of: ${BREAKDOWNS.join(", ")}` });
    const db = getDb();
    res.json({ ...campaignAnalytics(db, workflowId, range), ...(isBreakdown(by) ? { breakdown: campaignBreakdown(db, workflowId, by, range) } : {}) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load analytics" });
  }
}
