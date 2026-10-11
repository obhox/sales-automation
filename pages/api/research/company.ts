// Fill companies in from their own websites.
//
//   POST { dry_run: true, company_ids }   what reading these would cost
//   POST { company_ids }                  read at most COMPANY_RESEARCH_BATCH of them
//
// Only empty fields are filled, so this never argues with Apollo or with something a
// member typed. A dry run reaches no provider and spends nothing.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ResearchRefused, researchConnected, researchKey } from "@/lib/research/providers";
import {
  COMPANY_RESEARCH_BATCH, MAX_COMPANY_RESEARCH,
  companyCandidates, companyResearchCost, researchCompany, type CompanyResearchOutcome,
} from "@/lib/research/company";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export { COMPANY_RESEARCH_BATCH };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();

  const asked = Array.isArray(req.body?.company_ids) ? [...new Set(req.body.company_ids.filter((id: unknown) => typeof id === "string"))] as string[] : null;
  if (!asked || asked.length === 0) return res.status(400).json({ error: "company_ids must be a non-empty array" });
  if (asked.length > MAX_COMPANY_RESEARCH) return res.status(400).json({ error: `Read at most ${MAX_COMPANY_RESEARCH} companies at a time` });

  const candidates = companyCandidates(db, ctx.workspaceId, asked);

  if (req.body?.dry_run === true) {
    return res.json({
      ...companyResearchCost(db, ctx.workspaceId, candidates, asked.length),
      firecrawl_connected: researchConnected(db, ctx.workspaceId).firecrawl,
    });
  }

  if (asked.length > COMPANY_RESEARCH_BATCH) return res.status(400).json({ error: `Send at most ${COMPANY_RESEARCH_BATCH} companies in one request` });

  const apiKey = researchKey(db, ctx.workspaceId, "firecrawl");
  if (!apiKey) return res.status(400).json({ error: "Connect Firecrawl under Integrations to read company websites." });

  const result: Record<CompanyResearchOutcome, number> = { enriched: 0, nothing_new: 0, no_website: 0, unreadable: 0 };
  let stopped: string | null = null;
  for (const candidate of candidates) {
    try {
      result[await researchCompany(db, ctx.workspaceId, candidate, apiKey)] += 1;
    } catch (error) {
      if (error instanceof ResearchRefused) { stopped = error.message; break; }
      result.unreadable += 1;
    }
  }

  const read = result.enriched + result.nothing_new;
  if (read > 0) recordAudit(ctx, "companies.website_enriched", "company", asked.length === 1 ? asked[0] : undefined, { ...result, credits: read * 5 });
  if (stopped) return res.status(502).json({ error: stopped, ...result });
  return res.json(result);
}
