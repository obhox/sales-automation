import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

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
    for (const col of ["step_type", "template_id", "delay_seconds", "step_order", "connect_note", "message_body", "email_subject", "email_body"]) {
      if (has(col)) put(col, body[col] ?? null);
    }
    if (has("email_delivery_mode")) {
      const mode = body.email_delivery_mode === "enhanced" ? "enhanced" : "plain";
      put("email_delivery_mode", mode);
      if (mode === "plain") { put("email_track_opens", 0); put("email_track_clicks", 0); }
    }
    if (has("email_track_opens") && body.email_delivery_mode !== "plain") put("email_track_opens", body.email_track_opens ? 1 : 0);
    if (has("email_track_clicks") && body.email_delivery_mode !== "plain") put("email_track_clicks", body.email_track_clicks ? 1 : 0);
    if (sets.length === 0) return res.json({ ok: true });
    db.prepare(`UPDATE workflow_steps SET ${sets.join(", ")} WHERE id = ?`).run(...params, stepId);
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
