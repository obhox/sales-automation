import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { aiStepPatch, aiSteps, saveAiStep, WRITABLE_STEP_TYPES, type AiStep } from "@/lib/ai/steps";
import { recordAudit, requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

// A campaign's steps as the AI & models screen lists them, and a change to one step's AI
// settings. Changing a campaign's steps takes the same role here as everywhere else: member.

export interface AiStepsPayload {
  workflow_id: string;
  steps: AiStep[];
}

const text = (value: unknown) => (typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "");

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();

  if (req.method === "GET") {
    const workflowId = text(req.query.workflow_id);
    if (!workflowId) return res.status(400).json({ error: "workflow_id is required" });
    if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
    const payload: AiStepsPayload = { workflow_id: workflowId, steps: aiSteps(db, workflowId) };
    return res.json(payload);
  }

  if (req.method === "PUT") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workflowId = text(body.workflow_id);
    const stepId = text(body.step_id);
    if (!workflowId || !stepId) return res.status(400).json({ error: "workflow_id and step_id are required" });
    if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
    const step = db.prepare("SELECT step_type FROM workflow_steps WHERE id = ? AND workflow_id = ?").get(stepId, workflowId) as { step_type: string } | undefined;
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (!(WRITABLE_STEP_TYPES as readonly string[]).includes(step.step_type)) return res.status(400).json({ error: "Only email, LinkedIn message and InMail steps can be written by AI" });
    const checked = aiStepPatch(body);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    saveAiStep(db, workflowId, stepId, checked.patch);
    recordAudit(ctx, "workflow.step_ai_updated", "workflow", workflowId, { step_id: stepId, fields: Object.keys(checked.patch) });
    return res.json({ ok: true, step: aiSteps(db, workflowId).find((candidate) => candidate.id === stepId) ?? null });
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end();
}
