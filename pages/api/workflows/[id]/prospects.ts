import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { actOnProspects, addProspects, campaignProspects, PROSPECT_ACTIONS, type ProspectAction } from "@/lib/campaigns/prospects";
import { campaignSummaries } from "@/lib/campaigns/summary";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";

/**
 * Everyone a campaign has enrolled, and what can be done to them.
 *
 *   GET   ?page=1&limit=25&sort=status|name|enrolled|next[:asc|desc]&q=&status=&step_id=&run_id=
 *         → { campaign, prospects, total, page, limit, counts, steps, runs }
 *         status is one or more (comma-separated) of active, held, failed, replied,
 *         completed, skipped. step_id is "standing on this step now". counts are for the
 *         whole campaign; steps carry how many contacts stand on each. The older filters
 *         (state, step with track, search) are still understood.
 *   POST  { action: "retry" | "unenroll" | "remove", ids: [enrolment ids] }   (manager)
 *         → { changed, asked, waiting }
 *         retry puts failed steps back in line; unenroll stops a contact's remaining
 *         steps; remove takes the enrolment out of the campaign altogether.
 *   POST  { action: "add", list_id } or { action: "add", target_ids: [...] }   (manager)
 *         → { run_id, asked, enrolled, already_enrolled, excluded, in_another_campaign }
 *         enrols more contacts in the campaign's run in flight. It must be running or paused.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager"); if (!ctx) return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;

  // The campaign comes along so the page can draw its name, status and tabs from the one request.
  if (req.method === "GET") return res.json({ campaign: campaignSummaries(db, ctx.workspaceId).find((candidate) => candidate.id === workflowId), ...campaignProspects(db, ctx.workspaceId, workflowId, req.query) });

  const body = (req.body ?? {}) as { action?: unknown; ids?: unknown; list_id?: unknown; target_ids?: unknown };
  if (body.action === "add") {
    const added = addProspects(db, ctx.workspaceId, workflowId, body);
    if (!added.ok) return res.status(added.status).json({ error: added.error });
    recordAudit(ctx, "workflow.prospects_added", "workflow", workflowId, { run_id: added.run_id, enrolled: added.enrolled, list_id: typeof body.list_id === "string" ? body.list_id : undefined });
    return res.json({ run_id: added.run_id, asked: added.asked, enrolled: added.enrolled, already_enrolled: added.already_enrolled, excluded: added.excluded, in_another_campaign: added.in_another_campaign });
  }
  if (!(PROSPECT_ACTIONS as readonly unknown[]).includes(body.action)) return res.status(400).json({ error: `action must be one of ${[...PROSPECT_ACTIONS, "add"].join(", ")}` });
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((id) => typeof id !== "string")) return res.status(400).json({ error: "ids must be a list of enrolment ids" });
  const action = body.action as ProspectAction;
  const result = actOnProspects(db, ctx.workspaceId, workflowId, action, body.ids as string[]);
  if (result.changed > 0) recordAudit(ctx, `workflow.prospects_${action === "retry" ? "retried" : action === "unenroll" ? "unenrolled" : "removed"}`, "workflow", workflowId, { contacts: result.changed });
  return res.json(result);
}
