// What changes a company from outside: an Apollo look-up of the company, Apollo's list of
// the people who work there, and turning one of those people into a contact. Every function
// that calls Apollo is named for it, and the routes above show what a call costs first.
import type DatabaseType from "better-sqlite3";
import { randomUUID } from "crypto";
import { enrichOrganization, matchPersonById, searchPeopleAtDomain, type ApolloMatchResult, type ApolloOrganization } from "@/lib/apollo";

type DB = DatabaseType.Database;

/** One Apollo credit for each company looked up, and for each person looked up. */
export const CREDITS_PER_COMPANY = 1;
export const CREDITS_PER_PERSON = 1;
/** Companies looked up in one request. The page asks again for the next batch. */
export const COMPANY_ENRICH_BATCH = 10;
/** The most companies one "Re-enrich all" takes on. */
export const MAX_COMPANY_ENRICH = 2000;
/** People asked for in one search, and added in one request. */
export const SUGGESTION_SEARCH_SIZE = 10;
export const MAX_SUGGESTIONS_ADDED = 10;

/** "www.Example.com/" → "example.com". Null when there is nothing a look-up could use. */
export function lookupDomain(value: string | null | undefined): string | null {
  const domain = (value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

export type CompanyEnrichOutcome = "enriched" | "not_found" | "no_domain";

/**
 * Write what Apollo knows about a company onto its row. A look-up is the newest word on
 * what Apollo fills (size, funding, technologies), so those are replaced when Apollo has a
 * value; the fields a member may have typed (name, industry, location, website, LinkedIn
 * address) are only filled when empty. Nothing is ever blanked.
 */
export function applyOrganization(db: DB, companyId: string, org: ApolloOrganization): void {
  db.prepare(
    `UPDATE companies SET
       industry = COALESCE(NULLIF(industry, ''), @industry),
       location = COALESCE(NULLIF(location, ''), @location),
       linkedin_url = COALESCE(NULLIF(linkedin_url, ''), @linkedin_url),
       website = COALESCE(NULLIF(website, ''), @website),
       city = COALESCE(NULLIF(city, ''), @city),
       country = COALESCE(NULLIF(country, ''), @country),
       logo_url = COALESCE(@logo_url, logo_url),
       phone = COALESCE(NULLIF(phone, ''), @phone),
       description = COALESCE(@description, description),
       founded_year = COALESCE(@founded_year, founded_year),
       annual_revenue = COALESCE(@annual_revenue, annual_revenue),
       employee_count = COALESCE(@employee_count, employee_count),
       technology_names = COALESCE(@technology_names, technology_names),
       keywords = COALESCE(@keywords, keywords),
       funding_stage = COALESCE(@funding_stage, funding_stage),
       funding_amount = COALESCE(@funding_amount, funding_amount),
       funding_at = COALESCE(@funding_at, funding_at),
       funding_total = COALESCE(@funding_total, funding_total),
       department_headcount = COALESCE(@department_headcount, department_headcount),
       headcount_growth = COALESCE(@headcount_growth, headcount_growth),
       stock_symbol = COALESCE(@stock_symbol, stock_symbol),
       stock_exchange = COALESCE(@stock_exchange, stock_exchange),
       domain_rank = COALESCE(@domain_rank, domain_rank),
       enrichment_source = 'apollo',
       enriched_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id: companyId,
    industry: org.industry, location: [org.city, org.country].filter(Boolean).join(", ") || null, linkedin_url: org.linkedin_url, website: org.website_url,
    city: org.city, country: org.country, logo_url: org.logo_url, phone: org.phone, description: org.short_description, founded_year: org.founded_year,
    annual_revenue: org.annual_revenue_printed, employee_count: org.estimated_num_employees,
    technology_names: org.technology_names ? JSON.stringify(org.technology_names) : null, keywords: org.keywords ? JSON.stringify(org.keywords) : null,
    funding_stage: org.funding_stage, funding_amount: org.funding_amount, funding_at: org.funding_at, funding_total: org.funding_total,
    department_headcount: org.department_headcount ? JSON.stringify(org.department_headcount) : null, headcount_growth: org.headcount_growth,
    stock_symbol: org.stock_symbol, stock_exchange: org.stock_exchange, domain_rank: org.domain_rank,
  });
}

/**
 * Look one company up on Apollo by its domain and store the answer. Spends one credit
 * unless the company has no usable domain. An unknown domain is still stamped as looked
 * up, so "enriched 3 days ago" is true of the attempt. Throws an ApolloError when Apollo
 * refuses to answer; nothing is written then.
 */
export async function enrichCompanyFromApollo(db: DB, workspaceId: string, companyId: string, apiKey: string): Promise<CompanyEnrichOutcome> {
  const company = db.prepare("SELECT id, domain, website FROM companies WHERE id = ? AND workspace_id = ?").get(companyId, workspaceId) as { id: string; domain: string | null; website: string | null } | undefined;
  const domain = lookupDomain(company?.domain) ?? lookupDomain(company?.website);
  if (!company || !domain) return "no_domain";
  const org = await enrichOrganization(domain, apiKey);
  if (!org) {
    db.prepare("UPDATE companies SET enriched_at = datetime('now'), enrichment_source = COALESCE(enrichment_source, 'apollo') WHERE id = ?").run(company.id);
    return "not_found";
  }
  applyOrganization(db, company.id, org);
  return "enriched";
}

// ── Suggested people ──────────────────────────────────────────────────────────

/**
 * Ask Apollo who works at a company and keep the people who are not contacts yet. This is
 * a search: no email address is revealed. People already suggested, added or dismissed are
 * left as they are.
 */
export async function findSuggestions(db: DB, workspaceId: string, companyId: string, apiKey: string): Promise<{ found: number; added: number; outcome: "searched" | "no_domain" }> {
  const company = db.prepare("SELECT id, domain, website FROM companies WHERE id = ? AND workspace_id = ?").get(companyId, workspaceId) as { id: string; domain: string | null; website: string | null } | undefined;
  const domain = lookupDomain(company?.domain) ?? lookupDomain(company?.website);
  if (!company || !domain) return { found: 0, added: 0, outcome: "no_domain" };
  const { people } = await searchPeopleAtDomain(domain, apiKey, { perPage: SUGGESTION_SEARCH_SIZE });
  const known = new Set((db.prepare("SELECT apollo_id FROM targets WHERE workspace_id = ? AND company_id = ? AND apollo_id IS NOT NULL").all(workspaceId, company.id) as { apollo_id: string }[]).map((row) => row.apollo_id));
  const knownUrls = new Set((db.prepare("SELECT lower(linkedin_url) AS url FROM targets WHERE workspace_id = ? AND linkedin_url IS NOT NULL").all(workspaceId) as { url: string }[]).map((row) => row.url.replace(/\/+$/, "")));
  const insert = db.prepare(
    "INSERT OR IGNORE INTO company_suggestions (id, workspace_id, company_id, source, external_id, name, title, seniority, linkedin_url) VALUES (?, ?, ?, 'apollo', ?, ?, ?, ?, ?)",
  );
  let added = 0;
  db.transaction(() => {
    for (const person of people) {
      if (known.has(person.id)) continue;
      if (person.linkedin_url && knownUrls.has(person.linkedin_url.toLowerCase().replace(/\/+$/, ""))) continue;
      added += insert.run(randomUUID(), workspaceId, company.id, person.id, person.name, person.title, person.seniority, person.linkedin_url).changes;
    }
  })();
  return { found: people.length, added, outcome: "searched" };
}

export type SuggestionOutcome = "added" | "linked" | "not_found";

/** The contact a look-up describes, when the workspace already has them: by Apollo id, LinkedIn address or email. */
function existingContact(db: DB, workspaceId: string, person: ApolloMatchResult): string | null {
  const byId = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND apollo_id = ?").get(workspaceId, person.apollo_id) as { id: string } | undefined;
  if (byId) return byId.id;
  if (person.linkedin_url) {
    const url = person.linkedin_url.replace(/\/+$/, "");
    const byUrl = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND rtrim(lower(linkedin_url), '/') = lower(?)").get(workspaceId, url) as { id: string } | undefined;
    if (byUrl) return byUrl.id;
  }
  if (person.email) {
    const byEmail = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND lower(email) = lower(?)").get(workspaceId, person.email) as { id: string } | undefined;
    if (byEmail) return byEmail.id;
  }
  return null;
}

/**
 * Turn one suggested person into a contact of the company. This is a look-up: it spends
 * one credit and brings back the full name, the LinkedIn address and the email. Someone
 * the workspace already has is linked to the company, not made twice.
 */
export async function addSuggestion(db: DB, ctx: { workspaceId: string; userId: string | null }, suggestionId: string, apiKey: string): Promise<{ outcome: SuggestionOutcome; target_id: string | null }> {
  const suggestion = db.prepare(
    `SELECT s.id, s.company_id, s.external_id, s.name, s.title, s.linkedin_url, c.name AS company_name
       FROM company_suggestions s JOIN companies c ON c.id = s.company_id
      WHERE s.id = ? AND s.workspace_id = ? AND s.status = 'suggested'`,
  ).get(suggestionId, ctx.workspaceId) as { id: string; company_id: string; external_id: string; name: string; title: string | null; linkedin_url: string | null; company_name: string } | undefined;
  if (!suggestion) return { outcome: "not_found", target_id: null };

  const person = await matchPersonById(suggestion.external_id, apiKey);
  // Apollo no longer has the person, or will not say how to reach them: nothing to make a contact from.
  if (!person || (!person.linkedin_url && !person.email)) {
    db.prepare("UPDATE company_suggestions SET status = 'dismissed' WHERE id = ?").run(suggestion.id);
    return { outcome: "not_found", target_id: null };
  }

  return db.transaction(() => {
    const existing = existingContact(db, ctx.workspaceId, person);
    if (existing) {
      db.prepare("UPDATE targets SET company_id = COALESCE(company_id, ?), apollo_id = COALESCE(apollo_id, ?) WHERE id = ?").run(suggestion.company_id, person.apollo_id, existing);
      db.prepare("UPDATE company_suggestions SET status = 'added', target_id = ? WHERE id = ?").run(existing, suggestion.id);
      return { outcome: "linked" as const, target_id: existing };
    }
    const id = randomUUID();
    const name = person.name ?? suggestion.name;
    db.prepare(
      `INSERT INTO targets (id, workspace_id, owner_id, full_name, first_name, last_name, title, company, company_id, linkedin_url, email, email_status,
                            email_domain_catchall, headline, seniority, apollo_id, apollo_functions, apollo_departments, city, country, time_zone, positions_json, apollo_enriched_at)
       VALUES (@id, @workspace_id, @owner_id, @full_name, @first_name, @last_name, @title, @company, @company_id, @linkedin_url, @email, @email_status,
               @catchall, @headline, @seniority, @apollo_id, @functions, @departments, @city, @country, @time_zone, @positions_json, datetime('now'))`,
    ).run({
      id, workspace_id: ctx.workspaceId, owner_id: ctx.userId, full_name: name, first_name: person.first_name, last_name: person.last_name,
      title: person.title ?? suggestion.title, company: suggestion.company_name, company_id: suggestion.company_id,
      linkedin_url: person.linkedin_url?.includes("/in/") ? person.linkedin_url : null, email: person.email, email_status: person.email ? person.email_status : null,
      catchall: person.email_domain_catchall ? 1 : 0, headline: person.headline, seniority: person.seniority, apollo_id: person.apollo_id,
      functions: person.functions ? JSON.stringify(person.functions) : null, departments: person.departments ? JSON.stringify(person.departments) : null,
      city: person.city, country: person.country, time_zone: person.time_zone, positions_json: person.positions_json,
    });
    db.prepare("UPDATE company_suggestions SET status = 'added', target_id = ? WHERE id = ?").run(id, suggestion.id);
    return { outcome: "added" as const, target_id: id };
  })();
}

/** Put suggestions aside without looking anyone up. Returns how many were dismissed. */
export function dismissSuggestions(db: DB, workspaceId: string, companyId: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  return db.prepare(
    `UPDATE company_suggestions SET status = 'dismissed' WHERE workspace_id = ? AND company_id = ? AND status = 'suggested' AND id IN (${ids.map(() => "?").join(", ")})`,
  ).run(workspaceId, companyId, ...ids).changes;
}

// ── The bounce flag ───────────────────────────────────────────────────────────

/** A contact's own address bounced, as against being marked invalid because a colleague's did. */
const OWN_BOUNCE = `(EXISTS (SELECT 1 FROM sender_events se WHERE se.workspace_id = t.workspace_id AND se.event_type = 'bounced' AND lower(se.recipient) = lower(t.email))
  OR EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = t.workspace_id AND s.kind = 'email' AND lower(s.value) = lower(t.email)))`;

/**
 * Give back the benefit of the doubt to contacts who were marked invalid only because
 * someone else at their company bounced: their address goes back to "not checked". A
 * contact whose own address bounced, or is on the do-not-send list, stays as it is.
 */
function restoreColleagues(db: DB, workspaceId: string, companyId: string): number {
  return db.prepare(
    `UPDATE targets SET email_status = NULL, email_verified_at = NULL
      WHERE id IN (SELECT t.id FROM targets t WHERE t.company_id = ? AND t.workspace_id = ? AND t.email IS NOT NULL AND t.email != '' AND t.email_status = 'invalid' AND NOT ${OWN_BOUNCE})`,
  ).run(companyId, workspaceId).changes;
}

/**
 * Clear a company's bounce flag, so email to it is no longer skipped. Colleagues marked
 * invalid by the flag become unchecked again; the address that bounced stays invalid and
 * on the do-not-send list. Email steps skipped while the flag was set are not sent later.
 */
export function clearBounceFlag(db: DB, ctx: { workspaceId: string; userId: string | null }, companyId: string): { cleared: boolean; restored: number } {
  return db.transaction(() => {
    const cleared = db.prepare(
      "UPDATE companies SET email_domain_invalid = 0, bounce_cleared_at = datetime('now'), bounce_cleared_by = ? WHERE id = ? AND workspace_id = ? AND email_domain_invalid = 1",
    ).run(ctx.userId, companyId, ctx.workspaceId).changes > 0;
    return { cleared, restored: cleared ? restoreColleagues(db, ctx.workspaceId, companyId) : 0 };
  })();
}

/**
 * Queue the company's addresses for a check: everyone with an address that did not itself
 * bounce. The runner works the queue in the background, the same one a list's "Verify
 * emails" fills. The flag is left alone: that is a person's call once the results are in.
 */
export function reverifyCompany(db: DB, workspaceId: string, companyId: string): { queued: number; restored: number } {
  return db.transaction(() => {
    const restored = restoreColleagues(db, workspaceId, companyId);
    const queued = db.prepare(
      `UPDATE targets SET email_verify_requested_at = datetime('now')
        WHERE id IN (SELECT t.id FROM targets t WHERE t.company_id = ? AND t.workspace_id = ? AND t.email IS NOT NULL AND t.email != '' AND COALESCE(t.email_status, '') != 'invalid' AND NOT ${OWN_BOUNCE})`,
    ).run(companyId, workspaceId).changes;
    return { queued, restored };
  })();
}
