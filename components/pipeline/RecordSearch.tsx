import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { IconButton, SearchInput, Spinner } from "@/components/ui";
import { api } from "@/lib/client/api";

export interface Picked { id: string; label: string }
interface Found { kind: string; id: string; title: string; subtitle: string | null }

/**
 * Choose one contact or one company by searching for it. A workspace can hold many
 * thousands, so they are searched for on the server rather than listed.
 */
export function RecordSearch({ kind, value, onChange, id, disabled }: { kind: "contact" | "company"; value: Picked | null; onChange: (picked: Picked | null) => void; id?: string; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Found[] | null>(null);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return;
    let stale = false;
    const timer = setTimeout(() => {
      api<{ results: Found[] }>("/api/search", { query: { q: text } })
        .then((found) => { if (!stale) setResults(found.results.filter((result) => result.kind === kind)); })
        .catch(() => { if (!stale) setResults([]); });
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [query, kind]);

  if (value) {
    return (
      <div className="flex h-8 items-center justify-between gap-2 rounded-md border border-line-strong bg-surface pl-2.5 pr-1">
        <span id={id} className="min-w-0 truncate text-12 text-ink">{value.label}</span>
        {disabled ? null : <IconButton icon={X} label={`Clear the ${kind}`} size={22} onClick={() => { onChange(null); setQuery(""); setResults(null); }} />}
      </div>
    );
  }
  const searching = query.trim().length >= 2;
  return (
    <div className="flex flex-col gap-1.5">
      <SearchInput id={id} aria-label={kind === "contact" ? "Contact" : "Company"} value={query} onChange={(next) => { setQuery(next); setResults(null); }} disabled={disabled} placeholder={kind === "contact" ? "Find a contact by name, email or company" : "Find a company by name"} />
      {searching && results === null ? <div className="flex items-center gap-2 text-11 text-ink-3"><Spinner size={12} />Searching…</div> : null}
      {searching && results && results.length === 0 ? <p className="text-11 text-ink-3">{kind === "contact" ? "No contact matches." : "No company matches."}</p> : null}
      {searching && results && results.length > 0 ? (
        <ul className="flex max-h-[168px] flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {results.map((result) => (
            <li key={result.id}>
              <button type="button" onClick={() => onChange({ id: result.id, label: result.title })} className="flex w-full min-w-0 flex-col px-2.5 py-1.5 text-left hover:bg-subtle focus-visible:bg-subtle focus-visible:outline-none">
                <span className="truncate text-12 font-medium text-ink">{result.title}</span>
                {result.subtitle ? <span className="truncate text-105 text-ink-3">{result.subtitle}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
