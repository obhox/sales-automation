import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { recordAudit, requireWorkspace, type WorkspaceContext } from "@/lib/workspace";
import { settleStage, settleStageOpportunities } from "@/lib/platform/pipeline";

type DB = ReturnType<typeof getDb>;
type Body = Record<string, unknown>;

const OPPORTUNITY = `SELECT o.*, ps.name stage_name, ps.probability, ps.is_won, ps.is_lost,
  t.full_name contact_name, c.name company_name, u.email owner_email FROM opportunities o
  LEFT JOIN pipeline_stages ps ON ps.id=o.stage_id LEFT JOIN targets t ON t.id=o.target_id
  LEFT JOIN companies c ON c.id=o.company_id LEFT JOIN users u ON u.id=o.owner_id`;

// Everyone works opportunities; the stages are the shape of the whole team's pipeline.
const MANAGES_STAGES = ["owner", "admin", "manager"];

/** A value the caller sent that is not usable, as the message to send back. */
class Refused extends Error {}

function amountOf(value: unknown): number | null {
  if (value === null || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Refused("Amount must be a number, zero or more");
  return amount;
}

function closeDateOf(value: unknown): string | null {
  if (value === null || value === "") return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new Refused("Expected close date must be a date (YYYY-MM-DD)");
  return text;
}

function currencyOf(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Refused("Currency must be a three-letter code, like USD");
  return code;
}

function probabilityOf(value: unknown): number {
  const probability = Number(value);
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) throw new Refused("Probability must be a whole number from 0 to 100");
  return probability;
}

/** An id the caller named must be something in their workspace; null or "" clears the link. */
function refOf(db: DB, ctx: WorkspaceContext, field: string, value: unknown): string | null {
  if (value === null || value === "") return null;
  const id = String(value);
  const found = field === "owner_id"
    ? db.prepare("SELECT 1 FROM workspace_members WHERE user_id=? AND workspace_id=?").get(id, ctx.workspaceId)
    : db.prepare(`SELECT 1 FROM ${{ target_id: "targets", company_id: "companies", stage_id: "pipeline_stages" }[field]} WHERE id=? AND workspace_id=?`).get(id, ctx.workspaceId);
  if (!found) throw new Refused({ target_id: "Contact not found", company_id: "Company not found", stage_id: "Pipeline stage not found", owner_id: "Owner is not a workspace member" }[field]!);
  return id;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();
  try {
    if (req.method === "GET") return read(db, ctx, res);
    const body = (req.body ?? {}) as Body;
    const stageWork = req.method === "DELETE" ? req.query.stage_id !== undefined : String(body.entity ?? "").startsWith("stage");
    if (stageWork && !MANAGES_STAGES.includes(ctx.role)) return res.status(403).json({ error: "Changing the pipeline's stages needs a manager" });
    if (req.method === "POST") return body.entity === "stage" ? createStage(db, ctx, body, res) : createOpportunity(db, ctx, body, res);
    if (req.method === "PATCH") {
      if (body.entity === "stage_order") return reorderStages(db, ctx, body, res);
      return body.entity === "stage" ? updateStage(db, ctx, body, res) : updateOpportunity(db, ctx, body, res);
    }
    if (req.method === "DELETE") return stageWork ? deleteStage(db, ctx, req, res) : deleteOpportunity(db, ctx, req, res);
    return res.status(405).end();
  } catch (error) {
    if (error instanceof Refused) return res.status(400).json({ error: error.message });
    throw error;
  }
}

function read(db: DB, ctx: WorkspaceContext, res: NextApiResponse) {
  const stages = db.prepare(`SELECT ps.*, COUNT(o.id) opportunity_count, COALESCE(SUM(o.amount),0) amount,
    COALESCE(SUM(COALESCE(o.amount,0) * ps.probability / 100.0),0) weighted_amount
    FROM pipeline_stages ps LEFT JOIN opportunities o ON o.stage_id=ps.id WHERE ps.workspace_id=? GROUP BY ps.id ORDER BY ps.position, ps.name`).all(ctx.workspaceId);
  const opportunities = db.prepare(`${OPPORTUNITY} WHERE o.workspace_id=? ORDER BY o.updated_at DESC`).all(ctx.workspaceId);
  const meetings = db.prepare(`SELECT m.*, t.full_name contact_name, ec.name connection_name, ec.provider
    FROM meetings m LEFT JOIN targets t ON t.id=m.target_id LEFT JOIN external_connections ec ON ec.id=m.connection_id
    WHERE m.workspace_id=? ORDER BY m.starts_at DESC LIMIT 500`).all(ctx.workspaceId);
  const revenue = db.prepare(`SELECT COALESCE(SUM(CASE WHEN ps.is_won=1 THEN o.amount ELSE 0 END),0) won_revenue,
    COALESCE(SUM(CASE WHEN ps.is_won=0 AND ps.is_lost=0 THEN o.amount ELSE 0 END),0) open_pipeline,
    COALESCE(SUM(CASE WHEN ps.is_won=0 AND ps.is_lost=0 THEN o.amount*ps.probability/100.0 ELSE 0 END),0) weighted_pipeline
    FROM opportunities o LEFT JOIN pipeline_stages ps ON ps.id=o.stage_id WHERE o.workspace_id=?`).get(ctx.workspaceId);
  // Who an opportunity can be given to.
  const members = db.prepare(`SELECT u.id, u.email, wm.role FROM workspace_members wm JOIN users u ON u.id=wm.user_id
    WHERE wm.workspace_id=? ORDER BY u.email`).all(ctx.workspaceId);
  return res.json({ stages, opportunities, meetings, revenue, members });
}

