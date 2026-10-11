// What the Companies screen reads: the list of companies a page at a time, the figures
// across all of them, one company in detail, and the bounces behind a company's flag.
// Reads only; nothing here asks Apollo anything.
import type DatabaseType from "better-sqlite3";
import type { NextApiRequest } from "next";
import { paged, parsePaging, parseSort, type Paged } from "@/lib/api/paging";
import { apolloKey } from "@/lib/contacts/apollo-enrich";
import { LINKEDIN_STATUS_SQL, type LinkedinStatus } from "@/lib/contacts/filters";

type DB = DatabaseType.Database;
type Query = NextApiRequest["query"];

export const COMPANY_FILTERS = ["all", "contacts", "bouncing", "campaign", "target"] as const;
export type CompanyFilter = (typeof COMPANY_FILTERS)[number];

const CONTACTS = "(SELECT COUNT(*) FROM targets t WHERE t.company_id = c.id AND t.workspace_id = c.workspace_id)";
/** A company's intent: its own score from signals recorded against it, or the highest among its contacts, whichever is higher. */
const INTENT = "MAX(COALESCE(c.intent_score, 0), COALESCE((SELECT MAX(t.intent_score) FROM targets t WHERE t.company_id = c.id AND t.workspace_id = c.workspace_id), 0))";
/** A contact still has a step to come in a campaign that is running or paused. */
const ACTIVE_RUN = `r.status IN ('running', 'paused')
  AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped'))`;
const IN_CAMPAIGN = `EXISTS (SELECT 1 FROM targets t JOIN run_profiles rp ON rp.target_id = t.id JOIN runs r ON r.id = rp.run_id
  WHERE t.company_id = c.id AND t.workspace_id = c.workspace_id AND ${ACTIVE_RUN})`;

export const COMPANY_SORTS: Record<string, string> = {
  intent: INTENT,
  name: "c.name COLLATE NOCASE",
  contacts: CONTACTS,
  employees: "COALESCE(c.employee_count, 0)",
  created: "c.created_at",
};
export const DEFAULT_COMPANY_SORT = { key: "intent", direction: "desc" as const };

const FILTER_SQL: Record<CompanyFilter, string | null> = {
  all: null,
  contacts: `${CONTACTS} > 0`,
  bouncing: "c.email_domain_invalid = 1",
  campaign: IN_CAMPAIGN,
  target: "c.is_target = 1",
};

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value) ?? "";

export interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  logo_url: string | null;
  employee_count: number | null;
  intent: number;
  contacts: number;
  bouncing: boolean;
  is_target: boolean;
}

