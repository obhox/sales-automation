import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { prelaunch } from "@/lib/campaigns/setup";
import { overlappingContacts } from "@/lib/outreach/launch";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

/**
 * GET: is this campaign ready to launch, and what would launching it do?
 *
 * The audience on the chosen list (how many would be enrolled, how many are left out as
 * customers or open deals, how many are part-way through another campaign and which), six
 * checks each saying ok, warn or block, the sending capacity of the chosen senders, and
 * what the AI writing is likely to cost. Nothing is changed.
 *
 * ?overlaps=1 adds the contacts who are in another campaign, by name, for review.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", id)) return;
  const result = prelaunch(db, ctx.workspaceId, id);
  const wantsOverlaps = req.query.overlaps === "1" && result.list;
  return res.json({ ...result, ...(wantsOverlaps ? { overlapping_contacts: overlappingContacts(db, ctx.workspaceId, id, result.list!.id) } : {}) });
}
