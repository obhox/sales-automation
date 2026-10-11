import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { ArrowDownWideNarrow, Building2, Download, ListFilter, OctagonAlert, Plus, Target, Upload, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import { Button, Card, EmptyState, ErrorState, Menu, MenuItem, Pill, SearchInput, Skeleton, Spinner, TONE_TINT, confirm } from "@/components/ui";
import { ApiError, api, apiUrl, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
import { NAV, navHref } from "@/lib/client/nav";
import { useCan } from "@/lib/client/roles";
import { useTableState } from "@/lib/client/table-state";
import { AddContactDialog, AddToCampaignDialog } from "@/components/contacts/ContactDialogs";
import { downloadFile } from "@/components/contacts/browser";
import { CONTACTS_PATH, type ContactFacets } from "@/components/contacts/model";
import { AddPeopleDialog, BouncesDialog, CompanyFormDialog, EnrichCompaniesDialog, FindPeopleDialog, ImportCompaniesDialog, type EnrichScope } from "./CompanyDialogs";
import { CompanyDetailPane, CompanyMark, DetailSkeleton, type DetailActions } from "./CompanyDetailPane";
import {
  COMPANIES_PATH, COMPANY_EXPORT_PATH, FILTER_DEFAULTS, FILTER_OPTIONS, PAGE_SIZE, SIGNALS_PATH, SORT_OPTIONS, TABLE_OPTIONS, accountsNoun, bouncesPath, bouncingLine, companyPath, contactsNoun,
  intentTone, rangeLine, reverifyOutcome, subLine, suggestionsPath,
  type CompaniesPage, type CompaniesSummary, type CompanyDetail, type CompanyRow, type CompanySuggestion,
} from "./model";
import { useCompanyEnrichRun } from "./useCompanyEnrichRun";

const hrefOf = (key: string) => navHref(NAV.flatMap((section) => section.items).find((item) => item.key === key)!);
const INTEGRATIONS_HREF = hrefOf("integrations");
const SIGNALS_HREF = hrefOf("signals");

/** Audience → Companies. The list on the left, the chosen company on the right; its id is the last part of the address. */
export function CompaniesScreen() {
  const router = useRouter();
  const { mutate: mutateAny } = useSWRConfig();
  const canEdit = useCan("member");
  const canExport = useCan("manager");
  const table = useTableState(TABLE_OPTIONS);
  const selectedId = Array.isArray(router.query.id) ? router.query.id[0] ?? null : typeof router.query.id === "string" && router.query.id ? router.query.id : null;

  // ── Search ──
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

  // ── Data ──
  const filter = table.filters.filter;
  const sortValue = `${table.sort.key}:${table.sort.direction}`;
  const listQuery = useMemo(() => ({ q: table.search || undefined, filter: filter === "all" ? undefined : filter, sort: sortValue }), [table.search, filter, sortValue]);
  // The list grows a page at a time ("Load more"); what it is filtered and sorted by lives in the address.
  const list = useSWRInfinite<CompaniesPage, ApiError>((index) => (table.ready ? apiUrl(COMPANIES_PATH, { view: "table", ...listQuery, page: index + 1, limit: PAGE_SIZE }) : null));
  const pages = list.data;
  const rows = useMemo(() => pages?.flatMap((page) => page.items) ?? null, [pages]);
  const total = pages?.[0]?.total ?? 0;
  const loadingMore = list.isValidating && pages !== undefined && list.size > pages.length;
  const summary = useApi<CompaniesSummary>(COMPANIES_PATH, { view: "summary" });
  const detailRequest = useApi<CompanyDetail>(selectedId ? companyPath(selectedId) : null, { view: "detail" });
  const detail = detailRequest.data && detailRequest.data.company.id === selectedId ? detailRequest.data : undefined;
  const narrowed = table.search !== "" || filter !== "all";

  // ── Dialogs ──
  const [form, setForm] = useState<"add" | "edit" | null>(null);
  const [importing, setImporting] = useState(false);
  const [enrichScope, setEnrichScope] = useState<EnrichScope | null>(null);
  const [finding, setFinding] = useState(false);
  const [adding, setAdding] = useState<CompanySuggestion[] | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [campaignIds, setCampaignIds] = useState<string[] | null>(null);
  const [addingContact, setAddingContact] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // The campaigns and lists the two contact dialogs offer, asked for when one of them is first opened.
  const [facetsWanted, setFacetsWanted] = useState(false);
  const facets = useApi<ContactFacets>(facetsWanted ? CONTACTS_PATH : null, { view: "facets" }).data;

  const { mutate: mutateList } = list;
  const { mutate: mutateSummary } = summary;
  const { mutate: mutateDetail } = detailRequest;
  const refresh = useCallback(() => { void mutateList(); void mutateSummary(); void mutateDetail(); }, [mutateList, mutateSummary, mutateDetail]);
  const enrichRun = useCompanyEnrichRun(refresh);

  const hrefFor = useCallback((id: string | null) => {
    const { id: _gone, ...rest } = router.query;
    void _gone;
    return { pathname: router.pathname, query: id ? { ...rest, id: [id] } : rest };
  }, [router.pathname, router.query]);
  const select = useCallback((id: string | null, how: "push" | "replace" = "push") => {
    void router[how](hrefFor(id), undefined, { shallow: true, scroll: false });
  }, [router, hrefFor]);

  // With nothing chosen, the first company in the list is opened.
  const firstId = rows?.[0]?.id ?? null;
  useEffect(() => {
    if (!selectedId && firstId && router.isReady) select(firstId, "replace");
  }, [selectedId, firstId, router.isReady, select]);

  /** Run one request against the chosen company, say what happened, and read everything again. */
  async function run(key: string, work: () => Promise<{ title: string; description?: string } | void>) {
    setBusy(key);
    try {
      const said = await work();
      if (said) toast.success(said.title, { description: said.description });
      refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  function startEnrich(scope: EnrichScope) {
    if (!enrichRun.running) enrichRun.clear();
    setEnrichScope(scope);
  }

  async function exportCsv() {
    setBusy("export");
    try {
      await downloadFile(COMPANY_EXPORT_PATH, listQuery, "linki-companies.csv");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const clearAll = () => { setPushed(""); setText(""); table.set({ search: "", filters: FILTER_DEFAULTS }); };
  const company = detail?.company;
  const companyRef = company ? { id: company.id, name: company.name, domain: company.domain } : null;

  const actions: DetailActions | null = !detail || !company ? null : {
    onReviewBounces: () => setReviewing(true),
    onReverify: () => void run("reverify", async () => reverifyOutcome(await api<{ queued: number; restored: number }>(bouncesPath(company.id), { method: "POST", body: { action: "reverify" } }))),
    onEnrich: () => startEnrich({ ids: [company.id], name: company.name }),
    onAddToCampaign: () => void (async () => {
      setFacetsWanted(true);
      // The card shows the first fifty; a campaign takes everyone here.
      if (detail.contacts.total <= detail.contacts.items.length) return setCampaignIds(detail.contacts.items.map((contact) => contact.id));
      try {
        setCampaignIds((await api<{ ids: string[] }>(CONTACTS_PATH, { query: { view: "ids", company_id: company.id } })).ids);
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    })(),
    onToggleTarget: () => void run("target", async () => {
      await api(companyPath(company.id), { method: "PUT", body: { is_target: !company.is_target } });
      return { title: company.is_target ? `${company.name} is no longer a target account` : `${company.name} marked as a target account` };
    }),
    onEdit: () => setForm("edit"),
    onDelete: () => void (async () => {
      const ok = await confirm({
        title: `Delete ${company.name}?`,
        body: `${detail.contacts.total > 0 ? `Its ${contactsNoun(detail.contacts.total)} stay in Linki and are no longer linked to a company. ` : ""}Its signals and suggested people go with it. This cannot be undone.`,
        confirmLabel: "Delete company", tone: "danger",
      });
      if (!ok) return;
      try {
        await api(companyPath(company.id), { method: "DELETE" });
        toast.success(`${company.name} deleted`);
        select(null, "replace");
        void mutateList();
        void mutateSummary();
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    })(),
    onAddContact: () => { setFacetsWanted(true); setAddingContact(true); },
    onFindPeople: () => setFinding(true),
    onAddPeople: (people) => setAdding(people),
    onDismissPerson: (person) => void run(`dismiss:${person.id}`, async () => {
      await api(suggestionsPath(company.id), { method: "POST", body: { action: "dismiss", ids: [person.id] } });
    }),
    onHandleSignals: (ids) => void run("signals", async () => {
      const { changed } = await api<{ changed: number }>(SIGNALS_PATH, { method: "PATCH", body: ids ? { ids, handled: true } : { company_id: company.id, handled: true } });
      // The sidebar counts the signals nobody has dealt with.
      void mutateAny("/api/shell");
      if (!ids) return { title: `${formatCount(changed)} ${changed === 1 ? "signal" : "signals"} marked as handled` };
    }),
  };

  const missing = detailRequest.error instanceof ApiError && detailRequest.error.status === 404;
  const bouncing = summary.data?.bouncing ?? 0;

  return (
    <Page
      title="Companies" padded={false}
      meta={
        summary.data ? (
          <>
            <Pill>{accountsNoun(summary.data.total)}</Pill>
            {bouncing > 0 ? (
              <button type="button" onClick={() => table.set({ filters: { filter: filter === "bouncing" ? "all" : "bouncing" } })} aria-pressed={filter === "bouncing"} title={filter === "bouncing" ? "Show every company" : "Show only these"} className="rounded-full">
                <Pill tone="bad" icon={OctagonAlert}>{bouncingLine(bouncing)}</Pill>
              </button>
            ) : null}
          </>
        ) : null
      }
      actions={
        <>
          {canEdit ? <Button variant="ghost" icon={Upload} onClick={() => setImporting(true)}>Import</Button> : null}
          {canEdit ? <Button icon={WandSparkles} disabled={total === 0 && !enrichRun.running} onClick={() => startEnrich({ q: table.search, filter })}>Re-enrich all</Button> : null}
          {canExport ? <Button icon={Download} loading={busy === "export"} disabled={total === 0} onClick={() => void exportCsv()}>Export</Button> : null}
          {canEdit ? <Button variant="primary" icon={Plus} onClick={() => setForm("add")}>Add company</Button> : null}
          {canEdit || canExport ? <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" /> : null}
        </>
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5 lg:flex-row lg:overflow-hidden">
        {/* ── The list ── */}
        <Card className="flex max-h-[420px] min-h-[260px] shrink-0 flex-col overflow-hidden shadow-none lg:max-h-none lg:w-[380px]">
          <div className="flex h-[45.5px] shrink-0 items-center gap-2 border-b border-line px-3">
            <SearchInput value={text} onChange={setText} placeholder="Search companies or domains" aria-label="Search companies or domains" frameClassName="h-[30px] min-w-0 flex-1" />
            <Menu
              width={170}
              trigger={
                <button type="button" aria-label={`Sorted by ${SORT_OPTIONS.find((option) => option.value === sortValue)?.label ?? "intent"}. Change the order`} className="inline-flex h-[30px] shrink-0 items-center gap-[5px] rounded-md border border-line-strong bg-surface px-[9px] text-11 font-medium text-ink hover:bg-subtle">
                  <ArrowDownWideNarrow size={12} className="text-ink-2" aria-hidden="true" />
                  {SORT_OPTIONS.find((option) => option.value === sortValue)?.label ?? "Intent"}
                </button>
              }
            >
              {SORT_OPTIONS.map((option) => {
                const [key, direction] = option.value.split(":");
                return <MenuItem key={option.value} onSelect={() => table.set({ sort: { key, direction: direction === "asc" ? "asc" : "desc" } })}>{option.label}</MenuItem>;
              })}
            </Menu>
          </div>
          <div role="group" aria-label="Show" className="flex h-[39.5px] shrink-0 items-center gap-[5px] overflow-x-auto border-b border-line bg-subtle px-3">
            {FILTER_OPTIONS.map((option) => {
              const active = filter === option.value;
              return (
                <button
                  key={option.value} type="button" aria-pressed={active} onClick={() => table.set({ filters: { filter: option.value } })}
                  className={cn("inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-11", active ? "border-brand-tint bg-brand-tint font-semibold text-brand-strong" : "border-line bg-surface font-medium text-ink-2 hover:bg-control")}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={list.isLoading}>
            {list.error && !rows ? (
              <ErrorState message={errorMessage(list.error)} onRetry={() => void list.mutate()} />
            ) : !rows ? (
              <ul aria-label="Loading companies">{Array.from({ length: 9 }, (_, index) => <li key={index} className="flex h-[51.5px] items-center gap-2.5 border-b border-line px-3"><Skeleton className="size-[30px] rounded-md" /><span className="flex flex-1 flex-col gap-1.5"><Skeleton className="h-3 w-2/5" /><Skeleton className="h-2.5 w-3/5" /></span></li>)}</ul>
            ) : rows.length === 0 ? (
              narrowed ? (
                <EmptyState icon={ListFilter} title="No company matches" action={<Button size="sm" onClick={clearAll}>Clear search and filter</Button>}>Nothing fits the search and the filter together.</EmptyState>
              ) : (
                <EmptyState icon={Building2} title="No companies yet" action={canEdit ? <span className="flex gap-2"><Button size="sm" icon={Plus} onClick={() => setForm("add")}>Add company</Button><Button size="sm" icon={Upload} onClick={() => setImporting(true)}>Import a CSV</Button></span> : undefined}>
                  Companies arrive when a contact is enriched, or add them here.
                </EmptyState>
              )
            ) : (
              <ul aria-label="Companies" className={cn("transition-opacity", list.isValidating && !loadingMore && pages && pages.length === 1 ? "opacity-70" : undefined)}>
                {rows.map((row) => <CompanyListRow key={row.id} row={row} selected={row.id === selectedId} href={hrefFor(row.id)} />)}
              </ul>
            )}
          </div>

          <div className="flex h-[35.5px] shrink-0 items-center justify-between border-t border-line bg-subtle px-3">
            <span className="text-11 text-ink-3" aria-live="polite">{rows ? rangeLine(rows.length, total) : ""}</span>
            {rows && rows.length < total ? (
              <button type="button" onClick={() => void list.setSize(list.size + 1)} disabled={loadingMore} className="inline-flex items-center gap-1.5 text-11 font-semibold text-brand-strong hover:underline disabled:opacity-60">
                {loadingMore ? <Spinner size={11} label="Loading more" /> : null}
                Load more
              </button>
            ) : null}
          </div>
        </Card>

        {/* ── The chosen company ── */}
        <section aria-label={company ? company.name : "Company"} className="flex min-w-0 flex-1 flex-col gap-3.5 lg:overflow-y-auto">
          {!selectedId ? (
            rows && rows.length === 0 ? null : <DetailSkeleton />
          ) : missing ? (
            <Card className="shadow-none"><EmptyState icon={Building2} title="This company is not here">It may have been deleted, or it belongs to another workspace.</EmptyState></Card>
          ) : detailRequest.error && !detail ? (
            <Card className="shadow-none"><ErrorState message={errorMessage(detailRequest.error)} onRetry={() => void detailRequest.mutate()} /></Card>
          ) : !detail || !actions ? (
            <DetailSkeleton />
          ) : (
            <CompanyDetailPane key={detail.company.id} detail={detail} canEdit={canEdit} busy={busy} signalsHref={SIGNALS_HREF} actions={actions} />
          )}
        </section>
      </div>

      <CompanyFormDialog open={form !== null} company={form === "edit" ? company ?? null : null} onClose={() => setForm(null)} onSaved={(id) => { refresh(); if (id !== selectedId) select(id); }} />
      <ImportCompaniesDialog open={importing} onClose={() => setImporting(false)} onImported={refresh} />
      <EnrichCompaniesDialog
        scope={enrichScope} progress={enrichRun.progress} integrationsHref={INTEGRATIONS_HREF}
        onStart={(ids, batch) => void enrichRun.start(ids, batch)} onStop={enrichRun.stop} onClose={() => { setEnrichScope(null); enrichRun.clear(); }}
      />
      <FindPeopleDialog company={finding ? companyRef : null} integrationsHref={INTEGRATIONS_HREF} onClose={() => setFinding(false)} onDone={refresh} />
      {companyRef ? <AddPeopleDialog company={companyRef} people={adding} integrationsHref={INTEGRATIONS_HREF} onClose={() => setAdding(null)} onDone={refresh} /> : null}
      <BouncesDialog company={reviewing ? companyRef : null} canEdit={canEdit} onClose={() => setReviewing(false)} onChanged={refresh} />
      <AddToCampaignDialog ids={campaignIds} campaigns={facets?.campaigns ?? []} canEnrol={canExport} onClose={() => setCampaignIds(null)} onDone={refresh} />
      <AddContactDialog open={addingContact} lists={facets?.lists ?? []} listId={null} company={companyRef} onClose={() => setAddingContact(false)} onCreated={refresh} />
    </Page>
  );
}

function CompanyListRow({ row, selected, href }: { row: CompanyRow; selected: boolean; href: { pathname: string; query: Record<string, string | string[] | undefined> } }) {
  const tone = intentTone(row.intent);
  return (
    <li className="border-b border-line">
      <Link
        href={href} shallow scroll={false} aria-current={selected ? "true" : undefined}
        className={cn("flex h-[51.5px] items-center gap-2.5 px-3 focus-visible:outline-offset-[-2px]", selected ? "bg-brand-tint" : "hover:bg-subtle")}
      >
        <CompanyMark name={row.name} size={30} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-12 font-semibold tracking-[-0.1px] text-ink">{row.name}</span>
            {row.is_target ? <Target size={11} className="shrink-0 text-brand" aria-label="Target account" /> : null}
            {row.bouncing ? <OctagonAlert size={11} className="shrink-0 text-bad" aria-label="Email is bouncing" /> : null}
          </span>
          <span className="truncate text-105 text-ink-3">{subLine(row)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-[3px]">
          <span className={cn("inline-flex h-[18px] items-center rounded-full px-[7px] text-10 font-bold tabular-nums", TONE_TINT[tone])} title={`Intent ${row.intent}`}><span className="sr-only">Intent </span>{row.intent}</span>
          <span className="text-10 text-ink-3">{contactsNoun(row.contacts)}</span>
        </span>
      </Link>
    </li>
  );
}
