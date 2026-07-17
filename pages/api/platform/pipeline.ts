import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    const stages = db.prepare(`SELECT ps.*, COUNT(o.id) opportunity_count, COALESCE(SUM(o.amount),0) amount,
      COALESCE(SUM(COALESCE(o.amount,0) * ps.probability / 100.0),0) weighted_amount
      FROM pipeline_stages ps LEFT JOIN opportunities o ON o.stage_id=ps.id WHERE ps.workspace_id=? GROUP BY ps.id ORDER BY ps.position`).all(ctx.workspaceId);
    const opportunities = db.prepare(`SELECT o.*, ps.name stage_name, ps.probability, ps.is_won, ps.is_lost,
      t.full_name contact_name, c.name company_name, u.email owner_email FROM opportunities o
      LEFT JOIN pipeline_stages ps ON ps.id=o.stage_id LEFT JOIN targets t ON t.id=o.target_id
      LEFT JOIN companies c ON c.id=o.company_id LEFT JOIN users u ON u.id=o.owner_id
      WHERE o.workspace_id=? ORDER BY o.updated_at DESC`).all(ctx.workspaceId);
    const meetings = db.prepare(`SELECT m.*, t.full_name contact_name, ec.name connection_name, ec.provider
      FROM meetings m LEFT JOIN targets t ON t.id=m.target_id LEFT JOIN external_connections ec ON ec.id=m.connection_id
      WHERE m.workspace_id=? ORDER BY m.starts_at DESC LIMIT 500`).all(ctx.workspaceId);
    const revenue = db.prepare(`SELECT COALESCE(SUM(CASE WHEN ps.is_won=1 THEN o.amount ELSE 0 END),0) won_revenue,
      COALESCE(SUM(CASE WHEN ps.is_won=0 AND ps.is_lost=0 THEN o.amount ELSE 0 END),0) open_pipeline,
      COALESCE(SUM(CASE WHEN ps.is_won=0 AND ps.is_lost=0 THEN o.amount*ps.probability/100.0 ELSE 0 END),0) weighted_pipeline
      FROM opportunities o LEFT JOIN pipeline_stages ps ON ps.id=o.stage_id WHERE o.workspace_id=?`).get(ctx.workspaceId);
    return res.json({ stages, opportunities, meetings, revenue });
  }
  if (req.method === "POST") {
    const body = req.body as Record<string, unknown>;
    if (body.entity === "stage") {
      const name = String(body.name ?? "").trim();
      if (!name) return res.status(400).json({ error: "name is required" });
      const id = randomUUID();
      db.prepare("INSERT INTO pipeline_stages (id,workspace_id,name,position,probability,is_won,is_lost) VALUES (?,?,?,?,?,?,?)")
        .run(id, ctx.workspaceId, name, Number(body.position ?? 0), Number(body.probability ?? 0), body.is_won ? 1 : 0, body.is_lost ? 1 : 0);
      recordAudit(ctx, "pipeline_stage.created", "pipeline_stage", id);
      return res.status(201).json({ id });
    }
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    if(body.target_id&&!db.prepare("SELECT 1 FROM targets WHERE id=? AND workspace_id=?").get(body.target_id,ctx.workspaceId))return res.status(400).json({error:"Contact not found"});
    if(body.company_id&&!db.prepare("SELECT 1 FROM companies WHERE id=? AND workspace_id=?").get(body.company_id,ctx.workspaceId))return res.status(400).json({error:"Company not found"});
    if(body.stage_id&&!db.prepare("SELECT 1 FROM pipeline_stages WHERE id=? AND workspace_id=?").get(body.stage_id,ctx.workspaceId))return res.status(400).json({error:"Pipeline stage not found"});
    if(body.owner_id&&!db.prepare("SELECT 1 FROM workspace_members WHERE user_id=? AND workspace_id=?").get(body.owner_id,ctx.workspaceId))return res.status(400).json({error:"Owner is not a workspace member"});
    const id = randomUUID();
    db.prepare(`INSERT INTO opportunities (id,workspace_id,target_id,company_id,stage_id,owner_id,name,amount,currency,expected_close_date,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, ctx.workspaceId, body.target_id ?? null, body.company_id ?? null, body.stage_id ?? null, body.owner_id ?? ctx.userId,
      name, body.amount === undefined ? null : Number(body.amount), String(body.currency ?? "USD"), body.expected_close_date ?? null, body.source ?? "manual");
    recordAudit(ctx, "opportunity.created", "opportunity", id);
    return res.status(201).json(db.prepare("SELECT * FROM opportunities WHERE id=?").get(id));
  }
  if (req.method === "PATCH") {
    const body = req.body as Record<string, unknown>;
    const id = String(body.id ?? "");
    if (!id) return res.status(400).json({ error: "id is required" });
    if(body.stage_id&&!db.prepare("SELECT 1 FROM pipeline_stages WHERE id=? AND workspace_id=?").get(body.stage_id,ctx.workspaceId))return res.status(400).json({error:"Pipeline stage not found"});
    if(body.owner_id&&!db.prepare("SELECT 1 FROM workspace_members WHERE user_id=? AND workspace_id=?").get(body.owner_id,ctx.workspaceId))return res.status(400).json({error:"Owner is not a workspace member"});
    const allowed = ["stage_id", "owner_id", "name", "amount", "currency", "expected_close_date", "source"];
    const updates = allowed.filter((key) => body[key] !== undefined);
    if (!updates.length) return res.status(400).json({ error: "No supported fields supplied" });
    db.prepare(`UPDATE opportunities SET ${updates.map((x) => `${x}=?`).join(",")},updated_at=datetime('now') WHERE id=? AND workspace_id=?`)
      .run(...updates.map((x) => x === "amount" ? Number(body[x]) : body[x]), id, ctx.workspaceId);
    recordAudit(ctx, "opportunity.updated", "opportunity", id, { fields: updates });
    return res.json(db.prepare("SELECT * FROM opportunities WHERE id=? AND workspace_id=?").get(id, ctx.workspaceId));
  }
  return res.status(405).end();
}