function where(query: Query, workspaceId: string): { sql: string; params: unknown[] } {
  const clauses = ["c.workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  const q = first(query.q).trim();
  if (q) {
    clauses.push("(c.name LIKE ? ESCAPE '\\' OR c.domain LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(like, like);
  }
  const filter = first(query.filter) as CompanyFilter;
  const condition = COMPANY_FILTERS.includes(filter) ? FILTER_SQL[filter] : null;
  if (condition) clauses.push(condition);
  const ids = first(query.ids).split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length > 0) {
    clauses.push(`c.id IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }
  return { sql: clauses.join(" AND "), params };
}

/** One page of the companies list: search by name or domain, one filter, one sort. */
export function companiesPage(db: DB, workspaceId: string, query: Query): Paged<CompanyRow> {
  const paging = parsePaging(query, { defaultLimit: 25, maxLimit: 100 });
  const { orderBy } = parseSort(query, COMPANY_SORTS, DEFAULT_COMPANY_SORT);
  const filter = where(query, workspaceId);
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM companies c WHERE ${filter.sql}`).get(...filter.params) as { c: number }).c;
  const rows = db.prepare(
    `SELECT c.id, c.name, c.domain, c.logo_url, c.employee_count, c.email_domain_invalid, c.is_target, ${INTENT} AS intent, ${CONTACTS} AS contacts
       FROM companies c WHERE ${filter.sql}
      ORDER BY ${orderBy}, c.name COLLATE NOCASE ASC, c.id ASC LIMIT ? OFFSET ?`,
  ).all(...filter.params, paging.limit, paging.offset) as (Omit<CompanyRow, "bouncing" | "is_target"> & { email_domain_invalid: number | null; is_target: number })[];
  const items = rows.map(({ email_domain_invalid, is_target, ...row }) => ({ ...row, intent: Math.round(row.intent), bouncing: email_domain_invalid === 1, is_target: is_target === 1 }));
  return paged(items, total, paging);
}

/** The ids behind the list as it is filtered, for an action on all of them. Capped. */
export function companyIds(db: DB, workspaceId: string, query: Query, cap: number, extra = ""): { ids: string[]; total: number } {
  const filter = where(query, workspaceId);
  const sql = `${filter.sql}${extra ? ` AND ${extra}` : ""}`;
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM companies c WHERE ${sql}`).get(...filter.params) as { c: number }).c;
  const ids = (db.prepare(`SELECT c.id FROM companies c WHERE ${sql} ORDER BY c.name COLLATE NOCASE, c.id LIMIT ?`).all(...filter.params, cap) as { id: string }[]).map((row) => row.id);
  return { ids, total };
}

/** The list as it is filtered and sorted, with the fields a CSV file carries, for the export. */
export function companiesForExport(db: DB, workspaceId: string, query: Query): { total: number; page: (limit: number, offset: number) => Record<string, unknown>[] } {
  const { orderBy } = parseSort(query, COMPANY_SORTS, DEFAULT_COMPANY_SORT);
  const filter = where(query, workspaceId);
  return {
    total: (db.prepare(`SELECT COUNT(*) AS c FROM companies c WHERE ${filter.sql}`).get(...filter.params) as { c: number }).c,
    page: (limit, offset) => (db.prepare(
      `SELECT c.name, c.domain, c.website, c.linkedin_url, c.industry, c.location, c.employee_count, c.annual_revenue, c.founded_year, c.funding_stage, c.funding_amount,
              c.technology_names, c.keywords, c.is_target, c.email_domain_invalid, c.enrichment_source, c.enriched_at, c.created_at, ${INTENT} AS intent, ${CONTACTS} AS contacts
         FROM companies c WHERE ${filter.sql} ORDER BY ${orderBy}, c.name COLLATE NOCASE ASC, c.id ASC LIMIT ? OFFSET ?`,
    ).all(...filter.params, limit, offset) as Record<string, unknown>[]).map((row) => ({
      ...row, intent: Math.round(Number(row.intent)), technology_names: parseList(row.technology_names as string | null).join(", "), keywords: parseList(row.keywords as string | null).join(", "),
      is_target: row.is_target === 1 ? "yes" : "no", email_domain_invalid: row.email_domain_invalid === 1 ? "yes" : "no",
    })),
  };
}

export interface CompaniesSummary {
  total: number;
  bouncing: number;
  targets: number;
  with_contacts: number;
  /** Companies with a domain, which is what an Apollo look-up needs. */
  with_domain: number;
  apollo_connected: boolean;
}

export function companiesSummary(db: DB, workspaceId: string): CompaniesSummary {
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(c.email_domain_invalid = 1), 0) AS bouncing,
            COALESCE(SUM(c.is_target = 1), 0) AS targets,
            COALESCE(SUM(${CONTACTS} > 0), 0) AS with_contacts,
            COALESCE(SUM(c.domain IS NOT NULL AND c.domain != ''), 0) AS with_domain
       FROM companies c WHERE c.workspace_id = ?`,
  ).get(workspaceId) as Omit<CompaniesSummary, "apollo_connected">;
  return { ...row, apollo_connected: apolloKey(db, workspaceId) !== null };
}

// ── One company ───────────────────────────────────────────────────────────────

