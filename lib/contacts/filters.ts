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

/**
 * The contacts a contacts-page request selects, as `FROM ... WHERE ...` over `targets t`
 * with its parameters: the workspace's contacts, narrowed by `list_id`, `search` and the
 * filter bar. The caller adds what to select, the order and the paging.
 */
export function contactsQuery(query: Query, workspaceId: string): { from: string; where: string; params: unknown[] } {
  const listId = typeof query.list_id === "string" && query.list_id ? query.list_id : null;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (listId) { clauses.push("lt.list_id = ?"); params.push(listId); }
  clauses.push("t.workspace_id = ?");
  params.push(workspaceId);
  if (typeof query.search === "string" && query.search.trim()) {
    const like = `%${query.search.trim()}%`;
    clauses.push("(t.full_name LIKE ? OR t.company LIKE ? OR t.title LIKE ?)");
    params.push(like, like, like);
  }
  const filters = filterClause(parseFilters(query), CONTACT_FILTER_COLUMNS, true);
  return {
    // All contacts unless a list is named, including ones in no list at all.
    from: listId ? "FROM targets t JOIN list_targets lt ON lt.target_id = t.id" : "FROM targets t",
    where: `WHERE ${clauses.join(" AND ")}${filters.sql}`,
    params: [...params, ...filters.params],
  };
}
