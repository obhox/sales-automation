// Which contacts a request is asking for. The contacts page, a list's page, the campaign
// prospects table and the CSV exports of each all read the same query string, so they are
// turned into SQL in one place: an export has exactly the rows that were on screen.
import type { ActiveFilter, FilterOp } from "@/components/ui/FilterBar";

export type Query = Partial<Record<string, string | string[]>>;

/** `f[0][field]`, `f[0][op]`, `f[0][value]`, `f[1][field]`, ... as the filter bar sends them. */
export function parseFilters(query: Query): ActiveFilter[] {
  const filters: ActiveFilter[] = [];
  let i = 0;
  while (query[`f[${i}][field]`]) {
    filters.push({
      id: String(i),
      field: query[`f[${i}][field]`] as string,
      op: query[`f[${i}][op]`] as FilterOp,
      value: query[`f[${i}][value]`] as string | undefined,
    });
    i++;
  }
  return filters;
}

/** The columns a contacts filter may name, and the SQL each stands for. Anything else is ignored. */
export const CONTACT_FILTER_COLUMNS: Record<string, string> = {
  seniority: "t.seniority",
  email_status: "t.email_status",
  degree: "t.degree",
  email: "t.email",
  apollo_enriched_at: "t.apollo_enriched_at",
  connection_requested_at: "t.connection_requested_at",
  connected_at: "t.connected_at",
  message_sent_at: "t.message_sent_at",
  last_replied_at: "t.last_replied_at",
  open_link: "t.open_link",
  email_domain_catchall: "t.email_domain_catchall",
  company_size: "t.company_size",
  tenure_months: "t.tenure_months",
  country: "t.country",
  company_industry: "t.company_industry",
  company: "t.company",
};

/** The same for the campaign prospects table, which offers a shorter list. */
export const PROSPECT_FILTER_COLUMNS: Record<string, string> = {
  degree: "t.degree",
  connection_requested_at: "t.connection_requested_at",
  connected_at: "t.connected_at",
  message_sent_at: "t.message_sent_at",
  company: "t.company",
  title: "t.title",
  seniority: "t.seniority",
  country: "t.country",
};

// Where a contact stands on LinkedIn is worked out from several columns, not stored.
function connectionStatusClause(filter: ActiveFilter): string {
  let expr: string;
  switch (filter.value) {
    case "replied": expr = "t.last_replied_at IS NOT NULL"; break;
    case "messaged": expr = "t.message_sent_at IS NOT NULL AND t.last_replied_at IS NULL"; break;
    case "connected": expr = "t.degree = 1 AND t.message_sent_at IS NULL"; break;
    case "request_sent": expr = "t.connection_requested_at IS NOT NULL AND (t.degree IS NULL OR t.degree != 1)"; break;
    case "not_contacted":
    default: expr = "t.connection_requested_at IS NULL AND t.message_sent_at IS NULL";
  }
  return filter.op === "is_not" ? `NOT (${expr})` : expr;
}

/** Filters as ` AND ...` SQL over `targets t`. `connectionStatus` allows the derived connection_status field. */
export function filterClause(filters: ActiveFilter[], columns: Record<string, string>, connectionStatus = false): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    if (connectionStatus && f.field === "connection_status") { parts.push(connectionStatusClause(f)); continue; }
    const col = columns[f.field];
    if (!col) continue;
    switch (f.op) {
      case "is_set": parts.push(`${col} IS NOT NULL AND ${col} != ''`); break;
      case "is_not_set": parts.push(`(${col} IS NULL OR ${col} = '')`); break;
      case "is_true": parts.push(`${col} = 1`); break;
      case "is_false": parts.push(`(${col} = 0 OR ${col} IS NULL)`); break;
      case "is": parts.push(`LOWER(${col}) = LOWER(?)`); params.push(f.value ?? ""); break;
      case "is_not": parts.push(`LOWER(${col}) != LOWER(?)`); params.push(f.value ?? ""); break;
      case "contains": parts.push(`${col} LIKE ?`); params.push(`%${f.value ?? ""}%`); break;
      case "gt": parts.push(`CAST(${col} AS REAL) > ?`); params.push(Number(f.value ?? 0)); break;
      case "lt": parts.push(`CAST(${col} AS REAL) < ?`); params.push(Number(f.value ?? 0)); break;
    }
  }
  return { sql: parts.length > 0 ? " AND " + parts.join(" AND ") : "", params };
}

