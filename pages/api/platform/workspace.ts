import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getMemberships, requireWorkspace, recordAudit, type WorkspaceRole } from "@/lib/workspace";

const ROLES = new Set<WorkspaceRole>(["owner", "admin", "manager", "member", "viewer"]);

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    const workspace = db.prepare("SELECT id, name, slug, created_at FROM workspaces WHERE id = ?").get(ctx.workspaceId);
    const members = db.prepare(`SELECT u.id, u.email, wm.role, wm.created_at FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? ORDER BY wm.created_at`).all(ctx.workspaceId);
    const workspaces = ctx.userId ? getMemberships(ctx.userId) : [workspace];
    return res.json({ workspace, workspaces, current_role: ctx.role, members });
  }
  if (req.method === "POST") {
    const { email, role = "member" } = req.body as { email?: string; role?: WorkspaceRole };
    if (!email || !ROLES.has(role)) return res.status(400).json({ error: "Valid email and role are required" });
    if (role === "owner" && ctx.role !== "owner") return res.status(403).json({ error: "Only an owner can grant owner access" });
    const user = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;
    if (!user) return res.status(404).json({ error: "User must create an account before being added" });
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role")
      .run(ctx.workspaceId, user.id, role);
    recordAudit(ctx, "workspace.member_upserted", "user", user.id, { role });
    return res.status(201).json({ ok: true });
  }
  if (req.method === "PATCH") {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });
    db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name.trim(), ctx.workspaceId);
    recordAudit(ctx, "workspace.updated", "workspace", ctx.workspaceId, { name });
    return res.json({ ok: true });
  }
  if (req.method === "DELETE") {
    const userId = req.query.user_id as string;
    if (!userId) return res.status(400).json({ error: "user_id is required" });
    const owners = (db.prepare("SELECT COUNT(*) c FROM workspace_members WHERE workspace_id = ? AND role = 'owner'").get(ctx.workspaceId) as { c: number }).c;
    const member = db.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ctx.workspaceId, userId) as { role: string } | undefined;
    if (member?.role === "owner" && ctx.role !== "owner") return res.status(403).json({ error: "Only an owner can remove another owner" });
    if (member?.role === "owner" && owners <= 1) return res.status(400).json({ error: "Cannot remove the last owner" });
    db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(ctx.workspaceId, userId);
    recordAudit(ctx, "workspace.member_removed", "user", userId);
    return res.status(204).end();
  }
  return res.status(405).end();
}
