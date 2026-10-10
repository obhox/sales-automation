import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { saveAiConfig } from "@/lib/ai/config";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

// The workspace's AI settings as they are stored. The AI & models screen saves through
// here, and so does the MCP tool.
//
// PUT changes the fields it is sent and leaves the others alone; send null to clear one.
// Examples may be sent as plain text or as a list of { title, body }.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;

  if (req.method === "GET") {
    const row = getDb().prepare("SELECT * FROM workspace_ai_config WHERE workspace_id = ?").get(ctx.workspaceId);
    return res.json(row ?? { workspace_id: ctx.workspaceId });
  }

  if (req.method === "PUT") {
    const saved = saveAiConfig(ctx.workspaceId, req.body);
    if (!saved.ok) return res.status(400).json({ error: saved.error });
    recordAudit(ctx, "ai_config.updated", "workspace", ctx.workspaceId, { fields: saved.changed });
    return res.json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end();
}
