// Filling in a company from its own website.
//
// This is not a second Apollo. Apollo is better at firmographics — headcount, funding,
// revenue — because it maintains them; a website is better at saying what the company
// actually does and what it is built on, because they wrote it. So this only ever fills a
// field that is empty and never overwrites one Apollo or a member supplied.
//
// That rule also keeps two providers out of a fight. If the website could overwrite Apollo
// and Apollo could overwrite the website, the last person to press a button would decide
// what a company "is", and running both would make a company's record depend on the order
// the buttons were pressed.
import type DatabaseType from "better-sqlite3";
import { CREDITS_PER_EXTRACT, extractPage, readableUrl } from "@/lib/research/firecrawl";


type DB = DatabaseType.Database;

/** Its own row in research_findings, so a facts read and a signals read do not overwrite
 *  each other's snapshot — they ask for different fields and are compared differently. */
export const FACTS_KIND = "website:facts";

export const COMPANY_RESEARCH_BATCH = 5;
export const MAX_COMPANY_RESEARCH = 300;

/** What the reader is asked for. Only fields a website answers better than a database. */
export const COMPANY_SCHEMA = {
  type: "object",
  properties: {
    description: { type: ["string", "null"], description: "One or two sentences, in their own words, saying what this company does and for whom." },
    industry: { type: ["string", "null"], description: "The industry they operate in, in two or three words. Null if the page does not make it clear." },
    location: { type: ["string", "null"], description: "Their headquarters as 'City, Country', if the page says. Null otherwise." },
    founded_year: { type: ["integer", "null"], description: "The year they were founded, if the page says. Null otherwise." },
    technologies: { type: "array", items: { type: "string" }, description: "Named products, platforms or tools they say they use or are built on. Names only." },
    keywords: { type: "array", items: { type: "string" }, description: "Up to eight short phrases a buyer would search for to find this company." },
  },
  required: ["description", "industry", "location", "founded_year", "technologies", "keywords"],
} as const;

export interface CompanyFacts {
  description: string | null;
  industry: string | null;
  location: string | null;
  founded_year: number | null;
  technologies: string[];
  keywords: string[];
}

const text = (value: unknown, max: number): string | null => {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw ? raw.slice(0, max) : null;
};
const list = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? [...new Set(value.map((item) => text(item, 60)).filter((item): item is string => item !== null))].slice(0, max).sort()
    : [];

export function readCompanyFacts(extracted: unknown): CompanyFacts {
  const row = (extracted && typeof extracted === "object" ? extracted : {}) as Record<string, unknown>;
  const year = typeof row.founded_year === "number" && Number.isFinite(row.founded_year) ? Math.trunc(row.founded_year) : null;
  return {
    description: text(row.description, 1_000),
    industry: text(row.industry, 80),
    location: text(row.location, 120),
    // A model asked for a year it cannot see will sometimes offer one. Anything outside the
    // range a company could plausibly have been founded in is dropped rather than stored.
    founded_year: year !== null && year >= 1800 && year <= new Date().getUTCFullYear() ? year : null,
    technologies: list(row.technologies, 40),
    keywords: list(row.keywords, 8),
  };
}

export type CompanyResearchOutcome = "enriched" | "nothing_new" | "no_website" | "unreadable";

export interface CompanyCandidate { id: string; name: string; website: string | null }

