import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const list = db.prepare("SELECT * FROM lists WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId);
    if (!list) return res.status(404).json({ error: "Not found" });
    const targets = db
      .prepare(
        `SELECT t.* FROM targets t
         JOIN list_targets lt ON lt.target_id = t.id
         WHERE lt.list_id = ? AND t.workspace_id = ?
         ORDER BY t.created_at DESC`
      )
      .all(id, ctx.workspaceId);
    return res.json({ ...list, targets });
  }

  if (req.method === "PUT") {
    const { name, description } = req.body;
    db.prepare(
      "UPDATE lists SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ? AND workspace_id = ?"
    ).run(name, description, id, ctx.workspaceId);
    recordAudit(ctx, "list.updated", "list", id);
    return res.json(db.prepare("SELECT * FROM lists WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM runs WHERE list_id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    db.prepare("DELETE FROM lists WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "list.deleted", "list", id);
    return res.status(204).end();
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end();
}
