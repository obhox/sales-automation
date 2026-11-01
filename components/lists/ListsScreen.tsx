import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import {useTranslations} from "next-intl";
import { Archive, ArchiveRestore, Ellipsis, FolderInput, ListChecks, ListFilter, MailCheck, Pencil, Plus, RefreshCw, SendHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import {
  BulkBar, Button, CellStack, DataTable, EmptyState, IconButton, KpiCard, Menu, MenuItem, MenuSeparator, Meter, OptionPicker, Pagination, Pill, SearchInput, Select, Skeleton, Spinner, TONE_SOLID,
  confirm, type Column,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, formatRelative } from "@/lib/client/format";
import { navPath, recordHref } from "@/lib/client/nav";
import { useCan } from "@/lib/client/roles";
import { useTableState } from "@/lib/client/table-state";
import { AddToCampaignDialog, EnrichDialog } from "@/components/contacts/ContactDialogs";
import { CONTACTS_PATH, campaignTone, type ContactFacets } from "@/components/contacts/model";
import { useEnrichRun } from "@/components/contacts/useEnrichRun";
import { UnfinishedImports } from "@/components/csv-import/UnfinishedImports";
import { newImportHref } from "@/components/csv-import/model";
import { ImportsDrawer, ListFormDialog } from "./ListDialogs";
import {
  FILTER_DEFAULTS, LISTS_PATH, PAGE_SIZES, SORT_OPTIONS, SOURCE_LABEL, SOURCE_OPTIONS, STATE_LABEL, STATE_OPTIONS, TABLE_OPTIONS,
  capLine, contactsNoun, enrichedShare, footerLine, kpis, listPath, ownerLine, pastCampaigns, selectionLine, sourceLine, totalsLine, verifiedShare,
  type ListRow, type ListsOverlap, type ListsPage, type ListsSummary, type Share,
} from "./model";

const INTEGRATIONS_HREF = navPath("integrations");

function ShareCell({ share }: { share: Share }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={cn("text-12 font-semibold", share.ratio === null ? "text-ink-3" : "text-ink")}>{share.label}</span>
      {share.ratio === null ? (share.note ? <span className="text-10 text-ink-3">{share.note}</span> : null) : <Meter value={share.ratio} max={1} height={3} tone={share.tone} className="w-20" />}
    </div>
  );
}

