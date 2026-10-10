import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";
import { canPublish } from "@/lib/campaigns/builder";
import { draftProblem, getDraft, publishDraft, sequenceOverview, type SequenceDraft } from "@/lib/outreach/publish";

/**
 * Make a sequence the one that runs.
 *
 *   POST {}                            publish the stored draft
 *   POST { steps, gates?, settings? }  publish this sequence directly
 *   POST { ..., force: true }          publish even though the running sequence has changed since the draft was started
 *
 * A member may publish while no contact is part-way through the sequence; with contacts in
 * flight it takes a manager.
 *
 * Steps keep their ids, so statistics and gates stay with their step and every contact
 * part-way through stays on theirs. The answer says how many contacts were in flight and
 * how many had their place carried to a step that moved.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
  // Anyone who can build a campaign can save its sequence while nobody is part-way through
  // it. Once contacts are, changing what happens to them next is a manager's call.
  const inFlight = sequenceOverview(db, workflowId).in_flight;
  if (!canPublish(ctx.role, inFlight)) {
    return res.status(403).json({ error: `${inFlight} ${inFlight === 1 ? "contact is" : "contacts are"} part-way through this sequence. A manager publishes changes to a running campaign; your draft is kept for them.`, required_role: "manager", in_flight: inFlight });
  }

  const stored = getDraft(db, workflowId);
  const inline = Array.isArray(req.body?.steps);
  if (!inline && !stored) return res.status(400).json({ error: "There is no draft to publish" });
  const draft: SequenceDraft = inline ? { steps: req.body.steps, gates: req.body.gates ?? [], settings: req.body.settings } : stored!.draft;

  const version = (db.prepare("SELECT COALESCE(sequence_version, 0) AS v FROM workflows WHERE id = ?").get(workflowId) as { v: number }).v;
  if (!inline && stored!.base_version !== version && req.body?.force !== true) {
    return res.status(409).json({ error: "The running sequence has changed since this draft was started. Review the draft against it, or publish with force to replace it.", base_version: stored!.base_version, published_version: version });
  }
  const problem = draftProblem(db, ctx.workspaceId, workflowId, draft);
  if (problem) return res.status(400).json({ error: problem });

  const result = publishDraft(db, ctx.workspaceId, workflowId, draft);
  recordAudit(ctx, "workflow.published", "workflow", workflowId, { version: result.version, created: result.created.length, deleted: result.deleted.length, in_flight: result.in_flight, moved: result.moved });
  return res.json({ ok: true, ...result });
}
