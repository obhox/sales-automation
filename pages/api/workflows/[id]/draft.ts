import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";
import { discardDraft, draftShapeProblem, getDraft, loadSequence, saveDraft, type SequenceDraft } from "@/lib/outreach/publish";

/**
 * The sequence an editor is working on, kept apart from the one that is running.
 *
 *   GET     the draft if there is one, else the published sequence, with which it is
 *   PUT     { steps, gates?, settings? }   keep the draft (it may be unfinished)
 *   DELETE  discard it
 *
 * Nothing here changes what the runner does. POST /api/workflows/{id}/publish does that.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member"); if (!ctx) return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
  const version = (db.prepare("SELECT COALESCE(sequence_version, 0) AS v FROM workflows WHERE id = ?").get(workflowId) as { v: number }).v;

  if (req.method === "GET") {
    const stored = getDraft(db, workflowId);
    return res.json(stored
      ? { has_draft: true, ...stored, published_version: version, stale: stored.base_version !== version }
      : { has_draft: false, draft: loadSequence(db, workflowId), base_version: version, published_version: version, stale: false, updated_by: null, updated_at: null });
  }

  if (req.method === "PUT") {
    const problem = draftShapeProblem(req.body);
    if (problem) return res.status(400).json({ error: problem });
    const { steps, gates, settings } = req.body as SequenceDraft;
    const stored = saveDraft(db, ctx.workspaceId, workflowId, ctx.userId, { steps, gates: gates ?? [], settings });
    return res.json({ ok: true, base_version: stored.base_version, published_version: version, stale: stored.base_version !== version, updated_at: stored.updated_at });
  }

  if (req.method === "DELETE") {
    return res.json({ ok: true, discarded: discardDraft(db, workflowId) });
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end();
}
