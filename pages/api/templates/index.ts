import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const templates = db.prepare("SELECT * FROM templates WHERE workspace_id = ? ORDER BY created_at DESC").all(ctx.workspaceId);
    return res.json(templates);
  }

  if (req.method === "POST") {
    const { name, body } = req.body;
    if (!name || !body) return res.status(400).json({ error: "name and body required" });
    const id = randomUUID();
    db.prepare("INSERT INTO templates (id, workspace_id, name, body) VALUES (?, ?, ?, ?)").run(id, ctx.workspaceId, name, body);
    recordAudit(ctx, "template.created", "template", id);
    return res.status(201).json(db.prepare("SELECT * FROM templates WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}