function createStage(db: DB, ctx: WorkspaceContext, body: Body, res: NextApiResponse) {
  const name = String(body.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  if (body.is_won && body.is_lost) return res.status(400).json({ error: "A stage is won or lost, not both" });
  // A new stage goes at the end unless it is given a place.
  const position = body.position === undefined
    ? (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 next FROM pipeline_stages WHERE workspace_id=?").get(ctx.workspaceId) as { next: number }).next
    : Number(body.position) || 0;
  const id = randomUUID();
  db.prepare("INSERT INTO pipeline_stages (id,workspace_id,name,position,probability,is_won,is_lost) VALUES (?,?,?,?,?,?,?)")
    .run(id, ctx.workspaceId, name, position, probabilityOf(body.probability ?? 0), body.is_won ? 1 : 0, body.is_lost ? 1 : 0);
  recordAudit(ctx, "pipeline_stage.created", "pipeline_stage", id);
  return res.status(201).json({ id });
}

function updateStage(db: DB, ctx: WorkspaceContext, body: Body, res: NextApiResponse) {
  const id = String(body.id ?? "");
  const stage = db.prepare("SELECT is_won, is_lost FROM pipeline_stages WHERE id=? AND workspace_id=?").get(id, ctx.workspaceId) as { is_won: number; is_lost: number } | undefined;
  if (!stage) return res.status(404).json({ error: "Pipeline stage not found" });
  const set: Record<string, unknown> = {};
  if (body.name !== undefined) {
    set.name = String(body.name).trim();
    if (!set.name) return res.status(400).json({ error: "name is required" });
  }
  if (body.probability !== undefined) set.probability = probabilityOf(body.probability);
  if (body.position !== undefined) set.position = Number(body.position) || 0;
  if (body.is_won !== undefined) set.is_won = body.is_won ? 1 : 0;
  if (body.is_lost !== undefined) set.is_lost = body.is_lost ? 1 : 0;
  const fields = Object.keys(set);
  if (!fields.length) return res.status(400).json({ error: "No supported fields supplied" });
  if ((set.is_won ?? stage.is_won) && (set.is_lost ?? stage.is_lost)) return res.status(400).json({ error: "A stage is won or lost, not both" });
  db.transaction(() => {
    db.prepare(`UPDATE pipeline_stages SET ${fields.map((x) => `${x}=?`).join(",")} WHERE id=? AND workspace_id=?`).run(...fields.map((x) => set[x]), id, ctx.workspaceId);
    if ("is_won" in set || "is_lost" in set) settleStageOpportunities(db, ctx.workspaceId, id);
  })();
  recordAudit(ctx, "pipeline_stage.updated", "pipeline_stage", id, { fields });
  return res.json(db.prepare("SELECT * FROM pipeline_stages WHERE id=?").get(id));
}

/** Put the stages in the order given. Every stage has to be named once, so none is left without a place. */
function reorderStages(db: DB, ctx: WorkspaceContext, body: Body, res: NextApiResponse) {
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const existing = (db.prepare("SELECT id FROM pipeline_stages WHERE workspace_id=?").all(ctx.workspaceId) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length !== existing.length || new Set(ids).size !== ids.length || !ids.every((id) => existing.includes(id))) {
    return res.status(400).json({ error: "ids must list every stage of this pipeline exactly once" });
  }
  const place = db.prepare("UPDATE pipeline_stages SET position=? WHERE id=? AND workspace_id=?");
  db.transaction(() => ids.forEach((id, position) => place.run(position, id, ctx.workspaceId)))();
  recordAudit(ctx, "pipeline_stage.reordered", "pipeline_stage", undefined, { ids });
  return res.json({ ok: true });
}

function deleteStage(db: DB, ctx: WorkspaceContext, req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.stage_id ?? "");
  if (!db.prepare("SELECT 1 FROM pipeline_stages WHERE id=? AND workspace_id=?").get(id, ctx.workspaceId)) return res.status(404).json({ error: "Pipeline stage not found" });
  const inStage = (db.prepare("SELECT id FROM opportunities WHERE stage_id=? AND workspace_id=?").all(id, ctx.workspaceId) as Array<{ id: string }>).map((row) => row.id);
  const moveTo = typeof req.query.move_to === "string" && req.query.move_to ? req.query.move_to : null;
  // Deleting the stage would otherwise leave its opportunities in no stage at all, where
  // the board has no column for them and the totals stop counting them.
  if (inStage.length && !moveTo) return res.status(409).json({ error: `This stage holds ${inStage.length} ${inStage.length === 1 ? "opportunity" : "opportunities"}. Choose a stage to move them to.`, opportunity_count: inStage.length });
  if (moveTo && (moveTo === id || !db.prepare("SELECT 1 FROM pipeline_stages WHERE id=? AND workspace_id=?").get(moveTo, ctx.workspaceId))) return res.status(400).json({ error: "Pipeline stage not found" });
  db.transaction(() => {
    if (moveTo) {
      db.prepare("UPDATE opportunities SET stage_id=?, updated_at=datetime('now') WHERE stage_id=? AND workspace_id=?").run(moveTo, id, ctx.workspaceId);
      for (const opportunityId of inStage) settleStage(db, ctx.workspaceId, opportunityId, id);
    }
    db.prepare("DELETE FROM pipeline_stages WHERE id=? AND workspace_id=?").run(id, ctx.workspaceId);
  })();
  recordAudit(ctx, "pipeline_stage.deleted", "pipeline_stage", id, { moved: inStage.length, move_to: moveTo });
  return res.json({ ok: true, moved: inStage.length });
}

function createOpportunity(db: DB, ctx: WorkspaceContext, body: Body, res: NextApiResponse) {
  const name = String(body.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const ref = (field: string) => body[field] === undefined ? null : refOf(db, ctx, field, body[field]);
  const row = {
    target_id: ref("target_id"), company_id: ref("company_id"), stage_id: ref("stage_id"),
    owner_id: body.owner_id === undefined ? ctx.userId : refOf(db, ctx, "owner_id", body.owner_id),
    amount: body.amount === undefined ? null : amountOf(body.amount),
    currency: body.currency === undefined ? "USD" : currencyOf(body.currency),
    expected_close_date: body.expected_close_date === undefined ? null : closeDateOf(body.expected_close_date),
  };
  const id = randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO opportunities (id,workspace_id,target_id,company_id,stage_id,owner_id,name,amount,currency,expected_close_date,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, ctx.workspaceId, row.target_id, row.company_id, row.stage_id, row.owner_id, name, row.amount, row.currency, row.expected_close_date, String(body.source ?? "manual"));
    settleStage(db, ctx.workspaceId, id);
  })();
  recordAudit(ctx, "opportunity.created", "opportunity", id);
  return res.status(201).json(db.prepare(`${OPPORTUNITY} WHERE o.id=?`).get(id));
}

