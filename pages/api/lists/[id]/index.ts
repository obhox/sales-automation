import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { listDetail } from "@/lib/lists/overview";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    // What the list's own screen reads: figures, campaigns and choices, without the contacts
    // (those come a page at a time from /api/targets?view=table&list_id=). Without `view`
    // the answer is the list with every contact, as it always was.
    if (req.query.view === "detail") {
      const detail = listDetail(db, ctx.workspaceId, id);
      return detail ? res.json(detail) : res.status(404).json({ error: "Not found" });
    }
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
    const { name, description, owner_id, archived } = (req.body ?? {}) as { name?: string; description?: string; owner_id?: string | null; archived?: unknown };
    if (!db.prepare("SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId)) return res.status(404).json({ error: "Not found" });
    if (typeof name === "string" && !name.trim()) return res.status(400).json({ error: "A list needs a name" });
    // Who looks after the list: a member of this workspace, or nobody.
    if (owner_id !== undefined) {
      const owner = owner_id === null || owner_id === "" ? null : String(owner_id);
      if (owner && !db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ctx.workspaceId, owner)) {
        return res.status(400).json({ error: "The owner must be a member of this workspace" });
      }
      db.prepare("UPDATE lists SET owner_id = ? WHERE id = ? AND workspace_id = ?").run(owner, id, ctx.workspaceId);
    }
    // An archived list keeps its contacts and its history; it is only marked as out of use.
    if (archived !== undefined) {
      if (typeof archived !== "boolean") return res.status(400).json({ error: "archived must be true or false" });
      db.prepare("UPDATE lists SET archived_at = CASE WHEN ? = 1 THEN COALESCE(archived_at, datetime('now')) ELSE NULL END WHERE id = ? AND workspace_id = ?").run(archived ? 1 : 0, id, ctx.workspaceId);
    }
    db.prepare(
      "UPDATE lists SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ? AND workspace_id = ?"
    ).run(typeof name === "string" ? name.trim() : name, description, id, ctx.workspaceId);
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
