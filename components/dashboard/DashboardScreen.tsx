import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { CalendarCheck, Check, CircleCheck, Download, Eye, ListChecks, Mail, MessageSquare, OctagonAlert, Plus, RefreshCw, SendHorizontal, Timer, TriangleAlert, UserPlus, UserRound } from "lucide-react";
import { Page } from "@/components/shell";
import {
  BarChart, Button, Card, CardHeader, ChannelBadge, Delta, Dialog, ErrorState, Funnel, IconButton, KpiCard, Legend, Meter, Pill, Segmented, Select, Skeleton, Tooltip,
  type BarSeries, type Icon,
} from "@/components/ui";
import { apiUrl, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, formatRelative } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import {
  ALERTS_SHOWN, ALL, NEXT_CHANNEL, RANGE_OPTIONS, TOP_SORTS, activityIsEmpty, activityPoints, activitySubtitle, channelWord, funnelStages, funnelSubtitle, isRange, isTopSort, kpiViews,
  livePill, setupSteps, todayRows, topCampaigns,
  type Alert, type Dashboard, type DashboardData, type DashboardRange, type OverviewChannel, type TodayRow, type TopSort,
} from "./model";

const ALERT_ICON: Partial<Record<Alert["kind"], Icon>> = { "runner.stalled": Timer };
const TODAY_ICON: Record<TodayRow["key"], Icon> = { emails: Mail, invites: UserPlus, visits: Eye, replies: MessageSquare, meetings: CalendarCheck };
const SERIES: BarSeries[] = [{ key: "linkedin", label: "LinkedIn", tone: "li" }, { key: "email", label: "Email", tone: "mail" }, { key: "replies", label: "Replies", tone: "brand" }];

// How the top campaigns are ranked is this browser's own choice, kept between visits.
const TOP_SORT_KEY = "linki.dashboard.top-sort";
const topSortListeners = new Set<() => void>();
let topSortHere: string | null = null;
const subscribeTopSort = (listener: () => void) => { topSortListeners.add(listener); return () => { topSortListeners.delete(listener); }; };
function readTopSort(): string | null {
  try {
    return window.localStorage.getItem(TOP_SORT_KEY) ?? topSortHere;
  } catch {
    // Private browsing: the choice lasts until the page is closed.
    return topSortHere;
  }
}
function writeTopSort(next: TopSort) {
  topSortHere = next;
  try { window.localStorage.setItem(TOP_SORT_KEY, next); } catch { /* kept in memory above */ }
  for (const listener of topSortListeners) listener();
}

/** One thing that needs attention: what it is, the fact behind it, and where to deal with it. */
function AlertRow({ alert }: { alert: Alert }) {
  const Glyph = ALERT_ICON[alert.kind] ?? (alert.tone === "bad" ? OctagonAlert : TriangleAlert);
  return (
    <li className={cn("flex gap-[9px] rounded-lg p-2.5", alert.tone === "bad" ? "bg-bad-tint" : "bg-warn-tint")}>
      <Glyph size={15} className={cn("mt-px shrink-0", alert.tone === "bad" ? "text-bad" : "text-warn")} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-[3px]">
        <span className="text-12 font-medium leading-4 text-ink">{alert.title}</span>
        <span className="text-105 leading-[14px] text-ink-2">{alert.detail}</span>
        <Link href={alert.action.href} className="mt-0.5 inline-flex h-6 items-center rounded-md border border-line-strong bg-surface px-[9px] text-11 font-semibold text-ink hover:bg-subtle">
          {alert.action.label}
          <span className="sr-only">: {alert.title}</span>
        </Link>
      </div>
    </li>
  );
}

