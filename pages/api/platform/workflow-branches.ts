import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { gateProblem, gatesOf, saveGate, stepRefs, type GateInput, type Outcome } from "@/lib/outreach/publish";

/**
 * The gates on a campaign's steps. A gate asks something about a contact and sends them
 * one way or the other; the original kind, a branch on a set of conditions, is still the
 * default and still takes true_step_id / false_step_id.
 *
 *   GET    ?workflow_id=                                        the stored rows, each with `gate`: its kind and both outcomes
 *   POST   { workflow_id, source_step_id, conditions, true_step_id?, false_step_id? }      a conditions branch, as always
 *   POST   { workflow_id, source_step_id, kind, conditions?, on_true?, on_false? }          any gate, with outcomes
 *   DELETE ?id=
 *
 * An outcome is { then: continue | jump | end_track | leave | handover_email, step?, effects? }.
 * A step has at most one gate; saving another on the same step replaces it.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    const workflowId = req.query.workflow_id as string;
    const rows = db.prepare("SELECT * FROM workflow_branches WHERE workspace_id = ? AND workflow_id = ? ORDER BY created_at").all(ctx.workspaceId, workflowId) as Array<Record<string, unknown>>;
    const parsed = new Map(gatesOf(db, workflowId).map((gate) => [gate.id, gate]));
    return res.json(rows.map((row) => ({ ...row, gate: parsed.get(String(row.id)) ?? null })));
  }
  if (req.method === "POST") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { workflow_id, source_step_id, conditions, true_step_id, false_step_id } = body;
    const kind = body.kind === undefined ? "conditions" : body.kind;
    if (typeof workflow_id !== "string" || typeof source_step_id !== "string" || (kind === "conditions" && (!conditions || typeof conditions !== "object"))) return res.status(400).json({ error: "workflow_id, source_step_id and conditions are required" });
    if (!db.prepare("SELECT 1 FROM workflows WHERE id = ? AND workspace_id = ?").get(workflow_id, ctx.workspaceId)) return res.status(404).json({ error: "Source step not found" });

    // The original form names a step for each side; the new form gives each side an outcome.
    const legacy = (stepId: unknown): Outcome | null => (typeof stepId === "string" ? { then: "jump", step: stepId } : null);
    const gate: GateInput = {
      source: source_step_id, kind: kind as GateInput["kind"], conditions: conditions as GateInput["conditions"],
      on_true: (body.on_true as Outcome | undefined) ?? legacy(true_step_id),
      on_false: (body.on_false as Outcome | undefined) ?? legacy(false_step_id),
    };
    const steps = new Map(stepRefs(db, workflow_id).map((step) => [step.id, step]));
    const resolve = (ref: string) => steps.get(ref);
    const problem = gateProblem(db, ctx.workspaceId, gate, resolve);
    if (problem) return res.status(problem === "Source step not found" ? 404 : 400).json({ error: problem });

    // One gate per source step. The existing row's id is reused on update, so the caller
    // always gets back the id that is actually stored.
    const saved = saveGate(db, ctx.workspaceId, workflow_id, gate, resolve);
    recordAudit(ctx, "workflow.branch_upserted", "workflow", workflow_id, { source_step_id, kind, conditions, on_true: gate.on_true, on_false: gate.on_false });
    return res.status(saved.created ? 201 : 200).json({ id: saved.id });
  }
  if (req.method === "DELETE") {
    const id = req.query.id as string;
    db.prepare("DELETE FROM workflow_branches WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "workflow.branch_deleted", "workflow_branch", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}
