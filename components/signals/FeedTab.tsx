import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCheck, Ellipsis, Eye, EyeOff, Radar } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, EmptyState, ErrorState, IconButton, Menu, MenuItem, Pill, SearchInput, Segmented, Select, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, formatDateTime, formatRelative } from "@/lib/client/format";
import { recordHref } from "@/lib/client/nav";
import { useDebounced } from "@/lib/client/table-state";
import { PAGE_SIZE, SIGNALS_PATH, TYPE_TONE, aboutLine, pageLine, sourceLabel, typeLabel, typeOptions, type SignalFeed, type SignalRow } from "./model";

/** The signals, newest first: what happened, to whom, where it came from, and whether anyone has looked. */
export function FeedTab({ member, round, onChanged }: { member: boolean; /** Counts up when a signal was recorded, so the feed reads again. */ round: number; onChanged: () => void }) {
  const [state, setState] = useState<"all" | "new">("all");
  const [type, setType] = useState("all");
  const [source, setSource] = useState("all");
  const [text, setText] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useDebounced(text.trim(), 250);
  const [busy, setBusy] = useState(false);
  const { data, error, isLoading, mutate } = useApi<SignalFeed>(SIGNALS_PATH, {
    view: "feed", state: state === "new" ? "new" : undefined, type: type === "all" ? undefined : type, source: source === "all" ? undefined : source, q: q || undefined, limit: PAGE_SIZE, offset,
  });
  useEffect(() => { void mutate(); }, [round, mutate]);

  const filter = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setOffset(0); };
  // Asking only for what is new, with nothing else narrowed: an empty answer means caught up, not a search that missed.
  const onlyNew = state === "new" && type === "all" && source === "all" && q === "";

  async function mark(body: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api(SIGNALS_PATH, { method: "PATCH", body });
      toast.success(done);
      void mutate();
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<"all" | "new">
            label="Which signals" value={state} onChange={filter(setState)}
            options={[{ value: "all", label: "All", count: data ? formatCount(data.all_count) : undefined }, { value: "new", label: "New", count: data ? formatCount(data.new_count) : undefined }]}
          />
          {data ? <Select label="Kind" value={type} onChange={filter(setType)} options={typeOptions(data, type)} /> : null}
          {data && data.sources.length > 1 ? (
            <Select label="Source" value={source} onChange={filter(setSource)} options={[{ value: "all", label: "Every source" }, ...data.sources.map((item) => ({ value: item, label: sourceLabel(item) }))]} />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <SearchInput value={text} onChange={filter(setText)} placeholder="Search signals" frameClassName="w-[220px]" />
          {member && data && data.new_count > 0 ? (
            <Button icon={CheckCheck} loading={busy} onClick={() => void mark({ all: true }, `${formatCount(data.new_count)} ${data.new_count === 1 ? "signal" : "signals"} marked as seen`)}>Mark all as seen</Button>
          ) : null}
        </div>
      </div>

      <Card className="flex flex-col overflow-hidden">
        {error && !data ? (
          <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
        ) : isLoading && !data ? (
          <div aria-busy="true" aria-label="Loading signals" className="flex flex-col">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 border-t border-line px-3.5 py-3 first:border-t-0">
                <Skeleton className="h-5 w-[84px] rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5"><Skeleton className="h-3 w-[46%]" /><Skeleton className="h-2.5 w-[30%]" /></div>
                <Skeleton className="h-3 w-[70px]" />
              </div>
            ))}
          </div>
        ) : !data || data.signals.length === 0 ? (
          data && data.all_count === 0 ? (
            <EmptyState icon={Radar} title="No signals yet">
              A signal is something that makes now a good time to write: a new job, a funding round, a hiring push. Record one by hand, send them in through the API, or have watched accounts checked for you under Detection.
            </EmptyState>
          ) : onlyNew ? (
            <EmptyState icon={Radar} title="Nothing new" action={<Button onClick={() => setState("all")}>Show all signals</Button>}>Every signal has been seen.</EmptyState>
          ) : (
            <EmptyState icon={Radar} title="No signal matches">Nothing fits the kind, source and search chosen.</EmptyState>
          )
        ) : (
          <ul className="flex flex-col">
            {data.signals.map((signal) => <SignalItem key={signal.id} signal={signal} member={member} busy={busy} onMark={(seen) => void mark({ ids: [signal.id], seen }, seen ? "Marked as seen" : "Marked as new")} />)}
          </ul>
        )}
        {data && data.total > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle px-3.5 py-2">
            <span className="text-11 text-ink-3">{pageLine(data, offset, data.signals.length)}</span>
            <div className="flex items-center gap-1.5">
              <Button size="xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Newer</Button>
              <Button size="xs" disabled={offset + data.signals.length >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Older</Button>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}

function SignalItem({ signal, member, busy, onMark }: { signal: SignalRow; member: boolean; busy: boolean; onMark: (seen: boolean) => void }) {
  return (
    <li className={cn("flex items-start gap-3 border-t border-line px-3.5 py-3 first:border-t-0", !signal.seen && "bg-brand-tint/40")}>
      <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", signal.seen ? "bg-transparent" : "bg-brand")} aria-hidden="true" />
      <div className="w-[104px] shrink-0 pt-px"><Pill tone={TYPE_TONE[signal.type] ?? "neutral"}>{typeLabel(signal.type)}</Pill></div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className={cn("text-125 leading-[17px] text-ink", signal.seen ? "font-medium" : "font-semibold")}>
          {signal.title}
          {signal.seen ? null : <span className="sr-only"> (new)</span>}
        </p>
        {signal.description ? <p className="text-115 leading-[16px] text-ink-2">{signal.description}</p> : null}
        <p className="flex flex-wrap items-center gap-x-1.5 text-105 text-ink-3">
          {signal.contact ? <Link href={recordHref("contact", signal.contact.id)} className="font-medium text-ink-2 hover:text-brand-strong hover:underline">{signal.contact.name}</Link> : null}
          {signal.contact && signal.company ? <span aria-hidden="true">·</span> : null}
          {signal.company ? <Link href={recordHref("company", signal.company.id)} className="font-medium text-ink-2 hover:text-brand-strong hover:underline">{signal.company.name}</Link> : null}
          {!signal.contact && !signal.company ? <span>{aboutLine(signal)}</span> : null}
          <span aria-hidden="true">·</span>
          <span>{sourceLabel(signal.source)}</span>
          <span aria-hidden="true">·</span>
          <span>score {formatCount(signal.score)}</span>
        </p>
      </div>
      <span className="shrink-0 pt-0.5 text-11 text-ink-3" title={formatDateTime(signal.occurred_at)}>{formatRelative(signal.occurred_at)}</span>
      {member ? (
        <Menu trigger={<IconButton icon={Ellipsis} label={`Actions for ${signal.title}`} size={24} />}>
          {signal.seen
            ? <MenuItem icon={EyeOff} disabled={busy} onSelect={() => onMark(false)}>Mark as new</MenuItem>
            : <MenuItem icon={Eye} disabled={busy} onSelect={() => onMark(true)}>Mark as seen</MenuItem>}
        </Menu>
      ) : null}
    </li>
  );
}
