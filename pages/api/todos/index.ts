import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export interface TodoRow {
  id: string;
  target_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: "open" | "done";
  created_at: string;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const status = req.query.status;
    const rows = status === "open" || status === "done"
      ? db.prepare("SELECT * FROM todos WHERE workspace_id = ? AND status = ? ORDER BY due_date IS NULL, due_date, created_at DESC").all(ctx.workspaceId, status)
      : db.prepare("SELECT * FROM todos WHERE workspace_id = ? ORDER BY status ASC, due_date IS NULL, due_date, created_at DESC").all(ctx.workspaceId);
    return res.json(rows);
  }

  if (req.method === "POST") {
    const { target_id, title, description, due_date } = req.body as Record<string, unknown>;
    if (typeof target_id !== "string" || !target_id || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "target_id and title are required" });
    }
    const target = db.prepare("SELECT id FROM targets WHERE id = ? AND workspace_id = ?").get(target_id, ctx.workspaceId);
    if (!target) return res.status(404).json({ error: "Contact not found" });

    const id = randomUUID();
    db.prepare(`
      INSERT INTO todos (id, workspace_id, target_id, title, description, due_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ctx.workspaceId,
      target_id,
      title.trim(),
      typeof description === "string" && description.trim() ? description.trim() : null,
      typeof due_date === "string" && due_date ? due_date : null,
    );
    const todo = db.prepare("SELECT * FROM todos WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as TodoRow;
    recordAudit(ctx, "todo.created", "todo", id);
    return res.status(201).json(todo);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
}
