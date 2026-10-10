import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { addSuppression, findTargetSuppression, isAddressSuppressed, normalizeSuppression, type SuppressionKind } from "@/lib/platform/suppression";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { suppressionCreateSchema, firstIssue } from "@/lib/validation";

const KINDS = new Set(["email", "domain", "linkedin", "phone"]);

/** Entries a person asked for, or a mail system produced, rather than ones a teammate added. */
export function isProtectedSuppression(row: { reason: string; source: string | null }): boolean {
  return ["unsubscribe", "unsubscribed", "complained", "bounced"].includes(row.reason) || ["reply_classifier", "bounce"].includes(row.source ?? "");
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  if (req.method === "GET") {
    // ?q= matches part of the value, ?kind= one kind. The newest 500 by default, up to 2000.
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const kind = typeof req.query.kind === "string" && KINDS.has(req.query.kind) ? req.query.kind : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
    return res.json(getDb().prepare(`SELECT * FROM suppressions WHERE workspace_id = ?
      AND (? = '' OR instr(lower(value), ?) > 0) AND (? IS NULL OR kind = ?)
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(ctx.workspaceId, q, q, kind, kind, limit));
  }
  if (req.method === "POST") {
    const parsed = suppressionCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error, "Valid kind and value are required") });
    const { kind, value, target_id } = parsed.data;
    const reason = parsed.data.reason ?? "manual";
    if(target_id&&!getDb().prepare("SELECT 1 FROM targets WHERE id=? AND workspace_id=?").get(target_id,ctx.workspaceId))return res.status(400).json({error:"Contact not found"});
    const row = addSuppression({ workspaceId: ctx.workspaceId, kind, value, reason, source: "manual", targetId: target_id, createdBy: ctx.userId ?? undefined });
    recordAudit(ctx, "suppression.created", "suppression", (row as { id?: string })?.id, { kind, value, reason });
    return res.status(201).json(row);
  }
  if(req.method==="PUT"){
    const {target_id,kind,value}=req.body as {target_id?:string;kind?:SuppressionKind;value?:string};
    if(target_id)return res.json({suppressed:findTargetSuppression(ctx.workspaceId,target_id)});
    if(!kind||!value)return res.status(400).json({error:"target_id or kind and value are required"});
    const match=kind==="email"?isAddressSuppressed(ctx.workspaceId,value):getDb().prepare("SELECT kind,value,reason FROM suppressions WHERE workspace_id=? AND kind=? AND value=?").get(ctx.workspaceId,kind,normalizeSuppression(kind,value));
    return res.json({suppressed:match??null});
  }
  if (req.method === "DELETE") {
    const id = req.query.id as string;
    const row = getDb().prepare("SELECT kind, value, reason, source FROM suppressions WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as { kind: string; value: string; reason: string; source: string | null } | undefined;
    if (!row) return res.status(204).end();
    // Someone who opted out, complained or bounced is on the list for a reason nobody typed
    // in. Lifting that is an admin's call, not any member's.
    if (isProtectedSuppression(row) && !["admin", "owner"].includes(ctx.role)) {
      return res.status(403).json({ error: "Only an admin can remove an entry that came from an unsubscribe, a complaint or a bounce" });
    }
    getDb().prepare("DELETE FROM suppressions WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "suppression.deleted", "suppression", id, { kind: row.kind, value: row.value, reason: row.reason });
    return res.status(204).end();
  }
  return res.status(405).end();
}
