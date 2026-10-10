import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/client/cn";
import { Checkbox } from "./Checkbox";
import { EmptyState, ErrorState, Skeleton } from "./States";

export interface Column<Row> {
  key: string;
  header: ReactNode;
  /** Fixed width in px. Leave out on the one column that should take the remaining space. */
  width?: number;
  align?: "left" | "right";
  /** Passed back through `onSortChange` when the header is clicked. */
  sortKey?: string;
  cell: (row: Row) => ReactNode;
}

export interface Sort {
  key: string;
  direction: "asc" | "desc";
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[] | undefined;
  rowKey: (row: Row) => string;
  /** Names the table for screen readers. */
  label: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  empty?: ReactNode;
  /** Pass both to get the checkbox column. */
  selected?: Set<string>;
  onSelectedChange?: (selected: Set<string>) => void;
  sort?: Sort;
  onSortChange?: (sort: Sort) => void;
  onRowClick?: (row: Row) => void;
  /** "comfortable" is the 52px row of the design; "compact" is 40px. */
  density?: "comfortable" | "compact";
  footer?: ReactNode;
  className?: string;
}

/**
 * The table every list screen uses: fixed column widths with one flexible
 * column, optional selection and sorting, and loading, empty and error states
 * built in. Rows come already filtered, sorted and paged from the server.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  label,
  loading,
  error,
  onRetry,
  empty,
  selected,
  onSelectedChange,
  sort,
  onSortChange,
  onRowClick,
  density = "comfortable",
  footer,
  className,
}: DataTableProps<Row>) {
  const selectable = selected !== undefined && onSelectedChange !== undefined;
  const ids = (rows ?? []).map(rowKey);
  const chosenHere = selectable ? ids.filter(id => selected.has(id)).length : 0;
  const headState: boolean | "indeterminate" = chosenHere === 0 ? false : chosenHere === ids.length ? true : "indeterminate";
  const rowHeight = density === "comfortable" ? "h-[52px]" : "h-10";
  const span = columns.length + (selectable ? 1 : 0);

  const toggleAll = (checked: boolean) => {
    if (!selectable) return;
    const next = new Set(selected);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    onSelectedChange(next);
  };
  const toggleOne = (id: string, checked: boolean) => {
    if (!selectable) return;
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedChange(next);
  };

  return (
    <div className={cn("overflow-hidden rounded-lg border border-line bg-surface shadow-card", className)}>
      <div className="overflow-x-auto">
        <table aria-label={label} aria-busy={loading || undefined} className="w-full table-fixed border-collapse text-left">
          <colgroup>
            {selectable ? <col style={{ width: 41 }} /> : null}
            {columns.map(column => (
              <col key={column.key} style={column.width ? { width: column.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr className="h-[34px] border-b border-line bg-subtle">
              {selectable ? (
                <th scope="col" className="pl-3.5">
                  <Checkbox checked={headState} onChange={toggleAll} label="Select all rows on this page" disabled={ids.length === 0} />
                </th>
              ) : null}
              {columns.map((column, index) => {
                const active = column.sortKey !== undefined && sort?.key === column.sortKey;
                const Arrow = active && sort?.direction === "asc" ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (sort?.direction === "asc" ? "ascending" : "descending") : undefined}
                    className={cn(
                      "whitespace-nowrap px-1.5 text-10 font-semibold uppercase tracking-label text-ink-3",
                      index === 0 && !selectable && "pl-3.5",
                      index === columns.length - 1 && "pr-3.5",
                      column.align === "right" && "text-right",
                    )}
                  >
                    {column.sortKey && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => onSortChange({ key: column.sortKey!, direction: active && sort?.direction === "desc" ? "asc" : "desc" })}
                        className={cn("inline-flex items-center gap-1 uppercase tracking-label hover:text-ink", active && "text-ink-2")}
                      >
                        {column.header}
                        <Arrow size={11} className={active ? undefined : "opacity-0"} aria-hidden="true" />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={span}>
                  <ErrorState message={error} onRetry={onRetry} />
                </td>
              </tr>
            ) : rows === undefined || (loading && rows.length === 0) ? (
              Array.from({ length: 6 }, (_, index) => (
                <tr key={index} className={cn("border-b border-line last:border-b-0", rowHeight)}>
                  <td colSpan={span} className="px-3.5">
                    <Skeleton className="h-3.5 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={span}>{empty ?? <EmptyState title="Nothing here yet" />}</td>
              </tr>
            ) : (
              rows.map(row => {
                const id = rowKey(row);
                const isSelected = selectable && selected.has(id);
                return (
                  <tr
                    key={id}
                    data-selected={isSelected || undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      "border-b border-line transition-colors last:border-b-0",
                      rowHeight,
                      isSelected ? "bg-brand-tint" : "hover:bg-subtle/70",
                      onRowClick && "cursor-pointer",
                    )}
                  >
                    {selectable ? (
                      <td className="pl-3.5" onClick={event => event.stopPropagation()}>
                        <Checkbox checked={isSelected} onChange={checked => toggleOne(id, checked)} label="Select row" />
                      </td>
                    ) : null}
                    {columns.map((column, index) => (
                      <td
                        key={column.key}
                        className={cn(
                          "truncate px-1.5 text-125 text-ink",
                          index === 0 && !selectable && "pl-3.5",
                          index === columns.length - 1 && "pr-3.5",
                          column.align === "right" && "text-right",
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {footer ? <div className="flex min-h-10 items-center justify-between gap-3 border-t border-line bg-subtle px-3.5 py-2 text-11 text-ink-3">{footer}</div> : null}
    </div>
  );
}

/** Two-line cell: a strong first line and a quiet second one. */
export function CellStack({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-125 font-semibold tracking-snug text-ink">{title}</span>
      {sub ? <span className="truncate text-105 text-ink-3">{sub}</span> : null}
    </div>
  );
}

