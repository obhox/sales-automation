import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDownUp, Download, Ellipsis, ListFilter, RotateCcw, ScrollText, Trash2, UserMinus, UserPlus, UserRound } from "lucide-react";
import { toast } from "sonner";
import { CampaignFrame } from "@/components/campaigns/CampaignFrame";
import {
  BulkBar, Button, CellStack, ChannelBadge, DataTable, Drawer, EmptyState, ErrorState, IconButton, Menu, MenuItem, MenuSeparator, Pagination, Pill, SearchInput, Segmented, Select,
  Skeleton, Tooltip, confirm, type Column,
} from "@/components/ui";
import { api, apiUrl, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatDate, formatDateTime } from "@/lib/client/format";
import { formatDateTimeByLocale, formatRelativeByLocale } from "@/lib/client/localize-relative";
import { useCan } from "@/lib/client/roles";
import { useDebounced, useTableState } from "@/lib/client/table-state";
import type { LogEntry } from "@/lib/campaigns/prospects";
import type { CampaignSummary } from "../model";
import { AddProspectsDialog } from "./Dialogs";
import {
  PROSPECT_SORT_OPTIONS, STATUS_HELP, STATUS_LABEL, STATUS_TONE, actionOutcome, defaultSortDirection, placeLine, prospectTabs, stepLabel,
  type ActionResult, type ProspectAction, type ProspectRow, type ProspectSort, type ProspectsPage, type StatusTab, type TrackPlace,
} from "./model";

const FILTERS = { status: "all", step_id: "all", run_id: "all" };
const ANY = "all";

/** One channel's place in a table cell: the channel's mark, then where the prospect is on it. */
function Place({ channel, place }: { channel: "linkedin" | "email"; place: TrackPlace | null }) {
  const t = useTranslations("CampaignProspects");
  const locale = useLocale();
  if (!place) return <span className="text-115 text-ink-3">—</span>;
  const stopped = place.state === "failed";
  const waiting = place.next_step_at && (place.state === "in_progress" || place.state === "pending") && !place.hold;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ChannelBadge channel={channel} size={18} />
      <span className="flex min-w-0 flex-col">
        <span className={cn("truncate text-115", stopped ? "text-bad" : place.state === "completed" || place.state === "skipped" ? "text-ink-2" : "text-ink")}>{locale === "pt-BR" ? place.state === "completed" ? t("finished")
        : place.state === "failed" ? t("failed") + (place.note ? " · " + place.note : "")
        : place.state === "skipped" ? place.note ?? t("skipped")
        : place.hold === "handover" ? t("handover")
        : t("stepLine", {position: place.position, total: place.of,
            type: place.step_type === "visit" ? t("profileVisit") : place.step_type === "connect" ? t("connectionRequest")
              : place.step_type === "message" ? t("linkedinMessage") : place.step_type === "email" ? t("emailStep")
              : place.step_type === "delay" ? t("wait") : place.step_type ?? t("nextStep")}) + (place.hold === "other_campaign" ? " · " + t("held") : "")
      : placeLine(place)}</span>
        {waiting ? <span className="truncate text-105 text-ink-3" title={formatDateTimeByLocale(place.next_step_at, locale)}>{t("dueRelative", {relative: formatRelativeByLocale(place.next_step_at, locale)})}</span> : null}
      </span>
    </span>
  );
}

