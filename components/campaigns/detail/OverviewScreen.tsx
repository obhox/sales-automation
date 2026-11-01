import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useLocale, useTranslations } from "next-intl";
import { Download, Link2, RefreshCw, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { CampaignFrame } from "@/components/campaigns/CampaignFrame";
import { Alert, Button, ErrorState, IconButton, Segmented, Select, Skeleton, Tooltip, confirm } from "@/components/ui";
import { api, apiUrl, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatRelativeByLocale } from "@/lib/client/localize-relative";
import { useCan } from "@/lib/client/roles";
import type { CampaignSummary } from "../model";
import { AddProspectsDialog, ShareDialog } from "./Dialogs";
import { ActivityCard, FunnelCard, KpiRow, OpensCard, VariantsCard } from "./OverviewCards";
import { CHANNEL_OPTIONS, RANGE_OPTIONS, isChannel, isRange, periodNote, type CampaignOverview, type OverviewChannel, type OverviewRange, type VariantTest, type VariantVerdict } from "./model";

interface OverviewData { campaign: CampaignSummary; overview: CampaignOverview }

/** A campaign's Overview tab: how it is doing, over the period and on the channel chosen. */
export function OverviewScreen() {
  const t = useTranslations("CampaignOverview");
  const locale = useLocale();
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
        title: t("promoteTitle", {label, number: test.email_number}),
        body: test.significant
          ? t("promoteSignificant", {label})
          : t("promoteUncertain", {label}),
        confirmLabel: t("promoteAction", {label}),
      });
      if (!ok) return;
    }
    setBusyStep(test.step_id);
    try {
      await api(`/api/workflows/${id}/steps/${test.step_id}/winner`, { method: "POST", body: "winner" in action ? { variant_id: action.winner } : { clear: true } });
      toast.success("winner" in action ? t("promoted", {label: test.leader?.label ?? ""}) : t("reopened"));
      await mutate();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusyStep(null);
    }
  }

  const periodDescription = locale !== "pt-BR" ? periodNote(range) : t("periodNote", {
    period: range === "7d" ? t("range7") : range === "14d" ? t("range14") : range === "30d" ? t("range30") : t("rangeAll"),
  });
  const overview = data?.overview;
  const archived = data?.campaign.status === "archived";
  return (
    <CampaignFrame
      id={id ?? ""}
      campaign={data?.campaign}
      tab="overview"
      actions={
        <>
          <Button variant="ghost" icon={Link2} onClick={() => setSharing(true)} disabled={!id}>{t("shareReport")}</Button>
          {can.manager && id ? (
            <Button asChild variant="secondary" icon={Download}>
              <a href={apiUrl("/api/export/analytics", { workflow_id: id })} download>{t("exportCsv")}</a>
            </Button>
          ) : null}
          {can.manager ? <Button variant="primary" icon={UserPlus} disabled={!id || archived} onClick={() => setAdding(true)}>{t("addProspects")}</Button> : null}
        </>
      }
      aside={
        <>
          <Tooltip label={periodDescription} side="bottom">
            <span data-tour="campaign-period"><Segmented size="sm" label={t("period")} value={range} onChange={(value) => setQuery({ range: value })} options={RANGE_OPTIONS.map((option) => ({...option, label: option.value === "all" ? t("allTime") : option.label}))} /></span>
          </Tooltip>
          <Select size="sm" label={t("channel")} value={channel} onChange={(value) => setQuery({ channel: value })} options={CHANNEL_OPTIONS.map((option) => ({...option, label: option.value === "both" ? t("both") : option.value === "linkedin" ? t("linkedinOnly") : t("emailOnly")}))} />
          <span className="hidden items-center gap-1 text-11 text-ink-3 lg:flex">
            {overview ? t("updated", {relative: formatRelativeByLocale(overview.generated_at, locale)}) : null}
            <IconButton icon={RefreshCw} label={t("refresh")} size={24} onClick={() => void mutate()} className={isValidating ? "animate-spin" : undefined} />
          </span>
        </>
      }
    >
      {error && !data ? (
        <ErrorState message={error.status === 404 ? t("missing") : errorMessage(error)} onRetry={error.status === 404 ? undefined : () => void mutate()} />
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
            <Alert tone="info" title={t("nobody")}>
              {data.campaign.status === "draft" ? t("launchHint") : t("addHint")}
            </Alert>
          ) : null}
          <p className="sr-only" aria-live="polite">{periodDescription}</p>
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
      {id ? <ShareDialog id={id} name={data?.campaign.name ?? t("campaignName")} open={sharing} onOpenChange={setSharing} canManage={can.manager} /> : null}
    </CampaignFrame>
  );
}