// ── The contacts screen's named filters ───────────────────────────────────────
// One value each, named in the address bar (`?email=verified&intent=60`). They sit
// beside the older `f[0][field]` form, which the API and the campaign prospects table
// still send.

/** Where a contact stands on LinkedIn, worked out from what has been recorded. */
export const LINKEDIN_STATUS_SQL = `CASE
    WHEN t.degree = 1 OR t.connected_at IS NOT NULL THEN 'connected'
    WHEN t.invite_withdrawn_at IS NOT NULL THEN 'withdrawn'
    WHEN t.connection_requested_at IS NOT NULL THEN 'invite_sent'
    WHEN t.inmail_sent_at IS NOT NULL THEN 'inmail_sent'
    ELSE 'not_connected' END`;
export const LINKEDIN_STATUSES = ["connected", "invite_sent", "inmail_sent", "withdrawn", "not_connected"] as const;
export type LinkedinStatus = (typeof LINKEDIN_STATUSES)[number];

export const EMAIL_FILTER_VALUES = ["any", "none", "verified", "checked", "catchall", "unverified", "invalid", "unchecked"] as const;

/** At most this many ids in one `ids=` selection. */
export const MAX_SELECTION = 5000;

const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
const HAS_EMAIL = "(t.email IS NOT NULL AND t.email != '')";