export function companyCandidates(db: DB, workspaceId: string, companyIds: string[]): CompanyCandidate[] {
  if (companyIds.length === 0) return [];
  const placeholders = companyIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, name, COALESCE(NULLIF(website, ''), NULLIF(domain, '')) AS website
    FROM companies WHERE workspace_id = ? AND id IN (${placeholders})
  `).all(workspaceId, ...companyIds) as CompanyCandidate[];
  return rows.map((row) => ({ ...row, website: readableUrl(row.website) }));
}

export interface CompanyResearchCost {
  selected: number;
  eligible: number;
  eligible_ids: string[];
  no_website: number;
  credits: number;
  batch: number;
  /** How many already have a description, so re-reading them fills less. */
  described: number;
}

export function companyResearchCost(db: DB, workspaceId: string, candidates: CompanyCandidate[], selected: number): CompanyResearchCost {
  const eligible = candidates.filter((row) => row.website !== null);
  const ids = eligible.map((row) => row.id);
  const described = ids.length === 0 ? 0 : (db.prepare(
    `SELECT COUNT(*) AS c FROM companies WHERE workspace_id = ? AND description IS NOT NULL AND description != '' AND id IN (${ids.map(() => "?").join(",")})`,
  ).get(workspaceId, ...ids) as { c: number }).c;
  return {
    selected, eligible: eligible.length, eligible_ids: ids,
    no_website: candidates.length - eligible.length,
    credits: eligible.length * CREDITS_PER_EXTRACT,
    batch: COMPANY_RESEARCH_BATCH,
    described,
  };
}

/**
 * Write what the website said onto the company, filling only what is empty.
 *
 * Every column uses COALESCE(NULLIF(col, ''), @new): existing wins. Apollo's own writer
 * reserves that form for fields a member may have typed and lets itself replace the ones it
 * maintains — this writer claims none of them, because it has no better claim to a
 * headcount than Apollo does and no claim at all to one a person entered.
 *
 * `enrichment_source` is first-writer-wins, matching Apollo's not-found path. It is one
 * scalar and cannot describe two sources, so research_findings is where which provider read
 * what actually lives.
 */
export function applyCompanyFacts(db: DB, companyId: string, facts: CompanyFacts): boolean {
  const changed = db.prepare(`
    UPDATE companies SET
      description = COALESCE(NULLIF(description, ''), @description),
      industry = COALESCE(NULLIF(industry, ''), @industry),
      location = COALESCE(NULLIF(location, ''), @location),
      founded_year = COALESCE(founded_year, @founded_year),
      technology_names = COALESCE(NULLIF(technology_names, ''), @technology_names),
      keywords = COALESCE(NULLIF(keywords, ''), @keywords),
      enrichment_source = COALESCE(enrichment_source, 'firecrawl'),
      enriched_at = datetime('now')
    WHERE id = @id
      AND (
        (COALESCE(NULLIF(description, ''), '') = '' AND @description IS NOT NULL)
        OR (COALESCE(NULLIF(industry, ''), '') = '' AND @industry IS NOT NULL)
        OR (COALESCE(NULLIF(location, ''), '') = '' AND @location IS NOT NULL)
        OR (founded_year IS NULL AND @founded_year IS NOT NULL)
        OR (COALESCE(NULLIF(technology_names, ''), '') = '' AND @technology_names IS NOT NULL)
        OR (COALESCE(NULLIF(keywords, ''), '') = '' AND @keywords IS NOT NULL)
      )
  `).run({
    id: companyId,
    description: facts.description,
    industry: facts.industry,
    location: facts.location,
    founded_year: facts.founded_year,
    technology_names: facts.technologies.length ? facts.technologies.join(", ") : null,
    keywords: facts.keywords.length ? facts.keywords.join(", ") : null,
  }).changes;
  return changed > 0;
}

/** Read one company's site and fill in what it was missing. */
export async function researchCompany(
  db: DB,
  workspaceId: string,
  candidate: CompanyCandidate,
  apiKey: string,
): Promise<CompanyResearchOutcome> {
  if (!candidate.website) return "no_website";
  const extracted = await extractPage(candidate.website, apiKey, COMPANY_SCHEMA as unknown as Record<string, unknown>);
  if (extracted === null) return "unreadable";

  const facts = readCompanyFacts(extracted);
  const filled = applyCompanyFacts(db, candidate.id, facts);
  // The read happened whether or not it filled anything, so it is recorded either way —
  // otherwise a company with every field already set would be re-read on every run.
  db.prepare(`
    INSERT INTO research_findings (id, workspace_id, company_id, kind, provider, url, snapshot_json, checked_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'firecrawl', ?, ?, datetime('now'))
    ON CONFLICT(workspace_id, company_id, kind) DO UPDATE SET
      provider = excluded.provider, url = excluded.url, snapshot_json = excluded.snapshot_json, checked_at = excluded.checked_at
  `).run(workspaceId, candidate.id, FACTS_KIND, candidate.website, JSON.stringify(facts));

  return filled ? "enriched" : "nothing_new";
}
