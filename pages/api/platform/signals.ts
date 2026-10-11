import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ingestSignal } from "@/lib/platform/signals";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { SIGNAL_TYPES } from "@/lib/platform/signal-types";

const TYPES = new Set<string>(SIGNAL_TYPES);
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
  // Mark signals as dealt with, or as new again: the ones named, or every signal of one
  // company. A dealt-with signal no longer counts in the sidebar.
  //   PATCH { company_id, handled }   PATCH { ids, handled }
  if (req.method === "PATCH") {
    const body = (req.body ?? {}) as { ids?: unknown; company_id?: unknown; handled?: unknown };
    if (typeof body.handled !== "boolean") return res.status(400).json({ error: "handled must be true or false" });
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id !== "").slice(0, 500) : [];
    const companyId = typeof body.company_id === "string" && body.company_id ? body.company_id : null;
    if (ids.length === 0 && !companyId) return res.status(400).json({ error: "Name the signals (ids) or the company (company_id)" });
    const scope = ids.length > 0 ? `id IN (${ids.map(() => "?").join(",")})` : "company_id = ?";
    const state = body.handled ? "processed_at IS NULL" : "processed_at IS NOT NULL";
    const changed = getDb().prepare(`UPDATE signals SET processed_at = ${body.handled ? "datetime('now')" : "NULL"} WHERE workspace_id = ? AND ${scope} AND ${state}`)
      .run(ctx.workspaceId, ...(ids.length > 0 ? ids : [companyId])).changes;
    if (changed > 0) recordAudit(ctx, body.handled ? "signals.handled" : "signals.reopened", companyId ? "company" : "signal", companyId ?? (ids.length === 1 ? ids[0] : undefined), { signals: changed });
    return res.json({ changed });
  }
  return res.status(405).end();
}
