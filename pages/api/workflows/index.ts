import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const workflows = db
      .prepare(
        `SELECT w.*, COUNT(ws.id) as step_count
         FROM workflows w
         LEFT JOIN workflow_steps ws ON ws.workflow_id = w.id
         WHERE w.workspace_id = ?
         GROUP BY w.id
         ORDER BY w.created_at DESC`
      )
      .all(ctx.workspaceId);
    return res.json(workflows);
  }

  if (req.method === "POST") {
    const { name, description, prompt } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const id = randomUUID();
    db.prepare("INSERT INTO workflows (id, workspace_id, name, description, prompt) VALUES (?, ?, ?, ?, ?)").run(id, ctx.workspaceId, name, description ?? null, prompt ?? null);
    recordAudit(ctx, "workflow.created", "workflow", id);
    return res.status(201).json(db.prepare("SELECT * FROM workflows WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  res.status(405).end();
}
