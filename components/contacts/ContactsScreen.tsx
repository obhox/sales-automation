import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import {
  AlignJustify, Check, ChevronDown, Columns3, Download, ListChecks, ListFilter, ListPlus, SendHorizontal, Settings2, ShieldCheck, Sparkles, Tag, Trash2, Upload, UserPlus, Users, X,
} from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import {
  AddFilterButton, BulkBar, Button, DataTable, EmptyState, FilterChip, Menu, MenuCheckItem, MenuItem, MenuLabel, MenuSeparator, OptionPicker, Pagination, Pill, SearchInput, Spinner,
  confirm, type PickerOption,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, plural } from "@/lib/client/format";
import { navPath } from "@/lib/client/nav";
import { useCan } from "@/lib/client/roles";
import { useTableState, writeTableState } from "@/lib/client/table-state";
import { contactColumns, type RowAction } from "./ContactCells";
import { AddContactDialog, AddToCampaignDialog, AddToListDialog, EnrichDialog, TagDialog } from "./ContactDialogs";
import { newImportHref } from "@/components/csv-import/model";
import { CustomFieldsDialog, ManageTagsDialog } from "./ManageDialogs";
import { SavedViews } from "./SavedViews";
import { downloadFile, rememberListContext, useStoredPreference } from "./browser";
import { useEnrichRun } from "./useEnrichRun";
import {
  COLUMNS, CONTACTS_EXPORT_PATH, CONTACTS_PATH, DENSITIES, FILTERS, FILTER_DEFAULTS, NAME_COLUMN_MIN, PAGE_SIZES, SAVED_VIEWS_PATH, TABLE_OPTIONS,
  contactsNoun, filterOptions, filterValueLabel, rangeLine, readLayout, sameQuery, viewQuery,
  type ColumnKey, type ContactFacets, type ContactFilters, type ContactRow, type ContactsPage, type FilterKey, type SavedView, type TableLayout,
} from "./model";

const LAYOUT_KEY = "linki.contacts.layout";
const INTEGRATIONS_HREF = navPath("integrations");
const TOOL_BUTTON = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-12 font-medium text-ink transition-colors hover:bg-subtle";

