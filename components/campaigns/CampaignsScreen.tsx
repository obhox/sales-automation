import { useEffect, useState } from "react";
import Link from "next/link";
import {useTranslations} from "next-intl";
import { useRouter } from "next/router";
import { Archive, ArchiveRestore, ArrowDownUp, Columns3, Copy, Download, Ellipsis, Pause, Pencil, Play, Plus, Radio, Rocket, Trash2, Upload, User } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import {
  Avatar, BulkBar, Button, CellStack, ChannelBadge, DataTable, EmptyState, IconButton, Menu, MenuCheckItem, MenuItem, MenuLabel, MenuSeparator,
  Meter, Pagination, Pill, SearchInput, Segmented, Select, confirm, type Column,
} from "@/components/ui";
import { api, apiUrl, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount, formatPercent, formatRelative } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import { useDebounced, useTableState } from "@/lib/client/table-state";
import { CampaignWizard } from "./wizard/CampaignWizard";
import {
  LIST_PATH, OPTIONAL_COLUMNS, SORT_OPTIONS, STATUS_TONE, audienceLine, bulkOutcome, campaignHref, defaultDirection, hiddenColumnsFrom, sequenceHref, statusTabs,
  type BulkAction, type BulkResult, type CampaignList, type CampaignSort, type CampaignSummary, type OptionalColumn, type StatusTab,
} from "./model";

const HIDDEN_COLUMNS_KEY = "linki.campaigns.hidden-columns";
const FILTERS = { status: "all", channel: "all", owner: "all" };

