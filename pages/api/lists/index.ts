import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const rows = db
      .prepare(
        `SELECT l.*, COUNT(lt.target_id) as target_count,
          (SELECT COUNT(*) FROM list_imports li WHERE li.list_id = l.id AND li.status NOT IN ('completed','failed','cancelled','canceled')) as active_imports,
          (SELECT COUNT(*) FROM list_targets lt2 JOIN targets t ON t.id = lt2.target_id
             WHERE lt2.list_id = l.id AND t.email_verify_requested_at IS NOT NULL) as pending_verification
         FROM lists l
         LEFT JOIN list_targets lt ON lt.list_id = l.id
         WHERE l.workspace_id = ?
         GROUP BY l.id
         ORDER BY l.created_at DESC`
      )
      .all(ctx.workspaceId) as Array<Record<string, unknown> & { target_count: number; active_imports: number; pending_verification: number }>;

    // A list is "ready to send" once nothing is processing (importing / verifying) and it
    // has contacts. Surfaced as a status badge in the UI.
    const lists = rows.map((l) => ({
      ...l,
      status: l.active_imports > 0 ? "importing"
        : l.pending_verification > 0 ? "verifying"
        : l.target_count > 0 ? "ready"
        : "empty",
    }));
    return res.json(lists);
  }

  if (req.method === "POST") {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const id = randomUUID();
    db
      .prepare("INSERT INTO lists (id, workspace_id, name, description) VALUES (?, ?, ?, ?)")
      .run(id, ctx.workspaceId, name, description ?? null);
    recordAudit(ctx, "list.created", "list", id);
    return res.status(201).json(db.prepare("SELECT * FROM lists WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}
