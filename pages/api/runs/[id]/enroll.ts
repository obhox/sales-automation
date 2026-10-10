import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { assignEmailAccounts, enrollTargets, workflowTracks as campaignTracks } from "@/lib/outreach/enroll";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx=requireWorkspace(req,res,"manager"); if(!ctx)return;

  const db = getDb();
  const runId = req.query.id as string;
  if(!requireWorkspaceEntity(res,ctx,"runs",runId))return;
  const { target_ids } = req.body as { target_ids?: string[] };

  if (!Array.isArray(target_ids) || target_ids.length === 0) {
    return res.status(400).json({ error: "target_ids required" });
  }
  const targetPlaceholders=target_ids.map(()=>"?").join(",");
  const ownedCount=(db.prepare(`SELECT COUNT(*) c FROM targets WHERE workspace_id=? AND id IN (${targetPlaceholders})`).get(ctx.workspaceId,...target_ids) as {c:number}).c;
  if(ownedCount!==target_ids.length) return res.status(400).json({error:"One or more contacts are outside this workspace"});

  const run = db
    .prepare("SELECT id, workflow_id FROM runs WHERE id = ? AND workspace_id = ?")
    .get(runId, ctx.workspaceId) as { id: string; workflow_id: string } | undefined;
  if (!run) return res.status(404).json({ error: "run_not_found" });

  // Tracks defined on this workflow
  const workflowTracks = campaignTracks(db, run.workflow_id);

  // Existing email-account pool for this run (used as round-robin pool for new enrollments)
  const emailAccountPool: string[] = (db
    .prepare(
      `SELECT DISTINCT email_account_id FROM run_profiles
       WHERE run_id = ? AND email_account_id IS NOT NULL`
    )
    .all(runId) as Array<{ email_account_id: string }>).map((r) => r.email_account_id);

  // Dedup: already enrolled in this workflow at all
  const alreadyEnrolled = new Set(
    (db
      .prepare(
        `SELECT DISTINCT rp.target_id FROM run_profiles rp
         JOIN runs r ON r.id = rp.run_id
         WHERE r.workflow_id = ?`
      )
      .all(run.workflow_id) as { target_id: string }[]).map((r) => r.target_id)
  );

  // Active elsewhere (in some other running/paused run with an in-progress track)
  const activeElsewhere = new Set(
    (db
      .prepare(
        `SELECT DISTINCT rp.target_id FROM run_profiles rp
         JOIN runs r ON r.id = rp.run_id
         WHERE r.status IN ('running', 'paused') AND r.workspace_id = ?
         AND EXISTS (
           SELECT 1 FROM run_profile_tracks rt
           WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped')
         )`
      )
      .all(ctx.workspaceId) as { target_id: string }[]).map((r) => r.target_id)
  );

  let skipped_already_enrolled = 0;
  let skipped_active_elsewhere = 0;
  const eligible: string[] = [];
  for (const tid of target_ids) {
    if (alreadyEnrolled.has(tid)) { skipped_already_enrolled++; continue; }
    if (activeElsewhere.has(tid)) { skipped_active_elsewhere++; continue; }
    eligible.push(tid);
  }

  if (eligible.length === 0) {
    return res.json({ enrolled: 0, skipped_already_enrolled, skipped_active_elsewhere });
  }

  // Same assignment and the same rows as starting a run.
  const emailAssignment = assignEmailAccounts(db, eligible, emailAccountPool);
  db.transaction(() => enrollTargets(db, runId, workflowTracks, eligible, emailAssignment))();

  return res.json({
    enrolled: eligible.length,
    skipped_already_enrolled,
    skipped_active_elsewhere,
  });
}
