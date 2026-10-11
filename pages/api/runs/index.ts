import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { checkAccountPool, isLinkedinRotation } from "@/lib/outreach/enroll";
import { createRun, isOverlapChoice } from "@/lib/outreach/launch";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager");
  if (!ctx) return;

  if (req.method === "GET") {
    const runs = db
      .prepare(
        `SELECT r.*,
                w.name as workflow_name,
                l.name as list_name,
                a.name as account_name,
                (SELECT COUNT(*) FROM run_accounts ra WHERE ra.run_id = r.id) as linkedin_pool_size,
                COUNT(DISTINCT rp.id) as total_profiles,
                COUNT(DISTINCT CASE WHEN NOT EXISTS (
                  SELECT 1 FROM run_profile_tracks rt2
                  WHERE rt2.run_profile_id = rp.id AND rt2.state NOT IN ('completed', 'failed', 'skipped')
                ) AND EXISTS (
                  SELECT 1 FROM run_profile_tracks rt3
                  WHERE rt3.run_profile_id = rp.id AND rt3.state = 'completed'
                ) THEN rp.id END) as completed_profiles,
                -- The runner heartbeats at the top of each poll AND after every profile it
                -- processes. A run that claims to be running but has not been ticked in this
                -- long is wedged, not idle — surfacing this is what turns a silent two-day
                -- stall into something visible.
                -- The window must exceed the longest legitimate gap between two heartbeats,
                -- which is one step at its watchdog budget (300s) plus the delay after it.
                -- An earlier 5-minute window sat BELOW that and flagged a runner that was
                -- simply working through a backlog.
                CASE WHEN r.status = 'running'
                       AND (r.last_tick_at IS NULL
                            OR r.last_tick_at < datetime('now', '-12 minutes'))
                     THEN 1 ELSE 0 END as runner_stale
         FROM runs r
         LEFT JOIN workflows w ON w.id = r.workflow_id
         LEFT JOIN lists l ON l.id = r.list_id
         LEFT JOIN accounts a ON a.id = r.account_id
         LEFT JOIN run_profiles rp ON rp.run_id = r.id
         WHERE r.workspace_id = ?
         GROUP BY r.id
         ORDER BY r.created_at DESC`
      )
      .all(ctx.workspaceId);
    return res.json(runs);
  }

  if (req.method === "POST") {
    const { workflow_id, list_id, email_account_id, email_account_ids, target_ids } = req.body;
    if (!workflow_id || !list_id)
      return res.status(400).json({ error: "workflow_id and list_id required" });
    // One LinkedIn account (account_id, as always) or several (account_ids). Several are a
    // pool: each contact is given one of them and stays with it. One account sent as a
    // list is still just one account.
    let linkedinPool: string[] = [];
    if (req.body.account_ids !== undefined) {
      const checked = checkAccountPool(db, ctx.workspaceId, req.body.account_ids);
      if (!Array.isArray(checked)) return res.status(400).json({ error: checked.error });
      linkedinPool = checked;
    }
    if (req.body.linkedin_rotation != null && !isLinkedinRotation(req.body.linkedin_rotation)) {
      return res.status(400).json({ error: "linkedin_rotation must be round_robin or capacity" });
    }
    if (req.body.overlap != null && !isOverlapChoice(req.body.overlap)) return res.status(400).json({ error: "overlap must be skip or take_over" });
    // Normalise the mailbox list: prefer the array, fall back to the single id.
    const emailAccountPool: string[] = Array.isArray(email_account_ids) && email_account_ids.length > 0 ? email_account_ids : (email_account_id ? [email_account_id] : []);

    // exclude and overlap are new and optional: without them a run is created as it always was.
    const result = createRun(db, ctx.workspaceId, {
      workflowId: workflow_id, listId: list_id, linkedinPool, linkedinAccountId: req.body.account_id,
      rotation: isLinkedinRotation(req.body.linkedin_rotation) ? req.body.linkedin_rotation : "round_robin",
      emailAccountIds: emailAccountPool, targetIds: Array.isArray(target_ids) ? target_ids : undefined,
      exclude: req.body.exclude && typeof req.body.exclude === "object" ? { customers: req.body.exclude.customers === true, open_deals: req.body.exclude.open_deals === true } : undefined,
      overlap: req.body.overlap ?? undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.message ? { message: result.message } : {}) });

    recordAudit(ctx, "run.created", "run", result.id, {
      workflow_id, list_id, enrolled: result.enrolled, email_verification: result.email_verification,
      ...(linkedinPool.length > 1 ? { linkedin_accounts: linkedinPool.length, linkedin_rotation: req.body.linkedin_rotation ?? "round_robin" } : {}),
      ...(result.taken_over > 0 ? { taken_over: result.taken_over } : {}),
      ...(result.audience.excluded > 0 ? { excluded: result.audience.excluded } : {}),
    });
    return res.status(201).json({
      id: result.id,
      enrolled: result.enrolled,
      // How the contacts were shared out, when the campaign has several LinkedIn accounts.
      ...(result.linkedin_accounts ? { linkedin_accounts: result.linkedin_accounts } : {}),
      email_verification: result.email_verification,
      // Reported separately because these contacts are enrolled but will be unenrolled from
      // the email track on their first due step, without ever being emailed.
      email_will_not_send: result.email_will_not_send,
      ...(result.taken_over > 0 ? { taken_over: result.taken_over } : {}),
      ...(result.audience.excluded > 0 ? { excluded: result.audience.excluded } : {}),
    });
  }

  res.status(405).end();
}
