import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") return res.json(db.prepare(`SELECT sr.*,l.name list_name,w.name workflow_name,a.name account_name
    FROM signal_rules sr LEFT JOIN lists l ON l.id=sr.list_id LEFT JOIN workflows w ON w.id=sr.workflow_id LEFT JOIN accounts a ON a.id=sr.account_id
    WHERE sr.workspace_id=? ORDER BY sr.created_at DESC`).all(ctx.workspaceId));
  if (req.method === "POST") {
    const b=req.body as Record<string,unknown>; const name=String(b.name??"").trim(), type=String(b.signal_type??"").trim();
    if(!name||!type) return res.status(400).json({error:"name and signal_type are required"});
    for(const [table,id] of [["lists",b.list_id],["workflows",b.workflow_id],["accounts",b.account_id]] as Array<[string,unknown]>) {
      if(id && !db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspace_id=?`).get(id,ctx.workspaceId)) return res.status(400).json({error:`${table.slice(0,-1)} does not belong to this workspace`});
    }
    const id=randomUUID(); db.prepare(`INSERT INTO signal_rules (id,workspace_id,name,signal_type,min_score,list_id,workflow_id,account_id,enabled,auto_start)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,ctx.workspaceId,name,type,Number(b.min_score??0),b.list_id??null,b.workflow_id??null,b.account_id??null,b.enabled===false?0:1,b.auto_start?1:0);
    recordAudit(ctx,"signal_rule.created","signal_rule",id); return res.status(201).json(db.prepare("SELECT * FROM signal_rules WHERE id=?").get(id));
  }
  if(req.method==="PATCH") {
    const b=req.body as Record<string,unknown>, id=String(b.id??""); if(!id) return res.status(400).json({error:"id is required"});
    if(!db.prepare("SELECT 1 FROM signal_rules WHERE id=? AND workspace_id=?").get(id,ctx.workspaceId)) return res.status(404).json({error:"Rule not found"});
    // Validate any referenced entity belongs to this workspace (POST already does this).
    for(const [table,val] of [["lists",b.list_id],["workflows",b.workflow_id],["accounts",b.account_id]] as Array<[string,unknown]>) {
      if(val && !db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspace_id=?`).get(val,ctx.workspaceId)) return res.status(400).json({error:`${table.slice(0,-1)} does not belong to this workspace`});
    }
    const fields=["name","signal_type","min_score","list_id","workflow_id","account_id","enabled","auto_start"].filter(x=>b[x]!==undefined);
    if(!fields.length) return res.status(400).json({error:"No fields supplied"});
    const coerce=(x:string)=>["enabled","auto_start"].includes(x)?(b[x]?1:0):x==="min_score"?Number(b[x]??0):(b[x]??null);
    db.prepare(`UPDATE signal_rules SET ${fields.map(x=>`${x}=?`).join(",")} WHERE id=? AND workspace_id=?`).run(...fields.map(coerce),id,ctx.workspaceId);
    recordAudit(ctx,"signal_rule.updated","signal_rule",id); return res.json({ok:true});
  }
  if(req.method==="DELETE") { const id=String(req.query.id??""); db.prepare("DELETE FROM signal_rules WHERE id=? AND workspace_id=?").run(id,ctx.workspaceId); recordAudit(ctx,"signal_rule.deleted","signal_rule",id); return res.status(204).end(); }
  return res.status(405).end();
}
