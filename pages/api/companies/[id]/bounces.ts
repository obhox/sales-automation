import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { clearBounceFlag, reverifyCompany } from "@/lib/companies/enrich";
import { bounceFigures, companyBounces } from "@/lib/companies/overview";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

// What is behind a company's bounce flag, and the two things a member can do about it.
//
//   GET                           the bounces from this company's addresses, newest first, and the figures
//   POST { action: "reverify" }   queue the company's addresses for a check (not the ones that bounced)
//   POST { action: "clear" }      clear the flag, so email to the company is no longer skipped
//
// The flag is set by the mailbox reader when an address at the company hard-bounces, and
// while it is set the runner skips every email step for the company's contacts.

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();
  const company = db.prepare("SELECT id, domain, email_domain_invalid, bounce_cleared_at FROM companies WHERE id = ? AND workspace_id = ?").get(String(req.query.id), ctx.workspaceId) as
    { id: string; domain: string | null; email_domain_invalid: number | null; bounce_cleared_at: string | null } | undefined;
  if (!company) return res.status(404).json({ error: "not found" });

  if (req.method === "GET") {
    return res.json({
      flagged: company.email_domain_invalid === 1, cleared_at: company.bounce_cleared_at,
      figures: bounceFigures(db, ctx.workspaceId, company), bounces: companyBounces(db, ctx.workspaceId, company),
    });
  }

  const action = (req.body ?? {}).action;
  if (action === "reverify") {
    const result = reverifyCompany(db, ctx.workspaceId, company.id);
    recordAudit(ctx, "company.emails_queued_for_verification", "company", company.id, result);
    return res.json(result);
  }
  if (action === "clear") {
    const result = clearBounceFlag(db, ctx, company.id);
    if (result.cleared) recordAudit(ctx, "company.bounce_flag_cleared", "company", company.id, { restored: result.restored });
    return res.json(result);
  }
  return res.status(400).json({ error: "action must be reverify or clear" });
}
