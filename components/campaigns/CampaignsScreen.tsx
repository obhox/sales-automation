import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { Archive, ArchiveRestore, ArrowDownUp, Columns3, Copy, Download, Ellipsis, Pause, Pencil, Play, Plus, Radio, Trash2, Upload, User } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import {
  Avatar, BulkBar, Button, CellStack, ChannelBadge, DataTable, EmptyState, IconButton, Menu, MenuCheckItem, MenuItem, MenuLabel, MenuSeparator,
  Meter, Pagination, Pill, SearchInput, Segmented, Select, confirm, type Column,
} from "@/components/ui";
import { api, apiUrl, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount, formatPercent, formatRelative, plural } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import { useDebounced, useTableState } from "@/lib/client/table-state";
import { NewCampaignDialog } from "./NewCampaignDialog";
import {
  LIST_PATH, OPTIONAL_COLUMNS, SORT_OPTIONS, STATUS_LABEL, STATUS_TONE, audienceLine, bulkOutcome, campaignHref, defaultDirection, hiddenColumnsFrom, sequenceHref, statusTabs,
  type BulkAction, type BulkResult, type CampaignList, type CampaignSort, type CampaignSummary, type OptionalColumn, type StatusTab,
} from "./model";

const HIDDEN_COLUMNS_KEY = "linki.campaigns.hidden-columns";
const FILTERS = { status: "all", channel: "all", owner: "all" };

