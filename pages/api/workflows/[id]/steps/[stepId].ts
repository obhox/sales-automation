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
    const { step_type, template_id, delay_seconds, step_order, connect_note, message_body, email_subject, email_body, email_delivery_mode, email_track_opens, email_track_clicks } = req.body;
    const deliveryMode = email_delivery_mode === "enhanced" ? "enhanced" : email_delivery_mode === "plain" ? "plain" : null;
    db.prepare(
      `UPDATE workflow_steps SET
        step_type = COALESCE(?, step_type),
        template_id = COALESCE(?, template_id),
        delay_seconds = COALESCE(?, delay_seconds),
        step_order = COALESCE(?, step_order),
        connect_note = ?,
        message_body = ?,
        email_subject = ?,
        email_body = ?,
        email_delivery_mode = COALESCE(?, email_delivery_mode),
        email_track_opens = COALESCE(?, email_track_opens),
        email_track_clicks = COALESCE(?, email_track_clicks)
       WHERE id = ?`
    ).run(step_type ?? null, template_id ?? null, delay_seconds ?? null, step_order ?? null, connect_note ?? null, message_body ?? null, email_subject ?? null, email_body ?? null, deliveryMode, deliveryMode === "plain" ? 0 : email_track_opens ?? null, deliveryMode === "plain" ? 0 : email_track_clicks ?? null, stepId);
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
