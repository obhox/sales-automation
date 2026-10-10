import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { assignEmailAccounts, enrollTargets, workflowTracks as campaignTracks } from "@/lib/outreach/enroll";
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
    const { workflow_id, list_id, account_id, email_account_id, email_account_ids, target_ids } = req.body;
    if (!workflow_id || !list_id)
      return res.status(400).json({ error: "workflow_id and list_id required" });
    const owned = db.prepare(`SELECT
      EXISTS(SELECT 1 FROM workflows WHERE id = ? AND workspace_id = ?) AS workflow_ok,
      EXISTS(SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?) AS list_ok,
      EXISTS(SELECT 1 FROM accounts WHERE id = ? AND workspace_id = ?) AS account_ok`
    ).get(workflow_id, ctx.workspaceId, list_id, ctx.workspaceId, account_id ?? null, ctx.workspaceId) as { workflow_ok: number; list_ok: number; account_ok: number };
    if (!owned.workflow_ok || !owned.list_ok || (account_id && !owned.account_ok)) return res.status(404).json({ error: "Workflow, list, or sender not found in this workspace" });

    // Normalise email account list — prefer the new array, fall back to legacy single-id
    const emailAccountPool: string[] = Array.isArray(email_account_ids) && email_account_ids.length > 0
      ? email_account_ids
      : (email_account_id ? [email_account_id] : []);
    if (emailAccountPool.length > 0) {
      const ownedMailboxes = (db.prepare(`SELECT COUNT(*) c FROM email_accounts WHERE workspace_id = ? AND id IN (${emailAccountPool.map(() => "?").join(",")})`)
        .get(ctx.workspaceId, ...emailAccountPool) as { c: number }).c;
      if (ownedMailboxes !== new Set(emailAccountPool).size) return res.status(404).json({ error: "Workflow, list, or sender not found in this workspace" });
    }

    // A campaign needs a sender for each channel it has steps on, and only for those: one
    // with no LinkedIn steps runs without a LinkedIn account.
    const tracks = campaignTracks(db, workflow_id);
    if (tracks.includes("linkedin") && !account_id) {
      return res.status(400).json({ error: "linkedin_account_required", message: "This campaign has LinkedIn steps. Choose a LinkedIn account to run them from." });
    }
    if (!tracks.includes("linkedin") && emailAccountPool.length === 0) {
      return res.status(400).json({ error: "email_account_required", message: "This campaign only sends email. Choose at least one mailbox to send from." });
    }
    const linkedinAccountId: string | null = account_id ?? null;

    // Check 1: only one active run per workflow
    const activeRun = db.prepare(
      "SELECT id FROM runs WHERE workflow_id = ? AND workspace_id = ? AND status IN ('running', 'paused') LIMIT 1"
    ).get(workflow_id, ctx.workspaceId) as { id: string } | undefined;
    if (activeRun) {
      return res.status(400).json({
        error: "workflow_already_active",
        message: "This workflow is already running. Stop or pause it before enrolling a new list.",
      });
    }

    // Compute who can actually be enrolled BEFORE creating anything, so a no-op enroll (or a
    // failure part-way) never leaves an orphaned run or a stranded enrollment record.
    const runId = randomUUID();

    // Candidate targets — either the selected ids or all targets in the list
    const candidates: { target_id: string }[] = Array.isArray(target_ids) && target_ids.length > 0
      ? (target_ids as string[]).map((id) => ({ target_id: id }))
      : db.prepare("SELECT lt.target_id FROM list_targets lt JOIN targets t ON t.id = lt.target_id WHERE lt.list_id = ? AND t.workspace_id = ?").all(list_id, ctx.workspaceId) as { target_id: string }[];

    // Exclude targets already enrolled in any run of this workflow
    const alreadyEnrolled = new Set(
      (db.prepare(
        `SELECT DISTINCT rp.target_id FROM run_profiles rp
         JOIN runs r ON r.id = rp.run_id
         WHERE r.workflow_id = ? AND r.workspace_id = ?`
      ).all(workflow_id, ctx.workspaceId) as { target_id: string }[]).map((r) => r.target_id)
    );

    // Exclude targets currently active in any other running/paused workflow
    const activeElsewhere = new Set(
      (db.prepare(
        `SELECT DISTINCT rp.target_id FROM run_profiles rp
         JOIN runs r ON r.id = rp.run_id
         WHERE r.status IN ('running', 'paused') AND r.workspace_id = ?
         AND EXISTS (
           SELECT 1 FROM run_profile_tracks rt
           WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped')
         )`
      ).all(ctx.workspaceId) as { target_id: string }[]).map((r) => r.target_id)
    );

    const targets = candidates.filter((t) => !alreadyEnrolled.has(t.target_id) && !activeElsewhere.has(t.target_id));

    if (targets.length === 0) {
      // No run was ever created, so there's nothing to clean up and nothing is left enrolled.
      return res.status(400).json({
        error: "all_already_enrolled",
        message: "All selected contacts are already enrolled in this workflow.",
      });
    }

    // Company-grouped round-robin over the mailbox pool, then the run and every enrolment in
    // ONE transaction: any failure rolls back the run AND its enrollments together, so
    // neither can be left orphaned.
    const emailAssignment = assignEmailAccounts(db, targets.map((t) => t.target_id), emailAccountPool);
    db.transaction(() => {
      db.prepare("INSERT INTO runs (id, workspace_id, workflow_id, list_id, account_id, email_account_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(runId, ctx.workspaceId, workflow_id, list_id, linkedinAccountId, emailAccountPool[0] ?? null);
      enrollTargets(db, runId, tracks, targets.map((t) => t.target_id), emailAssignment);
    })();
    const workflowTracks = tracks;

    // Verification mix of everything just enrolled on the email track. Nothing is blocked
    // here — the runner probes each address for real immediately before its send and skips
    // the dead and catch-all ones — but enrolling a list is the moment someone can still act
    // on it, and until now the mix was invisible: lists routinely carry a blend of verified,
    // unverified, catch-all and known-invalid addresses with no indication anywhere.
    const emailMix = workflowTracks.includes("email")
      ? (db.prepare(
          `SELECT COALESCE(NULLIF(t.email_status, ''), 'unverified') AS status, COUNT(*) AS count
             FROM run_profiles rp JOIN targets t ON t.id = rp.target_id
            WHERE rp.run_id = ? AND t.email IS NOT NULL AND t.email != ''
            GROUP BY status`,
        ).all(runId) as { status: string; count: number }[])
      : [];
    const emailVerification = Object.fromEntries(emailMix.map((r) => [r.status, r.count]));
    const willNotSend = (emailVerification.invalid ?? 0) + (emailVerification.catchall ?? 0);

    recordAudit(ctx, "run.created", "run", runId, { workflow_id, list_id, enrolled: targets.length, email_verification: emailVerification });
    return res.status(201).json({
      id: runId,
      enrolled: targets.length,
      email_verification: emailVerification,
      // Reported separately because these contacts are enrolled but will be unenrolled from
      // the email track on their first due step, without ever being emailed.
      email_will_not_send: willNotSend,
    });
  }

  res.status(405).end();
}
