import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { setupOptions } from "@/lib/campaigns/setup";
import { premium } from "@/lib/premium";
import { requireWorkspace } from "@/lib/workspace";

/**
 * GET: what a new campaign can be set up with, before it exists. The workspace's lists
 * with how many contacts each holds, its LinkedIn accounts and mailboxes with what each can
 * do today, and whether the AI writer is there to brief.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const db = getDb();
  const defaultModel = (db.prepare("SELECT default_model FROM workspace_ai_config WHERE workspace_id = ?").get(ctx.workspaceId) as { default_model: string | null } | undefined)?.default_model ?? null;
  return res.json({ options: setupOptions(db, ctx.workspaceId), ai_available: Boolean(premium.ai), default_model: defaultModel });
}
