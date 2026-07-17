import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getDailyImportCap } from "@/lib/import-jobs";
import { requireWorkspace } from "@/lib/workspace";

/** GET — all import jobs (active first), with list names, for the Jobs panel. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx=requireWorkspace(req,res); if(!ctx)return;
  const db = getDb();

  const jobs = db.prepare(`
    SELECT li.id, li.list_id, l.name AS list_name, li.status, li.phase,
           li.page, li.total_pages, li.count, li.total, li.imported, li.skipped, li.error,
           li.scheduled_for, li.start_page, li.batch_index, li.started_at, li.finished_at
    FROM list_imports li
    LEFT JOIN lists l ON l.id = li.list_id
    WHERE l.workspace_id = ? AND (li.status IN ('running', 'scheduled')
       OR li.finished_at >= datetime('now', '-2 days'))
    ORDER BY
      CASE li.status WHEN 'running' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
      li.scheduled_for ASC,
      li.started_at DESC
  `).all(ctx.workspaceId);

  return res.json({
    jobs,
    dailyCap: getDailyImportCap(db),
    importedToday: (db.prepare(`SELECT COALESCE(SUM(li.imported),0) n FROM list_imports li JOIN lists l ON l.id=li.list_id WHERE l.workspace_id=? AND date(li.finished_at)=date('now')`).get(ctx.workspaceId) as {n:number}).n,
  });
}
