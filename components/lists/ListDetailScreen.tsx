import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import {
  Archive, ArchiveRestore, ArrowRightLeft, ChevronDown, Download, Ellipsis, ExternalLink, FolderInput, ListFilter, ListMinus, MailCheck, Pencil, RefreshCw, SendHorizontal, Sparkles, Tag, Trash2, Upload, Users,
} from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import {
  Alert, BulkBar, Button, Card, DataTable, EmptyState, ErrorState, FilterChip, IconButton, KpiCard, Menu, MenuItem, MenuSeparator, Meter, OptionPicker, Pagination, Pill, SearchInput, Skeleton, Spinner,
  confirm,
} from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, formatDate, formatRelative } from "@/lib/client/format";
import { navPath, recordHref } from "@/lib/client/nav";
import { useCan } from "@/lib/client/roles";
import { useTableState } from "@/lib/client/table-state";
import { contactColumns, type RowAction } from "@/components/contacts/ContactCells";
import { AddToCampaignDialog, EnrichDialog, TagDialog } from "@/components/contacts/ContactDialogs";
import { ManageTagsDialog } from "@/components/contacts/ManageDialogs";
import { downloadFile, rememberListContext } from "@/components/contacts/browser";
import {
  CONTACTS_PATH, FILTERS, PAGE_SIZES as CONTACT_PAGE_SIZES, filterOptions, filterValueLabel, rangeLine,
  type ColumnKey, type ContactFacets, type ContactRow, type ContactsPage, type FilterKey,
} from "@/components/contacts/model";
import { useEnrichRun } from "@/components/contacts/useEnrichRun";
import { newImportHref } from "@/components/csv-import/model";
import { ImportsDrawer, ListFormDialog, MoveContactsDialog, SalesNavImportDialog, SyncStatusDialog } from "./ListDialogs";
import { IMPORTS_PATH, SOURCE_LABEL, STATE_LABEL, capLine, contactsNoun, detailKpis, importBanner, listPath, planLine, runState, type ImportStatus, type ListDetail } from "./model";

const INTEGRATIONS_HREF = navPath("integrations");
const LIST_FILTERS = { email: "all", linkedin: "all", campaign: "all", replied: "all", enriched: "all", tag: "all" };
const TABLE_OPTIONS = { pageSize: 50, sort: { key: "name", direction: "asc" as const }, filters: LIST_FILTERS };
// Beside the side cards there is room for the contact and four more; campaign and intent stay on the Contacts screen (and as filters here).
const COLUMNS: ColumnKey[] = ["company", "email", "linkedin", "last_activity"];
const PINNED: FilterKey[] = ["email", "linkedin"];
const EXTRA: FilterKey[] = ["campaign", "replied", "enriched", "tag"];

/** Audience → Lists → one list. The id comes from the address; each list gets a fresh screen. */
export function ListDetailScreen() {
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  if (!id) return <Page title="List" crumbs={[{ label: "Lists", href: "/lists" }]}><LoadingLayout /></Page>;
  return <Detail key={id} id={id} />;
}

