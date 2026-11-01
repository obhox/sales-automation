import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { CheckCheck, Ellipsis, Eye, EyeOff, Radar } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, EmptyState, ErrorState, IconButton, Menu, MenuItem, Pill, SearchInput, Segmented, Select, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
import { formatRelativeByLocale, formatDateTimeByLocale } from "@/lib/client/localize-relative";
import { recordHref } from "@/lib/client/nav";
import { useDebounced } from "@/lib/client/table-state";
import { PAGE_SIZE, SIGNALS_PATH, TYPE_TONE, aboutLine, sourceLabel, typeLabel, typeOptions, type SignalFeed, type SignalRow } from "./model";

/** The signals, newest first: what happened, to whom, where it came from, and whether anyone has looked. */
export function FeedTab({ member, round, onChanged }: { member: boolean; /** Counts up when a signal was recorded, so the feed reads again. */ round: number; onChanged: () => void }) {
  const t = useTranslations("SignalsFeed");
  const displayType = (type: string) => {
    const keys: Record<string, "job" | "funding" | "hiring" | "tech" | "intent" | "custom"> = {
      job_change: "job", funding: "funding", hiring: "hiring",
      technology: "tech", product_intent: "intent", custom: "custom",
    };
    return keys[type] ? t(keys[type]) : typeLabel(type);
  };
  const displaySource = (source: string | null) => {
    const keys: Record<string, "manual" | "apollo" | "api" | "mcp" | "import"> = {
      manual: "manual", apollo: "apollo", api: "api", public_api: "api", mcp: "mcp", import: "import",
    };
    return source && keys[source] ? t(keys[source]) : source ? sourceLabel(source) : t("unknown");
  };
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
            label={t("filter")} value={state} onChange={filter(setState)}
            options={[{ value: "all", label: t("all"), count: data ? formatCount(data.all_count) : undefined }, { value: "new", label: t("new"), count: data ? formatCount(data.new_count) : undefined }]}
          />
          {data ? <Select label={t("kind")} value={type} onChange={filter(setType)} options={typeOptions(data, type).map((option) => ({
              ...option, label: option.value === "all" ? t("allKinds", {count: Object.values(data.by_type).reduce((sum, n) => sum+n, 0)})
                : t("typeCount", {name: displayType(option.value), count: data.by_type[option.value] ?? 0}),
            }))} /> : null}
          {data && data.sources.length > 1 ? (
            <Select label={t("source")} value={source} onChange={filter(setSource)} options={[{ value: "all", label: t("everySource") }, ...data.sources.map((item) => ({ value: item, label: displaySource(item) }))]} />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <SearchInput value={text} onChange={filter(setText)} placeholder={t("search")} frameClassName="w-[220px]" />
          {member && data && data.new_count > 0 ? (
            <Button icon={CheckCheck} loading={busy} onClick={() => void mark({ all: true }, t("markedCount", {count: data.new_count}))}>{t("markAll")}</Button>
          ) : null}
        </div>
      </div>

      <Card className="flex flex-col overflow-hidden">
        {error && !data ? (
          <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
        ) : isLoading && !data ? (
          <div aria-busy="true" aria-label={t("loading")} className="flex flex-col">
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
            <EmptyState icon={Radar} title={t("empty")}>
              {t("emptyHelp")}
            </EmptyState>
          ) : onlyNew ? (
            <EmptyState icon={Radar} title={t("nothingNew")} action={<Button onClick={() => setState("all")}>{t("showAll")}</Button>}>{t("seenAll")}</EmptyState>
          ) : (
            <EmptyState icon={Radar} title={t("noMatches")}>{t("noMatchesHelp")}</EmptyState>
          )
        ) : (
          <ul className="flex flex-col">
            {data.signals.map((signal) => <SignalItem key={signal.id} signal={signal} member={member} busy={busy} onMark={(seen) => void mark({ ids: [signal.id], seen }, seen ? t("seen") : t("unseen"))} />)}
          </ul>
        )}
        {data && data.total > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle px-3.5 py-2">
            <span className="text-11 text-ink-3">{t("page", {start: offset+1, end: offset+data.signals.length, total: data.total})}</span>
            <div className="flex items-center gap-1.5">
              <Button size="xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t("newer")}</Button>
              <Button size="xs" disabled={offset + data.signals.length >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>{t("older")}</Button>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}

function SignalItem({ signal, member, busy, onMark }: { signal: SignalRow; member: boolean; busy: boolean; onMark: (seen: boolean) => void }) {
  const t = useTranslations("SignalsFeed");
  const locale = useLocale();
  const displayType = (type: string) => {
    const keys: Record<string, "job" | "funding" | "hiring" | "tech" | "intent" | "custom"> = {
      job_change: "job", funding: "funding", hiring: "hiring",
      technology: "tech", product_intent: "intent", custom: "custom",
    };
    return keys[type] ? t(keys[type]) : typeLabel(type);
  };
  const displaySource = (source: string | null) => {
    const keys: Record<string, "manual" | "apollo" | "api" | "mcp" | "import"> = {
      manual: "manual", apollo: "apollo", api: "api", public_api: "api", mcp: "mcp", import: "import",
    };
    return source && keys[source] ? t(keys[source]) : source ? sourceLabel(source) : t("unknown");
  };
  return (
    <li className={cn("flex items-start gap-3 border-t border-line px-3.5 py-3 first:border-t-0", !signal.seen && "bg-brand-tint/40")}>
      <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", signal.seen ? "bg-transparent" : "bg-brand")} aria-hidden="true" />
      <div className="w-[104px] shrink-0 pt-px"><Pill tone={TYPE_TONE[signal.type] ?? "neutral"}>{displayType(signal.type)}</Pill></div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className={cn("text-125 leading-[17px] text-ink", signal.seen ? "font-medium" : "font-semibold")}>
          {signal.title}
          {signal.seen ? null : <span className="sr-only">{t("newSr")}</span>}
        </p>
        {signal.description ? <p className="text-115 leading-[16px] text-ink-2">{signal.description}</p> : null}
        <p className="flex flex-wrap items-center gap-x-1.5 text-105 text-ink-3">
          {signal.contact ? <Link href={recordHref("contact", signal.contact.id)} className="font-medium text-ink-2 hover:text-brand-strong hover:underline">{signal.contact.name}</Link> : null}
          {signal.contact && signal.company ? <span aria-hidden="true">·</span> : null}
          {signal.company ? <Link href={recordHref("company", signal.company.id)} className="font-medium text-ink-2 hover:text-brand-strong hover:underline">{signal.company.name}</Link> : null}
          {!signal.contact && !signal.company ? <span>{aboutLine(signal)}</span> : null}
          <span aria-hidden="true">·</span>
          <span>{displaySource(signal.source)}</span>
          <span aria-hidden="true">·</span>
          <span>{t("score", {count: formatCount(signal.score)})}</span>
        </p>
      </div>
      <span className="shrink-0 pt-0.5 text-11 text-ink-3" title={formatDateTimeByLocale(signal.occurred_at, locale)}>{formatRelativeByLocale(signal.occurred_at, locale)}</span>
      {member ? (
        <Menu trigger={<IconButton icon={Ellipsis} label={t("actions", {name: signal.title})} size={24} />}>
          {signal.seen
            ? <MenuItem icon={EyeOff} disabled={busy} onSelect={() => onMark(false)}>{t("markNew")}</MenuItem>
            : <MenuItem icon={Eye} disabled={busy} onSelect={() => onMark(true)}>{t("markSeen")}</MenuItem>}
        </Menu>
      ) : null}
    </li>
  );
}