/** What the campaign has done, newest first, in a panel beside the table. */
function RunLog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("CampaignProspects");
  const locale = useLocale();
  const [level, setLevel] = useState<"all" | "warn" | "error">("all");
  const [older, setOlder] = useState<LogEntry[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const first = useApi<{ entries: LogEntry[]; more: boolean }>(open ? `/api/workflows/${id}/log` : null, { limit: 50, level: level === "all" ? undefined : level });
  const entries = [...(first.data?.entries ?? []), ...older];
  const hasMore = more ?? first.data?.more ?? false;

  function changeLevel(next: "all" | "warn" | "error") {
    setLevel(next);
    setOlder([]);
    setMore(null);
  }

  async function loadMore() {
    const last = entries.at(-1);
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<{ entries: LogEntry[]; more: boolean }>(`/api/workflows/${id}/log`, { query: { limit: 50, before: last.id, level: level === "all" ? undefined : level } });
      setOlder([...older, ...page.entries]);
      setMore(page.more);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t("logTitle")} description={t("logDescription")} icon={ScrollText} width={480}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Segmented size="sm" label={t("show")} value={level} onChange={changeLevel} options={[{ value: "all", label: t("all") }, { value: "warn", label: t("warnings") }, { value: "error", label: t("errors") }]} />
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => { setOlder([]); setMore(null); void first.mutate(); }}>{t("refresh")}</Button>
        </div>
        {first.error && !first.data ? (
          <ErrorState message={errorMessage(first.error)} onRetry={() => void first.mutate()} />
        ) : !first.data ? (
          <div className="flex flex-col gap-2">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-9 w-full" />)}</div>
        ) : entries.length === 0 ? (
          <EmptyState icon={ScrollText} title={level === "all" ? t("noneLogged") : t("noneAtLevel")}>
            {level === "all" ? t("logEmpty") : t("noWarnings")}
          </EmptyState>
        ) : (
          <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-start gap-2.5 px-3 py-2">
                <span className={cn("mt-[5px] size-[7px] shrink-0 rounded-full", entry.level === "error" ? "bg-bad" : entry.level === "warn" ? "bg-warn" : "bg-line-strong")} aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="break-words text-115 leading-[17px] text-ink">
                    {entry.level !== "info" ? <span className="sr-only">{entry.level === "error" ? t("errorPrefix") : t("warningPrefix")}</span> : null}
                    {entry.message}
                  </span>
                  <span className="text-105 text-ink-3">
                    {entry.contact && entry.target_id ? <><Link href={`/contacts/${entry.target_id}`} className="font-medium text-ink-2 hover:underline">{entry.contact}</Link> · </> : null}
                    <span title={formatDateTimeByLocale(entry.created_at, locale)}>{formatRelativeByLocale(entry.created_at, locale)}</span>
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        {entries.length > 0 && hasMore ? <Button variant="secondary" loading={loadingMore} onClick={loadMore} className="self-center">{t("older")}</Button> : null}
      </div>
    </Drawer>
  );
}