/** The named filters present in a query, as clauses over `targets t`. Values that mean nothing are ignored. */
export function namedContactFilters(query: Query, workspaceId: string): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const q = one(query.q);
  if (q) {
    const like = `%${q}%`;
    clauses.push("(t.full_name LIKE ? OR t.company LIKE ? OR t.title LIKE ? OR t.email LIKE ?)");
    params.push(like, like, like, like);
  }

  const email = one(query.email);
  if (email === "any") clauses.push(HAS_EMAIL);
  else if (email === "none") clauses.push(`NOT ${HAS_EMAIL}`);
  else if (email === "unchecked") clauses.push(`${HAS_EMAIL} AND (t.email_status IS NULL OR t.email_status = '')`);
  else if ((EMAIL_FILTER_VALUES as readonly string[]).includes(email)) { clauses.push(`${HAS_EMAIL} AND t.email_status = ?`); params.push(email); }

  const linkedin = one(query.linkedin);
  if ((LINKEDIN_STATUSES as readonly string[]).includes(linkedin)) { clauses.push(`${LINKEDIN_STATUS_SQL} = ?`); params.push(linkedin); }

  // In a campaign means enrolled in any of its runs, finished or not.
  const campaign = one(query.campaign);
  const inAnyCampaign = "EXISTS (SELECT 1 FROM run_profiles rp WHERE rp.target_id = t.id)";
  if (campaign === "any") clauses.push(inAnyCampaign);
  else if (campaign === "none") clauses.push(`NOT ${inAnyCampaign}`);
  else if (campaign) {
    clauses.push("EXISTS (SELECT 1 FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE rp.target_id = t.id AND r.workflow_id = ? AND r.workspace_id = ?)");
    params.push(campaign, workspaceId);
  }

  const intent = Number(one(query.intent));
  if (one(query.intent) && Number.isFinite(intent)) { clauses.push("t.intent_score >= ?"); params.push(intent); }

  const owner = one(query.owner);
  if (owner === "none") clauses.push("t.owner_id IS NULL");
  else if (owner) { clauses.push("t.owner_id = ?"); params.push(owner); }

  const tag = one(query.tag);
  const anyTag = "EXISTS (SELECT 1 FROM target_tags tt WHERE tt.target_id = t.id)";
  if (tag === "none") clauses.push(`NOT ${anyTag}`);
  else if (tag) { clauses.push("EXISTS (SELECT 1 FROM target_tags tt WHERE tt.target_id = t.id AND tt.tag_id = ?)"); params.push(tag); }

  const seniority = one(query.seniority);
  if (seniority) { clauses.push("LOWER(t.seniority) = LOWER(?)"); params.push(seniority); }
  const country = one(query.country);
  if (country) { clauses.push("LOWER(t.country) = LOWER(?)"); params.push(country); }

  const replied = one(query.replied);
  const hasReplied = "(t.last_replied_at IS NOT NULL OR t.email_replied_at IS NOT NULL)";
  if (replied === "yes") clauses.push(hasReplied);
  else if (replied === "no") clauses.push(`NOT ${hasReplied}`);

  const enriched = one(query.enriched);
  if (enriched === "yes") clauses.push("t.apollo_enriched_at IS NOT NULL");
  else if (enriched === "no") clauses.push("t.apollo_enriched_at IS NULL");

  // In any of several lists: `list_ids=a,b,c`, for an action on a selection of lists.
  const listIds = one(query.list_ids);
  if (listIds) {
    const lists = listIds.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 200);
    clauses.push(lists.length ? `EXISTS (SELECT 1 FROM list_targets ltm WHERE ltm.target_id = t.id AND ltm.list_id IN (${lists.map(() => "?").join(",")}))` : "0");
    params.push(...lists);
  }

  // Everyone at one company: `company_id=…`, for an action on a company's contacts.
  const companyId = one(query.company_id);
  if (companyId) { clauses.push("t.company_id = ?"); params.push(companyId); }

  // A hand-picked selection: `ids=a,b,c`. More than MAX_SELECTION are cut off, never widened.
  const ids = one(query.ids);
  if (ids) {
    const list = ids.split(",").map((id) => id.trim()).filter(Boolean).slice(0, MAX_SELECTION);
    clauses.push(list.length ? `t.id IN (${list.map(() => "?").join(",")})` : "0");
    params.push(...list);
  }
  return { clauses, params };
}

/**
 * The contacts a contacts-page request selects, as `FROM ... WHERE ...` over `targets t`
 * with its parameters: the workspace's contacts, narrowed by `list_id`, `search`, the
 * filter bar and the named filters. The caller adds what to select, the order and the paging.
 */
export function contactsQuery(query: Query, workspaceId: string): { from: string; where: string; params: unknown[] } {
  const listId = typeof query.list_id === "string" && query.list_id ? query.list_id : null;
  const clauses: string[] = [];
  const params: unknown[] = [];
  // `none` asks for the contacts that are in no list at all.
  const inNoList = listId === "none";
  if (inNoList) clauses.push("NOT EXISTS (SELECT 1 FROM list_targets lt WHERE lt.target_id = t.id)");
  else if (listId) { clauses.push("lt.list_id = ?"); params.push(listId); }
  clauses.push("t.workspace_id = ?");
  params.push(workspaceId);
  if (typeof query.search === "string" && query.search.trim()) {
    const like = `%${query.search.trim()}%`;
    clauses.push("(t.full_name LIKE ? OR t.company LIKE ? OR t.title LIKE ?)");
    params.push(like, like, like);
  }
  const named = namedContactFilters(query, workspaceId);
  const filters = filterClause(parseFilters(query), CONTACT_FILTER_COLUMNS, true);
  return {
    // All contacts unless a list is named, including ones in no list at all.
    from: listId && !inNoList ? "FROM targets t JOIN list_targets lt ON lt.target_id = t.id" : "FROM targets t",
    where: `WHERE ${[...clauses, ...named.clauses].join(" AND ")}${filters.sql}`,
    params: [...params, ...named.params, ...filters.params],
  };
}
