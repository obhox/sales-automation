import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    const workflowId = req.query.workflow_id as string;
    return res.json(db.prepare("SELECT * FROM workflow_branches WHERE workspace_id = ? AND workflow_id = ? ORDER BY created_at").all(ctx.workspaceId, workflowId));
  }
  if (req.method === "POST") {
    const { workflow_id, source_step_id, conditions, true_step_id, false_step_id } = req.body as Record<string, unknown>;
    if (typeof workflow_id !== "string" || typeof source_step_id !== "string" || !conditions || typeof conditions !== "object") return res.status(400).json({ error: "workflow_id, source_step_id and conditions are required" });
    const steps = db.prepare(`SELECT ws.id, ws.step_order FROM workflow_steps ws JOIN workflows w ON w.id = ws.workflow_id
      WHERE ws.workflow_id = ? AND w.workspace_id = ?`).all(workflow_id, ctx.workspaceId) as Array<{ id: string; step_order: number }>;
    const source = steps.find((s) => s.id === source_step_id);
    if (!source) return res.status(404).json({ error: "Source step not found" });
    for (const target of [true_step_id, false_step_id]) {
      if (typeof target === "string") {
        const step = steps.find((s) => s.id === target);
        if (!step || step.step_order <= source.step_order) return res.status(400).json({ error: "Branch targets must be later steps in the same workflow" });
      }
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO workflow_branches (id, workspace_id, workflow_id, source_step_id, conditions_json, true_step_id, false_step_id)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_step_id) DO UPDATE SET conditions_json = excluded.conditions_json,
      true_step_id = excluded.true_step_id, false_step_id = excluded.false_step_id`)
      .run(id, ctx.workspaceId, workflow_id, source_step_id, JSON.stringify(conditions), typeof true_step_id === "string" ? true_step_id : null, typeof false_step_id === "string" ? false_step_id : null);
    recordAudit(ctx, "workflow.branch_upserted", "workflow", workflow_id, { source_step_id, conditions, true_step_id, false_step_id });
    return res.status(201).json({ id });
  }
  if (req.method === "DELETE") {
    const id = req.query.id as string;
    db.prepare("DELETE FROM workflow_branches WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "workflow.branch_deleted", "workflow_branch", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}

