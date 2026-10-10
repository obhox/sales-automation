import { useEffect, useRef, useState } from "react";
import { ArrowUpDown, ChevronLeft, ChevronRight, Inbox, Lock, Search, X } from "lucide-react";
import { Avatar, ChannelBadge, EmptyState, ErrorState, IconButton, Menu, MenuCheckItem, Pill, SearchInput, Segmented, Skeleton, initialsOf } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatAge, formatCount, plural } from "@/lib/client/format";
import { SORTS, dueLabel, statusOf, verdictOf, type ConversationItem, type ConversationsResponse } from "./model";

type View = "all" | "unread" | "mine";

function Row({ item, selected, onSelect }: { item: ConversationItem; selected: boolean; onSelect: () => void }) {
  const verdict = verdictOf(item.verdict);
  const due = dueLabel(item.sla_due_at, item.status);
  const sub = [item.title, item.company].filter(Boolean).join(" · ") || item.email || "";
  return (
    <button
      type="button" role="option" aria-selected={selected} data-conversation={item.id} onClick={onSelect}
      className={cn(
        "flex w-full shrink-0 flex-col gap-[5px] border-b border-line px-[11px] py-[9px] text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
        selected ? "bg-brand-tint" : "hover:bg-subtle",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-[7px]">
          <span className={cn("size-1.5 shrink-0 rounded-full", item.unread ? "bg-brand" : "bg-transparent")} aria-hidden="true" />
          {item.last_message_channel ? <ChannelBadge channel={item.last_message_channel} size={18} className="rounded-[5px]" /> : null}
          <span className={cn("truncate text-125 tracking-[-0.1px] text-ink", item.unread ? "font-semibold" : "font-medium")}>{item.name}</span>
          {item.unread ? <span className="sr-only">Unread</span> : null}
        </span>
        <span className="shrink-0 text-105 text-ink-3">{formatAge(item.last_message_at)}</span>
      </span>
      {sub ? <span className="w-full truncate text-11 text-ink-2">{sub}</span> : null}
      <span className="line-clamp-2 min-h-[28px] w-full text-11 leading-[14px] text-ink-3">
        {item.last_message_direction === "out" ? <span className="font-medium text-ink-2">You: </span> : null}
        {item.last_message_preview ?? (item.last_message_channel === "linkedin" ? "Replied on LinkedIn. The message was not stored." : "Replied. The message was not stored.")}
      </span>
      <span className="flex w-full items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Pill tone={verdict.tone} className="h-[18px] px-[7px] text-10">{verdict.label}</Pill>
          {item.status !== "open" ? <Pill tone="neutral" className="h-[18px] px-[7px] text-10">{statusOf(item.status).label}</Pill> : null}
          {item.detached ? <Pill tone="warn" className="h-[18px] px-[7px] text-10">No contact</Pill> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {due?.overdue ? <span className="text-10 font-semibold text-bad">{due.text}</span> : null}
          {item.lock ? (
            <Pill tone="warn" icon={Lock} className="h-[18px] gap-[3px] px-1.5 text-10">{initialsOf(item.lock.name)} replying</Pill>
          ) : item.assignee ? (
            <span title={`Assigned to ${item.assignee.name}`}><Avatar name={item.assignee.name} size={18} tint="bg-brand-tint" className="text-brand-strong" /><span className="sr-only">Assigned to {item.assignee.name}</span></span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/**
 * The middle column: the conversations that match, newest first, a page at a time.
 * Arrow keys (or J and K) move through it and open each one as they go.
 */
export function ConversationList({
  data, error, loading, selectedId, view, search, sort, page, filtered, onView, onSearch, onSort, onPage, onSelect, onRetry, onReset,
}: {
  data: ConversationsResponse | undefined;
  error: Error | undefined;
  loading: boolean;
  selectedId: string | null;
  view: View;
  search: string;
  sort: string;
  page: number;
  /** Whether any filter or search is narrowing the list (changes what "nothing here" says). */
  filtered: boolean;
  onView: (view: View) => void;
  onSearch: (value: string) => void;
  onSort: (sort: string) => void;
  onPage: (page: number) => void;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onReset: () => void;
}) {
  const [searching, setSearching] = useState(search !== "");
  const [draft, setDraft] = useState(search);
  const listRef = useRef<HTMLDivElement>(null);
  const items = data?.conversations ?? [];

  // The box is typed into freely; the list is only asked again once typing has paused.
  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => onSearch(draft), 300);
    return () => clearTimeout(timer);
  }, [draft, search, onSearch]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (!step || items.length === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const at = items.findIndex((item) => item.id === selectedId);
    const next = items[Math.max(0, Math.min(items.length - 1, at === -1 ? 0 : at + step))];
    onSelect(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-conversation="${next.id}"]`)?.focus();
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.per)) : 1;
  const first = data ? (data.page - 1) * data.per + 1 : 0;

  return (
    <section className="flex h-full w-[352px] shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-card" aria-label="Conversations">
      <div className="flex h-[43px] shrink-0 items-center justify-between gap-2 border-b border-line px-[11px]">
        <Segmented
          label="Which conversations" size="sm" value={view} onChange={onView} className="h-[26px] rounded-md"
          options={[{ value: "all", label: "All" }, { value: "unread", label: "Unread", count: data?.facets.unread || undefined }, { value: "mine", label: "Mine", count: data?.facets.mine || undefined }]}
        />
        <div className="flex shrink-0 items-center gap-1">
          <span className="mr-1 text-105 text-ink-3" aria-live="polite">{data ? `${formatCount(data.total)} ${plural(data.total, "thread", "threads")}` : ""}</span>
          <IconButton icon={searching ? X : Search} label={searching ? "Close search" : "Search conversations"} size={24} onClick={() => { if (searching) { setDraft(""); onSearch(""); } setSearching(!searching); }} />
          <Menu trigger={<IconButton icon={ArrowUpDown} label="Sort" size={24} />} width={210}>
            {SORTS.map((option) => <MenuCheckItem key={option.value} checked={sort === option.value} onChange={() => onSort(option.value)}>{option.label}</MenuCheckItem>)}
          </Menu>
        </div>
      </div>
      {searching ? (
        <div className="shrink-0 border-b border-line p-2">
          <SearchInput value={draft} onChange={setDraft} placeholder="Name, company, email or words" aria-label="Search conversations" autoFocus frameClassName="h-7" />
        </div>
      ) : null}

      <div ref={listRef} role="listbox" aria-label="Conversations" tabIndex={-1} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && !data ? (
          <ErrorState message={error.message} onRetry={onRetry} />
        ) : loading && !data ? (
          <div className="flex flex-col" aria-busy="true" aria-label="Loading conversations">
            {Array.from({ length: 7 }, (_, index) => (
              <div key={index} className="flex flex-col gap-2 border-b border-line px-[11px] py-[11px]">
                <Skeleton className="h-3.5 w-2/5" /><Skeleton className="h-3 w-3/5" /><Skeleton className="h-3 w-full" /><Skeleton className="h-[18px] w-16 rounded-full" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState icon={Search} title="Nothing matches" action={<button type="button" onClick={onReset} className="text-11 font-semibold text-brand-strong hover:underline">Clear the filters</button>}>
              No conversation fits these filters.
            </EmptyState>
          ) : (
            <EmptyState icon={Inbox} title="No replies yet">
              When a contact answers a campaign email or LinkedIn message, the conversation appears here.
            </EmptyState>
          )
        ) : (
          items.map((item) => <Row key={item.id} item={item} selected={item.id === selectedId} onSelect={() => onSelect(item.id)} />)
        )}
      </div>

      {data && data.total > data.per ? (
        <div className="flex h-9 shrink-0 items-center justify-between border-t border-line px-[11px]">
          <span className="text-105 text-ink-3">{formatCount(first)}–{formatCount(Math.min(data.total, first + items.length - 1))} of {formatCount(data.total)}</span>
          <span className="flex items-center gap-1">
            <IconButton icon={ChevronLeft} label="Newer conversations" size={24} disabled={page <= 1} onClick={() => onPage(page - 1)} />
            <IconButton icon={ChevronRight} label="Older conversations" size={24} disabled={page >= pages} onClick={() => onPage(page + 1)} />
          </span>
        </div>
      ) : null}
    </section>
  );
}
