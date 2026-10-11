import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { roleAtLeast } from "@/lib/roles";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const workflow = db.prepare("SELECT * FROM workflows WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId);
    if (!workflow) return res.status(404).json({ error: "not found" });
    const steps = db
      .prepare(
        `SELECT ws.*, t.name as template_name
         FROM workflow_steps ws
         LEFT JOIN templates t ON t.id = ws.template_id
         WHERE ws.workflow_id = ?
         ORDER BY ws.step_order`
      )
      .all(id);
    return res.json({ ...workflow as object, steps });
  }

  if (req.method === "PUT") {
    const { name, description, prompt } = req.body;
    // name/description: COALESCE so a rename-only request doesn't null them out
    // prompt: always update when present in body (even "" to clear it)
    if (prompt !== undefined) {
      db.prepare(
        "UPDATE workflows SET name = COALESCE(?, name), description = COALESCE(?, description), prompt = ? WHERE id = ? AND workspace_id = ?"
      ).run(name ?? null, description ?? null, prompt || null, id, ctx.workspaceId);
    } else {
      db.prepare(
        "UPDATE workflows SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ? AND workspace_id = ?"
      ).run(name ?? null, description ?? null, id, ctx.workspaceId);
    }
    // Who owns it: a member of this workspace, or nobody.
    if (req.body.owner_id !== undefined) {
      const ownerId = req.body.owner_id ? String(req.body.owner_id) : null;
      if (ownerId && !db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ctx.workspaceId, ownerId)) {
        return res.status(400).json({ error: "The owner must be a member of this workspace" });
      }
      db.prepare("UPDATE workflows SET owner_id = ? WHERE id = ? AND workspace_id = ?").run(ownerId, id, ctx.workspaceId);
    }
    if (req.body.send_in_recipient_tz !== undefined) {
      db.prepare("UPDATE workflows SET send_in_recipient_tz = ? WHERE id = ? AND workspace_id = ?").run(req.body.send_in_recipient_tz ? 1 : 0, id, ctx.workspaceId);
    }
    recordAudit(ctx, "workflow.updated", "workflow", id);
    return res.json(db.prepare("SELECT * FROM workflows WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  if (req.method === "PATCH") {
    const { is_archived } = req.body;
    if (is_archived !== undefined) {
      db.prepare("UPDATE workflows SET is_archived = ? WHERE id = ? AND workspace_id = ?").run(is_archived ? 1 : 0, id, ctx.workspaceId);
    }
    recordAudit(ctx, "workflow.archived", "workflow", id, { is_archived: !!is_archived });
    return res.json(db.prepare("SELECT * FROM workflows WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    // A draft is anyone's to throw away. One that has enrolled people takes their history with it: a manager's call.
    const enrolled = (db.prepare("SELECT COUNT(*) AS c FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE r.workflow_id = ? AND r.workspace_id = ?").get(id, ctx.workspaceId) as { c: number }).c;
    if (enrolled > 0 && !roleAtLeast(ctx.role, "manager")) return res.status(403).json({ error: "This campaign has enrolled contacts, so deleting it needs a manager. Archive it instead." });
    db.prepare("DELETE FROM runs WHERE workflow_id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    db.prepare("DELETE FROM workflows WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "workflow.deleted", "workflow", id);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
