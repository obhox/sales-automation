import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { companiesPage, companiesSummary } from "@/lib/companies/overview";
import { lookupDomain } from "@/lib/companies/enrich";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  // The Companies screen reads `view=table` (a page of the list with each company's intent
  // and contact count; `q`, `filter`, `sort=key:direction`, `page`, `limit`) and
  // `view=summary` (the figures across every company). Without `view` the route answers as
  // it always has.
  if (req.method === "GET" && req.query.view === "table") return res.json(companiesPage(db, ctx.workspaceId, req.query));
  if (req.method === "GET" && req.query.view === "summary") return res.json(companiesSummary(db, ctx.workspaceId));

  if (req.method === "GET") {
    // Paging + light default fields — the full enrichment blobs (description, keywords,
    // technology_names, etc.) are heavy; only return them when full=1 is requested.
    const full = req.query.full === "1" || req.query.full === "true";
    const search = (req.query.search as string | undefined)?.trim();
    // Page by default (trimmed fields). full=1 with no explicit limit returns the whole set
    // (the companies UI relies on this for its own client-side search/filter).
    const explicitPaging = req.query.limit !== undefined || req.query.page !== undefined;
    const hasPaging = explicitPaging || !full;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = (Number(req.query.page) || 0) * limit;

    const where = search ? "WHERE c.workspace_id = ? AND c.name LIKE ?" : "WHERE c.workspace_id = ?";
    const whereArgs: unknown[] = search ? [ctx.workspaceId, `%${search}%`] : [ctx.workspaceId];

    const select = full
      ? "c.*"
      : "c.id, c.name, c.domain, c.industry, c.location, c.website, c.employee_count, c.created_at";

    const total = (db.prepare(`SELECT COUNT(*) as c FROM companies c ${where}`).get(...whereArgs) as { c: number }).c;

    const pageClause = hasPaging ? " LIMIT ? OFFSET ?" : "";
    const pageArgs = hasPaging ? [limit, offset] : [];

    const companies = db.prepare(`
      SELECT ${select}, COUNT(t.id) as contact_count
      FROM companies c
      LEFT JOIN targets t ON t.company_id = c.id
      ${where}
      GROUP BY c.id
      ORDER BY c.name COLLATE NOCASE${pageClause}
    `).all(...whereArgs, ...pageArgs);

    return res.json({ companies, total });
  }

  if (req.method === "POST") {
    const { name, domain, industry, location, linkedin_url, website, notes, is_target } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    // A domain is kept the way a look-up and a bounce match it: bare and lower case. One company per domain.
    const bare = typeof domain === "string" && domain.trim() ? lookupDomain(domain) ?? domain.trim().toLowerCase() : null;
    if (bare && db.prepare("SELECT 1 FROM companies WHERE workspace_id = ? AND lower(domain) = ?").get(ctx.workspaceId, bare)) {
      return res.status(409).json({ error: `A company with the domain ${bare} already exists` });
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO companies (id, workspace_id, name, domain, industry, location, linkedin_url, website, notes, is_target)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ctx.workspaceId, name, bare, industry ?? null, location ?? null, linkedin_url ?? null, website ?? null, notes ?? null, is_target === true ? 1 : 0);
    recordAudit(ctx, "company.created", "company", id);
    return res.status(201).json(db.prepare("SELECT * FROM companies WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}
