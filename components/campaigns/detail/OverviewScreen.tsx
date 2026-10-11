import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { Download, Link2, RefreshCw, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { CampaignFrame } from "@/components/campaigns/CampaignFrame";
import { Alert, Button, ErrorState, IconButton, Segmented, Select, Skeleton, Tooltip, confirm } from "@/components/ui";
import { api, apiUrl, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatRelative } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import type { CampaignSummary } from "../model";
import { AddProspectsDialog, ShareDialog } from "./Dialogs";
import { ActivityCard, FunnelCard, KpiRow, OpensCard, VariantsCard } from "./OverviewCards";
import { CHANNEL_OPTIONS, RANGE_OPTIONS, isChannel, isRange, periodNote, type CampaignOverview, type OverviewChannel, type OverviewRange, type VariantTest, type VariantVerdict } from "./model";

interface OverviewData { campaign: CampaignSummary; overview: CampaignOverview }

/** A campaign's Overview tab: how it is doing, over the period and on the channel chosen. */
export function OverviewScreen() {
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const range: OverviewRange = isRange(router.query.range) ? router.query.range : "14d";
  const channel: OverviewChannel = isChannel(router.query.channel) ? router.query.channel : "both";
  const can = { member: useCan("member"), manager: useCan("manager") };
  const { data, error, mutate, isValidating } = useApi<OverviewData>(id ? `/api/workflows/${id}/overview` : null, { range, channel });

  const [funnelView, setFunnelView] = useState<OverviewChannel>("both");
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  // "Updated 3 min ago" should keep counting while the page sits open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // The funnel follows the channel filter, and can then be turned on its own.
  useEffect(() => setFunnelView(channel), [channel]);

  const setQuery = (change: Record<string, string>) => {
    const next = { ...router.query, ...change };
    if (next.range === "14d") delete next.range;
    if (next.channel === "both") delete next.channel;
    void router.replace({ pathname: router.pathname, query: next }, undefined, { shallow: true, scroll: false });
  };

  async function act(test: VariantTest, action: NonNullable<VariantVerdict["action"]>) {
    if (!id) return;
    if ("winner" in action) {
      const label = test.leader?.label ?? "this version";
      const ok = await confirm({
        title: `Promote version ${label} of email ${test.email_number}?`,
        body: test.significant
          ? `Every contact from now on gets version ${label}. The other versions are paused and keep their results; the test can be reopened.`
          : `The gap is not yet more than chance would explain, so this is a judgement call. Every contact from now on gets version ${label}; the others are paused and the test can be reopened.`,
        confirmLabel: `Promote ${label}`,
      });
      if (!ok) return;
    }
    setBusyStep(test.step_id);
    try {
      await api(`/api/workflows/${id}/steps/${test.step_id}/winner`, { method: "POST", body: "winner" in action ? { variant_id: action.winner } : { clear: true } });
      toast.success("winner" in action ? `Version ${test.leader?.label ?? ""} is now the only one sending` : "The test is open again: every version is sending");
      await mutate();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusyStep(null);
    }
  }

  const overview = data?.overview;
  const archived = data?.campaign.status === "archived";
  return (
    <CampaignFrame
      id={id ?? ""}
      campaign={data?.campaign}
      tab="overview"
      actions={
        <>
          <Button variant="ghost" icon={Link2} onClick={() => setSharing(true)} disabled={!id}>Share report</Button>
          {can.manager && id ? (
            <Button asChild variant="secondary" icon={Download}>
              <a href={apiUrl("/api/export/analytics", { workflow_id: id })} download>Export CSV</a>
            </Button>
          ) : null}
          {can.manager ? <Button variant="primary" icon={UserPlus} disabled={!id || archived} onClick={() => setAdding(true)}>Add prospects</Button> : null}
        </>
      }
      aside={
        <>
          <Tooltip label={periodNote(range)} side="bottom">
            <span data-tour="campaign-period"><Segmented size="sm" label="Period" value={range} onChange={(value) => setQuery({ range: value })} options={RANGE_OPTIONS} /></span>
          </Tooltip>
          <Select size="sm" label="Channel" value={channel} onChange={(value) => setQuery({ channel: value })} options={CHANNEL_OPTIONS} />
          <span className="hidden items-center gap-1 text-11 text-ink-3 lg:flex">
            {overview ? `Updated ${formatRelative(overview.generated_at)}` : null}
            <IconButton icon={RefreshCw} label="Refresh the figures" size={24} onClick={() => void mutate()} className={isValidating ? "animate-spin" : undefined} />
          </span>
        </>
      }
    >
      {error && !data ? (
        <ErrorState message={error.status === 404 ? "This campaign does not exist, or is in another workspace." : errorMessage(error)} onRetry={error.status === 404 ? undefined : () => void mutate()} />
      ) : !overview ? (
        <>
          <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[104px]" />)}</div>
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 xl:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-3.5"><Skeleton className="h-[300px]" /><Skeleton className="h-[240px]" /></div>
            <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[380px]"><Skeleton className="h-[330px]" /><Skeleton className="h-[210px]" /></div>
          </div>
        </>
      ) : (
        <>
          {data.campaign.enrolled === 0 ? (
            <Alert tone="info" title="Nobody is enrolled yet">
              {data.campaign.status === "draft" ? "Finish setting the campaign up and launch it. Its figures appear here as soon as it starts sending." : "Add prospects to start filling these figures in."}
            </Alert>
          ) : null}
          <p className="sr-only" aria-live="polite">{periodNote(range)}</p>
          <KpiRow overview={overview} />
          <div className="flex flex-col gap-3.5 xl:flex-row xl:items-stretch">
            <div className="flex min-w-0 flex-1 flex-col gap-3.5">
              <ActivityCard overview={overview} className="flex-1" />
              <VariantsCard overview={overview} onAct={can.member && !archived ? act : undefined} busy={busyStep} />
            </div>
            <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[380px]">
              <FunnelCard overview={overview} view={funnelView} onViewChange={setFunnelView} className="flex-1" />
              <OpensCard overview={overview} />
            </div>
          </div>
        </>
      )}
      {id ? <AddProspectsDialog id={id} campaign={data?.campaign} open={adding} onOpenChange={setAdding} onAdded={() => void mutate()} /> : null}
      {id ? <ShareDialog id={id} name={data?.campaign.name ?? "this campaign"} open={sharing} onOpenChange={setSharing} canManage={can.manager} /> : null}
    </CampaignFrame>
  );
}
