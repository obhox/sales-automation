import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { addSuppression, findTargetSuppression, isAddressSuppressed, normalizeSuppression, type SuppressionKind } from "@/lib/platform/suppression";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { suppressionCreateSchema, firstIssue } from "@/lib/validation";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  if (req.method === "GET") return res.json(getDb().prepare("SELECT * FROM suppressions WHERE workspace_id = ? ORDER BY created_at DESC").all(ctx.workspaceId));
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
    getDb().prepare("DELETE FROM suppressions WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "suppression.deleted", "suppression", id);
    return res.status(204).end();
  }
  return res.status(405).end();
}
