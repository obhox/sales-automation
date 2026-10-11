const APOLLO_BASE = "https://api.apollo.io/api/v1";

export interface ApolloMatchResult {
  apollo_id: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  title: string | null;
  linkedin_url: string | null;
  headline: string | null;
  seniority: string | null;
  functions: string[] | null;
  departments: string[] | null;
  email: string | null;
  email_status: string | null;
  email_domain_catchall: boolean;
  city: string | null;
  country: string | null;
  time_zone: string | null;
  positions_json: string | null;
  organization: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    estimated_num_employees: number | null;
    short_description: string | null;
    location: string | null;
    linkedin_url: string | null;
    website_url: string | null;
    founded_year: number | null;
    logo_url: string | null;
    phone: string | null;
    annual_revenue_printed: string | null;
    technology_names: string[] | null;
    keywords: string[] | null;
    city: string | null;
    country: string | null;
  } | null;
}

export async function matchPerson(
  linkedinUrl: string,
  apiKey: string
): Promise<ApolloMatchResult | null> {
  return matchPersonBy({ linkedin_url: linkedinUrl }, apiKey);
}

/**
 * Look a person up by the id an Apollo search gave for them. Spends one credit, like any
 * look-up. Null when Apollo has nobody by that id; an ApolloError when it refused to answer,
 * so a caller can tell "nobody" from "not now".
 */
export async function matchPersonById(apolloId: string, apiKey: string): Promise<ApolloMatchResult | null> {
  return matchPersonBy({ id: apolloId }, apiKey, true);
}

async function matchPersonBy(who: { linkedin_url: string } | { id: string }, apiKey: string, strict = false): Promise<ApolloMatchResult | null> {
  const res = await fetch(`${APOLLO_BASE}/people/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({ ...who, reveal_personal_emails: false }),
  });

  if (!res.ok && strict && res.status !== 404 && res.status !== 422) throw refusal(res.status);
  if (!res.ok) return null;

  const data = await res.json();
  const p = data.person;
  if (!p || !p.id) return null;

  const org = p.organization ?? null;
  const location =
    org
      ? [org.city, org.country].filter(Boolean).join(", ") || null
      : null;

  // Map employment_history to positions_json format (same shape as Sales Nav enrichment)
  let positions_json: string | null = null;
  if (Array.isArray(p.employment_history) && p.employment_history.length > 0) {
    const positions = p.employment_history.map((e: Record<string, unknown>) => ({
      title: e.title ?? "",
      companyName: e.organization_name ?? "",
      current: e.current === true,
      startDate: e.start_date ?? undefined,
      endDate: e.end_date ?? undefined,
    }));
    positions_json = JSON.stringify(positions);
  }

  return {
    apollo_id: p.id,
    first_name: p.first_name ?? null,
    last_name: p.last_name ?? null,
    name: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null),
    title: p.title ?? null,
    linkedin_url: p.linkedin_url ?? null,
    headline: p.headline ?? null,
    seniority: p.seniority ?? null,
    functions: Array.isArray(p.functions) && p.functions.length > 0 ? p.functions : null,
    departments: Array.isArray(p.departments) && p.departments.length > 0 ? p.departments : null,
    email: p.email ?? null,
    email_status: p.email_status ?? null,
    email_domain_catchall: p.email_domain_catchall === true,
    city: p.city ?? null,
    country: p.country ?? null,
    time_zone: p.time_zone ?? null,
    positions_json,
    organization: org
      ? {
          name: org.name ?? null,
          domain: org.primary_domain ?? null,
          industry: org.industry ?? null,
          estimated_num_employees: org.estimated_num_employees ?? null,
          short_description: org.short_description ?? null,
          location,
          linkedin_url: org.linkedin_url ?? null,
          website_url: org.website_url ?? null,
          founded_year: org.founded_year ?? null,
          logo_url: org.logo_url ?? null,
          phone: org.phone ?? org.sanitized_phone ?? null,
          annual_revenue_printed: org.annual_revenue_printed ?? null,
          technology_names: Array.isArray(org.technology_names) && org.technology_names.length > 0 ? org.technology_names : null,
          keywords: Array.isArray(org.keywords) && org.keywords.length > 0 ? org.keywords : null,
          city: org.city ?? null,
          country: org.country ?? null,
        }
      : null,
  };
}

// ── Companies ─────────────────────────────────────────────────────────────────

/** Apollo answered, and the answer was a refusal: a bad key, no credits left, too many requests. */
export class ApolloError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApolloError";
  }
}

function refusal(status: number): ApolloError {
  const why = status === 401 || status === 403 ? "the API key was not accepted"
    : status === 402 ? "the Apollo account has no credits left"
      : status === 429 ? "too many requests; try again in a minute"
        : `it answered ${status}`;
  return new ApolloError(status, `Apollo could not be asked: ${why}`);
}

export interface ApolloOrganization {
  name: string | null;
  domain: string | null;
  industry: string | null;
  estimated_num_employees: number | null;
  short_description: string | null;
  linkedin_url: string | null;
  website_url: string | null;
  founded_year: number | null;
  logo_url: string | null;
  phone: string | null;
  annual_revenue_printed: string | null;
  technology_names: string[] | null;
  keywords: string[] | null;
  city: string | null;
  country: string | null;
  funding_stage: string | null;
  funding_amount: string | null;
  funding_at: string | null;
  funding_total: string | null;
  department_headcount: Record<string, number> | null;
  /** Headcount growth over twelve months, as a fraction. */
  headcount_growth: number | null;
  stock_symbol: string | null;
  stock_exchange: string | null;
  domain_rank: number | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strings = (value: unknown): string[] | null => {
  const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  return list.length > 0 ? list : null;
};

/** "$120M" from Apollo's amount and currency, which arrive as "120M" and "$", or as a number. */
function printedAmount(amount: unknown, currency: unknown): string | null {
  const sign = text(currency) ?? "";
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
    const short = amount >= 1e9 ? `${+(amount / 1e9).toFixed(1)}B` : amount >= 1e6 ? `${+(amount / 1e6).toFixed(1)}M` : amount >= 1e3 ? `${+(amount / 1e3).toFixed(0)}K` : String(amount);
    return `${sign || "$"}${short}`;
  }
  const printed = text(amount);
  if (!printed) return null;
  return /^[^0-9]/.test(printed) ? printed : `${sign || "$"}${printed}`;
}

/** What Apollo's organisation record says, in the shape a company row keeps. Exported for tests. */
export function readOrganization(org: Record<string, unknown>): ApolloOrganization {
  const events = (Array.isArray(org.funding_events) ? org.funding_events : []).filter((event): event is Record<string, unknown> => !!event && typeof event === "object");
  const latest = [...events].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))[0];
  const departments = org.departmental_head_count && typeof org.departmental_head_count === "object"
    ? Object.fromEntries(Object.entries(org.departmental_head_count as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0))
    : {};
  const total = printedAmount(org.total_funding_printed ?? org.total_funding, null);
  return {
    name: text(org.name),
    domain: text(org.primary_domain),
    industry: text(org.industry),
    estimated_num_employees: number(org.estimated_num_employees),
    short_description: text(org.short_description),
    linkedin_url: text(org.linkedin_url),
    website_url: text(org.website_url),
    founded_year: number(org.founded_year),
    logo_url: text(org.logo_url),
    phone: text(org.phone) ?? text(org.sanitized_phone),
    annual_revenue_printed: text(org.annual_revenue_printed),
    technology_names: strings(org.technology_names),
    keywords: strings(org.keywords),
    city: text(org.city),
    country: text(org.country),
    funding_stage: text(org.latest_funding_stage) ?? text(latest?.type),
    funding_amount: printedAmount(latest?.amount, latest?.currency),
    funding_at: text(org.latest_funding_round_date) ?? text(latest?.date),
    funding_total: total,
    department_headcount: Object.keys(departments).length > 0 ? departments : null,
    headcount_growth: number(org.organization_headcount_twelve_month_growth),
    stock_symbol: text(org.publicly_traded_symbol),
    stock_exchange: text(org.publicly_traded_exchange),
    domain_rank: number(org.alexa_ranking),
  };
}

/**
 * Look a company up by its domain. Spends one Apollo credit. Null when Apollo does not know
 * the domain; an ApolloError when it refused to answer.
 */
export async function enrichOrganization(domain: string, apiKey: string): Promise<ApolloOrganization | null> {
  const res = await fetch(`${APOLLO_BASE}/organizations/enrich?domain=${encodeURIComponent(domain)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
  });
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) throw refusal(res.status);
  const data = (await res.json()) as { organization?: Record<string, unknown> | null };
  return data.organization && typeof data.organization === "object" ? readOrganization(data.organization) : null;
}

