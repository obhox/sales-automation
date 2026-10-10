// Ending an email step's A/B test: one version keeps sending and the rest are paused, or
// the test is reopened and all of them send again. Paused versions keep their results.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { recordAudit, requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") { res.setHeader("Allow", ["POST"]); return res.status(405).end(); }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
  const stepId = req.query.stepId as string;
  const step = db.prepare("SELECT track FROM workflow_steps WHERE id = ? AND workflow_id = ?").get(stepId, workflowId) as { track: string } | undefined;
  if (!step) return res.status(404).json({ error: "Step not found" });
  const variants = (db.prepare("SELECT id FROM workflow_step_email_variants WHERE step_id = ?").all(stepId) as Array<{ id: string }>).map((row) => row.id);
  if (step.track !== "email" || variants.length === 0) return res.status(400).json({ error: "This step has no A/B test to end" });

  const body = (req.body ?? {}) as { variant_id?: unknown; clear?: unknown };
  if (!body.clear && body.variant_id === undefined) return res.status(400).json({ error: "Name the winner with variant_id (null for the step's original wording), or send clear to reopen the test" });
  // null names the step's own wording, which is version A.
  const winner = body.clear ? undefined : body.variant_id === null ? null : String(body.variant_id);
  if (typeof winner === "string" && !variants.includes(winner)) return res.status(400).json({ error: "That version does not belong to this step" });

  db.transaction(() => {
    if (winner === undefined) {
      db.prepare("UPDATE workflow_step_email_variants SET disabled_at = NULL WHERE step_id = ?").run(stepId);
      db.prepare("UPDATE workflow_steps SET email_control_disabled = 0 WHERE id = ?").run(stepId);
      return;
    }
    // A version paused earlier keeps the time it was first paused.
    db.prepare("UPDATE workflow_step_email_variants SET disabled_at = CASE WHEN id IS ? THEN NULL ELSE COALESCE(disabled_at, datetime('now')) END WHERE step_id = ?").run(winner, stepId);
    db.prepare("UPDATE workflow_steps SET email_control_disabled = ? WHERE id = ?").run(winner === null ? 0 : 1, stepId);
  })();
  recordAudit(ctx, winner === undefined ? "workflow.ab_test_reopened" : "workflow.ab_winner_chosen", "workflow_step", stepId, { workflow_id: workflowId, variant_id: winner ?? null });

  const state = db.prepare("SELECT email_control_disabled FROM workflow_steps WHERE id = ?").get(stepId) as { email_control_disabled: number };
  return res.json({
    step_id: stepId,
    control_paused: Boolean(state.email_control_disabled),
    variants: db.prepare("SELECT id, disabled_at FROM workflow_step_email_variants WHERE step_id = ? ORDER BY position").all(stepId),
  });
}
