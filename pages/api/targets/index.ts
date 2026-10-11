import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { contactsQuery } from "@/lib/contacts/filters";
import { contactNeighbours } from "@/lib/contacts/profile";
import { contactFacets, contactIds, contactsPage } from "@/lib/contacts/table";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  if (req.method === "POST") {
    const db = getDb();
    const { full_name, linkedin_url, title, company, location, email, phone, list_id, company_id } = req.body;
    // A contact needs a name and one way to reach them: a LinkedIn profile or an email address.
    if (!full_name) return res.status(400).json({ error: "full_name and linkedin_url are required" });
    if (!linkedin_url && !email) return res.status(400).json({ error: "A contact needs a LinkedIn URL or an email address" });
    // Added from a company's page: the contact is linked to it, and named after it unless a name was given.
    const employer = typeof company_id === "string" && company_id
      ? (db.prepare("SELECT id, name FROM companies WHERE id = ? AND workspace_id = ?").get(company_id, ctx.workspaceId) as { id: string; name: string } | undefined)
      : undefined;
    if (company_id && !employer) return res.status(400).json({ error: "Company not found" });
    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO targets (id, workspace_id, owner_id, full_name, linkedin_url, title, company, location, email, phone, company_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, ctx.workspaceId, ctx.userId, full_name, linkedin_url || null, title ?? null, company ?? employer?.name ?? null, location ?? null, email ?? null, phone ?? null, employer?.id ?? null);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE")) {
        return res.status(409).json({ error: "A contact with this LinkedIn URL already exists" });
      }
      throw e;
    }
    if (list_id) {
      try {
        const list = db.prepare("SELECT id FROM lists WHERE id = ? AND workspace_id = ?").get(list_id, ctx.workspaceId);
        if (list) db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)").run(list_id, id);
      } catch { /* ignore */ }
    }
    recordAudit(ctx, "contact.created", "contact", id);
    return res.status(201).json(db.prepare("SELECT * FROM targets WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    const db = getDb();
    const { target_ids } = req.body as { target_ids?: string[] };
    if (!Array.isArray(target_ids) || target_ids.length === 0) {
      return res.status(400).json({ error: "target_ids must be a non-empty array" });
    }
    const placeholders = target_ids.map(() => "?").join(",");
    // run_profiles/logs have no ON DELETE CASCADE — clear them first so the FK
    // constraint doesn't block the delete. run_profile_tracks cascade off run_profiles.
    const result = db.transaction(() => {
      db.prepare(`DELETE FROM run_profiles WHERE target_id IN (${placeholders})`).run(...target_ids);
      db.prepare(`DELETE FROM logs WHERE target_id IN (${placeholders})`).run(...target_ids);
      return db.prepare(`DELETE FROM targets WHERE id IN (${placeholders}) AND workspace_id = ?`).run(...target_ids, ctx.workspaceId);
    })();
    recordAudit(ctx, "contact.bulk_deleted", "contact", undefined, { target_ids, deleted: result.changes });
    return res.json({ deleted: result.changes });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET", "POST", "DELETE"]);
    return res.status(405).end();
  }

  const db = getDb();
  // What the contacts screen reads. Without `view` the answer is the shape the API and the
  // MCP tool have always been given (pages from 0, `{ contacts, total }`).
  if (req.query.view === "table") return res.json(contactsPage(db, ctx.workspaceId, req.query));
  if (req.query.view === "ids") return res.json(contactIds(db, ctx.workspaceId, req.query));
  if (req.query.view === "facets") return res.json(contactFacets(db, ctx.workspaceId));
  // Where one contact sits in a request, for the profile's previous and next. `id` names the contact.
  if (req.query.view === "neighbours") return res.json({ neighbours: contactNeighbours(db, ctx.workspaceId, String(req.query.id ?? ""), req.query) });

  const { page = "0", limit = "50" } = req.query;
  const offset = Number(page) * Number(limit);
  const { from, where, params } = contactsQuery(req.query, ctx.workspaceId);

  const rows = db.prepare(
    `SELECT t.id, t.linkedin_url, t.full_name, t.title, t.company, t.location,
            t.email, t.email_status, t.degree,
            t.connection_requested_at, t.connected_at, t.message_sent_at, t.last_replied_at,
            t.apollo_enriched_at, t.seniority, t.created_at
     ${from} ${where}
     ORDER BY t.full_name ASC
     LIMIT ? OFFSET ?`
  ).all(...params, Number(limit), offset);
  const total = (db.prepare(`SELECT COUNT(*) as c ${from} ${where}`).get(...params) as { c: number }).c;

  return res.json({ contacts: rows, total });
}