/** Audience → Lists: every list with how complete it is and what is using it, and actions across several at once. */
export function ListsScreen() {
  const t = useTranslations("Lists");
  const router = useRouter();
  const can = { member: useCan("member"), manager: useCan("manager"), admin: useCan("admin") };
  const table = useTableState(TABLE_OPTIONS);

  // The search box is typed into freely and reaches the address bar once it pauses.
  const [text, setText] = useState(table.search);
  const [pushed, setPushed] = useState(table.search);
  const [seen, setSeen] = useState(table.search);
  if (table.search !== seen) {
    setSeen(table.search);
    if (table.search !== pushed) setText(table.search);
  }
  const { search: urlSearch, set: setTable } = table;
  useEffect(() => {
    if (text === urlSearch) return;
    const timer = setTimeout(() => { setPushed(text); setTable({ search: text }); }, 250);
    return () => clearTimeout(timer);
  }, [text, urlSearch, setTable]);

  const summaryRequest = useApi<ListsSummary>(LISTS_PATH, { view: "summary" });
  const summary = summaryRequest.data;
  // An import moves on by itself, so the table is read again while one is under way.
  const importing = (summary?.imports.active ?? 0) > 0;
  const [readAt, setReadAt] = useState<number | null>(null);
  const { data, error, isLoading, isValidating, mutate } = useApi<ListsPage>(table.ready ? LISTS_PATH : null, { view: "table", ...table.apiQuery }, { refreshInterval: importing ? 6000 : 0, onSuccess: () => setReadAt(Date.now()) });
  const facets = useApi<ContactFacets>(CONTACTS_PATH, { view: "facets" }).data;

  // ── Selection, and what it adds up to ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const ids = useMemo(() => [...selected].sort(), [selected]);
  const overlapRequest = useApi<ListsOverlap>(ids.length > 0 ? LISTS_PATH : null, { view: "overlap", ids: ids.join(",") });
  const overlap = overlapRequest.data;
  const refresh = () => { void mutate(); void summaryRequest.mutate(); void overlapRequest.mutate(); };
  const [working, setWorking] = useState<string | null>(null);

  // ── Dialogs ──
  const [form, setForm] = useState<{ list: ListRow | null } | null>(null);
  const [importsOpen, setImportsOpen] = useState(false);
  const [campaignIds, setCampaignIds] = useState<string[] | null>(null);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [enrichIds, setEnrichIds] = useState<string[]>([]);
  const enrichRun = useEnrichRun(refresh);

  /** The contacts of some lists, each once. More than the action can take is said, not hidden. */
  async function contactsOf(listIds: string[]): Promise<string[] | null> {
    const result = await api<{ ids: string[]; total: number; capped: boolean }>(CONTACTS_PATH, { query: { view: "ids", list_ids: listIds.join(",") } });
    if (result.capped) toast.message(t("firstContacts", {first: formatCount(result.ids.length), total: formatCount(result.total)}), {description: t("firstHelp")});
    if (result.ids.length === 0) { toast.message(t("noContacts")); return null; }
    return result.ids;
  }

  async function withContacts(key: string, listIds: string[], then: (contactIds: string[]) => void) {
    setWorking(key);
    try {
      const contactIds = await contactsOf(listIds);
      if (contactIds) then(contactIds);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(null);
    }
  }

  const enrich = (listIds: string[]) => {
    if (enrichRun.running) return setEnrichOpen(true);
    enrichRun.clear();
    void withContacts("enrich", listIds, (contactIds) => { setEnrichIds(contactIds); setEnrichOpen(true); });
  };

  async function verify(lists: { id: string }[]) {
    setWorking("verify");
    try {
      let queued = 0;
      for (const list of lists) queued += (await api<{ queued: number }>(`${listPath(list.id)}/verify-emails`, { method: "POST", body: { unchecked_only: true } })).queued;
      if (queued > 0) toast.success(t("checking", {count: formatCount(queued)}), {description: t("checkHelp")});
      else toast.message(t("nothingToCheck"), {description: t("nothingToCheckHelp")});
      refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(null);
    }
  }

  async function archive(list: ListRow) {
    try {
      await api(listPath(list.id), { method: "PUT", body: { archived: !list.archived } });
      toast.success(list.archived ? t("restored", {name: list.name}) : t("archived", {name: list.name}));
      refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  async function remove(list: ListRow) {
    const runs = list.past_campaigns + (list.campaign ? 1 : 0);
    const ok = await confirm({
      title: t("deleteTitle", {name: list.name}),
      body: t("deleteBody", {contacts: list.contacts > 0 ? t("deleteContacts", {count: formatCount(list.contacts)}) : "", runs: runs > 0 ? t("deleteRuns", {count: formatCount(runs)}) : ""}),
      confirmLabel: t("deleteConfirm"), tone: "danger",
    });
    if (!ok) return;
    try {
      await api(listPath(list.id), { method: "DELETE" });
      toast.success(t("deleted", {name: list.name}));
      setSelected((current) => { const next = new Set(current); next.delete(list.id); return next; });
      refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  const filters = table.filters;
  const narrowed = table.activeFilterCount > 0 || table.search !== "";
  const clearAll = () => { setPushed(""); setText(""); table.set({ search: "", filters: FILTER_DEFAULTS }); };
  const sortValue = `${table.sort.key}:${table.sort.direction}`;
  const ownerOptions = [{ value: "all", label: t("anyone") }, { value: "none", label: t("noOwner") }, ...(summary?.members ?? []).map((member, index) => ({ value: member.id, label: member.name, separated: index === 0 }))];
  const ownerLabel = filters.owner === "all" ? t("anyone") : filters.owner === "none" ? t("noOwner") : summary?.members.find((member) => member.id === filters.owner)?.name ?? "…";
  const selectedRows = (data?.items ?? []).filter((row) => selected.has(row.id));

  const columns: Column<ListRow>[] = [
    {
      key: "list", header: t("column.list"), sortKey: "name",
      cell: (row) => <CellStack title={<Link href={recordHref("list", row.id)} onClick={(event) => event.stopPropagation()} className="hover:text-brand-strong">{row.name}</Link>} sub={ownerLine(row)} />,
    },
    { key: "contacts", header: t("column.contacts"), width: 84, sortKey: "contacts", cell: (row) => <span className="text-125 font-semibold tabular-nums text-ink">{formatCount(row.contacts)}</span> },
    {
      key: "source", header: t("column.source"), width: 138,
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-115 font-medium text-ink">{SOURCE_LABEL[row.source]}</span>
          <span className="truncate text-105 text-ink-3">{sourceLine(row)}</span>
        </div>
      ),
    },
    { key: "enriched", header: t("column.enriched"), width: 104, sortKey: "enriched", cell: (row) => <ShareCell share={enrichedShare(row)} /> },
    { key: "verified", header: t("column.verified"), width: 112, sortKey: "verified", cell: (row) => <ShareCell share={verifiedShare(row)} /> },
    { key: "status", header: t("column.status"), width: 132, cell: (row) => <Pill tone={STATE_LABEL[row.state].tone} dot>{STATE_LABEL[row.state].label}</Pill> },
    {
      key: "campaign", header: t("column.campaign"), width: 184,
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          {row.campaign ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("size-[5px] shrink-0 rounded-full", TONE_SOLID[campaignTone(row.campaign.status)])} aria-hidden="true" />
              <Link href={recordHref("campaign", row.campaign.id)} onClick={(event) => event.stopPropagation()} className="truncate text-115 font-medium text-ink hover:text-brand-strong">{row.campaign.name}</Link>
            </span>
          ) : <span className="text-115 text-ink-3">{t("notAssigned")}</span>}
          <span className="text-105 text-ink-3">{pastCampaigns(row.past_campaigns)}</span>
        </div>
      ),
    },
    {
      key: "actions", header: <span className="sr-only">{t("actions")}</span>, width: 68, align: "right",
      cell: (row) => (
        <span className="inline-flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
          {can.member ? <IconButton icon={Sparkles} size={24} label={`Enrich ${row.name}`} disabled={row.contacts === 0 || working === "enrich"} onClick={() => enrich([row.id])} /> : null}
          <Menu width={212} trigger={<IconButton icon={Ellipsis} size={24} label={`Actions for ${row.name}`} />}>
            <MenuItem icon={ListChecks} onSelect={() => void router.push(recordHref("list", row.id))}>{t("open")}</MenuItem>
            {can.member ? (
              <>
                <MenuItem icon={Pencil} onSelect={() => setForm({ list: row })}>{t("editOwner")}</MenuItem>
                <MenuSeparator />
                {can.manager ? <MenuItem icon={FolderInput} onSelect={() => void router.push(`${recordHref("list", row.id)}?import=sales-navigator`)}>{t("salesNav")}</MenuItem> : null}
                <MenuItem icon={Upload} onSelect={() => void router.push(newImportHref(row.id))}>{t("importCSV")}</MenuItem>
                <MenuItem icon={MailCheck} disabled={row.verifiable === 0} onSelect={() => void verify([row])}>{t("verifyEmails")}</MenuItem>
                <MenuSeparator />
                <MenuItem icon={row.archived ? ArchiveRestore : Archive} onSelect={() => void archive(row)}>{row.archived ? t("restore") : t("archive")}</MenuItem>
                <MenuItem icon={Trash2} tone="danger" onSelect={() => void remove(row)}>{t("delete")}</MenuItem>
              </>
            ) : null}
          </Menu>
        </span>
      ),
    },
  ];

  return (
    <Page
      title={t("title")}
      meta={summary ? <Pill>{totalsLine(summary)}</Pill> : null}
      actions={
        can.member ? (
          <>
            <Button asChild><Link href={newImportHref()}><Upload size={14} className="text-ink-2" aria-hidden="true" />{t("importCSV")}</Link></Button>
            <Button variant="primary" icon={Plus} onClick={() => setForm({ list: null })}>{t("newList")}</Button>
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
          </>
        ) : null
      }
    >
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">
        {summary
          ? kpis(summary).map((kpi) => <KpiCard key={kpi.label} label={kpi.label} value={kpi.value} note={<span className={kpi.noteTone === "warn" ? "text-warn" : "text-ink-2"}>{kpi.note}</span>} />)
          : Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[98px] rounded-lg" />)}
      </div>

      <UnfinishedImports enabled={can.member} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={text} onChange={setText} placeholder={t("search")} aria-label={t("searchAria")} frameClassName="w-[236px] border-line-strong" />
          <Select label={t("source")} value={filters.source} onChange={(source) => table.set({ filters: { source } })} options={SOURCE_OPTIONS} />
          <Select label={t("status")} value={filters.state} onChange={(state) => table.set({ filters: { state } })} options={STATE_OPTIONS} />
          <OptionPicker
            label={t("owner")} value={filters.owner} onChange={(owner) => table.set({ filters: { owner } })} options={ownerOptions} searchPlaceholder={t("findMember")}
            trigger={<button type="button" className="inline-flex h-8 shrink-0 items-center gap-[7px] rounded-md border border-line-strong bg-surface px-3 text-12 font-medium text-ink hover:bg-subtle">{t("ownerFilter", {name: ownerLabel})}</button>}
          />
          {narrowed ? <button type="button" onClick={clearAll} className="text-11 font-semibold text-brand-strong hover:underline">{t("clearAll")}</button> : null}
        </div>
        <div className="flex items-center gap-2">
          {summary && (summary.imports.active > 0 || can.manager) ? (
            <button type="button" onClick={() => setImportsOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-11 font-medium text-ink-2 hover:bg-control hover:text-ink">
              {summary.imports.active > 0 ? <><Spinner size={11} label={t("importing")} />{t("importsRunning", {count: summary.imports.active})}</> : capLine(summary.imports.today, summary.imports.daily_cap)}
            </button>
          ) : null}
          <span className="text-11 text-ink-3" aria-live="polite">{readAt ? t("updated", {relative: formatRelative(readAt)}) : ""}</span>
          <Select label={t("sort")} value={sortValue} onChange={(value) => { const [key, direction] = value.split(":"); table.set({ sort: { key, direction: direction === "asc" ? "asc" : "desc" } }); }} options={SORT_OPTIONS.some((option) => option.value === sortValue) ? SORT_OPTIONS : [...SORT_OPTIONS, { value: sortValue, label: t("customOrder") }]} />
          <IconButton icon={RefreshCw} label={t("refresh")} variant="outline" onClick={refresh} className={isValidating ? "[&_svg]:animate-spin" : undefined} />
        </div>
      </div>

      {can.member ? (
        <BulkBar
          count={selected.size} noun={["list", "lists"]} onClear={() => setSelected(new Set())}
          extra={overlap ? <span className="text-115 text-ink-2">{selectionLine(overlap)}</span> : <Spinner size={11} label="Adding up" />}
        >
          <Button size="sm" icon={Sparkles} loading={working === "enrich"} disabled={!overlap || overlap.enrichable === 0} onClick={() => enrich(ids)}>
            {overlap ? `Enrich ${contactsNoun(overlap.enrichable)}` : "Enrich"}
          </Button>
          <Button size="sm" icon={MailCheck} loading={working === "verify"} disabled={!overlap || overlap.verifiable === 0} onClick={() => void verify(ids.map((id) => ({ id })))}>
            {overlap && overlap.verifiable > 0 ? `Verify ${formatCount(overlap.verifiable)} emails` : "Verify emails"}
          </Button>
          <Button size="sm" icon={SendHorizontal} loading={working === "campaign"} disabled={!overlap || overlap.contacts === 0} onClick={() => void withContacts("campaign", ids, setCampaignIds)}>{t("addToCampaign")}</Button>
        </BulkBar>
      ) : null}

      <DataTable
        label={t("title")}
        columns={columns}
        rows={data?.items}
        rowKey={(row) => row.id}
        loading={isLoading}
        error={error && !data ? errorMessage(error) : undefined}
        onRetry={() => void mutate()}
        selected={can.member ? selected : undefined}
        onSelectedChange={can.member ? setSelected : undefined}
        sort={table.sort}
        onSortChange={(sort) => table.set({ sort })}
        onRowClick={(row) => void router.push(recordHref("list", row.id))}
        minWidth={1040}
        className={cn("transition-opacity", isLoading && data ? "opacity-60" : undefined)}
        empty={
          narrowed ? (
            <EmptyState icon={ListFilter} title={t("noMatch")} action={<Button size="sm" onClick={clearAll}>{t("clearSearch")}</Button>}>{t("noMatchDetail")}</EmptyState>
          ) : (
            <EmptyState icon={ListChecks} title={t("noLists")} action={can.member ? <Button size="sm" variant="primary" icon={Plus} onClick={() => setForm({ list: null })}>{t("newList")}</Button> : undefined}>
              {t("noListsDetail")}
            </EmptyState>
          )
        }
        footer={
          data ? (
            <>
              <span>{footerLine(data.items.length, data.total, summary)}{selectedRows.length < selected.size ? ` · ${t("otherPages", {count: formatCount(selected.size - selectedRows.length)})}` : ""}</span>
              <Pagination page={table.page} pageSize={table.pageSize} total={data.total} onPageChange={(page) => table.set({ page })} pageSizes={PAGE_SIZES} onPageSizeChange={(pageSize) => table.set({ pageSize })} />
            </>
          ) : undefined
        }
      />

      <ListFormDialog open={form !== null} list={form?.list ?? null} members={summary?.members ?? []} onClose={() => setForm(null)} onSaved={(id) => { if (form?.list) refresh(); else void router.push(recordHref("list", id)); }} />
      <ImportsDrawer open={importsOpen} canCancel={can.manager} canSetCap={can.admin} onClose={() => setImportsOpen(false)} onChanged={refresh} />
      <AddToCampaignDialog ids={campaignIds} campaigns={facets?.campaigns ?? []} canEnrol={can.manager} onClose={() => setCampaignIds(null)} onDone={refresh} />
      <EnrichDialog
        open={enrichOpen} ids={enrichIds} progress={enrichRun.progress} integrationsHref={INTEGRATIONS_HREF}
        onStart={(eligible, batch) => void enrichRun.start(eligible, batch)} onStop={enrichRun.stop} onClose={() => { setEnrichOpen(false); enrichRun.clear(); }}
      />
    </Page>
  );
}
