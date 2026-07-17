import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    const company = db.prepare("SELECT * FROM companies WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId);
    if (!company) return res.status(404).json({ error: "not found" });
    const contacts = db
      .prepare("SELECT id, full_name, title, email, linkedin_url FROM targets WHERE company_id = ? AND workspace_id = ? ORDER BY full_name")
      .all(id, ctx.workspaceId);
    return res.json({ ...company as object, contacts });
  }

  if (req.method === "PUT") {
    const { name, domain, industry, location, linkedin_url, website, notes } = req.body;
    db.prepare(`
      UPDATE companies SET
        name = COALESCE(?, name),
        domain = ?,
        industry = ?,
        location = ?,
        linkedin_url = ?,
        website = ?,
        notes = ?
      WHERE id = ? AND workspace_id = ?
    `).run(
      name ?? null, domain ?? null, industry ?? null,
      location ?? null, linkedin_url ?? null, website ?? null, notes ?? null,
      id, ctx.workspaceId
    );
    recordAudit(ctx, "company.updated", "company", id);
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
