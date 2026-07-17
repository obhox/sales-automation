import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { emitDomainEvent, processWebhookDeliveries } from "@/lib/platform/events";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

export default async function handler(req: NextApiRequest,res: NextApiResponse){
  const ctx=requireWorkspace(req,res,req.method==="GET"?"viewer":"manager");if(!ctx)return;
  if(req.method==="GET"){
    const limit=Math.min(500,Math.max(1,Number(req.query.limit??100)));const type=String(req.query.type??"");
    const rows=type?getDb().prepare("SELECT * FROM domain_events WHERE workspace_id=? AND type=? ORDER BY occurred_at DESC LIMIT ?").all(ctx.workspaceId,type,limit):getDb().prepare("SELECT * FROM domain_events WHERE workspace_id=? ORDER BY occurred_at DESC LIMIT ?").all(ctx.workspaceId,limit);
    return res.json(rows);
  }
  if(req.method==="POST"){
    const b=req.body as {type?:string;entity_type?:string;entity_id?:string;payload?:Record<string,unknown>;deliver?:boolean};
    if(!b.type?.trim())return res.status(400).json({error:"type is required"});
    const id=emitDomainEvent({workspaceId:ctx.workspaceId,type:b.type.trim(),entityType:b.entity_type,entityId:b.entity_id,payload:b.payload??{}});
    if(b.deliver!==false)await processWebhookDeliveries();
    recordAudit(ctx,"domain_event.emitted","domain_event",id,{type:b.type});return res.status(201).json({id});
  }
  return res.status(405).end();
}