function updateOpportunity(db: DB, ctx: WorkspaceContext, body: Body, res: NextApiResponse) {
  const id = String(body.id ?? "");
  if (!id) return res.status(400).json({ error: "id is required" });
  const before = db.prepare("SELECT stage_id FROM opportunities WHERE id=? AND workspace_id=?").get(id, ctx.workspaceId) as { stage_id: string | null } | undefined;
  if (!before) return res.status(404).json({ error: "Opportunity not found" });
  const set: Record<string, unknown> = {};
  for (const field of ["stage_id", "owner_id", "target_id", "company_id"]) if (body[field] !== undefined) set[field] = refOf(db, ctx, field, body[field]);
  if (body.name !== undefined) {
    set.name = String(body.name).trim();
    if (!set.name) return res.status(400).json({ error: "name is required" });
  }
  if (body.amount !== undefined) set.amount = amountOf(body.amount);
  if (body.currency !== undefined) set.currency = currencyOf(body.currency);
  if (body.expected_close_date !== undefined) set.expected_close_date = closeDateOf(body.expected_close_date);
  if (body.source !== undefined) set.source = body.source === null ? null : String(body.source);
  const fields = Object.keys(set);
  if (!fields.length) return res.status(400).json({ error: "No supported fields supplied" });
  db.transaction(() => {
    db.prepare(`UPDATE opportunities SET ${fields.map((x) => `${x}=?`).join(",")},updated_at=datetime('now') WHERE id=? AND workspace_id=?`).run(...fields.map((x) => set[x]), id, ctx.workspaceId);
    settleStage(db, ctx.workspaceId, id, before.stage_id);
  })();
  recordAudit(ctx, "opportunity.updated", "opportunity", id, { fields });
  return res.json(db.prepare(`${OPPORTUNITY} WHERE o.id=?`).get(id));
}

function deleteOpportunity(db: DB, ctx: WorkspaceContext, req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id ?? "");
  const row = db.prepare("SELECT name FROM opportunities WHERE id=? AND workspace_id=?").get(id, ctx.workspaceId) as { name: string } | undefined;
  if (!row) return res.status(404).json({ error: "Opportunity not found" });
  // Meetings tied to it stay, with the link cleared (ON DELETE SET NULL).
  db.prepare("DELETE FROM opportunities WHERE id=? AND workspace_id=?").run(id, ctx.workspaceId);
  recordAudit(ctx, "opportunity.deleted", "opportunity", id, { name: row.name });
  return res.status(204).end();
}
