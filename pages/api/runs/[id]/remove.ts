import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const ctx=requireWorkspace(req,res,"manager"); if(!ctx)return;

  const db = getDb();
  const runId = req.query.id as string;
  if(!requireWorkspaceEntity(res,ctx,"runs",runId))return;
  const { target_ids } = req.body as { target_ids: string[] };

  if (!target_ids?.length) return res.status(400).json({ error: "target_ids required" });

  const placeholders = target_ids.map(() => "?").join(",");
  const result = db
    .prepare(
      `DELETE FROM run_profiles
       WHERE run_id = ? AND target_id IN (${placeholders})`
    )
    .run(runId, ...target_ids);

  return res.json({ ok: true, removed: result.changes });
}
