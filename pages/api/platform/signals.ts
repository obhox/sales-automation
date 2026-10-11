import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ingestSignal } from "@/lib/platform/signals";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { SIGNAL_TYPES } from "@/lib/platform/signal-types";
import { markSignalsNew, markSignalsSeen, signalFeed } from "@/lib/signals/feed";

const TYPES = new Set<string>(SIGNAL_TYPES);
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  if (req.method === "GET") {
    // ?view=feed: a page of signals with who each is about and the counts the screen shows.
    // Without it, the stored rows as they have always been returned.
    if (req.query.view === "feed") {
      const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
      const limit = Math.min(Math.max(Number(one(req.query.limit)) || 50, 1), 200);
      const offset = Math.max(Number(one(req.query.offset)) || 0, 0);
      return res.json(signalFeed(getDb(), ctx.workspaceId, { type: one(req.query.type), source: one(req.query.source), state: one(req.query.state), q: one(req.query.q) }, limit, offset));
    }
    return res.json(getDb().prepare("SELECT * FROM signals WHERE workspace_id = ? ORDER BY occurred_at DESC LIMIT 500").all(ctx.workspaceId));
  }
  // Mark signals as seen (dealt with), or as new again. A seen signal no longer counts in
  // the sidebar. Which ones: { ids: [...] }, { company_id } for every signal of one company,
  // or { all: true }. Which way: seen is the default; { seen: false } puts them back among the
  // new. "handled" is the same switch under the name the Companies screen uses.
  if (req.method === "PATCH") {
    const body = (req.body ?? {}) as { ids?: unknown; company_id?: unknown; all?: unknown; seen?: unknown; handled?: unknown };
    const flag = body.handled ?? body.seen ?? true;
    if (typeof flag !== "boolean") return res.status(400).json({ error: "handled must be true or false" });
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id !== "") : [];
    const companyId = typeof body.company_id === "string" && body.company_id ? body.company_id : null;
    const scope = ids.length > 0 ? ids : companyId ? { companyId } : body.all === true ? "all" as const : null;
    if (!scope) return res.status(400).json({ error: "Name the signals (ids), the company (company_id), or send all: true" });
    if (!flag && scope === "all") return res.status(400).json({ error: "Name the signals to mark as new" });
    const changed = flag ? markSignalsSeen(getDb(), ctx.workspaceId, scope) : markSignalsNew(getDb(), ctx.workspaceId, scope as Exclude<typeof scope, "all">);
    const about = ids.length > 0 ? null : companyId;
    if (changed > 0) recordAudit(ctx, flag ? "signals.handled" : "signals.reopened", about ? "company" : "signal", about ?? (ids.length === 1 ? ids[0] : undefined), { signals: changed });
    return res.json({ changed });
  }
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
