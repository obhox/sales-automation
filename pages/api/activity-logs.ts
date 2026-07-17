import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

const ACTIVITY_TYPES = new Set(["call", "email", "meeting", "note", "other"]);

interface ActivityRow {
  id: string;
  target_id: string;
  type: string;
  body: string;
  logged_at: string;
  created_at: string;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const targetId = req.query.target_id as string | undefined;
    const rows = targetId
      ? db.prepare("SELECT * FROM activity_logs WHERE workspace_id = ? AND target_id = ? ORDER BY logged_at DESC").all(ctx.workspaceId, targetId)
      : db.prepare("SELECT * FROM activity_logs WHERE workspace_id = ? ORDER BY logged_at DESC LIMIT 500").all(ctx.workspaceId);
    return res.json(rows);
  }

  if (req.method === "POST") {
    const { target_id, type, body, logged_at } = req.body as Record<string, unknown>;
    if (typeof target_id !== "string" || !target_id || typeof body !== "string" || !body.trim()) {
      return res.status(400).json({ error: "target_id and body are required" });
    }
    const activityType = typeof type === "string" && ACTIVITY_TYPES.has(type) ? type : "note";
    const target = db.prepare("SELECT id FROM targets WHERE id = ? AND workspace_id = ?").get(target_id, ctx.workspaceId);
    if (!target) return res.status(404).json({ error: "Contact not found" });

    const id = randomUUID();
    db.prepare(`
      INSERT INTO activity_logs (id, workspace_id, target_id, type, body, logged_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    `).run(id, ctx.workspaceId, target_id, activityType, body.trim(), typeof logged_at === "string" && logged_at ? logged_at : null);
    recordAudit(ctx, "activity.created", "activity", id);
    return res.status(201).json(db.prepare("SELECT * FROM activity_logs WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  const id = req.query.id as string | undefined;
  if (!id) return res.status(400).json({ error: "id is required" });
  const existing = db.prepare("SELECT * FROM activity_logs WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as ActivityRow | undefined;
  if (!existing) return res.status(404).json({ error: "Activity not found" });

  if (req.method === "PATCH") {
    const { type, body, logged_at } = req.body as Record<string, unknown>;
    const nextType = typeof type === "string" && ACTIVITY_TYPES.has(type) ? type : existing.type;
    const nextBody = typeof body === "string" ? body.trim() : existing.body;
    if (!nextBody) return res.status(400).json({ error: "Body is required" });
    db.prepare("UPDATE activity_logs SET type = ?, body = ?, logged_at = ? WHERE id = ? AND workspace_id = ?").run(
      nextType,
      nextBody,
      typeof logged_at === "string" && logged_at ? logged_at : existing.logged_at,
      id, ctx.workspaceId,
    );
    recordAudit(ctx, "activity.updated", "activity", id);
    return res.json(db.prepare("SELECT * FROM activity_logs WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM activity_logs WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "activity.deleted", "activity", id);
    res.status(204).end();
    return;
  }

  res.setHeader("Allow", ["GET", "POST", "PATCH", "DELETE"]);
  return res.status(405).end();
}
