import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";
import { moveStep, removeStep, sequenceProblem, type StepInput } from "@/lib/outreach/publish";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx=requireWorkspace(req,res,"member"); if(!ctx)return;
  const db = getDb();
  const workflowId=req.query.id as string;
  if(!requireWorkspaceEntity(res,ctx,"workflows",workflowId))return;
  const stepId = req.query.stepId as string;
  const step=db.prepare("SELECT 1 FROM workflow_steps WHERE id=? AND workflow_id=?").get(stepId,workflowId);
  if(!step)return res.status(404).json({error:"Step not found"});

  if (req.method === "PUT") {
    // True partial-merge: only update columns present in the body. Previously connect_note,
    // message_body, email_subject and email_body were assigned directly, so updating just
    // email_body silently wiped email_subject (and vice versa).
    const body = req.body as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const sets: string[] = []; const params: unknown[] = [];
    const put = (col: string, val: unknown) => { sets.push(`${col} = ?`); params.push(val); };
    for (const col of ["step_type", "template_id", "delay_seconds", "connect_note", "message_body", "email_subject", "email_body", "window_start", "window_end", "window_days", "email_control_weight"]) {
      if (has(col)) put(col, body[col] ?? null);
    }
    // Checked as the step would be after the change, by the same rules a whole sequence is.
    const current = db.prepare("SELECT step_type, track, delay_seconds, window_start, window_end, window_days, email_control_weight FROM workflow_steps WHERE id = ?").get(stepId) as Record<string, unknown>;
    const merged = { ...current, ...Object.fromEntries(Object.entries(body).filter(([key]) => key in current)) } as unknown as StepInput;
    const problem = sequenceProblem([merged]);
    if (problem) return res.status(400).json({ error: problem.replace(/^Step 1: /, "") });
    if (has("email_delivery_mode")) {
      const mode = body.email_delivery_mode === "enhanced" ? "enhanced" : "plain";
      put("email_delivery_mode", mode);
      if (mode === "plain") { put("email_track_opens", 0); put("email_track_clicks", 0); }
    }
    if (has("email_track_opens") && body.email_delivery_mode !== "plain") put("email_track_opens", body.email_track_opens ? 1 : 0);
    if (has("email_track_clicks") && body.email_delivery_mode !== "plain") put("email_track_clicks", body.email_track_clicks ? 1 : 0);
    if (has("email_in_thread")) put("email_in_thread", body.email_in_thread ? 1 : 0);
    if (sets.length > 0) db.prepare(`UPDATE workflow_steps SET ${sets.join(", ")} WHERE id = ?`).run(...params, stepId);
    // A new place in the sequence goes through the writer, so the steps around it are
    // renumbered and everyone part-way through stays on their own step.
    if (has("step_order") && Number.isFinite(Number(body.step_order))) {
      const moved = moveStep(db, workflowId, stepId, Number(body.step_order));
      return res.json({ ok: true, in_flight: moved.in_flight, moved: moved.moved });
    }
    return res.json({ ok: true });
  }

  // Through the writer too: the steps after it close the gap and contacts keep their place.
  if (req.method === "DELETE") {
    const removed = removeStep(db, workflowId, stepId);
    return res.json({ ok: true, in_flight: removed.in_flight, moved: removed.moved });
  }

  res.status(405).end();
}
