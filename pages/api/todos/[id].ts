import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import type { TodoRow } from "./index";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx=requireWorkspace(req,res,"member"); if(!ctx)return;
  const db = getDb();
  const id = req.query.id as string;
  const existing = db.prepare("SELECT * FROM todos WHERE id = ? AND workspace_id = ?").get(id,ctx.workspaceId) as TodoRow | undefined;
  if (!existing) return res.status(404).json({ error: "Todo not found" });

  if (req.method === "PATCH") {
    const { title, description, due_date, status } = req.body as Record<string, unknown>;
    const nextTitle = typeof title === "string" ? title.trim() : existing.title;
    const nextStatus = status === "open" || status === "done" ? status : existing.status;
    if (!nextTitle) return res.status(400).json({ error: "Title is required" });

    db.prepare(`
      UPDATE todos SET title = ?, description = ?, due_date = ?, status = ? WHERE id = ?
    `).run(
      nextTitle,
      description === undefined ? existing.description : typeof description === "string" && description.trim() ? description.trim() : null,
      due_date === undefined ? existing.due_date : typeof due_date === "string" && due_date ? due_date : null,
      nextStatus,
      id,
    );
    recordAudit(ctx,"todo.updated","todo",id);
    return res.json(db.prepare("SELECT * FROM todos WHERE id = ? AND workspace_id = ?").get(id,ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM todos WHERE id = ? AND workspace_id = ?").run(id,ctx.workspaceId);
    recordAudit(ctx,"todo.deleted","todo",id);
    res.status(204).end();
    return;
  }

  res.setHeader("Allow", ["PATCH", "DELETE"]);
  return res.status(405).end();
}
