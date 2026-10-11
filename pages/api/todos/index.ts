import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { createTask, taskFieldsFrom, TaskRefused, type Priority } from "@/lib/pipeline/tasks";

export interface TodoRow {
  id: string;
  /** The contact it is about. Null for a task about a company, an opportunity, or nothing in particular. */
  target_id: string | null;
  title: string;
  description: string | null;
  due_date: string | null;
  /** The moment it is due, when a time was given as well as a day. */
  due_at: string | null;
  status: "open" | "done";
  priority: Priority;
  assigned_to: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  /** 1 when Linki made it by itself (a positive reply, a campaign step). */
  automatic: number;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
}

/**
 * Tasks as plain rows: what the contact profile, the MCP tools and scripts read and write.
 * The pipeline screen reads its list, with names and counts, from /api/pipeline/tasks.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const status = req.query.status;
    const where = ["workspace_id = ?"];
    const params: unknown[] = [ctx.workspaceId];
    if (status === "open" || status === "done") { where.push("status = ?"); params.push(status); }
    for (const key of ["target_id", "opportunity_id", "company_id", "assigned_to"] as const) {
      const value = req.query[key];
      if (typeof value === "string" && value) { where.push(`${key} = ?`); params.push(value); }
    }
    return res.json(db.prepare(`SELECT * FROM todos WHERE ${where.join(" AND ")} ORDER BY status ASC, due_date IS NULL, due_date, created_at DESC`).all(...params));
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.title !== "string" || !body.title.trim()) return res.status(400).json({ error: "title is required" });
    // A contact that is named has to exist: this was a 404 before a task could go without one, and still is.
    if (typeof body.target_id === "string" && body.target_id && !db.prepare("SELECT 1 FROM targets WHERE id = ? AND workspace_id = ?").get(body.target_id, ctx.workspaceId)) {
      return res.status(404).json({ error: "Contact not found" });
    }
    try {
      const fields = taskFieldsFrom(db, ctx.workspaceId, body);
      const id = createTask(db, { ...fields, title: fields.title!, workspaceId: ctx.workspaceId, createdBy: ctx.userId });
      recordAudit(ctx, "todo.created", "todo", id);
      return res.status(201).json(db.prepare("SELECT * FROM todos WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as TodoRow);
    } catch (error) {
      if (error instanceof TaskRefused) return res.status(400).json({ error: error.message });
      throw error;
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
}
