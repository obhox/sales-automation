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
    // Validate the condition group so a malformed branch can't be persisted and then break
    // evaluation at run time. `conditions` must be a group whose `conditions` is an array of
    // {field, operator} entries.
    const group = conditions as { mode?: unknown; conditions?: unknown };
    if (group.mode !== undefined && group.mode !== "all" && group.mode !== "any") return res.status(400).json({ error: "conditions.mode must be 'all' or 'any'" });
    if (!Array.isArray(group.conditions) || group.conditions.length === 0) return res.status(400).json({ error: "conditions.conditions must be a non-empty array" });
    // Validate operator against what the runner can actually evaluate, and require a value for
    // comparison operators. Without this, semantically-invalid conditions (e.g. a made-up
    // operator like 'not_replied') were accepted but silently never matched.
    const VALID_OPS = ["is", "is_not", "contains", "exists", "not_exists", "gt", "gte", "lt", "lte"];
    for (const c of group.conditions as Array<Record<string, unknown>>) {
      if (!c || typeof c.field !== "string" || !c.field.trim()) return res.status(400).json({ error: "each condition needs a non-empty field" });
      if (typeof c.operator !== "string" || !VALID_OPS.includes(c.operator)) return res.status(400).json({ error: `invalid operator ${JSON.stringify(c?.operator)} — use one of: ${VALID_OPS.join(", ")}` });
      if (c.operator !== "exists" && c.operator !== "not_exists" && (c.value === undefined || c.value === null || c.value === "")) return res.status(400).json({ error: `operator '${c.operator}' requires a value` });
    }
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
    // One branch per source step (UNIQUE constraint). Reuse the existing row's id on update
    // so the caller always gets back the id that's actually persisted.
    const existing = db.prepare("SELECT id FROM workflow_branches WHERE source_step_id = ? AND workspace_id = ?").get(source_step_id, ctx.workspaceId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    db.prepare(`INSERT INTO workflow_branches (id, workspace_id, workflow_id, source_step_id, conditions_json, true_step_id, false_step_id)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_step_id) DO UPDATE SET conditions_json = excluded.conditions_json,
      true_step_id = excluded.true_step_id, false_step_id = excluded.false_step_id`)
      .run(id, ctx.workspaceId, workflow_id, source_step_id, JSON.stringify(conditions), typeof true_step_id === "string" ? true_step_id : null, typeof false_step_id === "string" ? false_step_id : null);
    recordAudit(ctx, "workflow.branch_upserted", "workflow", workflow_id, { source_step_id, conditions, true_step_id, false_step_id });
    return res.status(existing ? 200 : 201).json({ id });
  }
  if (req.method === "DELETE") {
    const id = req.query.id as string;
    db.prepare("DELETE FROM workflow_branches WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "workflow.branch_deleted", "workflow_branch", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}

