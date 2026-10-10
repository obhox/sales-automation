import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { apolloKey, apolloLookupUrl, enrichTargetFromApollo, type EnrichableTarget } from "@/lib/contacts/apollo-enrich";
import { MAX_SELECTION } from "@/lib/contacts/filters";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

// Enrich a hand-picked set of contacts from Apollo, whatever lists they are in.
//
//   POST { target_ids, dry_run: true }   what it would cost: nothing is looked up or spent
//   POST { target_ids }                  look up at most ENRICH_BATCH of them and say what came back
//
// Each look-up spends one Apollo credit, so only contacts that could gain from one are
// looked up: no email yet, and a LinkedIn or Sales Navigator address to ask about. The
// screen asks for the cost first, shows it, and then sends the ids a batch at a time.

/** Look-ups in one request. The request holds open while Apollo answers each in turn. */
export const ENRICH_BATCH = 25;

interface Candidate extends EnrichableTarget {
  email: string | null;
  apollo_enriched_at: string | null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const db = getDb();
  const body = (req.body ?? {}) as { target_ids?: unknown; dry_run?: unknown };
  const ids = Array.isArray(body.target_ids) ? [...new Set(body.target_ids.filter((id): id is string => typeof id === "string" && id !== ""))] : [];
  if (ids.length === 0) return res.status(400).json({ error: "target_ids must be a non-empty array" });
  if (ids.length > MAX_SELECTION) return res.status(400).json({ error: `At most ${MAX_SELECTION} contacts can be checked at once` });

  const selected = db.prepare(
    `SELECT id, email, linkedin_url, sales_nav_url, apollo_enriched_at FROM targets WHERE workspace_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
  ).all(ctx.workspaceId, ...ids) as Candidate[];
  const hasEmail = selected.filter((contact) => Boolean(contact.email));
  const noAddress = selected.filter((contact) => !contact.email && !apolloLookupUrl(contact));
  const eligible = selected.filter((contact) => !contact.email && apolloLookupUrl(contact));
  const apiKey = apolloKey(db, ctx.workspaceId);

  if (body.dry_run === true) {
    return res.json({
      apollo_connected: apiKey !== null,
      selected: selected.length,
      eligible: eligible.length,
      eligible_ids: eligible.map((contact) => contact.id),
      // Looked up before without an email coming back; asking again spends another credit each.
      tried_before: eligible.filter((contact) => contact.apollo_enriched_at !== null).length,
      have_email: hasEmail.length,
      no_profile_address: noAddress.length,
      credits: eligible.length,
      batch: ENRICH_BATCH,
    });
  }

  if (!apiKey) return res.status(400).json({ error: "Apollo integration not configured" });
  if (ids.length > ENRICH_BATCH) return res.status(400).json({ error: `Send at most ${ENRICH_BATCH} contacts in one request` });

  let enriched = 0;
  let notFound = 0;
  let skipped = 0;
  let emailsFound = 0;
  for (const contact of eligible) {
    const outcome = await enrichTargetFromApollo(db, ctx.workspaceId, contact, apiKey);
    if (outcome === "enriched") {
      enriched++;
      if ((db.prepare("SELECT email FROM targets WHERE id = ?").get(contact.id) as { email: string | null } | undefined)?.email) emailsFound++;
    } else if (outcome === "not_found") notFound++;
    else skipped++;
  }
  recordAudit(ctx, "contact.bulk_enriched", "contact", undefined, { looked_up: eligible.length, enriched, not_found: notFound });
  return res.json({ enriched, notFound, skipped, emails_found: emailsFound, looked_up: eligible.length, total: selected.length });
}
