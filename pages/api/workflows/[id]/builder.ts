import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { builderData } from "@/lib/campaigns/builder";
import { requireWorkspace } from "@/lib/workspace";

/**
 * GET: what the sequence builder shows for one campaign. The campaign and its figures, the
 * published sequence with who is standing where, the draft if someone has one going, what
 * each step and each A/B version has sent, and the templates, lists, custom fields and
 * senders a step can refer to.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const data = builderData(getDb(), ctx.workspaceId, req.query.id as string, ctx.role);
  if (!data) return res.status(404).json({ error: "Resource not found" });
  return res.json(data);
}
