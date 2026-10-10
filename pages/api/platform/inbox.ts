import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

const STATUSES = new Set(["open", "pending", "resolved", "closed"]);
const SENTIMENTS = new Set(["positive", "neutral", "negative"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    const members = db.prepare(`SELECT u.id,u.email,wm.role FROM workspace_members wm JOIN users u ON u.id=wm.user_id
      WHERE wm.workspace_id=? ORDER BY u.email`).all(ctx.workspaceId);
    const tags = db.prepare("SELECT * FROM inbox_tags WHERE workspace_id=? ORDER BY name").all(ctx.workspaceId);
    const saved_replies = db.prepare("SELECT * FROM saved_replies WHERE workspace_id=? ORDER BY name").all(ctx.workspaceId);
    const stats = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN inbox_status='open' THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN sla_due_at < datetime('now') AND inbox_status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) overdue,
      SUM(CASE WHEN assigned_to IS NULL THEN 1 ELSE 0 END) unassigned
      FROM email_replies WHERE workspace_id=?`).get(ctx.workspaceId);
    return res.json({ members, tags, saved_replies, stats });
  }
  if (req.method !== "POST") return res.status(405).end();
  const body = req.body as Record<string, unknown>;
  const action = String(body.action ?? "");
  if (action === "create_tag") {
    const name = String(body.name ?? "").trim(); if (!name) return res.status(400).json({ error: "name is required" });
    const color = String(body.color ?? "#64748b"); if (!HEX_COLOR.test(color)) return res.status(400).json({ error: "color must be a hex colour such as #64748b" });
    const id = randomUUID();
    try { db.prepare("INSERT INTO inbox_tags (id,workspace_id,name,color) VALUES (?,?,?,?)").run(id,ctx.workspaceId,name,color); }
    catch { return res.status(409).json({ error: "Tag already exists" }); }
    recordAudit(ctx,"inbox.tag_created","inbox_tag",id); return res.status(201).json({ id });
  }
  if (action === "update_tag") {
    const id = String(body.id ?? "");
    if (!db.prepare("SELECT 1 FROM inbox_tags WHERE id=? AND workspace_id=?").get(id, ctx.workspaceId)) return res.status(404).json({ error: "Tag not found" });
    const name = body.name === undefined ? null : String(body.name).trim();
    const color = body.color === undefined ? null : String(body.color);
    if (name === "") return res.status(400).json({ error: "name is required" });
    if (color !== null && !HEX_COLOR.test(color)) return res.status(400).json({ error: "color must be a hex colour such as #64748b" });
    try { db.prepare("UPDATE inbox_tags SET name=COALESCE(?,name), color=COALESCE(?,color) WHERE id=? AND workspace_id=?").run(name, color, id, ctx.workspaceId); }
    catch { return res.status(409).json({ error: "Tag already exists" }); }
    recordAudit(ctx,"inbox.tag_updated","inbox_tag",id); return res.json({ ok: true });
  }
  if (action === "create_saved_reply") {
    const name=String(body.name??"").trim(), replyBody=String(body.body??"").trim(); if(!name||!replyBody) return res.status(400).json({error:"name and body are required"});
    const id=randomUUID(); db.prepare("INSERT INTO saved_replies (id,workspace_id,name,body,created_by) VALUES (?,?,?,?,?)").run(id,ctx.workspaceId,name,replyBody,ctx.userId);
    recordAudit(ctx,"inbox.saved_reply_created","saved_reply",id); return res.status(201).json({id});
  }
  if (action === "delete_tag" || action === "delete_saved_reply") {
    const id=String(body.id??""); const table=action==="delete_tag"?"inbox_tags":"saved_replies";
    db.prepare(`DELETE FROM ${table} WHERE id=? AND workspace_id=?`).run(id,ctx.workspaceId); recordAudit(ctx,`inbox.${action}`,table,id); return res.json({ok:true});
  }
  const replyIds = Array.isArray(body.reply_ids) ? body.reply_ids.map(String).slice(0,500) : body.reply_id ? [String(body.reply_id)] : [];
  if (!replyIds.length) return res.status(400).json({ error: "reply_id or reply_ids is required" });
  const placeholders=replyIds.map(()=>"?").join(",");
  let extra: Record<string, unknown> = {};
  const owned = db.prepare(`SELECT id FROM email_replies WHERE workspace_id=? AND id IN (${placeholders})`).all(ctx.workspaceId,...replyIds) as Array<{id:string}>;
  if (owned.length !== replyIds.length) return res.status(404).json({ error: "One or more replies were not found" });
  if (action === "lock") {
    if (!ctx.userId) return res.status(403).json({error:"User identity required"});
    const result=db.prepare(`UPDATE email_replies SET locked_by=?,locked_at=datetime('now') WHERE id=? AND workspace_id=?
      AND (locked_by IS NULL OR locked_by=? OR locked_at < datetime('now','-15 minutes'))`).run(ctx.userId,replyIds[0],ctx.workspaceId,ctx.userId);
    if(!result.changes) return res.status(409).json({error:"Reply is being handled by another teammate"});
  } else if (action === "unlock") {
    db.prepare(`UPDATE email_replies SET locked_by=NULL,locked_at=NULL WHERE id IN (${placeholders}) AND workspace_id=? AND (locked_by=? OR ? IN ('admin','owner'))`).run(...replyIds,ctx.workspaceId,ctx.userId,ctx.role);
  } else if (action === "assign") {
    const assignee=body.assigned_to===null?null:String(body.assigned_to??"");
    if(assignee && !db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?").get(ctx.workspaceId,assignee)) return res.status(400).json({error:"Assignee is not a workspace member"});
    db.prepare(`UPDATE email_replies SET assigned_to=? WHERE id IN (${placeholders}) AND workspace_id=?`).run(assignee,...replyIds,ctx.workspaceId);
  } else if (action === "status") {
    const status=String(body.status??""); if(!STATUSES.has(status)) return res.status(400).json({error:"Invalid status"});
    db.prepare(`UPDATE email_replies SET inbox_status=? WHERE id IN (${placeholders}) AND workspace_id=?`).run(status,...replyIds,ctx.workspaceId);
  } else if (action === "set_sla") {
    // Stored the way the "overdue" comparison reads it: SQLite's UTC text, not whatever
    // shape the caller sent. An unreadable value used to be written as it came, and such a
    // reply was then never, or always, overdue.
    const due = body.sla_due_at === null || body.sla_due_at === undefined || body.sla_due_at === "" ? null : Date.parse(String(body.sla_due_at));
    if (due !== null && Number.isNaN(due)) return res.status(400).json({ error: "sla_due_at must be a date and time" });
    db.prepare(`UPDATE email_replies SET sla_due_at=? WHERE id IN (${placeholders}) AND workspace_id=?`).run(due === null ? null : new Date(due).toISOString().slice(0, 19).replace("T", " "),...replyIds,ctx.workspaceId);
  } else if (action === "set_sentiment") {
    const sentiment = body.sentiment === null ? null : String(body.sentiment ?? "");
    if (sentiment !== null && !SENTIMENTS.has(sentiment)) return res.status(400).json({ error: "sentiment must be positive, neutral or negative" });
    db.prepare(`UPDATE email_replies SET sentiment=? WHERE id IN (${placeholders}) AND workspace_id=?`).run(sentiment,...replyIds,ctx.workspaceId);
  } else if (action === "tag") {
    const tagId=String(body.tag_id??""); if(!db.prepare("SELECT 1 FROM inbox_tags WHERE id=? AND workspace_id=?").get(tagId,ctx.workspaceId)) return res.status(400).json({error:"Tag not found"});
    const insert=db.prepare("INSERT OR IGNORE INTO email_reply_tags (reply_id,tag_id) VALUES (?,?)"); db.transaction(()=>replyIds.forEach(id=>insert.run(id,tagId)))();
  } else if (action === "untag") {
    const tagId=String(body.tag_id??""); db.prepare(`DELETE FROM email_reply_tags WHERE tag_id=? AND reply_id IN (${placeholders})`).run(tagId,...replyIds);
  } else if (action === "relink") {
    // Re-attach replies that lost their contact (the contact was deleted). With an explicit
    // target_id the operator picks the contact; without one each reply is matched to a contact
    // with the same email address, which is what recreating a deleted contact produces.
    const targetId = body.target_id === null || body.target_id === undefined ? null : String(body.target_id);
    if (targetId) {
      if (!db.prepare("SELECT 1 FROM targets WHERE id=? AND workspace_id=?").get(targetId, ctx.workspaceId)) return res.status(400).json({ error: "Contact not found in this workspace" });
      const linked = db.prepare(`UPDATE email_replies SET target_id=? WHERE id IN (${placeholders}) AND workspace_id=?`).run(targetId, ...replyIds, ctx.workspaceId);
      extra = { relinked: linked.changes, target_id: targetId };
    } else {
      const matched = db.prepare(`
        UPDATE email_replies SET target_id = (
          SELECT t.id FROM targets t
          WHERE t.workspace_id = email_replies.workspace_id AND lower(t.email) = lower(email_replies.from_email)
          ORDER BY t.created_at DESC LIMIT 1
        )
        WHERE id IN (${placeholders}) AND workspace_id = ? AND target_id IS NULL AND channel = 'email'
          AND EXISTS (SELECT 1 FROM targets t WHERE t.workspace_id = email_replies.workspace_id AND lower(t.email) = lower(email_replies.from_email))
      `).run(...replyIds, ctx.workspaceId);
      extra = { relinked: matched.changes, unmatched: replyIds.length - matched.changes };
    }
  } else return res.status(400).json({error:"Unknown action"});
  recordAudit(ctx,`inbox.${action}`,"email_reply",replyIds[0],{reply_ids:replyIds,...extra});
  return res.json({ok:true,updated:replyIds.length,...extra});
}
