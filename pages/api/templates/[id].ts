import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const t = db.prepare("SELECT * FROM templates WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId);
    if (!t) return res.status(404).json({ error: "Not found" });
    return res.json(t);
  }

  if (req.method === "PUT") {
    const { name, body } = req.body;
    db.prepare(
      "UPDATE templates SET name = COALESCE(?, name), body = COALESCE(?, body) WHERE id = ? AND workspace_id = ?"
    ).run(name, body, id, ctx.workspaceId);
    recordAudit(ctx, "template.updated", "template", id);
    return res.json(db.prepare("SELECT * FROM templates WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM templates WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "template.deleted", "template", id);
    return res.status(204).end();
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end();
}