export interface ApolloPerson {
  id: string;
  /** As much of the name as the search gives. Apollo hides part of the surname until the person is looked up. */
  name: string;
  title: string | null;
  seniority: string | null;
  linkedin_url: string | null;
}

/** One person from a search result, or null for a row with no id or no name. Exported for tests. */
export function readPerson(person: Record<string, unknown>): ApolloPerson | null {
  const id = text(person.id);
  const name = text(person.name) ?? [text(person.first_name), text(person.last_name) ?? text(person.last_name_obfuscated)].filter(Boolean).join(" ");
  if (!id || !name) return null;
  const linkedin = text(person.linkedin_url);
  return { id, name, title: text(person.title), seniority: text(person.seniority), linkedin_url: linkedin && linkedin.includes("/in/") ? linkedin : null };
}

/**
 * People Apollo lists at a domain, the most senior first as Apollo orders them. This is
 * Apollo's people search: it returns names and titles and reveals no email address, and by
 * Apollo's documentation it spends no credits. Getting an address is a look-up (matchPersonById).
 */
export async function searchPeopleAtDomain(domain: string, apiKey: string, options: { perPage?: number; titles?: string[] } = {}): Promise<{ people: ApolloPerson[]; total: number }> {
  const res = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({
      q_organization_domains_list: [domain], page: 1, per_page: Math.min(Math.max(options.perPage ?? 10, 1), 25),
      person_seniorities: ["owner", "founder", "c_suite", "partner", "vp", "head", "director"],
      ...(options.titles?.length ? { person_titles: options.titles } : {}),
    }),
  });
  if (!res.ok) throw refusal(res.status);
  const data = (await res.json()) as { people?: unknown; total_entries?: unknown; pagination?: { total_entries?: unknown } };
  const rows = (Array.isArray(data.people) ? data.people : []).filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  const people = rows.map(readPerson).filter((person): person is ApolloPerson => person !== null);
  return { people, total: number(data.total_entries) ?? number(data.pagination?.total_entries) ?? people.length };
}
