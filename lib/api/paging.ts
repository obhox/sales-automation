import type { NextApiRequest } from "next";

// The paging convention for list endpoints added during the rebuild:
//   request   ?page=1&limit=25      (pages are 1-based)
//   response  { items, total, page, limit }
// Rows are filtered, sorted and cut on the server. API handlers share a thread
// with the campaign runner, so no list endpoint returns an unbounded result.

export interface Paging {
  page: number;
  limit: number;
  offset: number;
}

export interface Paged<Row> {
  items: Row[];
  total: number;
  page: number;
  limit: number;
}

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function positiveInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Read `page` and `limit` from a query. Anything missing or malformed falls back to the default; `limit` is capped. */
export function parsePaging(query: NextApiRequest["query"], options: { defaultLimit?: number; maxLimit?: number } = {}): Paging {
  const maxLimit = options.maxLimit ?? 200;
  const defaultLimit = Math.min(options.defaultLimit ?? 25, maxLimit);
  const page = positiveInt(first(query.page)) ?? 1;
  const limit = Math.min(positiveInt(first(query.limit)) ?? defaultLimit, maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}

export function paged<Row>(items: Row[], total: number, paging: Paging): Paged<Row> {
  return { items, total, page: paging.page, limit: paging.limit };
}

export interface SortSpec {
  key: string;
  direction: "asc" | "desc";
}

/**
 * Read `sort=key:direction` and turn it into an ORDER BY fragment. Only keys in
 * `columns` are accepted (the value is the SQL expression to sort by), so the
 * query string never reaches the SQL text.
 */
export function parseSort(query: NextApiRequest["query"], columns: Record<string, string>, fallback: SortSpec): { sort: SortSpec; orderBy: string } {
  const [rawKey, rawDirection] = (first(query.sort) ?? "").split(":");
  const known = Object.prototype.hasOwnProperty.call(columns, rawKey);
  const sort: SortSpec = known ? { key: rawKey, direction: rawDirection === "asc" ? "asc" : rawDirection === "desc" ? "desc" : fallback.direction } : fallback;
  const expression = columns[sort.key];
  if (!expression) throw new Error(`parseSort: the fallback key "${fallback.key}" is not in the column map`);
  return { sort, orderBy: `${expression} ${sort.direction === "asc" ? "ASC" : "DESC"}` };
}
