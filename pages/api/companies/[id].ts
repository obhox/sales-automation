import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { companyDetail } from "@/lib/companies/overview";
import { lookupDomain } from "@/lib/companies/enrich";

/** The fields a member may type on a company. */
const EDITABLE = ["name", "domain", "industry", "location", "linkedin_url", "website", "notes"] as const;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  // The company's page: its fields ready to show, its contacts, the campaigns they are in,
  // suggested people, signals and what is behind a bounce flag. Without `view` the route
  // answers as it always has.
  if (req.method === "GET" && req.query.view === "detail") {
    const detail = companyDetail(db, ctx.workspaceId, id);
    return detail ? res.json(detail) : res.status(404).json({ error: "not found" });
  }

  if (req.method === "GET") {
    const company = db.prepare("SELECT * FROM companies WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId);
    if (!company) return res.status(404).json({ error: "not found" });
    const contacts = db
      .prepare("SELECT id, full_name, title, email, linkedin_url FROM targets WHERE company_id = ? AND workspace_id = ? ORDER BY full_name")
      .all(id, ctx.workspaceId);
    return res.json({ ...company as object, contacts });
  }

  if (req.method === "PUT") {
    // Only what is sent changes. A field sent as null or "" is emptied; a field left out is
    // left alone. (This route used to blank every field that was not sent.)
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!db.prepare("SELECT 1 FROM companies WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId)) return res.status(404).json({ error: "not found" });
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const field of EDITABLE) {
      if (!(field in body)) continue;
      const raw = body[field];
      if (raw !== null && typeof raw !== "string") return res.status(400).json({ error: `${field} must be text` });
      let value = typeof raw === "string" && raw.trim() ? raw.trim() : null;
      if (field === "name" && !value) return res.status(400).json({ error: "A company needs a name" });
      if (field === "domain" && value) {
        value = lookupDomain(value) ?? value.toLowerCase();
        if (db.prepare("SELECT 1 FROM companies WHERE workspace_id = ? AND lower(domain) = ? AND id != ?").get(ctx.workspaceId, value, id)) {
          return res.status(409).json({ error: `Another company already has the domain ${value}` });
        }
      }
      sets.push(`${field} = ?`);
      values.push(value);
    }
    if ("is_target" in body) {
      if (typeof body.is_target !== "boolean") return res.status(400).json({ error: "is_target must be true or false" });
      sets.push("is_target = ?");
      values.push(body.is_target ? 1 : 0);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`).run(...values, id, ctx.workspaceId);
      recordAudit(ctx, "company.updated", "company", id);
    }
    return res.json(db.prepare("SELECT * FROM companies WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    // Unlink contacts first, then delete company
    db.prepare("UPDATE targets SET company_id = NULL WHERE company_id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    db.prepare("DELETE FROM companies WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    recordAudit(ctx, "company.deleted", "company", id);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
