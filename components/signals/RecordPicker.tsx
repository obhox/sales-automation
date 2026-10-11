import { useState } from "react";
import { Building2, UserRound, X } from "lucide-react";
import { SearchInput, Spinner } from "@/components/ui";
import { useApi } from "@/lib/client/data";
import { useDebounced } from "@/lib/client/table-state";
import type { SearchResult } from "@/pages/api/search";

export interface Picked { kind: "contact" | "company"; id: string; name: string }

/**
 * Find a contact or a company by name and choose one. Uses the search behind the command
 * palette, keeping only the kinds asked for.
 */
export function RecordPicker({ kinds, value, onChange, placeholder, invalid, exclude }: {
  kinds: Array<"contact" | "company">;
  value: Picked | null;
  onChange: (value: Picked | null) => void;
  placeholder: string;
  invalid?: boolean;
  /** Ids not to offer (already chosen elsewhere). */
  exclude?: Set<string>;
}) {
  const [text, setText] = useState("");
  const query = useDebounced(text.trim(), 200);
  const { data, isLoading } = useApi<{ results: SearchResult[] }>(query.length >= 2 ? "/api/search" : null, { q: query }, { keepPreviousData: false });
  const results = (data?.results ?? []).filter((result) => (kinds as string[]).includes(result.kind) && !exclude?.has(result.id));

  if (value) {
    const Glyph = value.kind === "contact" ? UserRound : Building2;
    return (
      <div className="flex h-8 items-center justify-between gap-2 rounded-md border border-line-strong bg-subtle pl-2.5 pr-1">
        <span className="flex min-w-0 items-center gap-2 text-12 font-medium text-ink">
          <Glyph size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
          <span className="truncate">{value.name}</span>
        </span>
        <button type="button" aria-label={`Clear ${value.name}`} onClick={() => onChange(null)} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-control hover:text-ink">
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <SearchInput value={text} onChange={setText} placeholder={placeholder} aria-invalid={invalid || undefined} frameClassName={invalid ? "border-bad" : undefined} />
      {query.length >= 2 ? (
        <div role="listbox" aria-label="Matches" className="flex max-h-[168px] flex-col gap-px overflow-y-auto rounded-md border border-line p-1">
          {isLoading && !data ? (
            <span className="flex items-center gap-2 px-2 py-1.5 text-115 text-ink-3"><Spinner size={12} />Searching…</span>
          ) : results.length === 0 ? (
            <span className="px-2 py-1.5 text-115 text-ink-3">Nothing matches “{query}”.</span>
          ) : results.map((result) => {
            const Glyph = result.kind === "contact" ? UserRound : Building2;
            return (
              <button
                key={`${result.kind}:${result.id}`} type="button" role="option" aria-selected="false"
                onClick={() => { onChange({ kind: result.kind as "contact" | "company", id: result.id, name: result.title }); setText(""); }}
                className="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-brand-tint focus-visible:bg-brand-tint"
              >
                <Glyph size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
                <span className="truncate text-115 font-medium text-ink">{result.title}</span>
                {result.subtitle ? <span className="truncate text-105 text-ink-3">{result.subtitle}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