/** The first things to do in a workspace that has not launched anything yet. */
function SetupCard({ dashboard, canEdit }: { dashboard: Dashboard; canEdit: boolean }) {
  const steps = setupSteps(dashboard.setup);
  if (!steps) return null;
  const next = steps.find((step) => !step.done);
  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <CardHeader title="Get your first campaign out" subtitle={`${steps.filter((step) => step.done).length} of ${steps.length} done`} />
      <ol className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => (
          <li key={step.key} className={cn("flex flex-col gap-2 rounded-lg border p-3", step === next ? "border-brand bg-brand-tint" : "border-line")}>
            <span className="flex items-center gap-2">
              <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full text-105 font-semibold", step.done ? "bg-good text-white" : step === next ? "bg-brand text-white" : "bg-control text-ink-2")}>
                {step.done ? <Check size={12} aria-hidden="true" /> : index + 1}
              </span>
              <span className="text-125 font-semibold text-ink">{step.title}</span>
              {step.done ? <span className="sr-only">Done</span> : null}
            </span>
            <span className="flex-1 text-115 leading-[17px] text-ink-2">{step.detail}</span>
            {canEdit && step === next ? <Button asChild variant="primary" size="sm" className="self-start"><Link href={step.action.href}>{step.action.label}</Link></Button> : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** The home page: how the workspace's outreach is doing, what needs attention, and what today has used. */
export function DashboardScreen() {
  const router = useRouter();
  const can = { member: useCan("member"), manager: useCan("manager") };
  const range: DashboardRange = isRange(router.query.range) ? router.query.range : "7d";
  const pick = (key: string) => (typeof router.query[key] === "string" && router.query[key] ? (router.query[key] as string) : ALL);
  const filters = { workflow_id: pick("campaign"), list_id: pick("list"), owner_id: pick("member") };
  const query = { range, workflow_id: filters.workflow_id === ALL ? undefined : filters.workflow_id, list_id: filters.list_id === ALL ? undefined : filters.list_id, owner_id: filters.owner_id === ALL ? undefined : filters.owner_id };
  const { data, error, mutate, isValidating } = useApi<DashboardData>(router.isReady ? "/api/dashboard/overview" : null, query);

  const [channel, setChannel] = useState<OverviewChannel>("both");
  const storedSort = useSyncExternalStore(subscribeTopSort, readTopSort, () => null);
  const topSort: TopSort = isTopSort(storedSort) ? storedSort : "reply_rate";
  const [showAlerts, setShowAlerts] = useState(false);
  // "Updated 2 min ago" keeps counting, and the figures are read again every five minutes while the page is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const clock = window.setInterval(() => setTick((value) => value + 1), 60_000);
    const refresh = window.setInterval(() => { if (document.visibilityState === "visible") void mutate(); }, 5 * 60_000);
    return () => { window.clearInterval(clock); window.clearInterval(refresh); };
  }, [mutate]);

  const setQuery = (change: Record<string, string>) => {
    const next: Record<string, string | string[] | undefined> = { ...router.query, ...change };
    for (const key of Object.keys(next)) if (next[key] === ALL || (key === "range" && next[key] === "7d")) delete next[key];
    void router.replace({ pathname: router.pathname, query: next }, undefined, { shallow: true, scroll: false });
  };

  const dashboard = data?.dashboard;
  const alerts = data?.alerts ?? [];
  const live = data ? livePill(data.health.status) : null;
  const narrowed = filters.workflow_id !== ALL || filters.list_id !== ALL || filters.owner_id !== ALL;
  const top = dashboard ? topCampaigns(dashboard.campaigns, topSort) : [];

  return (
    <Page
      title="Dashboard"
      meta={live ? <Pill tone={live.tone} dot={live.dot}>{live.label}</Pill> : null}
      actions={can.manager ? (
        <Button asChild variant="secondary" icon={Download}>
          <a href={apiUrl("/api/export/dashboard", query)} download>Export</a>
        </Button>
      ) : null}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Period" value={range} onChange={(value) => setQuery({ range: value })} options={RANGE_OPTIONS} />
          <Select
            label="Campaign" icon={SendHorizontal} value={filters.workflow_id} onChange={(value) => setQuery({ campaign: value })}
            options={[{ value: ALL, label: "All campaigns" }, ...(dashboard?.options.campaigns ?? []).map((campaign) => ({ value: campaign.id, label: campaign.name }))]}
          />
          <Select
            label="List" icon={ListChecks} value={filters.list_id} onChange={(value) => setQuery({ list: value })}
            options={[{ value: ALL, label: "All lists" }, ...(dashboard?.options.lists ?? []).map((list) => ({ value: list.id, label: list.name }))]}
          />
          <Select
            label="Member" icon={UserRound} value={filters.owner_id} onChange={(value) => setQuery({ member: value })}
            options={[{ value: ALL, label: "All members" }, ...(dashboard?.options.members ?? []).map((member) => ({ value: member.id, label: member.name }))]}
          />
          {narrowed ? <Button variant="ghost" size="sm" onClick={() => setQuery({ campaign: ALL, list: ALL, member: ALL })}>Clear</Button> : null}
        </div>
        <div className="flex items-center gap-2">
          {dashboard ? <span className="text-11 text-ink-3">Updated {formatRelative(dashboard.generated_at)}</span> : null}
          <IconButton icon={RefreshCw} label="Refresh the figures" variant="outline" onClick={() => void mutate()} className={isValidating ? "[&_svg]:animate-spin" : undefined} />
        </div>
      </div>

      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
      ) : !dashboard ? (
        <>
          <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[104px]" />)}</div>
          <div className="flex flex-col gap-3.5 xl:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-3.5"><Skeleton className="h-[280px]" /><Skeleton className="h-[300px]" /></div>
            <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[356px]"><Skeleton className="h-[200px]" /><Skeleton className="h-[190px]" /><Skeleton className="h-[170px]" /></div>
          </div>
        </>
      ) : (
        <>
          <SetupCard dashboard={dashboard} canEdit={can.member} />

          <div className="grid shrink-0 grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-5">
            {kpiViews(dashboard).map((kpi) => (
              <div key={kpi.key} title={kpi.basis} className="flex min-w-0">
                <KpiCard label={kpi.label} value={kpi.value} delta={kpi.change ? <Delta value={kpi.change.label} direction={kpi.change.direction} /> : null} spark={kpi.spark} sparkTone={kpi.tone} />
                <span className="sr-only">{kpi.basis}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-3.5 xl:flex-row xl:items-stretch">
            <div className="flex min-w-0 flex-1 flex-col gap-3.5">
              <Card className="flex flex-col gap-4 p-4">
                <CardHeader title="Daily activity" subtitle={activitySubtitle(dashboard.activity)} actions={<Legend series={[SERIES[1], SERIES[0], SERIES[2]]} />} />
                {activityIsEmpty(dashboard.activity) ? (
                  <p className="flex h-[186px] items-center justify-center text-12 text-ink-3">{narrowed ? "Nothing was sent in this time by what the filters select." : "Nothing has been sent in this time."}</p>
                ) : (
                  <BarChart series={SERIES} points={activityPoints(dashboard.activity)} height={186} />
                )}
              </Card>

              <Card className="flex flex-1 flex-col gap-3.5 p-4">
                <CardHeader
                  title="Conversion funnel"
                  subtitle={funnelSubtitle(dashboard, channel)}
                  actions={
                    <Tooltip label="Switch between both channels, LinkedIn and email">
                      <button type="button" onClick={() => setChannel(NEXT_CHANNEL[channel])} className="h-8 rounded-md px-2.5 text-115 font-semibold text-brand-strong hover:bg-brand-tint">{channelWord(channel)}</button>
                    </Tooltip>
                  }
                />
                <Funnel stages={funnelStages(dashboard, channel)} className="flex-1 justify-between" />
              </Card>
            </div>

            <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[356px]">
              <Card className="flex flex-col gap-[11px] p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-[7px]">
                    <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Needs attention</h2>
                    {alerts.length > 0 ? <Pill tone={alerts.some((alert) => alert.tone === "bad") ? "bad" : "warn"}>{alerts.length}</Pill> : null}
                  </span>
                  {alerts.length > ALERTS_SHOWN ? <button type="button" onClick={() => setShowAlerts(true)} className="text-11 font-semibold text-brand-strong hover:underline">View all</button> : null}
                </div>
                {alerts.length === 0 ? (
                  <p className="flex items-center gap-2 rounded-lg bg-good-tint p-2.5 text-12 text-ink">
                    <CircleCheck size={15} className="shrink-0 text-good" aria-hidden="true" />
                    Nothing needs you right now. Senders, domains and background work are all in order.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">{alerts.slice(0, ALERTS_SHOWN).map((alert) => <AlertRow key={alert.id} alert={alert} />)}</ul>
                )}
              </Card>

              <Card className="flex flex-col gap-3 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Today so far</h2>
                  <span className="text-105 text-ink-3" title="Each sender's own calendar day, across the whole workspace">All senders</span>
                </div>
                <ul className="flex flex-col gap-3">
                  {todayRows(dashboard.today).map((row) => {
                    const Glyph = TODAY_ICON[row.key];
                    return (
                      <li key={row.key} className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 text-12 text-ink-2"><Glyph size={14} className="text-ink-3" aria-hidden="true" />{row.label}</span>
                          <span className="flex items-baseline gap-0.5 font-mono">
                            <span className="text-115 font-medium text-ink">{formatCount(row.count)}</span>
                            {row.cap !== null ? <span className="text-11 text-ink-3">/{formatCount(row.cap)}</span> : null}
                          </span>
                        </div>
                        {row.cap !== null ? <Meter value={row.count} max={Math.max(row.cap, 1)} tone={row.tone} label={`${row.label}: ${row.count} of ${row.cap}`} /> : null}
                      </li>
                    );
                  })}
                </ul>
              </Card>

              <Card className="flex flex-1 flex-col gap-[11px] p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Top campaigns</h2>
                  <Select size="sm" tone="sunken" label="Rank campaigns by" value={topSort} onChange={writeTopSort} options={TOP_SORTS.map((option) => ({ value: option.value, label: option.label }))} />
                </div>
                {top.length === 0 ? (
                  <p className="py-3 text-12 leading-[18px] text-ink-3">
                    {dashboard.campaigns.length === 0 ? "No campaign has enrolled anyone yet." : "No campaign has enough behind it to rank yet. A rate needs at least five people under it."}
                    {dashboard.campaigns.length === 0 && can.member ? <> <Link href="/campaigns?new=1" className="inline-flex items-center gap-0.5 font-semibold text-brand-strong hover:underline"><Plus size={11} aria-hidden="true" />New campaign</Link></> : null}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {top.map((row) => (
                      <li key={row.id} className="flex flex-col gap-1.5" title={row.basis}>
                        <div className="flex items-center justify-between gap-2.5">
                          <span className="flex min-w-0 flex-1 items-center gap-[7px]">
                            <span className="flex shrink-0 gap-[3px]">{row.channels.map((kind) => <ChannelBadge key={kind} channel={kind} size={18} />)}</span>
                            <Link href={`/campaigns/${row.id}`} className="truncate text-115 font-medium text-ink hover:underline">{row.name}</Link>
                          </span>
                          <span className="shrink-0 font-mono text-115 font-medium text-good">{row.figure}</span>
                        </div>
                        <Meter value={row.share * 100} label={`${row.name}: ${row.basis}`} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      )}

      <Dialog open={showAlerts} onOpenChange={setShowAlerts} title="Needs attention" description="Everything that is wrong or close to it right now. Each goes away by itself once it is dealt with." footer={<Button variant="ghost" onClick={() => setShowAlerts(false)}>Close</Button>}>
        <ul className="flex flex-col gap-2">{alerts.map((alert) => <AlertRow key={alert.id} alert={alert} />)}</ul>
      </Dialog>
    </Page>
  );
}