/** A list kept as JSON text, or as text with commas by an older import. */
export function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  let items: unknown = null;
  try { items = JSON.parse(value); } catch { items = null; }
  const list = Array.isArray(items) ? items : value.split(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const text = typeof item === "string" ? item.trim() : "";
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** People per department, largest first. */
export function parseDepartments(value: string | null | undefined): { name: string; count: number }[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface CompanyContact {
  id: string;
  full_name: string | null;
  title: string | null;
  email: string | null;
  email_status: string | null;
  linkedin_status: LinkedinStatus;
  intent_score: number;
}

export interface CompanySuggestion {
  id: string;
  name: string;
  title: string | null;
  seniority: string | null;
  linkedin_url: string | null;
}

export interface CompanySignal {
  id: string;
  type: string;
  title: string;
  description: string | null;
  source: string | null;
  occurred_at: string;
  handled: boolean;
}

export interface BounceFigures {
  /** Hard bounces from this company's addresses in the last seven days, and emails sent to them in that time. */
  bounces_7d: number;
  sends_7d: number;
  bounces_total: number;
  last_bounce_at: string | null;
  /** Contacts here with an address, whose email steps are skipped while the flag is set. */
  contacts_with_email: number;
  /** Addresses waiting for a check. */
  verifying: number;
}

export interface CompanyDetail {
  company: {
    id: string;
    name: string;
    domain: string | null;
    website: string | null;
    linkedin_url: string | null;
    industry: string | null;
    location: string | null;
    city: string | null;
    country: string | null;
    notes: string | null;
    description: string | null;
    logo_url: string | null;
    phone: string | null;
    employee_count: number | null;
    founded_year: number | null;
    annual_revenue: string | null;
    technologies: string[];
    keywords: string[];
    funding_stage: string | null;
    funding_amount: string | null;
    funding_at: string | null;
    funding_total: string | null;
    departments: { name: string; count: number }[];
    headcount_growth: number | null;
    stock_symbol: string | null;
    stock_exchange: string | null;
    domain_rank: number | null;
    enrichment_source: string | null;
    enriched_at: string | null;
    is_target: boolean;
    bouncing: boolean;
    bounce_cleared_at: string | null;
    intent: number;
    created_at: string | null;
  };
  contacts: { total: number; items: CompanyContact[] };
  /** Campaigns that still have a step to come for someone here. */
  campaigns: { id: string; name: string }[];
  suggestions: CompanySuggestion[];
  /** When Apollo was last asked who works here. Null: never. */
  suggestions_searched_at: string | null;
  signals: { total: number; new: number; items: CompanySignal[] };
  bounce: BounceFigures | null;
  apollo_connected: boolean;
}

interface CompanyRecord {
  id: string; name: string; domain: string | null; website: string | null; linkedin_url: string | null; industry: string | null; location: string | null;
  city: string | null; country: string | null; notes: string | null; description: string | null; logo_url: string | null; phone: string | null;
  employee_count: number | null; founded_year: number | null; annual_revenue: string | null; technology_names: string | null; keywords: string | null;
  funding_stage: string | null; funding_amount: string | null; funding_at: string | null; funding_total: string | null; department_headcount: string | null;
  headcount_growth: number | null; stock_symbol: string | null; stock_exchange: string | null; domain_rank: number | null; enrichment_source: string | null;
  enriched_at: string | null; is_target: number; email_domain_invalid: number | null; bounce_cleared_at: string | null; intent: number; created_at: string | null;
}

/** Bounced addresses that belong to a company: its contacts' addresses, and anything at its domain. */
const bounceMatch = (domain: string | null) => `se.workspace_id = ? AND se.event_type = 'bounced' AND (
  lower(se.recipient) IN (SELECT lower(t.email) FROM targets t WHERE t.company_id = ? AND t.workspace_id = se.workspace_id AND t.email IS NOT NULL AND t.email != '')
  ${domain ? "OR lower(se.recipient) LIKE ? ESCAPE '\\'" : ""})`;
const bounceParams = (workspaceId: string, companyId: string, domain: string | null): unknown[] =>
  [workspaceId, companyId, ...(domain ? [`%@${domain.toLowerCase().replace(/[\\%_]/g, "\\$&")}`] : [])];

export function bounceFigures(db: DB, workspaceId: string, company: { id: string; domain: string | null }): BounceFigures {
  const domain = company.domain?.trim() || null;
  const counts = db.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(se.occurred_at >= datetime('now', '-7 days')), 0) AS recent, MAX(se.occurred_at) AS last
       FROM sender_events se WHERE ${bounceMatch(domain)}`,
  ).get(...bounceParams(workspaceId, company.id, domain)) as { total: number; recent: number; last: string | null };
  const sends = (db.prepare(
    `SELECT COUNT(*) AS c FROM sent_messages sm JOIN targets t ON t.id = sm.target_id
      WHERE sm.workspace_id = ? AND t.company_id = ? AND sm.accepted_at >= datetime('now', '-7 days')`,
  ).get(workspaceId, company.id) as { c: number }).c;
  const people = db.prepare(
    `SELECT COALESCE(SUM(t.email IS NOT NULL AND t.email != ''), 0) AS with_email, COALESCE(SUM(t.email_verify_requested_at IS NOT NULL), 0) AS verifying
       FROM targets t WHERE t.company_id = ? AND t.workspace_id = ?`,
  ).get(company.id, workspaceId) as { with_email: number; verifying: number };
  return { bounces_7d: counts.recent, sends_7d: sends, bounces_total: counts.total, last_bounce_at: counts.last, contacts_with_email: people.with_email, verifying: people.verifying };
}

export interface CompanyBounce {
  id: string;
  recipient: string;
  occurred_at: string;
  contact_id: string | null;
  contact_name: string | null;
  mailbox: string | null;
  subject: string | null;
}

/** The bounces behind a company's flag, newest first. */
export function companyBounces(db: DB, workspaceId: string, company: { id: string; domain: string | null }): CompanyBounce[] {
  const domain = company.domain?.trim() || null;
  return db.prepare(
    `SELECT se.id, se.recipient, se.occurred_at, ea.from_email AS mailbox, sm.subject,
            (SELECT t.id FROM targets t WHERE t.workspace_id = se.workspace_id AND lower(t.email) = lower(se.recipient) LIMIT 1) AS contact_id,
            (SELECT t.full_name FROM targets t WHERE t.workspace_id = se.workspace_id AND lower(t.email) = lower(se.recipient) LIMIT 1) AS contact_name
       FROM sender_events se
       LEFT JOIN email_accounts ea ON ea.id = se.email_account_id
       LEFT JOIN sent_messages sm ON sm.id = se.sent_message_id
      WHERE ${bounceMatch(domain)}
      ORDER BY se.occurred_at DESC LIMIT 50`,
  ).all(...bounceParams(workspaceId, company.id, domain)) as CompanyBounce[];
}

/** One company with what its page shows, or null when it is not in this workspace. */
export function companyDetail(db: DB, workspaceId: string, id: string): CompanyDetail | null {
  const row = db.prepare(`SELECT c.*, ${INTENT} AS intent FROM companies c WHERE c.id = ? AND c.workspace_id = ?`).get(id, workspaceId) as CompanyRecord | undefined;
  if (!row) return null;

  const total = (db.prepare("SELECT COUNT(*) AS c FROM targets WHERE company_id = ? AND workspace_id = ?").get(id, workspaceId) as { c: number }).c;
  const items = db.prepare(
    `SELECT t.id, t.full_name, t.title, t.email, t.email_status, ${LINKEDIN_STATUS_SQL} AS linkedin_status, COALESCE(t.intent_score, 0) AS intent_score
       FROM targets t WHERE t.company_id = ? AND t.workspace_id = ?
      ORDER BY COALESCE(t.intent_score, 0) DESC, t.full_name COLLATE NOCASE LIMIT 50`,
  ).all(id, workspaceId) as CompanyContact[];
  const campaigns = db.prepare(
    `SELECT DISTINCT w.id, w.name FROM targets t
       JOIN run_profiles rp ON rp.target_id = t.id JOIN runs r ON r.id = rp.run_id JOIN workflows w ON w.id = r.workflow_id
      WHERE t.company_id = ? AND t.workspace_id = ? AND ${ACTIVE_RUN} ORDER BY w.name COLLATE NOCASE`,
  ).all(id, workspaceId) as { id: string; name: string }[];
  // In the order the search gave them, which is Apollo's: the most senior first.
  const suggestions = db.prepare(
    "SELECT id, name, title, seniority, linkedin_url FROM company_suggestions WHERE company_id = ? AND workspace_id = ? AND status = 'suggested' ORDER BY rowid",
  ).all(id, workspaceId) as CompanySuggestion[];
  const searched = (db.prepare("SELECT MAX(created_at) AS at FROM company_suggestions WHERE company_id = ? AND workspace_id = ?").get(id, workspaceId) as { at: string | null }).at;
  const counts = db.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(processed_at IS NULL), 0) AS fresh FROM signals WHERE workspace_id = ? AND company_id = ?",
  ).get(workspaceId, id) as { total: number; fresh: number };
  const signals = (db.prepare(
    "SELECT id, type, title, description, source, occurred_at, processed_at FROM signals WHERE workspace_id = ? AND company_id = ? ORDER BY occurred_at DESC LIMIT 8",
  ).all(workspaceId, id) as (Omit<CompanySignal, "handled"> & { processed_at: string | null })[]).map(({ processed_at, ...signal }) => ({ ...signal, handled: processed_at !== null }));

  const bouncing = row.email_domain_invalid === 1;
  return {
    company: {
      id: row.id, name: row.name, domain: row.domain, website: row.website, linkedin_url: row.linkedin_url, industry: row.industry, location: row.location,
      city: row.city, country: row.country, notes: row.notes, description: row.description, logo_url: row.logo_url, phone: row.phone,
      employee_count: row.employee_count, founded_year: row.founded_year, annual_revenue: row.annual_revenue,
      technologies: parseList(row.technology_names), keywords: parseList(row.keywords),
      funding_stage: row.funding_stage, funding_amount: row.funding_amount, funding_at: row.funding_at, funding_total: row.funding_total,
      departments: parseDepartments(row.department_headcount), headcount_growth: row.headcount_growth,
      stock_symbol: row.stock_symbol, stock_exchange: row.stock_exchange, domain_rank: row.domain_rank,
      enrichment_source: row.enrichment_source, enriched_at: row.enriched_at,
      is_target: row.is_target === 1, bouncing, bounce_cleared_at: row.bounce_cleared_at, intent: Math.round(row.intent), created_at: row.created_at,
    },
    contacts: { total, items },
    campaigns,
    suggestions,
    suggestions_searched_at: searched,
    signals: { total: counts.total, new: counts.fresh, items: signals },
    bounce: bouncing ? bounceFigures(db, workspaceId, row) : null,
    apollo_connected: apolloKey(db, workspaceId) !== null,
  };
}
