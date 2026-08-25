import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID, createHash } from "crypto";
import { verifyApiKey } from "@/lib/api-keys";
import { getDb } from "@/lib/db";
import { ingestSignal } from "@/lib/platform/signals";
import { emitDomainEvent } from "@/lib/platform/events";
import { apiContactCreateSchema, apiSignalCreateSchema, firstIssue } from "@/lib/validation";
import { verifyAndSuppressTargets } from "@/lib/email/verify";
import { isAddressSuppressed } from "@/lib/platform/suppression";
import { sendEmailDurably } from "@/lib/email/infrastructure";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("X-API-Version", "2026-07-17");
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const auth = raw ? verifyApiKey(raw) : null;
  if (!auth) return res.status(401).json({ error: "invalid_api_key" });
  const parts = Array.isArray(req.query.path) ? req.query.path : [String(req.query.path ?? "")];
  const [resource, id, action] = parts;
  const db = getDb(), ws = auth.workspaceId;
  const readScope = resource === "contacts" ? "contacts:read"
    : resource === "events" ? "events:read"
    : resource === "signals" ? "events:read"
    : resource === "signal_rules" ? "events:read"
    : resource === "suppressions" ? "contacts:read"
    : resource === "opportunities" ? "crm:read"
    : resource === "pipeline_stages" ? "crm:read"
    : "campaigns:read";
  // Sending is a distinct, more dangerous capability than editing a CRM field, so it is
  // gated on its own `email:send` scope instead of `contacts:write` — a key scoped only to
  // CRM edits must not be able to send mail just because the route happens to live under
  // `/contacts`.
  const writeScope = resource === "contacts" && action === "send" ? "email:send"
    : resource === "contacts" ? "contacts:write" : resource === "signals" ? "signals:write" : resource === "events" ? "events:write" : resource === "opportunities" ? "crm:write" : "campaigns:write";
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
    // Explicit column list — email_accounts also holds smtp_host/username/password, which must never leave this endpoint.
    if (resource === "email_accounts") return res.json(page(db, "SELECT id, from_email, from_name, provider, is_verified, created_at FROM email_accounts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    // Read-only rule config, so a caller can show *why* a signal will (or won't) trigger a workflow before ingesting one.
    if (resource === "signal_rules") return res.json(id ? one(db, "SELECT * FROM signal_rules WHERE id = ? AND workspace_id = ?", [id, ws], res) : page(db, "SELECT * FROM signal_rules WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    if (resource === "pipeline_stages") return res.json(id ? one(db, "SELECT * FROM pipeline_stages WHERE id = ? AND workspace_id = ?", [id, ws], res) : page(db, "SELECT * FROM pipeline_stages WHERE workspace_id = ? ORDER BY position ASC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    // Do-not-contact list. A caller pushing signals or creating contacts should check this before acting on anyone.
    if (resource === "suppressions") return res.json(id ? one(db, "SELECT * FROM suppressions WHERE id = ? AND workspace_id = ?", [id, ws], res) : page(db, "SELECT * FROM suppressions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    if (resource === "sent_messages") return res.json(id ? one(db, "SELECT * FROM sent_messages WHERE id = ? AND workspace_id = ?", [id, ws], res) : page(db, "SELECT * FROM sent_messages WHERE workspace_id = ? ORDER BY accepted_at DESC LIMIT ? OFFSET ?", [ws, limit, offset], limit, offset));
    // Which targets are enrolled in a run. Neither table has its own workspace_id, so ownership is
    // checked through the parent run instead. Filtered by ?run_id=, not by path id.
    if (resource === "run_profiles") {
      const runId = String(req.query.run_id ?? "");
      if (!runId) return res.status(400).json({ error: "run_id_required" });
      if (!belongs(db, "runs", runId, ws)) return res.status(400).json({ error: "run_not_found" });
      return res.json(page(db, "SELECT * FROM run_profiles WHERE run_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [runId, limit, offset], limit, offset));
    }
    // Per-target, per-channel (linkedin/email) progress within a run — the actual send/reply
    // state a caller needs (state is no longer on run_profiles itself; see dropDeprecatedRunProfileColumns).
    if (resource === "run_profile_tracks") {
      const runId = String(req.query.run_id ?? "");
      if (!runId) return res.status(400).json({ error: "run_id_required" });
      if (!belongs(db, "runs", runId, ws)) return res.status(400).json({ error: "run_not_found" });
      return res.json(page(db,
        `SELECT rpt.*, rp.target_id, rp.run_id FROM run_profile_tracks rpt
         JOIN run_profiles rp ON rp.id = rpt.run_profile_id
         WHERE rp.run_id = ? ORDER BY rpt.created_at DESC LIMIT ? OFFSET ?`,
        [runId, limit, offset], limit, offset));
    }
    // List membership pairs (list_id, target_id) — full contact rows are already available via /contacts, so this stays lightweight. Filtered by ?list_id=, not by path id.
    if (resource === "list_members") {
      const listId = String(req.query.list_id ?? "");
      if (!listId) return res.status(400).json({ error: "list_id_required" });
      if (!belongs(db, "lists", listId, ws)) return res.status(400).json({ error: "list_not_found" });
      return res.json(page(db, "SELECT list_id, target_id FROM list_targets WHERE list_id = ? LIMIT ? OFFSET ?", [listId, limit, offset], limit, offset));
    }
    return res.status(404).json({ error: "unknown_resource" });
  }

  // Placed before the plain "POST contacts" create branch below, which matches on
  // resource === "contacts" alone (no id guard) and would otherwise swallow these first.
  if (req.method === "POST" && resource === "contacts" && id === "verify") {
    const contact_ids = req.body?.contact_ids;
    if (!Array.isArray(contact_ids) || contact_ids.length === 0) return res.status(400).json({ error: "contact_ids_required" });
    const result = await verifyAndSuppressTargets(db, ws, contact_ids);
    return res.status(200).json(result);
  }
  if (req.method === "POST" && resource === "contacts" && id && action === "send") {
    if (!belongs(db, "targets", id, ws)) return res.status(404).json({ error: "contact_not_found" });
    const contact = db.prepare("SELECT email FROM targets WHERE id = ?").get(id) as { email: string | null } | undefined;
    if (!contact?.email) return res.status(400).json({ error: "contact_has_no_email" });
    const { subject, body, email_account_id } = req.body as { subject?: string; body?: string; email_account_id?: string };
    if (!subject || !body) return res.status(400).json({ error: "subject_and_body_required" });
    let emailAccountId = email_account_id;
    if (!emailAccountId) {
      const sender = db.prepare("SELECT id FROM email_accounts WHERE workspace_id = ? AND is_verified = 1 ORDER BY created_at LIMIT 1").get(ws) as { id: string } | undefined;
      if (!sender) return res.status(400).json({ error: "no_verified_sender" });
      emailAccountId = sender.id;
    }
    const suppression = isAddressSuppressed(ws, contact.email);
    if (suppression) return res.status(409).json({ error: "recipient_suppressed", suppression });
    try {
      const digest = createHash("sha256").update(`${contact.email}\n${subject}\n${body}`).digest("hex").slice(0, 16);
      // targetId is not decoration. It is what files the send on the contact's thread, and
      // what lets a later bounce mark THIS CONTACT's email invalid rather than only
      // suppressing the address — recordProviderEvent updates targets only when the
      // sent_message carries a target. Without it a public-API send is a message to an
      // address the CRM cannot see.
      const receipt = await sendEmailDurably({ workspaceId: ws, emailAccountId, idempotencyKey: `public-api:${id}:${digest}`, source: "public_api", targetId: id, to: contact.email, subject, body });
      return res.status(200).json({ ok: true, job_id: receipt.jobId, message_id: receipt.messageId });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Send failed" });
    }
  }
  if (req.method === "POST" && resource === "contacts" && !id) {
    const parsed = apiContactCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "invalid_request", detail: firstIssue(parsed.error) });
    const { full_name, linkedin_url, email, title, company, location } = parsed.data;
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
    const signalParsed = apiSignalCreateSchema.safeParse(req.body ?? {});
    if (!signalParsed.success) return res.status(400).json({ error: "invalid_request", detail: firstIssue(signalParsed.error) });
    const body = signalParsed.data;
    if (!body.type || !body.title) return res.status(400).json({ error: "type_and_title_required" });
    if(body.target_id&&!belongs(db,"targets",body.target_id,ws))return res.status(400).json({error:"target_not_found"});
    if(body.company_id&&!belongs(db,"companies",body.company_id,ws))return res.status(400).json({error:"company_not_found"});
    return res.status(201).json(ingestSignal({ workspaceId: ws, targetId: body.target_id ?? undefined, companyId: body.company_id ?? undefined, type: body.type, title: body.title, description: body.description ?? undefined, score: body.score, source: body.source ?? "public_api", occurredAt: body.occurred_at ?? undefined, metadata: body.metadata }));
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
function belongs(db:ReturnType<typeof getDb>,table:"targets"|"companies"|"pipeline_stages"|"runs"|"lists",id:string,workspaceId:string){return !!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspace_id=?`).get(id,workspaceId);}
