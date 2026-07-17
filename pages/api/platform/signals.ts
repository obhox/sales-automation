import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ingestSignal } from "@/lib/platform/signals";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

const TYPES = new Set(["job_change", "funding", "hiring", "technology", "product_intent", "custom"]);
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  if (req.method === "GET") return res.json(getDb().prepare("SELECT * FROM signals WHERE workspace_id = ? ORDER BY occurred_at DESC LIMIT 500").all(ctx.workspaceId));
  if (req.method === "POST") {
    const body = req.body as Record<string, unknown>;
    if (typeof body.type !== "string" || !TYPES.has(body.type) || typeof body.title !== "string") return res.status(400).json({ error: "Valid type and title are required" });
    if(body.target_id&&!getDb().prepare("SELECT 1 FROM targets WHERE id=? AND workspace_id=?").get(body.target_id,ctx.workspaceId))return res.status(400).json({error:"Contact not found"});
    if(body.company_id&&!getDb().prepare("SELECT 1 FROM companies WHERE id=? AND workspace_id=?").get(body.company_id,ctx.workspaceId))return res.status(400).json({error:"Company not found"});
    const row = ingestSignal({ workspaceId: ctx.workspaceId, targetId: typeof body.target_id === "string" ? body.target_id : undefined, companyId: typeof body.company_id === "string" ? body.company_id : undefined, type: body.type, title: body.title, description: typeof body.description === "string" ? body.description : undefined, score: Number(body.score ?? 0), source: typeof body.source === "string" ? body.source : "manual", occurredAt: typeof body.occurred_at === "string" ? body.occurred_at : undefined, metadata: body.metadata });
    recordAudit(ctx, "signal.created", "signal", (row as { id?: string })?.id);
    return res.status(201).json(row);
  }
  return res.status(405).end();
}
