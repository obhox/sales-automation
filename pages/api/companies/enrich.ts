import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ApolloError } from "@/lib/apollo";
import { apolloKey } from "@/lib/contacts/apollo-enrich";
import { COMPANY_ENRICH_BATCH, CREDITS_PER_COMPANY, MAX_COMPANY_ENRICH, enrichCompanyFromApollo, lookupDomain } from "@/lib/companies/enrich";
import { companyIds } from "@/lib/companies/overview";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

// Look companies up on Apollo: one company, a chosen few, or every company the list shows.
//
//   POST { dry_run: true, ids }               what looking these up would cost
//   POST { dry_run: true, q?, filter? }       the same for every company the list shows
//   POST { ids }                              look up at most COMPANY_ENRICH_BATCH of them
//
// Each look-up spends one Apollo credit, and only a company with a domain can be looked
// up. The screen asks for the cost first, shows it, and sends the ids a batch at a time
// once someone has agreed to it. A dry run never reaches Apollo.

const text = (value: unknown) => (typeof value === "string" ? value : "");

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();
  const body = (req.body ?? {}) as { ids?: unknown; dry_run?: unknown; q?: unknown; filter?: unknown };
  const asked = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id): id is string => typeof id === "string" && id !== ""))] : null;
  if (asked && asked.length > MAX_COMPANY_ENRICH) return res.status(400).json({ error: `At most ${MAX_COMPANY_ENRICH} companies can be looked up at once` });
  const apiKey = apolloKey(db, ctx.workspaceId);

  if (body.dry_run === true) {
    const scope = asked ? { ids: asked.join(",") } : { q: text(body.q), filter: text(body.filter) };
    if (asked && asked.length === 0) return res.status(400).json({ error: "ids must not be empty" });
    const everyone = companyIds(db, ctx.workspaceId, scope, MAX_COMPANY_ENRICH);
    const rows = everyone.ids.length === 0 ? [] : db.prepare(
      `SELECT id, domain, website, enriched_at FROM companies WHERE workspace_id = ? AND id IN (${everyone.ids.map(() => "?").join(",")})`,
    ).all(ctx.workspaceId, ...everyone.ids) as { id: string; domain: string | null; website: string | null; enriched_at: string | null }[];
    const eligible = rows.filter((row) => lookupDomain(row.domain) ?? lookupDomain(row.website));
    return res.json({
      apollo_connected: apiKey !== null,
      selected: everyone.total,
      eligible: eligible.length,
      eligible_ids: eligible.map((row) => row.id),
      no_domain: rows.length - eligible.length,
      // Looked up before: asking again spends another credit each and brings back what has changed since.
      enriched_before: eligible.filter((row) => row.enriched_at !== null).length,
      capped: everyone.total > everyone.ids.length,
      credits: eligible.length * CREDITS_PER_COMPANY,
      batch: COMPANY_ENRICH_BATCH,
    });
  }

  if (!asked || asked.length === 0) return res.status(400).json({ error: "ids must be a non-empty array" });
  if (asked.length > COMPANY_ENRICH_BATCH) return res.status(400).json({ error: `At most ${COMPANY_ENRICH_BATCH} companies are looked up in one request` });
  if (!apiKey) return res.status(400).json({ error: "Apollo integration not configured" });

  const result = { enriched: 0, not_found: 0, no_domain: 0, failed: 0 };
  let stopped: string | null = null;
  for (const id of asked) {
    try {
      const outcome = await enrichCompanyFromApollo(db, ctx.workspaceId, id, apiKey);
      result[outcome] += 1;
    } catch (cause) {
      // Apollo refused (bad key, no credits, too many requests): asking about the rest would fail the same way.
      if (cause instanceof ApolloError) { stopped = cause.message; break; }
      result.failed += 1;
    }
  }
  const done = result.enriched + result.not_found;
  if (done > 0) recordAudit(ctx, "companies.enriched", "company", asked.length === 1 ? asked[0] : undefined, { ...result, credits: done * CREDITS_PER_COMPANY });
  if (stopped) return res.status(502).json({ error: stopped, ...result });
  return res.json(result);
}