/** Outreach → Campaigns: every campaign with where it stands and what has come of it. */
export function CampaignsScreen() {
  const router = useRouter();
  const can = { member: useCan("member"), manager: useCan("manager") };
  const table = useTableState({ pageSize: 25, sort: { key: "last_activity", direction: "desc" }, filters: FILTERS });
  const [search, setSearch] = useState<string | null>(null);
  const typed = search ?? table.search;
  const settledSearch = useDebounced(typed);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<OptionalColumn[]>([]);
  const [creating, setCreating] = useState(false);
  const [working, setWorking] = useState(false);

  // The search box writes to the address bar once typing has stopped.
  useEffect(() => {
    if (table.ready && search !== null && settledSearch === search && settledSearch !== table.search) table.set({ search: settledSearch });
  }, [settledSearch]); // eslint-disable-line react-hooks/exhaustive-deps
  // Read after the first paint: the server does not know which columns this browser hides.
  useEffect(() => {
    try {
      setHidden(hiddenColumnsFrom(JSON.parse(window.localStorage.getItem(HIDDEN_COLUMNS_KEY) ?? "[]")));
    } catch {
      // Nothing stored, or nothing readable: every column shows.
    }
  }, []);

  const { data, error, isLoading, mutate } = useApi<CampaignList>(table.ready ? LIST_PATH : null, { view: "list", ...table.apiQuery }, { keepPreviousData: true });
  const rows = data?.items;
  const names = new Map((rows ?? []).map((campaign) => [campaign.id, campaign.name]));
  const status = table.filters.status as StatusTab;
  const filtered = table.search !== "" || table.activeFilterCount > 0;
  // "New campaign" in the sidebar and the command palette lands here with ?new=1.
  const wantsNew = router.query.new === "1";

  function toggleColumn(key: OptionalColumn, show: boolean) {
    const next = show ? hidden.filter((column) => column !== key) : [...hidden, key];
    setHidden(next);
    try {
      window.localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify(next));
    } catch {
      // Private browsing: the choice lasts until the page is closed.
    }
  }

  function clearFilters() {
    setSearch("");
    table.set({ search: "", filters: FILTERS });
  }

  function closeNew() {
    setCreating(false);
    if (wantsNew) {
      const rest = Object.fromEntries(Object.entries(router.query).filter(([key]) => key !== "new"));
      void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
    }
  }

  async function act(action: BulkAction, ids: string[]) {
    if (ids.length === 0 || working) return;
    if (action === "archive") {
      const ok = await confirm({
        title: ids.length === 1 ? `Archive ${names.get(ids[0]) ?? "this campaign"}?` : `Archive ${ids.length} campaigns?`,
        body: "An archived campaign leaves this list. Its contacts, history and figures are kept, and it can be brought back from the Archived tab. A campaign that is still running is left as it is: pause it first.",
        confirmLabel: "Archive",
        tone: "danger",
      });
      if (!ok) return;
    }
    setWorking(true);
    try {
      const result = await api<BulkResult>("/api/workflows/bulk", { method: "POST", body: { action, ids } });
      const outcome = bulkOutcome(action, result, names);
      if (outcome.ok) toast.success(outcome.ok);
      for (const problem of outcome.problems.slice(0, 3)) toast.error(problem);
      if (outcome.problems.length > 3) toast.error(`${outcome.problems.length - 3} more could not be changed`);
      setSelected(new Set());
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(false);
      void mutate();
    }
  }

  async function remove(campaign: CampaignSummary) {
    const ok = await confirm({
      title: `Delete ${campaign.name}?`,
      body: `This removes the campaign, its steps and the record of every contact it reached${campaign.status === "active" ? ", and stops it sending" : ""}. It cannot be undone. To take it out of this list and keep its history, archive it instead.`,
      confirmLabel: "Delete campaign",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/api/workflows/${campaign.id}`, { method: "DELETE" });
      toast.success(`${campaign.name} was deleted`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      void mutate();
    }
  }

  const columns: Column<CampaignSummary>[] = [
    {
      key: "name", header: "Campaign", sortKey: "name",
      // A real link, so the campaign can be reached by keyboard and opened in another tab.
      cell: (campaign) => (
        <CellStack
          title={<Link href={campaignHref(campaign.id)} onClick={(event) => event.stopPropagation()} className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand">{campaign.name}</Link>}
          sub={audienceLine(campaign)}
        />
      ),
    },
    {
      key: "status", header: "Status", width: 108,
      cell: (campaign) => <Pill tone={STATUS_TONE[campaign.status]} dot={campaign.status === "active"}>{STATUS_LABEL[campaign.status]}</Pill>,
    },
    {
      key: "channels", header: "Channels", width: 88,
      cell: (campaign) => (
        <span className="flex items-center gap-[5px]">
          {campaign.channels.length === 0 ? <span className="text-115 text-ink-3">—</span> : campaign.channels.map((channel) => <ChannelBadge key={channel} channel={channel} />)}
        </span>
      ),
    },
    {
      key: "enrolled", header: "Enrolled / done", width: 124, sortKey: "enrolled",
      cell: (campaign) => (
        <span className="flex items-baseline gap-1 whitespace-nowrap">
          <span className="text-125 font-semibold text-ink">{formatCount(campaign.enrolled)}</span>
          <span className="text-11 text-ink-3">/ {formatCount(campaign.done)}</span>
        </span>
      ),
    },
    {
      key: "reply_rate", header: "Reply rate", width: 100, sortKey: "reply_rate",
      cell: (campaign) => <Rate value={campaign.reply_rate} tone="mail" label={`${formatCount(campaign.replied)} of ${formatCount(campaign.contacted)} contacted replied`} />,
    },
    {
      key: "acceptance", header: "Acceptance", width: 104, sortKey: "acceptance",
      cell: (campaign) => <Rate value={campaign.acceptance_rate} tone="li" label={`${formatCount(campaign.accepted)} of ${formatCount(campaign.invited)} invited accepted`} />,
    },
    {
      key: "owner", header: "Owner", width: 140,
      cell: (campaign) => campaign.owner ? (
        <span className="flex min-w-0 items-center gap-[7px]">
          <Avatar name={campaign.owner.name} size={22} />
          <span className="truncate text-115 font-medium text-ink-2">{campaign.owner.name}</span>
        </span>
      ) : <span className="text-115 text-ink-3">Nobody</span>,
    },
    {
      key: "last_activity", header: "Last activity", width: 112, sortKey: "last_activity",
      cell: (campaign) => <span className="whitespace-nowrap text-115 text-ink-2">{formatRelative(campaign.last_activity_at)}</span>,
    },
    {
      key: "menu", header: <span className="sr-only">Actions</span>, width: 46,
      cell: (campaign) => (
        // The row itself opens the campaign; the menu must not.
        <span className="flex justify-end" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Menu align="end" width={196} trigger={<IconButton icon={Ellipsis} label={`Actions for ${campaign.name}`} size={22} />}>
            {can.manager && campaign.status === "paused" ? <MenuItem icon={Play} onSelect={() => void act("resume", [campaign.id])}>Resume campaign</MenuItem> : null}
            <MenuItem icon={Pencil} onSelect={() => void router.push(sequenceHref(campaign.id))}>{can.member ? "Edit sequence" : "View sequence"}</MenuItem>
            {can.member ? <MenuItem icon={Copy} onSelect={() => void act("duplicate", [campaign.id])}>Duplicate</MenuItem> : null}
            {can.manager ? <MenuItem icon={Download} onSelect={() => window.location.assign(apiUrl("/api/export/prospects", { workflow_id: campaign.id }))}>Export prospects</MenuItem> : null}
            {can.member ? <MenuSeparator /> : null}
            {can.manager && campaign.status === "active" ? <MenuItem icon={Pause} onSelect={() => void act("pause", [campaign.id])}>Pause</MenuItem> : null}
            {can.member && campaign.status === "archived" ? <MenuItem icon={ArchiveRestore} onSelect={() => void act("unarchive", [campaign.id])}>Bring back</MenuItem> : null}
            {can.member && campaign.status !== "archived" ? <MenuItem icon={Archive} tone="danger" onSelect={() => void act("archive", [campaign.id])}>Archive</MenuItem> : null}
            {can.member ? <MenuItem icon={Trash2} tone="danger" onSelect={() => void remove(campaign)}>Delete</MenuItem> : null}
          </Menu>
        </span>
      ),
    },
  ];
  const shown = columns.filter((column) => !hidden.includes(column.key as OptionalColumn));
  const chosen = [...selected].filter((id) => names.has(id));

  return (
    <Page
      title="Campaigns"
      meta={data ? (
        <>
          <Pill>{formatCount(data.counts.all)} total</Pill>
          {data.counts.active > 0 ? <Pill tone="good" dot>{formatCount(data.counts.active)} running</Pill> : null}
        </>
      ) : null}
      actions={
        <>
          {can.member ? (
            <Button variant="ghost" asChild>
              <Link href="/lists"><Upload size={14} aria-hidden="true" />Import prospects</Link>
            </Button>
          ) : null}
          {can.manager ? (
            <Button asChild>
              <a href={apiUrl("/api/export/campaigns", { ...table.apiQuery, page: undefined, limit: undefined })} download>
                <Download size={14} className="text-ink-2" aria-hidden="true" />Export
              </a>
            </Button>
          ) : null}
          {can.member ? <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New campaign</Button> : null}
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={typed} onChange={setSearch} placeholder="Search campaigns" frameClassName="w-[230px]" />
          <Segmented label="Status" value={status} onChange={(value) => table.set({ filters: { status: value } })} options={statusTabs(data?.counts, status)} />
          <Select
            label="Channel" icon={Radio} value={table.filters.channel} onChange={(value) => table.set({ filters: { channel: value } })}
            options={[{ value: "all", label: "All channels" }, { value: "linkedin", label: "LinkedIn" }, { value: "email", label: "Email" }]}
          />
          <Select
            label="Owner" icon={User} value={table.filters.owner} onChange={(value) => table.set({ filters: { owner: value } })}
            options={[{ value: "all", label: "All owners" }, ...(data?.owners ?? []).map((owner) => ({ value: owner.id, label: owner.name })), { value: "none", label: "No owner" }]}
          />
        </div>
        <div className="flex items-center gap-2">
          <Select
            label="Sort by" icon={ArrowDownUp} value={table.sort.key as CampaignSort}
            onChange={(value) => table.set({ sort: { key: value, direction: defaultDirection(value) } })}
            options={SORT_OPTIONS}
          />
          <Menu align="end" width={188} trigger={<IconButton icon={Columns3} label="Choose columns" variant="outline" />}>
            <MenuLabel>Columns</MenuLabel>
            {OPTIONAL_COLUMNS.map((column) => (
              <MenuCheckItem key={column.key} checked={!hidden.includes(column.key)} onChange={(show) => toggleColumn(column.key, show)}>{column.label}</MenuCheckItem>
            ))}
          </Menu>
        </div>
      </div>

      <BulkBar count={chosen.length} noun={["campaign", "campaigns"]} onClear={() => setSelected(new Set())}>
        {can.manager && status !== "archived" ? <Button size="sm" icon={Pause} disabled={working} onClick={() => void act("pause", chosen)}>Pause</Button> : null}
        {can.manager && status !== "archived" ? <Button size="sm" icon={Play} disabled={working} onClick={() => void act("resume", chosen)}>Resume</Button> : null}
        <Button size="sm" icon={Copy} disabled={working} onClick={() => void act("duplicate", chosen)}>Duplicate</Button>
        {status === "archived"
          ? <Button size="sm" icon={ArchiveRestore} disabled={working} onClick={() => void act("unarchive", chosen)}>Bring back</Button>
          : <Button size="sm" variant="danger" icon={Archive} disabled={working} onClick={() => void act("archive", chosen)}>Archive</Button>}
      </BulkBar>

      <DataTable
        label="Campaigns" columns={shown} rows={rows} rowKey={(campaign) => campaign.id}
        loading={isLoading || !table.ready} error={error && !data ? errorMessage(error) : undefined} onRetry={() => void mutate()}
        selected={can.member ? selected : undefined} onSelectedChange={can.member ? setSelected : undefined}
        sort={table.sort} onSortChange={(sort) => table.set({ sort })}
        onRowClick={(campaign) => void router.push(campaignHref(campaign.id))}
        empty={filtered ? (
          <EmptyState title="No campaign matches" action={<Button onClick={clearFilters}>Clear the filters</Button>}>
            Nothing fits the search and filters above.
          </EmptyState>
        ) : (
          <EmptyState title="No campaigns yet" action={can.member ? <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New campaign</Button> : undefined}>
            A campaign is a sequence of LinkedIn and email steps run over a list of contacts.
          </EmptyState>
        )}
        footer={data ? (
          <>
            <span>Showing {formatCount(data.items.length)} of {formatCount(data.total)} {plural(data.total, "campaign", "campaigns")}</span>
            <Pagination
              page={data.page} pageSize={data.limit} total={data.total} onPageChange={(page) => table.set({ page })}
              pageSizes={[25, 50, 100]} onPageSizeChange={(pageSize) => table.set({ pageSize })}
            />
          </>
        ) : undefined}
      />

      <NewCampaignDialog open={can.member && (creating || wantsNew)} onClose={closeNew} />
    </Page>
  );
}

/** A rate with the thin bar under it. Nothing sent yet shows as a dash, not as 0%. */
function Rate({ value, tone, label }: { value: number | null; tone: "mail" | "li"; label: string }) {
  if (value === null) return <span className="text-125 text-ink-3" title="Nothing sent yet">—</span>;
  return (
    <span className="flex flex-col gap-[5px]" title={label}>
      <span className="text-125 font-semibold text-ink">{formatPercent(value)}</span>
      <Meter value={value * 100} tone={tone} height={3} className="w-14" label={label} />
    </span>
  );
}
