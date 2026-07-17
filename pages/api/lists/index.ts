import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const lists = db
      .prepare(
        `SELECT l.*, COUNT(lt.target_id) as target_count
         FROM lists l
         LEFT JOIN list_targets lt ON lt.list_id = l.id
         WHERE l.workspace_id = ?
         GROUP BY l.id
         ORDER BY l.created_at DESC`
      )
      .all(ctx.workspaceId);
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
