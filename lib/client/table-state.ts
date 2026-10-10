import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import type { Query } from "./api";

// List screens keep their state (page, page size, sort, search and filters) in
// the address bar, so a filtered view can be linked, reloaded and saved as a
// view. Only values that differ from the defaults are written.

export interface TableSort {
  key: string;
  direction: "asc" | "desc";
}

export interface TableState<Filters extends Record<string, string>> {
  page: number;
  pageSize: number;
  sort: TableSort;
  search: string;
  filters: Filters;
}

export interface TableStateOptions<Filters extends Record<string, string>> {
  pageSize?: number;
  sort: TableSort;
  /** Every filter the screen has, with its "no filter" value (for example `{ status: "all" }`). */
  filters: Filters;
}

const RESERVED = new Set(["page", "per", "sort", "q"]);
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Read the state out of a parsed query string. Exported for tests. */
export function readTableState<Filters extends Record<string, string>>(query: Record<string, string | string[] | undefined>, options: TableStateOptions<Filters>): TableState<Filters> {
  const defaultPageSize = options.pageSize ?? 25;
  const page = Number(first(query.page));
  const pageSize = Number(first(query.per));
  const [sortKey, sortDirection] = (first(query.sort) ?? "").split(":");
  const filters = { ...options.filters };
  for (const key of Object.keys(options.filters) as (keyof Filters & string)[]) {
    const value = first(query[key]);
    if (value !== undefined && value !== "") filters[key] = value as Filters[typeof key];
  }
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 200 ? pageSize : defaultPageSize,
    sort: sortKey ? { key: sortKey, direction: sortDirection === "asc" ? "asc" : "desc" } : options.sort,
    search: first(query.q) ?? "",
    filters,
  };
}

/** Turn the state back into query-string entries, dropping whatever equals its default. Exported for tests. */
export function writeTableState<Filters extends Record<string, string>>(state: TableState<Filters>, options: TableStateOptions<Filters>): Record<string, string> {
  const out: Record<string, string> = {};
  if (state.page > 1) out.page = String(state.page);
  if (state.pageSize !== (options.pageSize ?? 25)) out.per = String(state.pageSize);
  if (state.sort.key !== options.sort.key || state.sort.direction !== options.sort.direction) out.sort = `${state.sort.key}:${state.sort.direction}`;
  if (state.search) out.q = state.search;
  for (const [key, value] of Object.entries(state.filters)) {
    if (RESERVED.has(key)) throw new Error(`"${key}" is reserved by the table state and cannot be a filter name`);
    if (value !== options.filters[key]) out[key] = value;
  }
  return out;
}

/**
 * Table state backed by the URL. `set` takes a partial change; changing
 * anything other than the page goes back to page 1. `apiQuery` is the same
 * state shaped for a list endpoint (`page`, `limit`, `sort`, `q` and the
 * filters that are not at their default).
 */
export function useTableState<Filters extends Record<string, string>>(options: TableStateOptions<Filters>) {
  const router = useRouter();
  // Options are written inline by callers; compare by value so a new object each render does not loop.
  const optionsKey = JSON.stringify(options);
  const stable = useMemo(() => options, [optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const state = useMemo(() => readTableState(router.query, stable), [router.query, stable]);

  const set = useCallback(
    (change: Partial<Omit<TableState<Filters>, "filters">> & { filters?: Partial<Filters> }) => {
      const next: TableState<Filters> = {
        ...state,
        ...change,
        filters: { ...state.filters, ...(change.filters ?? {}) } as Filters,
        page: change.page ?? (Object.keys(change).length > 0 ? 1 : state.page),
      };
      const owned = new Set([...RESERVED, ...Object.keys(stable.filters)]);
      const others = Object.fromEntries(Object.entries(router.query).filter(([key]) => !owned.has(key)));
      void router.replace({ pathname: router.pathname, query: { ...others, ...writeTableState(next, stable) } }, undefined, { shallow: true, scroll: false });
    },
    [router, state, stable],
  );

  const apiQuery: Query = useMemo(() => {
    const active = Object.fromEntries(Object.entries(state.filters).filter(([key, value]) => value !== stable.filters[key]));
    return { page: state.page, limit: state.pageSize, sort: `${state.sort.key}:${state.sort.direction}`, q: state.search || undefined, ...active };
  }, [state, stable]);

  const activeFilterCount = Object.entries(state.filters).filter(([key, value]) => value !== stable.filters[key]).length;

  return { ...state, set, apiQuery, activeFilterCount, ready: router.isReady };
}

/** The value, but only after it has stopped changing for `delay` ms. For search boxes. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
