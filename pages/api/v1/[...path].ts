import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { verifyApiKey } from "@/lib/api-keys";
import { getDb } from "@/lib/db";
import { ingestSignal } from "@/lib/platform/signals";
import { emitDomainEvent } from "@/lib/platform/events";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("X-API-Version", "2026-07-17");
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const auth = raw ? verifyApiKey(raw) : null;
  if (!auth) return res.status(401).json({ error: "invalid_api_key" });
  const parts = Array.isArray(req.query.path) ? req.query.path : [String(req.query.path ?? "")];
  const [resource, id] = parts;
  const db = getDb(), ws = auth.workspaceId;
  const readScope = resource === "contacts" ? "contacts:read" : resource === "events" ? "events:read" : resource === "signals" ? "events:read" : resource === "opportunities" ? "crm:read" : "campaigns:read";
  const writeScope = resource === "contacts" ? "contacts:write" : resource === "signals" ? "signals:write" : resource === "events" ? "events:write" : resource === "opportunities" ? "crm:write" : "campaigns:write";
  if (req.method === "GET" && !auth.scopes.includes(readScope)) return res.status(403).json({ error: "insufficient_scope", required: readScope });
  if (req.method !== "GET" && !auth.scopes.includes(writeScope)) return res.status(403).json({ error: "insufficient_scope", required: writeScope });

  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  if (req.method === "GET") {
    if (resource === "contacts") return res.json(id
      ? one(db, "SELECT * FROM targets WHERE id = ? AND workspace_id = ?", [id, ws], res)
      : page(db, "SELECT * FROM targets WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    if (resource === "companies") return res.json(id ? one(db, "SELECT * FROM companies WHERE id = ? AND workspace_id = ?", [id, ws], res) : page(db, "SELECT * FROM companies WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    if (resource === "lists") return res.json(id ? one(db, "SELECT * FROM lists WHERE id = ? AND workspace_id = ?", [id, ws], res) : page(db, "SELECT * FROM lists WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    if (resource === "workflows") return res.json(id ? one(db, "SELECT * FROM workflows WHERE id = ? AND workspace_id = ?", [id, ws], res) : page(db, "SELECT * FROM workflows WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    if (resource === "runs") return res.json(id ? one(db, "SELECT * FROM runs WHERE id = ? AND workspace_id = ?", [id, ws], res) : page(db, "SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    if (resource === "events") return res.json(page(db, "SELECT * FROM domain_events WHERE workspace_id = ? ORDER BY occurred_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    if (resource === "signals") return res.json(page(db, "SELECT * FROM signals WHERE workspace_id = ? ORDER BY occurred_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    if (resource === "opportunities") return res.json(id ? one(db, "SELECT * FROM opportunities WHERE id = ? AND workspace_id = ?", [id, ws], res) : page(db, "SELECT * FROM opportunities WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    return res.status(404).json({ error: "unknown_resource" });
  }

  if (req.method === "POST" && resource === "contacts") {
    const { full_name, linkedin_url, email, title, company, location } = req.body;
    if (!full_name) return res.status(400).json({ error: "full_name_required" });
    const contactId = randomUUID();
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url, email, title, company, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(contactId, ws, full_name, linkedin_url ?? null, email ?? null, title ?? null, company ?? null, location ?? null);
    emitDomainEvent({ workspaceId: ws, type: "contact.created", entityType: "contact", entityId: contactId, payload: req.body });
    return res.status(201).json(db.prepare("SELECT * FROM targets WHERE id = ?").get(contactId));
  }
  if (req.method === "PATCH" && resource === "contacts" && id) {
    if(req.body.owner_id&&!db.prepare("SELECT 1 FROM workspace_members WHERE user_id=? AND workspace_id=?").get(req.body.owner_id,ws))return res.status(400).json({error:"owner_not_found"});
    const allowed = ["full_name", "first_name", "last_name", "email", "phone", "title", "company", "location", "notes", "owner_id"];
    return update(db, "targets", id, ws, req.body, allowed, res);
  }
  if (req.method === "POST" && resource === "signals") {
    const body = req.body;
    if (!body.type || !body.title) return res.status(400).json({ error: "type_and_title_required" });
    if(body.target_id&&!belongs(db,"targets",body.target_id,ws))return res.status(400).json({error:"target_not_found"});
    if(body.company_id&&!belongs(db,"companies",body.company_id,ws))return res.status(400).json({error:"company_not_found"});
    return res.status(201).json(ingestSignal({ workspaceId: ws, targetId: body.target_id, companyId: body.company_id, type: body.type, title: body.title, description: body.description, score: body.score, source: body.source ?? "public_api", occurredAt: body.occurred_at, metadata: body.metadata }));
  }
  if (req.method === "POST" && resource === "events") {
    const allowed=new Set(["email.delivered","email.bounced","reply.received","linkedin.connected","meeting.booked"]);
    const type=String(req.body?.type??"");
    if(!allowed.has(type)) return res.status(400).json({error:"unsupported_event_type",allowed:[...allowed]});
    const eventId=emitDomainEvent({workspaceId:ws,type,entityType:req.body?.entity_type,entityId:req.body?.entity_id,payload:req.body?.data});
    return res.status(202).json({id:eventId,type});
  }
  if (req.method === "POST" && resource === "opportunities") {
    if (!req.body.name) return res.status(400).json({ error: "name_required" });
    if(req.body.target_id&&!belongs(db,"targets",req.body.target_id,ws))return res.status(400).json({error:"target_not_found"});
    if(req.body.company_id&&!belongs(db,"companies",req.body.company_id,ws))return res.status(400).json({error:"company_not_found"});
    if(req.body.stage_id&&!belongs(db,"pipeline_stages",req.body.stage_id,ws))return res.status(400).json({error:"stage_not_found"});
    if(req.body.owner_id&&!db.prepare("SELECT 1 FROM workspace_members WHERE user_id=? AND workspace_id=?").get(req.body.owner_id,ws))return res.status(400).json({error:"owner_not_found"});
    const opportunityId = randomUUID();
    db.prepare(`INSERT INTO opportunities (id, workspace_id, target_id, company_id, stage_id, owner_id, name, amount, currency, expected_close_date, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(opportunityId, ws, req.body.target_id ?? null, req.body.company_id ?? null, req.body.stage_id ?? null, req.body.owner_id ?? null, req.body.name, req.body.amount ?? null, req.body.currency ?? "USD", req.body.expected_close_date ?? null, req.body.source ?? "api");
    return res.status(201).json(db.prepare("SELECT * FROM opportunities WHERE id = ?").get(opportunityId));
  }
  if (req.method === "PATCH" && resource === "opportunities" && id) {
    if(req.body.stage_id&&!belongs(db,"pipeline_stages",req.body.stage_id,ws))return res.status(400).json({error:"stage_not_found"});
    if(req.body.owner_id&&!db.prepare("SELECT 1 FROM workspace_members WHERE user_id=? AND workspace_id=?").get(req.body.owner_id,ws))return res.status(400).json({error:"owner_not_found"});
    return update(db, "opportunities", id, ws, req.body, ["stage_id", "owner_id", "name", "amount", "currency", "expected_close_date", "source"], res);
  }
  return res.status(404).json({ error: "unsupported_operation" });
}

function page(db: ReturnType<typeof getDb>, sql: string, params: unknown[], limit: number, offset: number) { return { data: db.prepare(sql).all(...params), pagination: { limit, offset } }; }
function one(db: ReturnType<typeof getDb>, sql: string, params: unknown[], res: NextApiResponse) { const row = db.prepare(sql).get(...params); if (!row) { res.status(404); return { error: "not_found" }; } return row; }
function update(db: ReturnType<typeof getDb>, table: string, id: string, workspaceId: string, body: Record<string, unknown>, allowed: string[], res: NextApiResponse) {
  const fields = allowed.filter((key) => body[key] !== undefined); if (!fields.length) return res.status(400).json({ error: "no_editable_fields" });
  db.prepare(`UPDATE ${table} SET ${fields.map((key) => `${key} = ?`).join(", ")}${table === "opportunities" ? ", updated_at = datetime('now')" : ""} WHERE id = ? AND workspace_id = ?`).run(...fields.map((key) => body[key]), id, workspaceId);
  return res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ? AND workspace_id = ?`).get(id, workspaceId));
}
function belongs(db:ReturnType<typeof getDb>,table:"targets"|"companies"|"pipeline_stages",id:string,workspaceId:string){return !!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspace_id=?`).get(id,workspaceId);}