/** Outreach → Campaigns: every campaign with where it stands and what has come of it. */
export function CampaignsScreen() {
  const t = useTranslations("Campaigns");
  const states: Record<StatusTab, string> = {all:t("statuses.all"), active:t("statuses.active"), paused:t("statuses.paused"), draft:t("statuses.draft"), completed:t("statuses.completed"), archived:t("statuses.archived")};
  const sortNames: Record<CampaignSort, string> = {last_activity:t("sort.last_activity"), name:t("sort.name"), created:t("sort.created"), enrolled:t("sort.enrolled"), reply_rate:t("sort.reply_rate"), acceptance:t("sort.acceptance")};
  const columnNames: Record<OptionalColumn, string> = {status:t("table.status"), channels:t("table.channels"), enrolled:t("table.enrolled"), reply_rate:t("table.replyRate"), acceptance:t("table.acceptance"), owner:t("table.owner"), last_activity:t("table.lastActivity")};
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
  // "New campaign" in the sidebar and the command palette lands here with ?new=1; a draft
  // being set up is ?setup=<id>, so a reload picks the wizard up where it was.
  const wantsNew = router.query.new === "1";
  const settingUp = typeof router.query.setup === "string" ? router.query.setup : null;

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

  function closeWizard() {
    setCreating(false);
    if (wantsNew || settingUp) {
      const rest = Object.fromEntries(Object.entries(router.query).filter(([key]) => key !== "new" && key !== "setup"));
      void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
    }
    void mutate();
  }
  const setUp = (id: string) => void router.replace({ pathname: router.pathname, query: { ...router.query, setup: id } }, undefined, { shallow: true });

  async function act(action: BulkAction, ids: string[]) {
    if (ids.length === 0 || working) return;
    if (action === "archive") {
      const ok = await confirm({
        title: ids.length === 1 ? t("confirm.archiveOne", {name: names.get(ids[0]) ?? t("campaign")}) : t("confirm.archiveMany", {count: ids.length}),
        body: t("confirm.archiveBody"),
        confirmLabel: t("archive"),
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
      if (outcome.problems.length > 3) toast.error(t("confirm.moreFailed", {count: outcome.problems.length - 3}));
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
      title: t("confirm.deleteTitle", {name: campaign.name}),
      body: t("confirm.deleteBody", {stopping: campaign.status === "active" ? t("confirm.deleteStop") : ""}),
      confirmLabel: t("confirm.deleteCampaign"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/api/workflows/${campaign.id}`, { method: "DELETE" });
      toast.success(t("confirm.deleted", {name: campaign.name}));
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      void mutate();
    }
  }

  const columns: Column<CampaignSummary>[] = [
    {
      key: "name", header: t("table.campaign"), sortKey: "name",
      // A real link, so the campaign can be reached by keyboard and opened in another tab.
      cell: (campaign) => (
        <CellStack
          title={<Link href={campaign.status === "draft" && can.member ? `/campaigns?setup=${campaign.id}` : campaignHref(campaign.id)} onClick={(event) => event.stopPropagation()} className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand">{campaign.name}</Link>}
          sub={audienceLine(campaign)}
        />
      ),
    },
    {
      key: "status", header: t("table.status"), width: 108,
      cell: (campaign) => <Pill tone={STATUS_TONE[campaign.status]} dot={campaign.status === "active"}>{states[campaign.status]}</Pill>,
    },
    {
      key: "channels", header: t("table.channels"), width: 88,
      cell: (campaign) => (
        <span className="flex items-center gap-[5px]">
          {campaign.channels.length === 0 ? <span className="text-115 text-ink-3">—</span> : campaign.channels.map((channel) => <ChannelBadge key={channel} channel={channel} />)}
        </span>
      ),
    },
    {
      key: "enrolled", header: t("table.enrolled"), width: 124, sortKey: "enrolled",
      cell: (campaign) => (
        <span className="flex items-baseline gap-1 whitespace-nowrap">
          <span className="text-125 font-semibold text-ink">{formatCount(campaign.enrolled)}</span>
          <span className="text-11 text-ink-3">/ {formatCount(campaign.done)}</span>
        </span>
      ),
    },
    {
      key: "reply_rate", header: t("table.replyRate"), width: 100, sortKey: "reply_rate",
      cell: (campaign) => <Rate value={campaign.reply_rate} tone="mail" label={t("labelReply", {replied: formatCount(campaign.replied), contacted: formatCount(campaign.contacted)})} />,
    },
    {
      key: "acceptance", header: t("table.acceptance"), width: 104, sortKey: "acceptance",
      cell: (campaign) => <Rate value={campaign.acceptance_rate} tone="li" label={t("labelAccepted", {accepted: formatCount(campaign.accepted), invited: formatCount(campaign.invited)})} />,
    },
    {
      key: "owner", header: t("table.owner"), width: 140,
      cell: (campaign) => campaign.owner ? (
        <span className="flex min-w-0 items-center gap-[7px]">
          <Avatar name={campaign.owner.name} size={22} />
          <span className="truncate text-115 font-medium text-ink-2">{campaign.owner.name}</span>
        </span>
      ) : <span className="text-115 text-ink-3">{t("noOwnerCell")}</span>,
    },
    {
      key: "last_activity", header: t("table.lastActivity"), width: 112, sortKey: "last_activity",
      cell: (campaign) => <span className="whitespace-nowrap text-115 text-ink-2">{formatRelative(campaign.last_activity_at)}</span>,
    },
    {
      key: "menu", header: <span className="sr-only">{t("actions")}</span>, width: 46,
      cell: (campaign) => (
        // The row itself opens the campaign; the menu must not.
        <span className="flex justify-end" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Menu align="end" width={196} trigger={<IconButton icon={Ellipsis} label={`Actions for ${campaign.name}`} size={22} />}>
            {can.member && campaign.status === "draft" ? <MenuItem icon={Rocket} onSelect={() => setUp(campaign.id)}>{t("continueSetup")}</MenuItem> : null}
            {can.manager && campaign.status === "paused" ? <MenuItem icon={Play} onSelect={() => void act("resume", [campaign.id])}>{t("resumeCampaign")}</MenuItem> : null}
            <MenuItem icon={Pencil} onSelect={() => void router.push(sequenceHref(campaign.id))}>{can.member ? t("editSequence") : t("viewSequence")}</MenuItem>
            {can.member ? <MenuItem icon={Copy} onSelect={() => void act("duplicate", [campaign.id])}>{t("duplicate")}</MenuItem> : null}
            {can.manager ? <MenuItem icon={Download} onSelect={() => window.location.assign(apiUrl("/api/export/prospects", { workflow_id: campaign.id }))}>{t("exportProspects")}</MenuItem> : null}
            {can.member ? <MenuSeparator /> : null}
            {can.manager && campaign.status === "active" ? <MenuItem icon={Pause} onSelect={() => void act("pause", [campaign.id])}>{t("pause")}</MenuItem> : null}
            {can.member && campaign.status === "archived" ? <MenuItem icon={ArchiveRestore} onSelect={() => void act("unarchive", [campaign.id])}>{t("bringBack")}</MenuItem> : null}
            {can.member && campaign.status !== "archived" ? <MenuItem icon={Archive} tone="danger" onSelect={() => void act("archive", [campaign.id])}>{t("archive")}</MenuItem> : null}
            {can.member ? <MenuItem icon={Trash2} tone="danger" onSelect={() => void remove(campaign)}>{t("delete")}</MenuItem> : null}
          </Menu>
        </span>
      ),
    },
  ];
  const shown = columns.filter((column) => !hidden.includes(column.key as OptionalColumn));
  const chosen = [...selected].filter((id) => names.has(id));

  return (
    <Page
      title={t("title")}
      meta={data ? (
        <>
          <Pill>{t("total", {count: formatCount(data.counts.all)})}</Pill>
          {data.counts.active > 0 ? <Pill tone="good" dot>{t("running", {count: formatCount(data.counts.active)})}</Pill> : null}
        </>
      ) : null}
      actions={
        <>
          {can.member ? (
            <Button variant="ghost" asChild>
              <Link href="/lists"><Upload size={14} aria-hidden="true" />{t("importProspects")}</Link>
            </Button>
          ) : null}
          {can.manager ? (
            <Button asChild>
              <a href={apiUrl("/api/export/campaigns", { ...table.apiQuery, page: undefined, limit: undefined })} download>
                <Download size={14} className="text-ink-2" aria-hidden="true" />{t("export")}
              </a>
            </Button>
          ) : null}
          {can.member ? <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>{t("newCampaign")}</Button> : null}
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={typed} onChange={setSearch} placeholder={t("search")} frameClassName="w-[230px]" />
          <Segmented label={t("status")} value={status} onChange={(value) => table.set({ filters: { status: value } })} options={statusTabs(data?.counts, status).map(option => ({...option, label: states[option.value]}))} />
          <Select
            label={t("channel")} icon={Radio} value={table.filters.channel} onChange={(value) => table.set({ filters: { channel: value } })}
            options={[{ value: "all", label: "All channels" }, { value: "linkedin", label: "LinkedIn" }, { value: "email", label: "Email" }]}
          />
          <Select
            label={t("owner")} icon={User} value={table.filters.owner} onChange={(value) => table.set({ filters: { owner: value } })}
            options={[{ value: "all", label: "All owners" }, ...(data?.owners ?? []).map((owner) => ({ value: owner.id, label: owner.name })), { value: "none", label: "No owner" }]}
          />
        </div>
        <div className="flex items-center gap-2">
          <Select
            label={t("sortBy")} icon={ArrowDownUp} value={table.sort.key as CampaignSort}
            onChange={(value) => table.set({ sort: { key: value, direction: defaultDirection(value) } })}
            options={SORT_OPTIONS.map(option => ({...option, label: sortNames[option.value]}))}
          />
          <Menu align="end" width={188} trigger={<IconButton icon={Columns3} label={t("chooseColumns")} variant="outline" />}>
            <MenuLabel>{t("columns")}</MenuLabel>
            {OPTIONAL_COLUMNS.map((column) => (
              <MenuCheckItem key={column.key} checked={!hidden.includes(column.key)} onChange={(show) => toggleColumn(column.key, show)}>{columnNames[column.key]}</MenuCheckItem>
            ))}
          </Menu>
        </div>
      </div>

      <BulkBar count={chosen.length} noun={["campaign", "campaigns"]} onClear={() => setSelected(new Set())}>
        {can.manager && status !== "archived" ? <Button size="sm" icon={Pause} disabled={working} onClick={() => void act("pause", chosen)}>{t("pause")}</Button> : null}
        {can.manager && status !== "archived" ? <Button size="sm" icon={Play} disabled={working} onClick={() => void act("resume", chosen)}>{t("resume")}</Button> : null}
        <Button size="sm" icon={Copy} disabled={working} onClick={() => void act("duplicate", chosen)}>{t("duplicate")}</Button>
        {status === "archived"
          ? <Button size="sm" icon={ArchiveRestore} disabled={working} onClick={() => void act("unarchive", chosen)}>{t("bringBack")}</Button>
          : <Button size="sm" variant="danger" icon={Archive} disabled={working} onClick={() => void act("archive", chosen)}>{t("archive")}</Button>}
      </BulkBar>

      <DataTable
        label={t("title")} columns={shown} rows={rows} rowKey={(campaign) => campaign.id}
        loading={isLoading || !table.ready} error={error && !data ? errorMessage(error) : undefined} onRetry={() => void mutate()}
        selected={can.member ? selected : undefined} onSelectedChange={can.member ? setSelected : undefined}
        sort={table.sort} onSortChange={(sort) => table.set({ sort })}
        onRowClick={(campaign) => (campaign.status === "draft" && can.member ? setUp(campaign.id) : void router.push(campaignHref(campaign.id)))}
        empty={filtered ? (
          <EmptyState title={t("empty.noMatches")} action={<Button onClick={clearFilters}>{t("empty.clear")}</Button>}>
            {t("empty.noMatchesBody")}
          </EmptyState>
        ) : (
          <EmptyState title={t("empty.noCampaigns")} action={can.member ? <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>{t("newCampaign")}</Button> : undefined}>
            {t("empty.noCampaignsBody")}
          </EmptyState>
        )}
        footer={data ? (
          <>
            <span>{t("showing", {shown: formatCount(data.items.length), total: formatCount(data.total)})}</span>
            <Pagination
              page={data.page} pageSize={data.limit} total={data.total} onPageChange={(page) => table.set({ page })}
              pageSizes={[25, 50, 100]} onPageSizeChange={(pageSize) => table.set({ pageSize })}
            />
          </>
        ) : undefined}
      />

      <CampaignWizard open={can.member && (settingUp !== null || creating || wantsNew)} campaignId={settingUp} onClose={closeWizard} onChanged={() => void mutate()} />
    </Page>
  );
}

/** A rate with the thin bar under it. Nothing sent yet shows as a dash, not as 0%. */
function Rate({ value, tone, label }: { value: number | null; tone: "mail" | "li"; label: string }) {
  const t = useTranslations("Campaigns");
  if (value === null) return <span className="text-125 text-ink-3" title={t("nothingSent")}>—</span>;
  return (
    <span className="flex flex-col gap-[5px]" title={label}>
      <span className="text-125 font-semibold text-ink">{formatPercent(value)}</span>
      <Meter value={value * 100} tone={tone} height={3} className="w-14" label={label} />
    </span>
  );
}