const PAGE_BUTTON = "inline-flex size-6 items-center justify-center rounded-md border text-11 font-semibold transition-colors disabled:opacity-40";

/** Page controls for a table footer. Pages are 1-based. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizes,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  pageSizes?: number[];
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = Math.max(1, Math.min(page - 1, pages - 2));
  const shown = Array.from({ length: Math.min(3, pages) }, (_, index) => first + index);
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {pageSizes && onPageSizeChange ? (
        <>
          <label className="flex items-center gap-1 text-11 text-ink-3">
            Rows per page:
            <select
              value={pageSize}
              onChange={event => onPageSizeChange(Number(event.target.value))}
              className="rounded-sm bg-transparent font-medium text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-brand-tint"
            >
              {pageSizes.map(size => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span className="h-3.5 w-px bg-line-strong" aria-hidden="true" />
        </>
      ) : null}
      <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className={cn(PAGE_BUTTON, "border-line-strong bg-surface text-ink-2 hover:bg-subtle")}>
        <ChevronLeft size={12} aria-hidden="true" />
      </button>
      {shown.map(number => (
        <button
          key={number}
          type="button"
          aria-label={`Page ${number}`}
          aria-current={number === page ? "page" : undefined}
          onClick={() => onPageChange(number)}
          className={cn(PAGE_BUTTON, number === page ? "border-brand bg-brand text-white" : "border-line-strong bg-surface text-ink-2 hover:bg-subtle")}
        >
          {number}
        </button>
      ))}
      <button type="button" aria-label="Next page" disabled={page >= pages} onClick={() => onPageChange(page + 1)} className={cn(PAGE_BUTTON, "border-line-strong bg-surface text-ink-2 hover:bg-subtle")}>
        <ChevronRight size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The brand-tinted strip that appears above a table while rows are selected. */
export function BulkBar({
  count,
  noun,
  onClear,
  extra,
  children,
}: {
  count: number;
  /** Singular and plural, e.g. ["campaign", "campaigns"]. */
  noun: [string, string];
  onClear: () => void;
  /** Sits after the count ("Select all 148 matching"). */
  extra?: ReactNode;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div role="region" aria-label="Selection" className="flex min-h-9 items-center justify-between gap-3 rounded-lg border border-brand bg-brand-tint px-3 py-[5px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <Checkbox checked="indeterminate" onChange={onClear} label="Clear selection" />
        <span className="text-12 font-semibold text-brand-strong">
          {count.toLocaleString()} {count === 1 ? noun[0] : noun[1]} selected
        </span>
        {extra}
        <span className="h-4 w-px bg-brand/35" aria-hidden="true" />
        <div className="flex flex-wrap items-center gap-1">{children}</div>
      </div>
      <button type="button" onClick={onClear} className="shrink-0 rounded-md px-1.5 text-115 font-semibold text-brand-strong hover:underline">
        Clear selection
      </button>
    </div>
  );
}
