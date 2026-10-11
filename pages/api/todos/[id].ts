import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import type { TodoRow } from "./index";
import { recordAudit, requireWorkspace } from "@/lib/workspace";
import { taskFieldsFrom, TaskRefused, updateTask } from "@/lib/pipeline/tasks";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();
  const id = req.query.id as string;
  const existing = db.prepare("SELECT * FROM todos WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as TodoRow | undefined;
  if (!existing) return res.status(404).json({ error: "Todo not found" });

  if (req.method === "PATCH") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // A title that is sent has to say something. (Before there was a task library this said "Title is required".)
    if (typeof body.title === "string" && !body.title.trim()) return res.status(400).json({ error: "Title is required" });
    try {
      // A title of the wrong kind is passed over, as it always was, rather than refused.
      const fields = taskFieldsFrom(db, ctx.workspaceId, typeof body.title === "string" ? body : { ...body, title: undefined });
      const status = body.status === "open" || body.status === "done" ? body.status : undefined;
      updateTask(db, ctx.workspaceId, id, { ...fields, ...(status ? { status } : {}) }, ctx.userId);
    } catch (error) {
      if (error instanceof TaskRefused) return res.status(400).json({ error: error.message });
      throw error;
    }
    recordAudit(ctx, "todo.updated", "todo", id);
    return res.json(db.prepare("SELECT * FROM todos WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM todos WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "todo.deleted", "todo", id);
    res.status(204).end();
    return;
  }

  res.setHeader("Allow", ["PATCH", "DELETE"]);
  return res.status(405).end();
}
