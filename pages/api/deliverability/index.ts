import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { deliverabilityOverview } from "@/lib/email/deliverability-overview";
import { requireWorkspace } from "@/lib/workspace";

/**
 * GET ?domain=&range= : what the Deliverability screen reads. `domain` is one of the
 * workspace's sending domains (the one with most mailboxes when left out); `range` is 7,
 * 30 or 90 days and applies to the four figures.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const domain = typeof req.query.domain === "string" ? req.query.domain : null;
  return res.json(deliverabilityOverview(getDb(), ctx.workspaceId, { domain, range: req.query.range }));
}
