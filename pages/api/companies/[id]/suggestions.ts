import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ApolloError } from "@/lib/apollo";
import { apolloKey } from "@/lib/contacts/apollo-enrich";
import { CREDITS_PER_PERSON, MAX_SUGGESTIONS_ADDED, SUGGESTION_SEARCH_SIZE, addSuggestion, dismissSuggestions, findSuggestions, lookupDomain } from "@/lib/companies/enrich";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

// People Apollo says work at a company and who are not contacts yet.
//
//   POST { action: "find", dry_run: true }        what a search would do and cost
//   POST { action: "find" }                       ask Apollo and keep the people it names
//   POST { action: "add", ids, dry_run: true }    what adding these people would cost
//   POST { action: "add", ids }                   look each one up and make them a contact
//   POST { action: "dismiss", ids }               put suggestions aside; asks Apollo nothing
//
// A search returns names and titles and reveals no email address; by Apollo's
// documentation it spends no credits. Adding a person is a look-up, one credit each. A
// dry run never reaches Apollo. The suggestions themselves are read with the company
// (GET /api/companies/:id?view=detail).

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();
  const id = String(req.query.id);
  const company = db.prepare("SELECT id, domain, website FROM companies WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as { id: string; domain: string | null; website: string | null } | undefined;
  if (!company) return res.status(404).json({ error: "not found" });
  const body = (req.body ?? {}) as { action?: unknown; ids?: unknown; dry_run?: unknown };
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((value): value is string => typeof value === "string" && value !== ""))] : [];
  const apiKey = apolloKey(db, ctx.workspaceId);
  const domain = lookupDomain(company.domain) ?? lookupDomain(company.website);

  if (body.action === "dismiss") {
    if (ids.length === 0) return res.status(400).json({ error: "ids must be a non-empty array" });
    return res.json({ dismissed: dismissSuggestions(db, ctx.workspaceId, company.id, ids) });
  }

  if (body.action === "find") {
    if (body.dry_run === true) return res.json({ apollo_connected: apiKey !== null, domain, credits: 0, people: SUGGESTION_SEARCH_SIZE });
    if (!apiKey) return res.status(400).json({ error: "Apollo integration not configured" });
    if (!domain) return res.status(400).json({ error: "This company has no domain to search by. Add one first." });
    try {
      const result = await findSuggestions(db, ctx.workspaceId, company.id, apiKey);
      recordAudit(ctx, "company.suggestions_searched", "company", company.id, { found: result.found, added: result.added });
      return res.json({ found: result.found, added: result.added });
    } catch (cause) {
      if (cause instanceof ApolloError) return res.status(502).json({ error: cause.message });
      throw cause;
    }
  }

  if (body.action === "add") {
    if (ids.length === 0) return res.status(400).json({ error: "ids must be a non-empty array" });
    if (ids.length > MAX_SUGGESTIONS_ADDED) return res.status(400).json({ error: `At most ${MAX_SUGGESTIONS_ADDED} people are added in one request` });
    const known = (db.prepare(
      `SELECT id FROM company_suggestions WHERE workspace_id = ? AND company_id = ? AND status = 'suggested' AND id IN (${ids.map(() => "?").join(",")})`,
    ).all(ctx.workspaceId, company.id, ...ids) as { id: string }[]).map((row) => row.id);
    if (body.dry_run === true) return res.json({ apollo_connected: apiKey !== null, people: known.length, credits: known.length * CREDITS_PER_PERSON });
    if (!apiKey) return res.status(400).json({ error: "Apollo integration not configured" });

    const result = { added: 0, linked: 0, not_found: 0, failed: 0, target_ids: [] as string[] };
    let stopped: string | null = null;
    for (const suggestionId of known) {
      try {
        const { outcome, target_id } = await addSuggestion(db, ctx, suggestionId, apiKey);
        result[outcome] += 1;
        if (target_id) result.target_ids.push(target_id);
      } catch (cause) {
        if (cause instanceof ApolloError) { stopped = cause.message; break; }
        result.failed += 1;
      }
    }
    const looked = result.added + result.linked + result.not_found;
    if (looked > 0) recordAudit(ctx, "company.suggestions_added", "company", company.id, { added: result.added, linked: result.linked, not_found: result.not_found, credits: looked * CREDITS_PER_PERSON });
    if (stopped) return res.status(502).json({ error: stopped, ...result });
    return res.json(result);
  }

  return res.status(400).json({ error: "action must be find, add or dismiss" });
}
