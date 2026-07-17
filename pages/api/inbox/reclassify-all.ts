import type { NextApiRequest,NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { classifyAndDispatch } from "@/lib/community-replies";
import { recordAudit,requireWorkspace } from "@/lib/workspace";

export default async function handler(req:NextApiRequest,res:NextApiResponse){
  if(req.method!=="POST")return res.status(405).end();
  const ctx=requireWorkspace(req,res,"member");if(!ctx)return;
  const rows=getDb().prepare("SELECT id FROM email_replies WHERE workspace_id=? AND (classified_at IS NULL OR classification_error IS NOT NULL) ORDER BY received_at DESC LIMIT 250").all(ctx.workspaceId) as Array<{id:string}>;
  let classified=0,failed=0;
  for(const row of rows){try{await classifyAndDispatch(row.id);classified+=1;}catch{failed+=1;}}
  recordAudit(ctx,"reply.bulk_classified","email_reply",undefined,{total:rows.length,classified,failed});
  return res.json({total:rows.length,classified,failed});
}
