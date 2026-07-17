import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const ctx = requireWorkspace(req, res, "admin");
  if (!ctx) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = getDb().prepare(`SELECT al.*, u.email user_email FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
    WHERE al.workspace_id = ? ORDER BY al.created_at DESC LIMIT ?`).all(ctx.workspaceId, limit);
  return res.json(rows);
}