function Detail({ id }: { id: string }) {
  const router = useRouter();
  const can = { member: useCan("member"), manager: useCan("manager"), admin: useCan("admin") };
  const table = useTableState(TABLE_OPTIONS);
  const crumbs = [{ label: "Lists", href: "/lists" }];

  // ── Search ──
  const [text, setText] = useState(table.search);
  const [pushed, setPushed] = useState(table.search);
  const [seen, setSeen] = useState(table.search);
  if (table.search !== seen) {
    setSeen(table.search);
    if (table.search !== pushed) setText(table.search);
  }
  const { search: urlSearch, set: setTable } = table;

  // ── Data ──
  const [watching, setWatching] = useState(false);
  // While an import is under way the list is read again every few seconds: the batch moves on by itself.
  const detailRequest = useApi<ListDetail>(listPath(id), { view: "detail" }, { refreshInterval: watching ? 4000 : 0, onSuccess: (next) => setWatching(next.list.import !== null) });
  const detail = detailRequest.data;
  const facets = useApi<ContactFacets>(CONTACTS_PATH, { view: "facets" }).data;
  // Nothing more is asked about a list that turned out not to be there.
  const found = !detailRequest.error;
  const importStatus = useApi<ImportStatus>(detail ? `${listPath(id)}/import-status` : null, undefined, { refreshInterval: watching ? 4000 : 0 });
  const contactsRequest = useApi<ContactsPage>(table.ready && found ? CONTACTS_PATH : null, { view: "table", list_id: id, ...table.apiQuery }, { refreshInterval: watching ? 8000 : 0 });
  const contacts = contactsRequest.data;
  const refresh = () => { void detailRequest.mutate(); void contactsRequest.mutate(); void importStatus.mutate(); };

  // ── Selection ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState<{ total: number; capped: boolean } | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const clearSelection = () => { setSelected(new Set()); setAllMatching(null); };
  const ids = useMemo(() => [...selected], [selected]);
  useEffect(() => {
    if (text === urlSearch) return;
    const timer = setTimeout(() => { setPushed(text); setSelected(new Set()); setAllMatching(null); setTable({ search: text }); }, 250);
    return () => clearTimeout(timer);
  }, [text, urlSearch, setTable]);

  // ── Dialogs. `?import=sales-navigator` in the address opens that import. ──
  const asked = typeof router.query.import === "string" ? router.query.import : null;
  const [importing, setImporting] = useState<"sales-navigator" | null>(null);
  const [askedSeen, setAskedSeen] = useState<string | null>(null);
  if (asked !== askedSeen) {
    setAskedSeen(asked);
    if (asked === "sales-navigator") setImporting(asked);
  }
  // `?import=csv` used to open a dialog here. The CSV import has a page of its own now, and old links follow it there.
  useEffect(() => {
    if (asked === "csv" && id) void router.replace(newImportHref(id));
  }, [asked, id, router]);
  const closeImport = () => {
    setImporting(null);
    if (asked) {
      const { import: _import, ...rest } = router.query;
      void _import;
      void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true, scroll: false });
    }
  };
  const [editing, setEditing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [importsOpen, setImportsOpen] = useState(false);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [campaignIds, setCampaignIds] = useState<string[] | null>(null);
  const [tagIds, setTagIds] = useState<string[] | null>(null);
  const [managingTags, setManagingTags] = useState(false);
  const [extraFilters, setExtraFilters] = useState<FilterKey[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [enrichIds, setEnrichIds] = useState<string[]>([]);
  const enrichRun = useEnrichRun(refresh);

  if (detailRequest.error && !detail) {
    const missing = detailRequest.error instanceof ApiError && detailRequest.error.status === 404;
    return (
      <Page title="List" crumbs={crumbs}>
        {missing
          ? <Card><EmptyState title="This list is not here" action={<Button asChild><Link href="/lists">Back to lists</Link></Button>}>It may have been deleted, or it belongs to another workspace.</EmptyState></Card>
          : <Card><ErrorState message={errorMessage(detailRequest.error)} onRetry={() => void detailRequest.mutate()} /></Card>}
      </Page>
    );
  }
  if (!detail) return <Page title="List" crumbs={crumbs}><LoadingLayout /></Page>;

  const { list } = detail;
  const filters = table.filters;
  const narrowed = table.activeFilterCount > 0 || table.search !== "";
  const setFilter = (key: keyof typeof LIST_FILTERS, value: string) => { clearSelection(); table.set({ filters: { [key]: value } }); };
  const clearAll = () => { clearSelection(); setExtraFilters([]); setPushed(""); setText(""); table.set({ search: "", filters: LIST_FILTERS }); };
  const defs = FILTERS.filter((def) => def.key in LIST_FILTERS) as (typeof FILTERS[number] & { key: keyof typeof LIST_FILTERS })[];
  const shownFilters = defs.filter((def) => PINNED.includes(def.key) || filters[def.key] !== "all" || extraFilters.includes(def.key));
  const addable = defs.filter((def) => EXTRA.includes(def.key) && !shownFilters.includes(def));
  const listQuery = { ...table.apiQuery, list_id: id, page: undefined, limit: undefined };
  const contextQuery = Object.fromEntries(Object.entries(listQuery).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
  const rememberContext = () => rememberListContext({ query: contextQuery, href: router.asPath });
  const openProfile = (row: ContactRow) => { rememberContext(); void router.push(`/contacts/${row.id}`); };

  /** Run one request against the list, say what happened, and read the list again. */
  async function run(key: string, work: () => Promise<string | void>) {
    setBusy(key);
    try {
      const message = await work();
      if (message) toast.success(message);
      refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function selectEveryMatch() {
    setSelectingAll(true);
    try {
      const result = await api<{ ids: string[]; total: number; capped: boolean }>(CONTACTS_PATH, { query: { view: "ids", ...listQuery } });
      setSelected(new Set(result.ids));
      setAllMatching({ total: result.total, capped: result.capped });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSelectingAll(false);
    }
  }

  /** Enrich the selection, or with nothing selected, everyone in the list who can be looked up. */
  async function enrich(contactIds: string[] | null) {
    if (enrichRun.running) return setEnrichOpen(true);
    enrichRun.clear();
    if (contactIds) { setEnrichIds(contactIds); return setEnrichOpen(true); }
    setBusy("enrich");
    try {
      const result = await api<{ ids: string[]; total: number; capped: boolean }>(CONTACTS_PATH, { query: { view: "ids", list_id: id, email: "none", enriched: "no" } });
      if (result.ids.length === 0) return void toast.message("Nobody in this list is waiting for a look-up", { description: "Apollo is asked about contacts with no email who have not been looked up before. Select contacts to look them up again." });
      if (result.capped) toast.message(`Taking the first ${formatCount(result.ids.length)} of ${formatCount(result.total)}`, { description: "Run it again for the rest." });
      setEnrichIds(result.ids);
      setEnrichOpen(true);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  /** Check the selection as it stands, or with nothing selected, the addresses in the list that have no result yet. */
  async function verify(contactIds: string[] | null) {
    let body: Record<string, unknown> = contactIds ? { target_ids: contactIds } : { unchecked_only: true };
    if (!contactIds && list.verifiable === 0) {
      if (list.verifying > 0) return void toast.message("Already being checked", { description: `${formatCount(list.verifying)} ${list.verifying === 1 ? "address is" : "addresses are"} waiting for a result.` });
      const ok = await confirm({ title: "Check every address again?", body: "Each address in this list already has a result. Checking again asks the verifier about all of them, except the ones known to be invalid.", confirmLabel: "Check again" });
      if (!ok) return;
      body = {};
    }
    await run("verify", async () => {
      const result = await api<{ queued: number }>(`${listPath(id)}/verify-emails`, { method: "POST", body });
      if (result.queued === 0) { toast.message("Nothing to check", { description: "These addresses are already known to be invalid, or have no email." }); return; }
      clearSelection();
      return `${formatCount(result.queued)} email ${result.queued === 1 ? "address is" : "addresses are"} being checked in the background`;
    });
  }

  async function removeFromList(contactIds: string[], name?: string) {
    const ok = await confirm({
      title: name ? `Remove ${name} from this list?` : `Remove ${contactsNoun(contactIds.length)} from this list?`,
      body: `${contactIds.length === 1 ? "The contact stays" : "The contacts stay"} in Linki and in any other list. A campaign already running on this list keeps the contacts it has enrolled.`,
      confirmLabel: "Remove from list",
    });
    if (!ok) return;
    await run("remove", async () => {
      const result = await api<{ removed: number }>(`${listPath(id)}/targets`, { method: "DELETE", body: { target_ids: contactIds } });
      clearSelection();
      return `${contactsNoun(result.removed)} removed from ${list.name}`;
    });
  }

  async function cancelImport(jobId: string) {
    const ok = await confirm({ title: "Cancel this import?", body: "A batch that is running stops at its next page. Contacts already imported stay in the list.", confirmLabel: "Cancel import", cancelLabel: "Keep it", tone: "danger" });
    if (!ok) return;
    await run("cancel", async () => {
      await api(`${IMPORTS_PATH}/${jobId}/cancel`, { method: "POST" });
      return "Import cancelled";
    });
  }

  const archive = () => run("archive", async () => {
    await api(listPath(id), { method: "PUT", body: { archived: !list.archived } });
    return list.archived ? `${list.name} is in use again` : `${list.name} archived`;
  });

  async function remove() {
    const ok = await confirm({
      title: `Delete the list "${list.name}"?`,
      body: `${list.contacts > 0 ? `Its ${contactsNoun(list.contacts)} stay in Linki; only the list goes. ` : ""}${detail!.runs.length > 0 ? `The ${detail!.runs.length === 1 ? "campaign run" : `${detail!.runs.length} campaign runs`} made from this list ${detail!.runs.length === 1 ? "is" : "are"} deleted with it, with ${detail!.runs.length === 1 ? "its" : "their"} progress. ` : ""}This cannot be undone. To put a list out of use and keep it, archive it instead.`,
      confirmLabel: "Delete list", tone: "danger",
    });
    if (!ok) return;
    try {
      await api(listPath(id), { method: "DELETE" });
      toast.success(`${list.name} deleted`);
      void router.push("/lists");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  const exportCsv = (body: Record<string, unknown>) => run("export", () => downloadFile("/api/export/contacts", body, `linki-list-${list.name}.csv`));

  const onRowAction = (action: RowAction, row: ContactRow) => {
    if (action === "tag") setTagIds([row.id]);
    else if (action === "list") setMoveIds([row.id]);
    else void removeFromList([row.id], row.full_name ?? undefined);
  };

  const columns = contactColumns({
    shown: COLUMNS, profileHref: (row) => `/contacts/${row.id}`, canEdit: can.member, onOpen: openProfile, onAction: onRowAction, onVisit: rememberContext,
    labels: { list: "Move to another list", delete: "Remove from this list" },
  });
  const rows = contacts?.items;
  const total = contacts?.total ?? 0;
  const pageFullySelected = Boolean(rows?.length) && rows!.every((row) => selected.has(row.id));
  const state = STATE_LABEL[list.state];
  const banner = importBanner(importStatus.data);
  const plan = planLine(importStatus.data);

  return (
    <Page
      title={list.name}
      crumbs={crumbs}
      meta={
        <>
          <Pill tone={state.tone} dot>{state.label}</Pill>
          <Pill>{contactsNoun(list.contacts)}</Pill>
        </>
      }
      actions={
        <>
          {can.member ? (
            <Menu width={236} trigger={<Button icon={FolderInput} iconRight={ChevronDown}>Import</Button>}>
              {can.manager ? <MenuItem icon={FolderInput} disabled={list.import !== null} onSelect={() => setImporting("sales-navigator")}>From Sales Navigator</MenuItem> : null}
              <MenuItem icon={Upload} onSelect={() => void router.push(newImportHref(list.id))}>From a CSV file</MenuItem>
              <MenuSeparator />
              <MenuItem icon={RefreshCw} onSelect={() => setImportsOpen(true)}>Import jobs and the daily cap</MenuItem>
            </Menu>
          ) : null}
          {can.member ? <Button icon={Sparkles} loading={busy === "enrich"} disabled={list.contacts === 0} onClick={() => void enrich(null)}>Enrich</Button> : null}
          {can.member ? <Button icon={MailCheck} loading={busy === "verify"} disabled={list.with_email === 0} onClick={() => void verify(null)}>Verify emails</Button> : null}
          {can.member || list.sales_nav_url ? <Menu width={236} trigger={<IconButton icon={Ellipsis} label="More actions" variant="outline" />}>
            {can.manager ? <MenuItem icon={Download} disabled={list.contacts === 0 || busy === "export"} onSelect={() => void exportCsv({ list_id: id })}>Export as CSV</MenuItem> : null}
            {list.sales_nav_url ? <MenuItem icon={ExternalLink} onSelect={() => window.open(list.sales_nav_url!, "_blank", "noopener,noreferrer")}>Open the search in Sales Navigator</MenuItem> : null}
            {can.member ? (
              <>
                <MenuItem icon={RefreshCw} onSelect={() => setSyncing(true)}>Sync connection status</MenuItem>
                <MenuSeparator />
                <MenuItem icon={Pencil} onSelect={() => setEditing(true)}>Edit name, owner</MenuItem>
                <MenuItem icon={list.archived ? ArchiveRestore : Archive} onSelect={() => void archive()}>{list.archived ? "Take out of the archive" : "Archive"}</MenuItem>
                <MenuItem icon={Trash2} tone="danger" onSelect={() => void remove()}>Delete list</MenuItem>
              </>
            ) : null}
          </Menu> : null}
          {can.member || list.sales_nav_url ? <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" /> : null}
        </>
      }
    >
      {banner ? (
        <Alert
          banner tone={banner.tone} title={banner.title}
          actions={banner.cancel && can.manager ? <Button className="h-[30px]" loading={busy === "cancel"} onClick={() => void cancelImport(banner.cancel!)}>Cancel import</Button> : undefined}
        >
          {banner.body}
          {banner.progress ? <Meter value={banner.progress.value} max={banner.progress.max} height={3} className="mt-2 max-w-[360px]" label="Read so far" /> : null}
        </Alert>
      ) : null}
      {plan ? <Alert banner tone="warn" title="Imported in batches">{plan} <button type="button" onClick={() => setImportsOpen(true)} className="font-semibold underline-offset-2 hover:underline">See the schedule</button></Alert> : null}
      {list.archived ? <Alert banner tone="neutral" title="This list is archived">It keeps its contacts and history. Take it out of the archive to use it again.</Alert> : null}

      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">
        {detailKpis(detail).map((kpi) => <KpiCard key={kpi.label} label={kpi.label} value={kpi.value} note={<span className={kpi.noteTone === "warn" ? "text-warn" : "text-ink-2"}>{kpi.note}</span>} />)}
      </div>

      <div className="flex flex-col gap-3.5 min-[1400px]:grid min-[1400px]:grid-cols-[minmax(0,1fr)_300px] min-[1400px]:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-[7px]">
              <SearchInput value={text} onChange={setText} placeholder="Search this list" aria-label="Search this list" frameClassName="w-[220px]" />
              {shownFilters.map((def) => {
                const value = filters[def.key];
                return (
                  <OptionPicker
                    key={def.key} label={`Filter by ${def.name.toLowerCase()}`} value={value} onChange={(next) => setFilter(def.key, next)}
                    options={[{ value: "all", label: def.any }, ...filterOptions(def.key, facets)]} searchPlaceholder={`Find a ${def.name.toLowerCase()}`}
                    trigger={<FilterChip name={def.name} value={filterValueLabel(def, value, facets)} active={value !== "all"} className="h-8" />}
                  />
                );
              })}
              {addable.length > 0 ? (
                <Menu align="start" width={180} trigger={<button type="button" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-11 font-medium text-ink-3 hover:bg-control hover:text-ink"><ListFilter size={12} aria-hidden="true" />Add filter</button>}>
                  {addable.map((def) => <MenuItem key={def.key} onSelect={() => setExtraFilters((current) => [...current, def.key])}>{def.name}</MenuItem>)}
                </Menu>
              ) : null}
              {narrowed ? <button type="button" onClick={clearAll} className="text-11 font-semibold text-brand-strong hover:underline">Clear all</button> : null}
            </div>
            <span className="text-11 text-ink-3" aria-live="polite">{contacts ? `${formatCount(total)} ${narrowed ? "matching" : "in this list"}` : ""}</span>
          </div>

          {can.member ? (
            <BulkBar
              count={selected.size} noun={["contact", "contacts"]} onClear={clearSelection}
              extra={
                allMatching ? (
                  <span className="text-11 font-medium text-brand-strong">{allMatching.capped ? `The first ${formatCount(selected.size)} of ${formatCount(allMatching.total)}` : narrowed ? "Everyone matching is selected" : "The whole list is selected"}</span>
                ) : pageFullySelected && total > selected.size ? (
                  <button type="button" onClick={() => void selectEveryMatch()} disabled={selectingAll} className="inline-flex items-center gap-1.5 text-11 font-semibold text-brand-strong hover:underline disabled:opacity-60">
                    {selectingAll ? <Spinner size={11} label="Selecting" /> : null}
                    Select all {formatCount(total)} {narrowed ? "matching" : "in this list"}
                  </button>
                ) : null
              }
            >
              <Button size="sm" icon={ArrowRightLeft} onClick={() => setMoveIds(ids)}>Move</Button>
              <Button size="sm" icon={Sparkles} onClick={() => void enrich(ids)}>Enrich</Button>
              <Button size="sm" icon={MailCheck} loading={busy === "verify"} onClick={() => void verify(ids)}>Verify</Button>
              <Button size="sm" icon={SendHorizontal} onClick={() => setCampaignIds(ids)}>Add to campaign</Button>
              <Button size="sm" icon={Tag} onClick={() => setTagIds(ids)}>Tag</Button>
              {can.manager ? <Button size="sm" icon={Download} loading={busy === "export"} onClick={() => void exportCsv({ ids })}>Export</Button> : null}
              <Button size="sm" variant="danger" icon={ListMinus} loading={busy === "remove"} onClick={() => void removeFromList(ids)}>Remove</Button>
            </BulkBar>
          ) : null}

          <DataTable
            label={`Contacts in ${list.name}`}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={contactsRequest.isLoading}
            error={contactsRequest.error && !contacts ? errorMessage(contactsRequest.error) : undefined}
            onRetry={() => void contactsRequest.mutate()}
            selected={can.member ? selected : undefined}
            onSelectedChange={can.member ? (next) => { setSelected(next); setAllMatching(null); } : undefined}
            sort={table.sort}
            onSortChange={(sort) => table.set({ sort })}
            onRowClick={openProfile}
            density="regular"
            minWidth={780}
            className={cn("transition-opacity", contactsRequest.isLoading && contacts ? "opacity-60" : undefined)}
            empty={
              narrowed ? (
                <EmptyState icon={ListFilter} title="Nobody in this list matches" action={<Button size="sm" onClick={clearAll}>Clear search and filters</Button>} />
              ) : (
                <EmptyState
                  icon={Users} title="This list is empty"
                  action={can.member ? <span className="flex gap-2">{can.manager ? <Button size="sm" icon={FolderInput} onClick={() => setImporting("sales-navigator")}>Import from Sales Navigator</Button> : null}<Button asChild size="sm"><Link href={newImportHref(list.id)}><Upload size={12} className="text-ink-2" aria-hidden="true" />Import a CSV</Link></Button></span> : undefined}
                >
                  Fill it from a Sales Navigator search, a CSV file, or by selecting people on the Contacts screen.
                </EmptyState>
              )
            }
            footer={
              contacts ? (
                <>
                  <span>{rangeLine(contacts.page, contacts.limit, contacts.items.length, contacts.total)}</span>
                  <Pagination page={table.page} pageSize={table.pageSize} total={total} onPageChange={(page) => table.set({ page })} pageSizes={CONTACT_PAGE_SIZES} onPageSizeChange={(pageSize) => table.set({ pageSize })} />
                </>
              ) : undefined
            }
          />
        </div>

        <div className="flex flex-col gap-3.5">
          <Card className="flex flex-col gap-2.5 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-13 font-semibold tracking-snug text-ink">About this list</h2>
              {can.member ? <button type="button" onClick={() => setEditing(true)} className="text-11 font-semibold text-brand-strong hover:underline">Edit</button> : null}
            </div>
            {list.description ? <p className="whitespace-pre-wrap text-115 leading-[17px] text-ink-2">{list.description}</p> : null}
            <Fact label="Owner">{list.owner?.name ?? "No owner"}</Fact>
            <Fact label="Source">{SOURCE_LABEL[list.source]}</Fact>
            {list.source_detail ? <Fact label="Last file">{list.source_detail}</Fact> : null}
            <Fact label="Last filled">{list.last_synced_at ? formatRelative(list.last_synced_at) : "Not yet"}</Fact>
            <Fact label="Created">{formatDate(list.created_at)}</Fact>
            <button type="button" onClick={() => setImportsOpen(true)} className="mt-0.5 rounded-md bg-subtle px-[9px] py-[7px] text-left text-11 text-ink-2 hover:bg-control">{capLine(detail.imports.today, detail.imports.daily_cap)}</button>
          </Card>

          <Card className="flex flex-col gap-2.5 p-3.5">
            <h2 className="text-13 font-semibold tracking-snug text-ink">Campaigns on this list</h2>
            {detail.runs.length === 0 ? <p className="text-11 leading-4 text-ink-3">No campaign has used this list yet.</p> : (
              <ul className="flex flex-col gap-2">
                {detail.runs.map((item) => {
                  const pill = runState(item.status);
                  return (
                    <li key={item.id} className="flex flex-col gap-1 rounded-lg border border-line bg-subtle p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        {item.workflow_id
                          ? <Link href={recordHref("campaign", item.workflow_id)} className="min-w-0 truncate text-115 font-semibold text-ink hover:text-brand-strong">{item.workflow_name ?? "A campaign"}</Link>
                          : <span className="truncate text-115 font-semibold text-ink">A deleted campaign</span>}
                        <Pill size="sm" tone={pill.tone}>{pill.label}</Pill>
                      </div>
                      <span className="text-105 text-ink-3">{formatCount(item.finished)} of {contactsNoun(item.total)} finished · started {formatDate(item.started_at ?? item.created_at)}{item.account_name ? ` · ${item.account_name}` : ""}</span>
                      {item.total > 0 ? <Meter value={item.finished} max={item.total} height={3} tone={item.status === "running" ? "good" : "neutral"} label="Contacts finished" /> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <ListFormDialog open={editing} list={list} members={facets?.members ?? []} onClose={() => setEditing(false)} onSaved={refresh} />
      {/* The address can ask for an import; whether it opens is still down to the role. */}
      <SalesNavImportDialog open={importing === "sales-navigator" && can.manager} detail={detail} onClose={closeImport} onQueued={refresh} />
      <SyncStatusDialog open={syncing} detail={detail} onClose={() => setSyncing(false)} onSynced={refresh} />
      <ImportsDrawer open={importsOpen} canCancel={can.manager} canSetCap={can.admin} onClose={() => setImportsOpen(false)} onChanged={refresh} />
      <MoveContactsDialog ids={moveIds} from={list} lists={detail.other_lists} onClose={() => setMoveIds(null)} onMoved={() => { clearSelection(); refresh(); }} />
      <AddToCampaignDialog ids={campaignIds} campaigns={facets?.campaigns ?? []} canEnrol={can.manager} onClose={() => setCampaignIds(null)} onDone={refresh} />
      <TagDialog ids={tagIds} tags={facets?.tags ?? []} onClose={() => setTagIds(null)} onDone={refresh} onManage={() => { setTagIds(null); setManagingTags(true); }} />
      <ManageTagsDialog open={managingTags} tags={facets?.tags ?? []} canManage={can.manager} onClose={() => setManagingTags(false)} onChanged={refresh} />
      <EnrichDialog
        open={enrichOpen} ids={enrichIds} progress={enrichRun.progress} integrationsHref={INTEGRATIONS_HREF}
        onStart={(eligible, batch) => void enrichRun.start(eligible, batch)} onStop={enrichRun.stop} onClose={() => { setEnrichOpen(false); enrichRun.clear(); }}
      />
    </Page>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[18px] items-center justify-between gap-3">
      <span className="shrink-0 text-11 text-ink-3">{label}</span>
      <span className="min-w-0 truncate text-right text-11 font-medium text-ink-2">{children}</span>
    </div>
  );
}

function LoadingLayout() {
  return (
    <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Loading the list">
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[98px] rounded-lg" />)}</div>
      <div className="flex flex-col gap-3.5 min-[1400px]:grid min-[1400px]:grid-cols-[minmax(0,1fr)_300px]">
        <Skeleton className="h-[520px] rounded-lg" />
        <div className="flex flex-col gap-3.5"><Skeleton className="h-[200px] rounded-lg" /><Skeleton className="h-[160px] rounded-lg" /></div>
      </div>
    </div>
  );
}
