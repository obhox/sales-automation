// Looking one contact up on Apollo and writing back what it knows. Used by a list's
// enrichment and by enriching a selection on the contacts screen. Each look-up spends
// one Apollo credit, so callers decide who is worth one before calling.
import type DatabaseType from "better-sqlite3";
import { randomUUID } from "crypto";
import { matchPerson } from "@/lib/apollo";
import { decryptSecret } from "@/lib/crypto";

type DB = DatabaseType.Database;

export interface EnrichableTarget {
  id: string;
  linkedin_url: string | null;
  sales_nav_url: string | null;
}

export type EnrichOutcome = "enriched" | "not_found" | "skipped";

/** The workspace's Apollo key, or null when Apollo is not connected. */
export function apolloKey(db: DB, workspaceId: string): string | null {
  const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'apollo' AND workspace_id = ?").get(workspaceId) as { api_key: string | null } | undefined;
  return integration?.api_key ? decryptSecret(integration.api_key) : null;
}

/** The profile address Apollo is asked about: a real /in/ address when there is one, else the Sales Navigator one. */
export function apolloLookupUrl(target: EnrichableTarget): string | null {
  return target.linkedin_url && !target.linkedin_url.includes("/sales/lead/") ? target.linkedin_url : target.sales_nav_url;
}

/**
 * Look one contact up and store the result: the email and its status, seniority, location,
 * career history, and the company (found by domain in this workspace, or created).
 * Nothing already on the contact is overwritten except the Apollo fields themselves.
 */
export async function enrichTargetFromApollo(db: DB, workspaceId: string, target: EnrichableTarget, apiKey: string): Promise<EnrichOutcome> {
  const urlToUse = apolloLookupUrl(target);
  if (!urlToUse) return "skipped";

  try {
    const result = await matchPerson(urlToUse, apiKey);

    if (!result) {
      // Mark as attempted so we don't retry endlessly
      db.prepare("UPDATE targets SET apollo_enriched_at = datetime('now') WHERE id = ?").run(target.id);
      return "not_found";
    }

    // Company association via domain
    let companyId: string | null = null;
    if (result.organization?.domain) {
      const domain = result.organization.domain.replace(/^www\./, "").toLowerCase();
      const existing = db.prepare("SELECT id FROM companies WHERE domain = ? AND workspace_id = ?").get(domain, workspaceId) as { id: string } | undefined;
      const org = result.organization;
      if (existing) {
        companyId = existing.id;
        // Update company with richer data if we have it
        db.prepare(`
          UPDATE companies SET
            industry = COALESCE(industry, ?),
            location = COALESCE(location, ?),
            linkedin_url = COALESCE(linkedin_url, ?),
            website = COALESCE(website, ?),
            founded_year = COALESCE(founded_year, ?),
            logo_url = COALESCE(logo_url, ?),
            phone = COALESCE(phone, ?),
            annual_revenue = COALESCE(annual_revenue, ?),
            technology_names = COALESCE(technology_names, ?),
            keywords = COALESCE(keywords, ?),
            city = COALESCE(city, ?),
            country = COALESCE(country, ?),
            description = COALESCE(description, ?),
            employee_count = COALESCE(employee_count, ?)
          WHERE id = ?
        `).run(
          org.industry ?? null,
          org.location ?? null,
          org.linkedin_url ?? null,
          org.website_url ?? null,
          org.founded_year ?? null,
          org.logo_url ?? null,
          org.phone ?? null,
          org.annual_revenue_printed ?? null,
          org.technology_names ? JSON.stringify(org.technology_names) : null,
          org.keywords ? JSON.stringify(org.keywords) : null,
          org.city ?? null,
          org.country ?? null,
          org.short_description ?? null,
          org.estimated_num_employees ?? null,
          existing.id,
        );
      } else {
        companyId = randomUUID();
        db.prepare(`
          INSERT INTO companies (id, workspace_id, name, domain, industry, location, linkedin_url, website, founded_year, logo_url, phone, annual_revenue, technology_names, keywords, city, country, description, employee_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          companyId,
          workspaceId,
          org.name ?? "",
          domain,
          org.industry ?? null,
          org.location ?? null,
          org.linkedin_url ?? null,
          org.website_url ?? null,
          org.founded_year ?? null,
          org.logo_url ?? null,
          org.phone ?? null,
          org.annual_revenue_printed ?? null,
          org.technology_names ? JSON.stringify(org.technology_names) : null,
          org.keywords ? JSON.stringify(org.keywords) : null,
          org.city ?? null,
          org.country ?? null,
          org.short_description ?? null,
          org.estimated_num_employees ?? null,
        );
      }
    }

    // What the company carries came from Apollo. A look-up of the company itself is what
    // refreshes it, so a date already there is kept.
    if (companyId) db.prepare("UPDATE companies SET enrichment_source = COALESCE(enrichment_source, 'apollo'), enriched_at = COALESCE(enriched_at, datetime('now')) WHERE id = ?").run(companyId);

    // Apollo returns a real /in/ URL — always write it, even if target already has a Sales Nav URL
    const apolloLinkedinUrl = result.linkedin_url?.includes("/in/") ? result.linkedin_url : null;

    db.prepare(`
      UPDATE targets SET
        apollo_id = ?,
        seniority = ?,
        apollo_functions = ?,
        apollo_departments = ?,
        email = COALESCE(email, ?),
        email_status = COALESCE(email_status, ?),
        email_domain_catchall = ?,
        city = COALESCE(city, ?),
        country = COALESCE(country, ?),
        time_zone = COALESCE(time_zone, ?),
        headline = COALESCE(headline, ?),
        positions_json = COALESCE(positions_json, ?),
        company_id = COALESCE(company_id, ?),
        linkedin_url = COALESCE(?, linkedin_url),
        company_size = COALESCE(company_size, ?),
        apollo_enriched_at = datetime('now')
      WHERE id = ?
    `).run(
      result.apollo_id,
      result.seniority ?? null,
      result.functions ? JSON.stringify(result.functions) : null,
      result.departments ? JSON.stringify(result.departments) : null,
      result.email ?? null,
      result.email_status ?? null,
      result.email_domain_catchall ? 1 : 0,
      result.city ?? null,
      result.country ?? null,
      result.time_zone ?? null,
      result.headline ?? null,
      result.positions_json ?? null,
      companyId,
      apolloLinkedinUrl,
      result.organization?.estimated_num_employees ?? null,
      target.id,
    );

    return "enriched";
  } catch {
    return "skipped";
  }
}