/** Audience → Contacts: everyone the workspace knows, with filters, saved views and actions on a selection. */
export function ContactsScreen() {
  const router = useRouter();
  const can = { member: useCan("member"), manager: useCan("manager") };
  const table = useTableState(TABLE_OPTIONS);
  const [layout, saveLayout] = useStoredPreference<TableLayout>(LAYOUT_KEY, readLayout);

  // ── Selection ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState<{ total: number; capped: boolean } | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const clearSelection = () => { setSelected(new Set()); setAllMatching(null); };
  const ids = useMemo(() => [...selected], [selected]);

  // ── Search: the box is typed into freely and reaches the address bar once it pauses ──
  const [text, setText] = useState(table.search);
  const [pushed, setPushed] = useState(table.search);
  const [seen, setSeen] = useState(table.search);
  if (table.search !== seen) {
    setSeen(table.search);
    // Changed by something other than typing here (a saved view, Clear all, the back button).
    if (table.search !== pushed) setText(table.search);
  }
  const { search: urlSearch, set: setTable } = table;
  useEffect(() => {
    if (text === urlSearch) return;
    const timer = setTimeout(() => {
      setPushed(text);
      setSelected(new Set());
      setTable({ search: text });
    }, 250);
    return () => clearTimeout(timer);
  }, [text, urlSearch, setTable]);

  // ── Data ──
  const facetsRequest = useApi<ContactFacets>(CONTACTS_PATH, { view: "facets" });
  const facets = facetsRequest.data;
  const { data, error, isLoading, mutate } = useApi<ContactsPage>(table.ready ? CONTACTS_PATH : null, { view: "table", ...table.apiQuery });
  const viewsRequest = useApi<{ views: SavedView[] }>(SAVED_VIEWS_PATH, { resource: "contacts" });
  const views = viewsRequest.data?.views ?? [];
  const refresh = () => { void mutate(); void facetsRequest.mutate(); };

  // ── Dialogs ──
  const [adding, setAdding] = useState(false);
  const [listIds, setListIds] = useState<string[] | null>(null);
  const [campaignIds, setCampaignIds] = useState<string[] | null>(null);
  const [tagIds, setTagIds] = useState<string[] | null>(null);
  const [managingTags, setManagingTags] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [extraFilters, setExtraFilters] = useState<FilterKey[]>([]);
  const [exporting, setExporting] = useState(false);

  // ── Enrichment: a run belongs to this page, so it survives its dialog being hidden ──
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [enrichIds, setEnrichIds] = useState<string[]>([]);
  const enrichRun = useEnrichRun(refresh);
  const enrich = enrichRun.progress;
  const enrichRunning = enrichRun.running;

  // ── Filters ──
  const filters = table.filters;
  const narrowed = table.activeFilterCount > 0 || table.search !== "";
  const setFilter = (key: keyof ContactFilters, value: string) => { clearSelection(); table.set({ filters: { [key]: value } }); };
  const clearAll = () => {
    clearSelection();
    setExtraFilters([]);
    setPushed("");
    setText("");
    table.set({ search: "", filters: FILTER_DEFAULTS });
  };
  const shownFilters = FILTERS.filter((def) => def.pinned || filters[def.key] !== "all" || extraFilters.includes(def.key));
  const addable = FILTERS.filter((def) => !shownFilters.includes(def));

  // ── Saved views ──
  const currentQuery = viewQuery(writeTableState(table, TABLE_OPTIONS));
  const currentView = views.find((view) => sameQuery(view.state.query ?? {}, currentQuery) && JSON.stringify(readLayout(view.state.layout)) === JSON.stringify(layout)) ?? null;
  const applyView = (view: SavedView) => {
    clearSelection();
    const query = view.state.query ?? {};
    setPushed(query.q ?? "");
    setText(query.q ?? "");
    saveLayout(readLayout(view.state.layout));
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true, scroll: false });
  };

  // A page past the end (the last rows were deleted, or a link was kept): step back to the last page.
  const { page, pageSize } = table;
  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setTable({ page: Math.max(1, Math.ceil(data.total / pageSize)) });
  }, [data, page, pageSize, setTable]);

  // ── Actions ──
  const listQuery = { ...table.apiQuery, page: undefined, limit: undefined };
  const contextQuery = Object.fromEntries(Object.entries(listQuery).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
  const rememberContext = () => rememberListContext({ query: contextQuery, href: router.asPath });
  const openProfile = (row: ContactRow) => { rememberContext(); void router.push(`/contacts/${row.id}`); };

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

  async function remove(targetIds: string[], name?: string) {
    const ok = await confirm({
      title: name ? `Delete ${name}?` : `Delete ${contactsNoun(targetIds.length)}?`,
      body: `${targetIds.length === 1 ? "This contact is" : "These contacts are"} deleted from Linki altogether, not only from a list, along with ${targetIds.length === 1 ? "its" : "their"} campaign history. This cannot be undone.`,
      confirmLabel: targetIds.length === 1 ? "Delete contact" : `Delete ${contactsNoun(targetIds.length)}`, tone: "danger",
    });
    if (!ok) return;
    try {
      const result = await api<{ deleted: number }>(CONTACTS_PATH, { method: "DELETE", body: { target_ids: targetIds } });
      toast.success(`${contactsNoun(result.deleted)} deleted`);
      clearSelection();
      refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  async function exportCsv(body: Record<string, unknown>) {
    setExporting(true);
    try {
      await downloadFile(CONTACTS_EXPORT_PATH, body, "linki-contacts.csv");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setExporting(false);
    }
  }

  const onRowAction = (action: RowAction, row: ContactRow) => {
    if (action === "list") setListIds([row.id]);
    else if (action === "tag") setTagIds([row.id]);
    else void remove([row.id], row.full_name ?? undefined);
  };

  const openEnrich = () => {
    if (enrichRunning) return setEnrichOpen(true);
    // A run that finished with its window hidden has said so in a toast; start afresh.
    enrichRun.clear();
    if (ids.length === 0) return void toast.message("Select the contacts to enrich first", { description: "Tick them in the table, then choose Enrich selected." });
    setEnrichIds(ids);
    setEnrichOpen(true);
  };
  const closeEnrich = () => {
    setEnrichOpen(false);
    // A run that is over has been read; the next opening starts from a new selection.
    enrichRun.clear();
  };

  // ── Table ──
  const columns = contactColumns({ shown: layout.columns, profileHref: (row) => `/contacts/${row.id}`, canEdit: can.member, onOpen: openProfile, onAction: onRowAction, onVisit: rememberContext });
  const minWidth = NAME_COLUMN_MIN + 40 + (can.member ? 41 : 0) + COLUMNS.filter((column) => layout.columns.includes(column.key)).reduce((sum, column) => sum + column.width, 0);
  const rows = data?.items;
  const total = data?.total ?? 0;
  const pageFullySelected = Boolean(rows?.length) && rows!.every((row) => selected.has(row.id));
  const toggleColumn = (key: ColumnKey, on: boolean) => saveLayout({ ...layout, columns: COLUMNS.map((column) => column.key).filter((candidate) => (candidate === key ? on : layout.columns.includes(candidate))) });

  const listOptions: PickerOption[] = [
    { value: "all", label: "All contacts", aside: facets ? formatCount(facets.total) : undefined },
    { value: "none", label: "In no list" },
    ...(facets?.lists ?? []).map((list, index) => ({ value: list.id, label: list.name, aside: formatCount(list.count), separated: index === 0 })),
  ];
  const currentList = facets?.lists.find((list) => list.id === filters.list_id);
  const listLabel = filters.list_id === "all" ? "All contacts" : filters.list_id === "none" ? "In no list" : currentList?.name ?? (facets ? "A list that is no longer here" : "…");
  const listCount = filters.list_id === "all" ? facets?.total : filters.list_id === "none" ? undefined : currentList?.count;

  return (
    <Page
      title="Contacts"
      meta={
        <>
          {facets ? <Pill>{formatCount(facets.total)} total</Pill> : null}
          {enrichRunning && enrich ? (
            <button type="button" onClick={() => setEnrichOpen(true)} className="rounded-full" aria-label="Show enrichment progress">
              <Pill tone="brand" icon={Sparkles}>Enriching {formatCount(enrich.total - enrich.done)}</Pill>
            </button>
          ) : null}
          {facets && facets.verifying > 0 ? <Pill tone="brand" icon={ShieldCheck}>Verifying {formatCount(facets.verifying)}</Pill> : null}
        </>
      }
      actions={
        <>
          {can.member ? <Button asChild variant="ghost"><Link href={newImportHref(currentList?.id)}><Upload size={14} aria-hidden="true" />Import CSV</Link></Button> : null}
          {can.member ? <Button icon={Sparkles} onClick={openEnrich}>Enrich selected</Button> : null}
          {can.manager ? <Button icon={Download} loading={exporting} disabled={total === 0} onClick={() => void exportCsv(contextQuery)}>Export</Button> : null}
          {can.member ? <Button variant="primary" icon={UserPlus} onClick={() => setAdding(true)} disabled={!facets}>Add contacts</Button> : null}
          {can.member ? <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" /> : null}
        </>
      }
      className="gap-3"
    >
      {/* List, search, and how the table is laid out */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <OptionPicker
            label="Show contacts in" options={listOptions} value={filters.list_id} onChange={(value) => setFilter("list_id", value)} searchPlaceholder="Find a list" width={280} searchable
            trigger={
              <button type="button" className={cn(TOOL_BUTTON, "max-w-[320px] gap-[7px] px-[11px] font-semibold")}>
                <ListChecks size={14} className="shrink-0 text-ink-2" aria-hidden="true" />
                <span className="truncate">{listLabel}</span>
                {listCount !== undefined ? <span className="inline-flex h-[17px] shrink-0 items-center rounded-sm bg-control px-[5px] text-10 font-semibold text-ink-2">{formatCount(listCount)}</span> : null}
                <ChevronDown size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
              </button>
            }
          />
          <SearchInput value={text} onChange={setText} placeholder="Search name, company, title or email" aria-label="Search contacts" frameClassName="w-[252px]" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-11 text-ink-3" aria-live="polite">
            {data ? `${formatCount(total)} ${narrowed || filters.list_id !== "all" ? `matching ${plural(total, "contact", "contacts")}` : plural(total, "contact", "contacts")}` : ""}
          </span>
          <Menu width={212} trigger={<button type="button" className={TOOL_BUTTON}><Columns3 size={14} className="text-ink-2" aria-hidden="true" />Columns</button>}>
            <MenuLabel>Columns</MenuLabel>
            {COLUMNS.map((column) => <MenuCheckItem key={column.key} checked={layout.columns.includes(column.key)} onChange={(on) => toggleColumn(column.key, on)}>{column.label}</MenuCheckItem>)}
            <MenuSeparator />
            <MenuItem icon={Settings2} onSelect={() => setFieldsOpen(true)}>Custom fields</MenuItem>
          </Menu>
          <Menu width={168} trigger={<button type="button" className={TOOL_BUTTON}><AlignJustify size={14} className="text-ink-2" aria-hidden="true" />Density</button>}>
            {DENSITIES.map((density) => (
              <MenuItem key={density.value} icon={layout.density === density.value ? Check : undefined} onSelect={() => saveLayout({ ...layout, density: density.value })}>
                <span className={layout.density === density.value ? undefined : "pl-[21px]"}>{density.label}</span>
              </MenuItem>
            ))}
          </Menu>
        </div>
      </div>

      {/* Filters and saved views */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-[7px]">
          <ListFilter size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
          {shownFilters.map((def) => {
            const value = filters[def.key];
            const active = value !== "all";
            return (
              <span key={def.key} className="inline-flex items-center">
                <OptionPicker
                  label={`Filter by ${def.name.toLowerCase()}`} value={value} onChange={(next) => setFilter(def.key, next)}
                  options={[{ value: "all", label: def.any }, ...filterOptions(def.key, facets)]}
                  searchPlaceholder={`Find a ${def.name.toLowerCase()}`}
                  empty={def.key === "tag" ? "No tag by that name." : "Nothing matches."}
                  footer={def.key === "tag" && (facets?.tags.length ?? 0) > 0 ? (close) => <button type="button" onClick={() => { close(); setManagingTags(true); }} className="text-11 font-semibold text-brand-strong hover:underline">Manage tags</button> : undefined}
                  trigger={<FilterChip name={def.name} value={filterValueLabel(def, value, facets)} active={active} className={!def.pinned && !active ? "rounded-r-none border-r-0" : undefined} />}
                />
                {!def.pinned && !active ? (
                  <button
                    type="button" aria-label={`Remove the ${def.name} filter`} onClick={() => setExtraFilters((current) => current.filter((key) => key !== def.key))}
                    className="inline-flex h-7 w-6 items-center justify-center rounded-r-md border border-line-strong bg-surface text-ink-3 hover:bg-subtle hover:text-ink"
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            );
          })}
          {addable.length > 0 ? (
            <Menu align="start" width={180} trigger={<AddFilterButton />}>
              {addable.map((def) => <MenuItem key={def.key} onSelect={() => setExtraFilters((current) => [...current, def.key])}>{def.name}</MenuItem>)}
            </Menu>
          ) : null}
        </div>
        <div className="flex items-center gap-[9px]">
          {narrowed || filters.list_id !== "all" ? <button type="button" onClick={clearAll} className="text-11 font-semibold text-brand-strong hover:underline">Clear all</button> : null}
          <SavedViews
            resource="contacts" views={views} current={currentView} state={{ query: currentQuery, layout }} canSave={can.member} canShare={can.manager}
            onApply={applyView} onChanged={() => void viewsRequest.mutate()}
          />
        </div>
      </div>

      {can.member ? (
        <BulkBar
          count={selected.size} noun={["contact", "contacts"]} onClear={clearSelection}
          extra={
            allMatching ? (
              <span className="text-11 font-medium text-brand-strong">
                {allMatching.capped ? `The first ${formatCount(selected.size)} of ${formatCount(allMatching.total)} matching` : "Everyone matching is selected"}
              </span>
            ) : pageFullySelected && total > selected.size ? (
              <button type="button" onClick={() => void selectEveryMatch()} disabled={selectingAll} className="inline-flex items-center gap-1.5 text-11 font-semibold text-brand-strong hover:underline disabled:opacity-60">
                {selectingAll ? <Spinner size={11} label="Selecting" /> : null}
                {facets && total > facets.max_selection ? `Select the first ${formatCount(facets.max_selection)} of ${formatCount(total)} matching` : `Select all ${formatCount(total)} matching`}
              </button>
            ) : null
          }
        >
          <Button size="sm" icon={ListPlus} onClick={() => setListIds(ids)}>Add to list</Button>
          <Button size="sm" icon={SendHorizontal} onClick={() => setCampaignIds(ids)}>Add to campaign</Button>
          <Button size="sm" icon={Tag} onClick={() => setTagIds(ids)}>Tag</Button>
          {can.manager ? <Button size="sm" icon={Download} loading={exporting} onClick={() => void exportCsv({ ids })}>Export</Button> : null}
          <Button size="sm" variant="danger" icon={Trash2} className="border-bad font-semibold" onClick={() => void remove(ids)}>Delete</Button>
        </BulkBar>
      ) : null}

      <DataTable
        label="Contacts"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={isLoading}
        error={error && !data ? errorMessage(error) : undefined}
        onRetry={() => void mutate()}
        selected={can.member ? selected : undefined}
        onSelectedChange={can.member ? (next) => { setSelected(next); setAllMatching(null); } : undefined}
        sort={table.sort}
        onSortChange={(sort) => table.set({ sort })}
        onRowClick={openProfile}
        density={layout.density}
        minWidth={minWidth}
        className={cn("transition-opacity", isLoading && data ? "opacity-60" : undefined)}
        empty={
          narrowed || filters.list_id !== "all" ? (
            <EmptyState icon={ListFilter} title="No contacts match" action={<Button size="sm" onClick={clearAll}>Clear filters and search</Button>}>
              Nobody in this workspace fits the list, search and filters together.
            </EmptyState>
          ) : (
            <EmptyState
              icon={Users} title="No contacts yet"
              action={can.member ? <span className="flex gap-2"><Button asChild size="sm"><Link href={newImportHref(currentList?.id)}><Upload size={12} className="text-ink-2" aria-hidden="true" />Import CSV</Link></Button><Button size="sm" variant="primary" icon={UserPlus} onClick={() => setAdding(true)}>Add a contact</Button></span> : undefined}
            >
              Contacts arrive from a CSV file, a Sales Navigator search imported into a list, or by adding them one at a time.
            </EmptyState>
          )
        }
        footer={
          data ? (
            <>
              <span>{rangeLine(data.page, data.limit, data.items.length, data.total)}</span>
              <Pagination page={table.page} pageSize={table.pageSize} total={total} onPageChange={(next) => table.set({ page: next })} pageSizes={PAGE_SIZES} onPageSizeChange={(next) => table.set({ pageSize: next })} />
            </>
          ) : undefined
        }
      />

      <AddContactDialog open={adding} lists={facets?.lists ?? []} listId={currentList?.id ?? null} onClose={() => setAdding(false)} onCreated={refresh} />
      <AddToListDialog ids={listIds} lists={facets?.lists ?? []} onClose={() => setListIds(null)} onDone={refresh} />
      <AddToCampaignDialog ids={campaignIds} campaigns={facets?.campaigns ?? []} canEnrol={can.manager} onClose={() => setCampaignIds(null)} onDone={refresh} />
      <TagDialog ids={tagIds} tags={facets?.tags ?? []} onClose={() => setTagIds(null)} onDone={refresh} onManage={() => { setTagIds(null); setManagingTags(true); }} />
      <ManageTagsDialog open={managingTags} tags={facets?.tags ?? []} canManage={can.manager} onClose={() => setManagingTags(false)} onChanged={refresh} />
      <CustomFieldsDialog open={fieldsOpen} canManage={can.manager} onClose={() => setFieldsOpen(false)} onChanged={() => void facetsRequest.mutate()} />
      <EnrichDialog
        open={enrichOpen} ids={enrichIds} progress={enrich} integrationsHref={INTEGRATIONS_HREF}
        onStart={(eligible, batch) => void enrichRun.start(eligible, batch)} onStop={enrichRun.stop} onClose={closeEnrich}
      />
    </Page>
  );
}