/** A campaign's Prospects tab: everyone it enrolled, where each of them is, and what can be done about them. */
export function ProspectsScreen() {
  const t = useTranslations("CampaignProspects");
  const locale = useLocale();
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const can = { manager: useCan("manager") };
  const table = useTableState({ pageSize: 25, sort: { key: "status", direction: "asc" }, filters: FILTERS });
  const [search, setSearch] = useState<string | null>(null);
  const typed = search ?? table.search;
  const settledSearch = useDebounced(typed);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    if (table.ready && search !== null && settledSearch === search && settledSearch !== table.search) table.set({ search: settledSearch });
  }, [settledSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, error, isLoading, mutate } = useApi<ProspectsPage & { campaign: CampaignSummary }>(id && table.ready ? `/api/workflows/${id}/prospects` : null, table.apiQuery, { keepPreviousData: true });
  const campaign = data?.campaign;
  const rows = data?.prospects;
  const byId = new Map((rows ?? []).map((row) => [row.id, row]));
  const chosen = [...selected].filter((rowId) => byId.has(rowId));
  const status = table.filters.status as StatusTab;
  const filtered = table.search !== "" || table.activeFilterCount > 0;
  const archived = campaign?.status === "archived";

  function clearFilters() {
    setSearch("");
    table.set({ search: "", filters: FILTERS });
  }

  async function act(action: ProspectAction, ids: string[]) {
    if (!id || ids.length === 0 || working) return;
    const people = ids.length === 1 ? byId.get(ids[0])?.full_name ?? t("thisProspect") : t("manyProspects", {count: ids.length});
    if (action !== "retry") {
      const ok = await confirm(action === "unenroll" ? {
        title: t("unenrolTitle", {people}),
        body: t("unenrolBody"),
        confirmLabel: t("unenrol"),
        tone: "danger",
      } : {
        title: t("removeTitle", {people}),
        body: t("removeBody"),
        confirmLabel: t("remove"),
        tone: "danger",
      });
      if (!ok) return;
    }
    setWorking(true);
    try {
      const result = await api<ActionResult>(`/api/workflows/${id}/prospects`, { method: "POST", body: { action, ids } });
      const outcome = actionOutcome(action, result);
      const unchanged = result.asked - result.changed;
      const actionKey = action === "retry" ? "retried" : action === "unenroll" ? "unenrolled" : "removed";
      const reasonKey = action === "retry" ? "retryUntouched" : action === "unenroll" ? "unenrollUntouched" : "removeUntouched";
      const message = locale === "pt-BR"
        ? result.changed === 0 ? t(action === "retry" ? "noneRetry" : action === "unenroll" ? "noneUnenroll" : "noneRemove")
          : t(actionKey, {count: result.changed})
            + (action === "retry" && result.waiting ? " " + t("retryWaiting") : "")
            + (unchanged ? " " + t(reasonKey, {count: unchanged}) : "")
        : outcome.message;
      if (outcome.tone === "success") toast.success(message);
      else toast.message(message);
      setSelected(new Set());
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(false);
      void mutate();
    }
  }

  const statusLabels: Record<string, string> = {
    active: t("status_active"), held: t("status_held"), failed: t("status_failed"),
    replied: t("status_replied"), completed: t("status_completed"), skipped: t("status_skipped"),
  };
  const statusHelp: Record<string, string> = {
    active: t("help_active"), held: t("help_held"), failed: t("help_failed"),
    replied: t("help_replied"), completed: t("help_completed"), skipped: t("help_skipped"),
  };
  const columns: Column<ProspectRow>[] = [
    {
      key: "name", header: t("prospect"), sortKey: "name",
      cell: (row) => (
        <CellStack
          title={<Link href={`/contacts/${row.target_id}`} onClick={(event) => event.stopPropagation()} className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-tint">{row.full_name}</Link>}
          sub={[row.title, row.company].filter(Boolean).join(" · ") || row.email || undefined}
        />
      ),
    },
    {
      key: "status", header: t("status"), width: 108, sortKey: "status",
      cell: (row) => <Tooltip label={statusHelp[row.status] ?? STATUS_HELP[row.status]}><span><Pill tone={STATUS_TONE[row.status]} dot={row.status === "active"}>{statusLabels[row.status] ?? STATUS_LABEL[row.status]}</Pill></span></Tooltip>,
    },
    { key: "linkedin", header: "LinkedIn", width: 232, cell: (row) => <Place channel="linkedin" place={row.linkedin} /> },
    { key: "email", header: t("emailColumn"), width: 232, cell: (row) => <Place channel="email" place={row.email_track} /> },
    {
      key: "sender", header: t("sentFrom"), width: 170,
      cell: (row) => <CellStack title={<span className="font-normal text-ink-2">{row.linkedin_account ?? row.mailbox ?? "—"}</span>} sub={row.linkedin_account && row.mailbox ? row.mailbox : undefined} />,
    },
    {
      key: "enrolled", header: t("enrolled"), width: 104, sortKey: "enrolled",
      cell: (row) => <span className="text-115 text-ink-2" title={formatDateTime(row.enrolled_at)}>{formatDate(row.enrolled_at)}</span>,
    },
    {
      key: "menu", header: <span className="sr-only">{t("actions")}</span>, width: 46,
      cell: (row) => (
        <span className="flex justify-end" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Menu align="end" width={196} trigger={<IconButton icon={Ellipsis} label={t("actionsFor", {name: row.full_name})} size={24} />}>
            <MenuItem icon={UserRound} onSelect={() => void router.push(`/contacts/${row.target_id}`)}>{t("openContact")}</MenuItem>
            {can.manager && !archived ? (
              <>
                <MenuSeparator />
                {row.status === "failed" ? <MenuItem icon={RotateCcw} onSelect={() => void act("retry", [row.id])}>{t("retryFailedStep")}</MenuItem> : null}
                {row.status === "active" || row.status === "held" ? <MenuItem icon={UserMinus} onSelect={() => void act("unenroll", [row.id])}>{t("unenrol")}</MenuItem> : null}
                <MenuItem icon={Trash2} tone="danger" onSelect={() => void act("remove", [row.id])}>{t("removeCampaign")}</MenuItem>
              </>
            ) : null}
          </Menu>
        </span>
      ),
    },
  ];

  const stepOptions = [
    { value: ANY, label: t("anyStep") },
    ...(data?.steps ?? []).map((step) => ({ value: step.id, label: stepLabel(step), hint: t("stepHere", {count: step.count}) })),
  ];
  const runOptions = [
    { value: ANY, label: t("allRuns") },
    ...(data?.runs ?? []).map((run) => ({ value: run.id, label: run.list ?? t("addedManual"), hint: t("runCount", {count: run.enrolled, date: formatDate(run.created_at)}) })),
  ];
  const anyFailed = chosen.some((rowId) => byId.get(rowId)?.status === "failed");
  const anyLive = chosen.some((rowId) => ["active", "held"].includes(byId.get(rowId)?.status ?? ""));
  const exportQuery = { workflow_id: id ?? undefined, ...table.apiQuery, page: undefined, limit: undefined };

  return (
    <CampaignFrame
      id={id ?? ""}
      campaign={campaign}
      tab="prospects"
      actions={
        <>
          <Button variant="ghost" icon={ScrollText} disabled={!id} onClick={() => setLogOpen(true)}>{t("runLog")}</Button>
          {can.manager && id ? (
            <Button asChild variant="secondary" icon={Download}>
              <a href={apiUrl("/api/export/prospects", exportQuery)} download>{t("exportCsv")}</a>
            </Button>
          ) : null}
          {can.manager ? <Button variant="primary" icon={UserPlus} disabled={!id || archived} onClick={() => setAdding(true)}>{t("addProspects")}</Button> : null}
        </>
      }
    >
      {error?.status === 404 ? (
        <ErrorState message={t("missing")} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={typed} onChange={setSearch} placeholder={t("search")} frameClassName="w-[250px]" />
              <Segmented label={t("status")} value={status} onChange={(value) => table.set({ filters: { status: value } })} options={prospectTabs(data?.counts).map((option) => ({...option, label: option.value === "all" ? t("status_all") : statusLabels[option.value] ?? option.label}))} />
              <Select label={t("stepFilter")} icon={ListFilter} value={table.filters.step_id} onChange={(value) => table.set({ filters: { step_id: value } })} options={stepOptions} />
              {(data?.runs.length ?? 0) > 1 ? <Select label={t("enrolment")} value={table.filters.run_id} onChange={(value) => table.set({ filters: { run_id: value } })} options={runOptions} /> : null}
            </div>
            <Select
              label={t("sortBy")} icon={ArrowDownUp} value={table.sort.key as ProspectSort}
              onChange={(value) => table.set({ sort: { key: value, direction: defaultSortDirection(value) } })}
              options={PROSPECT_SORT_OPTIONS.map((opt) => ({...opt, label: opt.value === "status" ? t("sortStatus") : opt.value === "name" ? t("sortName") : opt.value === "enrolled" ? t("sortEnrolled") : t("sortNext")}))}
            />
          </div>

          <BulkBar count={chosen.length} noun={[t("prospectSingular"), t("prospectPlural")]} onClear={() => setSelected(new Set())}>
            <Button size="sm" icon={RotateCcw} disabled={working || !anyFailed} onClick={() => void act("retry", chosen)}>{t("retryFailed")}</Button>
            <Button size="sm" icon={UserMinus} disabled={working || !anyLive} onClick={() => void act("unenroll", chosen)}>{t("unenrol")}</Button>
            <Button size="sm" variant="danger" icon={Trash2} disabled={working} onClick={() => void act("remove", chosen)}>{t("removeBulk")}</Button>
          </BulkBar>

          <DataTable
            label={t("prospects")} columns={columns} rows={rows} rowKey={(row) => row.id} density="comfortable" minWidth={1040}
            loading={isLoading || !table.ready || !id} error={error && !data ? errorMessage(error) : undefined} onRetry={() => void mutate()}
            selected={can.manager && !archived ? selected : undefined} onSelectedChange={can.manager && !archived ? setSelected : undefined}
            sort={table.sort} onSortChange={(sort) => table.set({ sort })}
            empty={filtered ? (
              <EmptyState title={t("noMatches")} action={<Button onClick={clearFilters}>{t("clear")}</Button>}>
                {t("noMatchesHint")}
              </EmptyState>
            ) : (
              <EmptyState icon={UserPlus} title={t("nobody")} action={can.manager && campaign?.run ? <Button variant="primary" icon={UserPlus} onClick={() => setAdding(true)}>{t("addProspects")}</Button> : undefined}>
                {campaign?.run ? t("addToRun") : t("startRun")}
              </EmptyState>
            )}
            footer={data ? (
              <>
                <span>{t("showing", {shown: data.prospects.length, total: data.total})}</span>
                <Pagination
                  page={data.page} pageSize={data.limit} total={data.total} onPageChange={(page) => table.set({ page })}
                  pageSizes={[25, 50, 100]} onPageSizeChange={(pageSize) => table.set({ pageSize })}
                />
              </>
            ) : undefined}
          />
        </>
      )}
      {id ? <AddProspectsDialog id={id} campaign={campaign} open={adding} onOpenChange={setAdding} onAdded={() => void mutate()} /> : null}
      {id ? <RunLog id={id} open={logOpen} onOpenChange={setLogOpen} /> : null}
    </CampaignFrame>
  );
}
