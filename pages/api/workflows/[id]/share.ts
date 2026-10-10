import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { createShare, listShares, revokeShare } from "@/lib/campaigns/share";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";

/**
 * Links that show this campaign's results to someone with no account.
 *   GET     the links there are, live ones first
 *   POST    make one → { share, token, path }   (manager; the token is given once, here)
 *   DELETE  ?share_id=…  switch one off          (manager)
 *
 * A link opens /r/{token}: figures only, never a contact. Making and switching one off are
 * both written to the audit log.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager"); if (!ctx) return;
  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", id)) return;

  if (req.method === "GET") return res.json({ shares: listShares(db, ctx.workspaceId, id) });

  if (req.method === "POST") {
    const made = createShare(db, ctx.workspaceId, id, ctx.userId);
    if ("error" in made) return res.status(400).json({ error: made.error });
    recordAudit(ctx, "workflow.report_shared", "workflow", id, { share_id: made.share.id });
    return res.status(201).json({ share: made.share, token: made.token, path: `/r/${made.token}` });
  }

  if (req.method === "DELETE") {
    const shareId = Array.isArray(req.query.share_id) ? req.query.share_id[0] : req.query.share_id;
    if (!shareId) return res.status(400).json({ error: "share_id is required" });
    if (!revokeShare(db, ctx.workspaceId, id, shareId)) return res.status(404).json({ error: "There is no live link by that id" });
    recordAudit(ctx, "workflow.report_share_revoked", "workflow", id, { share_id: shareId });
    return res.json({ ok: true, shares: listShares(db, ctx.workspaceId, id) });
  }

  res.setHeader("Allow", ["GET", "POST", "DELETE"]);
  return res.status(405).end();
}
