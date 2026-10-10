// Choosing a contact or a company by typing part of its name, for the places that used to
// ask for a pasted id.
import { useEffect, useId, useRef, useState } from "react";
import { RiCloseLine } from "react-icons/ri";

export interface PickedRecord { id: string; label: string; sub?: string }

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export async function searchContacts(query: string): Promise<PickedRecord[]> {
  const body = await getJson(`/api/targets?limit=8&search=${encodeURIComponent(query)}`);
  return ((body.contacts ?? []) as Array<{ id: string; full_name: string | null; title: string | null; company: string | null }>)
    .map((row) => ({ id: row.id, label: row.full_name || "Unnamed contact", sub: [row.title, row.company].filter(Boolean).join(" · ") || undefined }));
}

export async function searchCompanies(query: string): Promise<PickedRecord[]> {
  const body = await getJson(`/api/companies?limit=8&search=${encodeURIComponent(query)}`);
  return ((body.companies ?? []) as Array<{ id: string; name: string; domain: string | null }>)
    .map((row) => ({ id: row.id, label: row.name, sub: row.domain ?? undefined }));
}

interface Props {
  value: PickedRecord | null;
  onChange: (value: PickedRecord | null) => void;
  /** One of the search functions above. Must keep its identity between renders. */
  search: (query: string) => Promise<PickedRecord[]>;
  placeholder: string;
  /** Read out for the field, since it has no visible label of its own. */
  label: string;
  size?: "sm" | "md";
}

export default function RecordPicker({ value, onChange, search, placeholder, label, size = "md" }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PickedRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const latest = useRef(0);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    // Only the answer to the newest question is shown, whatever order they come back in.
    const mine = ++latest.current;
    const timer = setTimeout(() => {
      setSearching(true);
      search(query.trim())
        .then((found) => { if (mine === latest.current) { setResults(found); setActive(0); } })
        .catch(() => { if (mine === latest.current) setResults([]); })
        .finally(() => { if (mine === latest.current) setSearching(false); });
    }, 180);
    return () => clearTimeout(timer);
  }, [open, query, search]);

  function pick(record: PickedRecord) { onChange(record); setQuery(""); setOpen(false); }

  const height = size === "sm" ? "h-8 text-xs" : "h-10 text-sm";
  if (value) {
    return (
      <div className={`flex ${height} items-center gap-2 rounded-[10px] border border-[var(--border)] bg-base-100 pl-3 pr-1`}>
        <span className="min-w-0 flex-1 truncate text-base-content">{value.label}{value.sub && <span className="text-base-content/45"> · {value.sub}</span>}</span>
        <button type="button" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange(null)} className="rounded-md p-1 text-base-content/40 hover:bg-base-200 hover:text-base-content/70"><RiCloseLine size={14} /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input
        role="combobox" aria-label={label} aria-expanded={open} aria-controls={listId} aria-autocomplete="list" autoComplete="off"
        className={`w-full ${height} rounded-[10px] border border-[var(--border)] bg-base-100 px-3 text-base-content placeholder:text-base-content/35 focus:border-[var(--border-focus)] focus:outline-none`}
        placeholder={placeholder} value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); return; }
          if (!open || results.length === 0) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((n) => (n + 1) % results.length); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((n) => (n - 1 + results.length) % results.length); }
          else if (e.key === "Enter") { e.preventDefault(); pick(results[active]); }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-[10px] border border-[var(--border-subtle)] bg-base-100 py-1 shadow-[var(--shadow-popover)]">
          {results.length === 0 && <li className="px-3 py-2 text-xs text-base-content/40">{searching ? "Searching…" : query.trim() ? "Nothing matches" : "Type to search"}</li>}
          {results.map((record, index) => (
            <li
              key={record.id} role="option" aria-selected={index === active}
              // mousedown, not click: the input's blur would close the list before a click lands.
              onMouseDown={(e) => { e.preventDefault(); pick(record); }}
              onMouseEnter={() => setActive(index)}
              className={`cursor-pointer px-3 py-1.5 text-sm ${index === active ? "bg-base-200" : ""}`}
            >
              <div className="truncate text-base-content">{record.label}</div>
              {record.sub && <div className="truncate text-[11px] text-base-content/45">{record.sub}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
