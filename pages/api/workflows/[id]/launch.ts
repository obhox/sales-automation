import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { prelaunch } from "@/lib/campaigns/setup";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { createRun } from "@/lib/outreach/launch";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";

/**
 * Launch a campaign as it is set up: enrol its audience and start sending.
 *   POST {}  → { ok, run_id, enrolled, excluded, taken_over, checks }
 *
 * Refused with the checks when anything blocks it (GET …/prelaunch shows them first).
 * Contacts already in this campaign are never enrolled twice; customers and open deals are
 * left out when the setup says so; a contact part-way through another campaign is skipped,
 * or taken over with their steps there held, as the setup says.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "manager"); if (!ctx) return;
  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", id)) return;
  if ((db.prepare("SELECT is_archived FROM workflows WHERE id = ?").get(id) as { is_archived: number | null }).is_archived) {
    return res.status(400).json({ error: "This campaign is archived. Bring it back before launching it." });
  }

  const ready = prelaunch(db, ctx.workspaceId, id);
  const blocking = ready.checks.filter((check) => check.state === "block");
  if (blocking.length > 0) return res.status(400).json({ error: blocking[0].detail, outcome: "not_ready", checks: ready.checks });

  const { setup } = ready;
  const created = createRun(db, ctx.workspaceId, {
    workflowId: id, listId: setup.list_id!, linkedinPool: ready.tracks.includes("linkedin") ? setup.account_ids : [], rotation: setup.rotation,
    emailAccountIds: setup.email_account_ids, exclude: setup.exclude, overlap: setup.overlap,
  });
  if (!created.ok) return res.status(created.status).json({ error: created.message ?? created.error, outcome: created.error });

  db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(created.id);
  recordAudit(ctx, "run.created", "run", created.id, {
    workflow_id: id, list_id: setup.list_id, enrolled: created.enrolled, email_verification: created.email_verification, launched: true,
    ...(setup.account_ids.length > 1 ? { linkedin_accounts: setup.account_ids.length, linkedin_rotation: setup.rotation } : {}),
    ...(created.taken_over > 0 ? { taken_over: created.taken_over } : {}), ...(created.audience.excluded > 0 ? { excluded: created.audience.excluded } : {}),
  });
  recordAudit(ctx, "run.started", "run", created.id);
  ensureGlobalRunnerStarted();

  return res.status(201).json({
    ok: true, run_id: created.id, enrolled: created.enrolled, excluded: created.audience.excluded, taken_over: created.taken_over,
    skipped_in_other_campaigns: setup.overlap === "skip" ? created.audience.overlapping : 0,
    email_will_not_send: created.email_will_not_send, checks: ready.checks,
  });
}
