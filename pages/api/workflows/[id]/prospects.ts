import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";
import { PROSPECTS_FROM, PROSPECTS_ORDER, PROSPECT_STATE, prospectsWhere } from "@/lib/outreach/prospects-query";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx=requireWorkspace(req,res); if(!ctx)return;

  try {
    const db = getDb();
    const workflowId = req.query.id as string;
    if(!requireWorkspaceEntity(res,ctx,"workflows",workflowId))return;
    const page = req.query.page ? Number(req.query.page) : 0;
    const limit = 25;
    const offset = page * limit;
    const { where, params } = prospectsWhere(req.query, workflowId);

    const total = (db.prepare(`SELECT COUNT(*) as c ${PROSPECTS_FROM} WHERE ${where}`).get(...params) as { c: number }).c;

    const prospects = db.prepare(
      `SELECT rp.id, rp.run_id, rp.target_id,
              ${PROSPECT_STATE} as state,
              COALESCE(rt_li.current_step, 0) as current_step,
              COALESCE(rt_li.next_step_at, rt_em.next_step_at) as next_step_at,
              COALESCE(rt_li.error_message, rt_em.error_message) as error_message,
              t.full_name, t.title, t.company, t.linkedin_url,
              t.degree, t.connection_requested_at, t.connected_at, t.message_sent_at,
              ws_li.step_type as li_step_type,
              ws_em.step_type as em_step_type,
              CASE
                WHEN rt_li.state NOT IN ('completed','skipped') THEN ws_li.step_type
                ELSE ws_em.step_type
              END as step_type,
              CASE
                WHEN rt_li.state NOT IN ('completed','skipped') THEN ws_li.track
                ELSE ws_em.track
              END as step_track
       ${PROSPECTS_FROM}
       LEFT JOIN workflow_steps ws_li ON ws_li.workflow_id = r.workflow_id AND ws_li.track = 'linkedin' AND ws_li.step_order = COALESCE(rt_li.current_step, 0) + 1
       LEFT JOIN workflow_steps ws_em ON ws_em.workflow_id = r.workflow_id AND ws_em.track = 'email' AND ws_em.step_order = COALESCE(rt_em.current_step, 0) + 1
       WHERE ${where}
       ${PROSPECTS_ORDER}
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    return res.json({ prospects, total });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
