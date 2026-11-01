import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Info } from "lucide-react";
import { BarChart, Card, CardHeader, Delta, Eyebrow, KpiCard, Legend, Pill, Tooltip, type BarSeries } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatCount, formatPercent } from "@/lib/client/format";
import {
  VARIANT_STATUS, chartIsEmpty, chartSubtitle, funnelRows, funnelSubtitle, kpiViews, opensRows, variantVerdict,
  type CampaignOverview, type OverviewChannel, type VariantTest, type VariantVerdict,
} from "./model";

// The cards of a campaign's overview. They only draw what they are given, so the tab
// inside the app and the report page a link opens show the same thing.

/** The five rates along the top, each with its change against the period before. */
export function KpiRow({ overview }: { overview: CampaignOverview }) {
  const t = useTranslations("CampaignOverviewCards");
  const labels: Record<string, string> = {
    acceptance: t("kpi_acceptance"), reply: t("kpi_reply"), open: t("kpi_open"),
    click: t("kpi_click"), completion: t("kpi_completion"),
  };
  return (
    <div className="grid shrink-0 grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-5">
      {kpiViews(overview).map((kpi) => (
        <div key={kpi.key} title={overview.kpis[kpi.key].whole === 0 ? t("basis_empty") : t(("basis_" + kpi.key) as "basis_acceptance" | "basis_reply" | "basis_open" | "basis_click" | "basis_completion", {part: overview.kpis[kpi.key].part, whole: overview.kpis[kpi.key].whole})} className="flex min-w-0">
          <KpiCard
            label={labels[kpi.key] ?? kpi.label}
            value={kpi.value}
            delta={kpi.change ? <Delta value={kpi.change.label} direction={kpi.change.direction} /> : null}
            spark={kpi.spark}
            sparkTone={kpi.tone}
          />
          <span className="sr-only">{overview.kpis[kpi.key].whole === 0 ? t("basis_empty") : t(("basis_" + kpi.key) as "basis_acceptance" | "basis_reply" | "basis_open" | "basis_click" | "basis_completion", {part: overview.kpis[kpi.key].part, whole: overview.kpis[kpi.key].whole})}</span>
        </div>
      ))}
    </div>
  );
}


/** What went out and came back each day. */
export function ActivityCard({ overview, className }: { overview: CampaignOverview; className?: string }) {
  const t = useTranslations("CampaignOverviewCards");
  const locale = useLocale();
  const DAY_OF_MONTH = new Intl.DateTimeFormat(locale === "pt-BR" ? "pt-BR" : "en", {day: "2-digit", timeZone: "UTC"});
  const FULL_DAY = new Intl.DateTimeFormat(locale === "pt-BR" ? "pt-BR" : "en", {day: "numeric", month: "long", timeZone: "UTC"});
  const series: BarSeries[] = [
    ...(overview.channel === "email" ? [] : [{ key: "linkedin", label: "LinkedIn", tone: "li" as const }]),
    ...(overview.channel === "linkedin" ? [] : [{ key: "email", label: t("email"), tone: "mail" as const }]),
    { key: "replies", label: t("replies"), tone: "brand" },
  ];
  // Thirty days of labels would run together: name every third.
  const every = overview.daily.length > 16 ? 3 : 1;
  const points = overview.daily.map((day, index) => {
    const date = new Date(`${day.day}T00:00:00Z`);
    return { label: index % every === 0 ? DAY_OF_MONTH.format(date) : "", title: FULL_DAY.format(date), values: { linkedin: day.linkedin, email: day.email, replies: day.replies } };
  });
  return (
    <Card className={cn("flex min-h-[300px] flex-col gap-4 p-4", className)}>
      <CardHeader title={t("activity")} subtitle={locale === "pt-BR" ? t("activitySubtitle", {days: overview.daily.length, channels: overview.channel === "linkedin" ? t("activityLinkedin") : overview.channel === "email" ? t("activityEmail") : t("activityBoth")}) : chartSubtitle(overview)} actions={<Legend series={series} />} />
      {chartIsEmpty(overview.daily) ? (
        <p className="flex flex-1 items-center justify-center text-12 text-ink-3">{t("noActivity")}</p>
      ) : (
        <BarChart series={series} points={points} height={210} fill className="min-h-0 flex-1" />
      )}
    </Card>
  );
}

function RateCell({ value, fill }: { value: number | null; fill: string }) {
  return (
    <span className="flex w-[92px] shrink-0 flex-col gap-[5px]">
      <span className="font-mono text-115 text-ink">{value === null ? "—" : formatPercent(value)}</span>
      <span className="h-1 w-[84px] overflow-hidden rounded-full bg-control" aria-hidden="true">
        <span style={{ width: `${Math.min(100, Math.round((value ?? 0) * 100))}%` }} className={cn("block h-full rounded-full", fill)} />
      </span>
    </span>
  );
}

/** One email's versions side by side, with how sure the gap between them is. */
function VariantTable({ test, verdict, action, autoPromote }: { test: VariantTest; verdict: VariantVerdict; action: ReactNode; autoPromote: boolean }) {
  const t = useTranslations("CampaignOverviewCards");
  const rows = test.rows.filter((row) => row.status !== "removed");
  const confidence = test.confidence === null ? null : Math.min(99, Math.floor(test.confidence * 100));
  const auto = t(autoPromote ? "autoOn" : "autoOff");
  const split = test.decided ? "" : t(test.even_split ? "splitEven" : "splitWeighted");
  const subtitle = t("variantSubtitle", {number: test.email_number, count: rows.length, split});
  const verdictPill = test.decided ? t("winnerChosen") :
    test.significant ? confidence === null ? t("significant") : t("confidenceSignificant", {percent: confidence}) :
      confidence === null ? t("tooEarly") : t("confidencePending", {percent: confidence});
  const note = test.decided ? t("winnerNote", {label: test.rows.find((row) => row.status === "winner")?.label ?? "?"}) :
    test.significant ? t("significantNote", {label: test.leader?.label ?? "?", auto: autoPromote ? t("autoWillPause") : auto}) :
      confidence === null ? t("needSends", {auto}) :
        test.more_sends_needed === null ? t("levelNote", {auto}) : t("moreSends", {count: test.more_sends_needed, auto});
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-11 text-ink-3">{subtitle}</p>
        <Pill tone={verdict.pill.tone} className="h-6 px-2.5 text-11">{verdictPill}</Pill>
      </div>
      <div role="table" aria-label={t("emailVersions", {number: test.email_number})} className="flex flex-col">
        <div role="row" className="flex h-[18px] items-center gap-3">
          <Eyebrow role="columnheader" className="min-w-0 flex-1">{t("variantSubject")}</Eyebrow>
          <Eyebrow role="columnheader" className="w-14 shrink-0">{t("sent")}</Eyebrow>
          <Eyebrow role="columnheader" className="w-[92px] shrink-0">{t("openRate")}</Eyebrow>
          <Eyebrow role="columnheader" className="w-[92px] shrink-0">{t("replyRate")}</Eyebrow>
          <Eyebrow role="columnheader" className="w-[60px] shrink-0">{t("positive")}</Eyebrow>
          <Eyebrow role="columnheader" className="w-[100px] shrink-0">{t("status")}</Eyebrow>
        </div>
        {test.rows.map((row) => {
          const ahead = row.status === "leading" || row.status === "winner";
          const quiet = row.status === "paused" || row.status === "removed";
          return (
            <div key={row.variant_id ?? "control"} role="row" className={cn("flex min-h-[42px] items-center gap-3 border-t border-line", quiet && "opacity-60")}>
              <span role="cell" className="flex min-w-0 flex-1 items-center gap-[9px]">
                <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md text-115 font-semibold", ahead ? "bg-good text-white" : "bg-control text-ink-2")}>{row.label === "Removed" ? "–" : row.label}</span>
                <span className="truncate text-115 text-ink">{row.subject || t("noSubject")}</span>
              </span>
              <span role="cell" className="w-14 shrink-0 font-mono text-115 text-ink">{formatCount(row.sent)}</span>
              <span role="cell"><RateCell value={row.open_rate} fill="bg-li" /></span>
              <span role="cell"><RateCell value={row.reply_rate} fill="bg-mail" /></span>
              <span role="cell" className="w-[60px] shrink-0 font-mono text-115 text-ink">{formatCount(row.positive)}</span>
              <span role="cell" className="w-[100px] shrink-0"><Pill tone={VARIANT_STATUS[row.status].tone}>{t(("status_" + row.status) as "status_control" | "status_leading" | "status_trailing" | "status_paused" | "status_removed" | "status_waiting" | "status_winner")}</Pill></span>
            </div>
          );
        })}
      </div>
      <div className="flex min-h-7 items-center justify-between gap-3 rounded-md bg-subtle px-2.5 py-1.5">
        <span className="flex min-w-0 items-center gap-[7px] text-11 text-ink-2">
          <Info size={12} className="shrink-0 text-ink-3" aria-hidden="true" />
          {note}
        </span>
        {action}
      </div>
    </div>
  );
}

/**
 * Every email that is being A/B tested. `onAct` is left out where nothing can be changed
 * (a viewer, the public report); `busy` names the step whose button was just pressed.
 */
export function VariantsCard({
  overview, onAct, busy, className,
}: {
  overview: CampaignOverview;
  onAct?: (test: VariantTest, action: NonNullable<VariantVerdict["action"]>) => void;
  busy?: string | null;
  className?: string;
}) {
  const t = useTranslations("CampaignOverviewCards");
  return (
    <Card className={cn("flex flex-col gap-4 p-4", className)}>
      <CardHeader title={t("variantsTitle")} subtitle={overview.variants.length === 0 ? undefined : t("variantsSubtitle")} />
      {overview.variants.length === 0 ? (
        <p className="py-6 text-center text-12 text-ink-3">
          {overview.channel === "linkedin" ? t("variantsLinkedin") : t("variantsEmpty")}
        </p>
      ) : (
        overview.variants.map((test, index) => {
          const verdict = variantVerdict(test, overview.auto_promote);
          return (
            <div key={test.step_id} className={cn(index > 0 && "border-t border-line pt-4")}>
              <VariantTable
                test={test}
                verdict={verdict}
                autoPromote={overview.auto_promote}
                action={verdict.action && onAct ? (
                  <button type="button" disabled={busy === test.step_id} onClick={() => onAct(test, verdict.action!)} className="shrink-0 text-11 font-semibold text-brand-strong hover:underline disabled:opacity-50">
                    {"reopen" in verdict.action! ? t("reopen") : t("promote", {label: test.leader?.label ?? "?"})}
                  </button>
                ) : null}
              />
            </div>
          );
        })
      )}
    </Card>
  );
}

/** How far contacts got, and why the ones who stopped did. `view` switches between both channels and each. */
export function FunnelCard({
  overview, view, onViewChange, className,
}: {
  overview: CampaignOverview;
  view: OverviewChannel;
  onViewChange?: (view: OverviewChannel) => void;
  className?: string;
}) {
  const t = useTranslations("CampaignOverviewCards");
  const stages = overview.funnel[view];
  const rows = funnelRows(stages, view);
  const next: Record<OverviewChannel, OverviewChannel> = { both: "linkedin", linkedin: "email", email: "both" };
  return (
    <Card className={cn("flex flex-col gap-3.5 p-4", className)}>
      <CardHeader
        title={t("funnel")}
        subtitle={funnelSubtitle(stages, view)}
        actions={onViewChange ? (
          <Tooltip label={t("funnelSwitch")}>
            <button type="button" onClick={() => onViewChange(next[view])} className="h-7 rounded-md px-2 text-115 font-semibold text-brand-strong hover:bg-brand-tint">
              {view === "both" ? t("byChannel") : view === "linkedin" ? "LinkedIn" : t("email")}
            </button>
          </Tooltip>
        ) : null}
      />
      <ol className="flex flex-1 flex-col justify-between gap-2">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-12 font-medium text-ink">{t(("funnel_" + (row.key === "positive" ? "positiveReply" : row.key)) as "funnel_enrolled" | "funnel_contacted" | "funnel_delivered" | "funnel_engaged" | "funnel_replied" | "funnel_positiveReply" | "funnel_meeting")}</span>
              <span className="flex shrink-0 items-center gap-2.5">
                {row.note ? <span className="text-105 text-ink-3">{row.note}</span> : null}
                <span className="font-mono text-12 font-medium text-ink">{formatCount(row.count)}</span>
                <span className="w-[38px] text-right text-11 text-ink-3">{row.key === "enrolled" ? (row.count > 0 ? "100%" : "—") : formatPercent(row.share)}</span>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-control" aria-hidden="true">
              <div style={{ width: `${Math.max(row.share * 100, row.count > 0 ? 1.5 : 0)}%` }} className={cn("h-full rounded-full", row.fill)} />
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** How many of the opens were a person, and what the rest were. */
export function OpensCard({ overview, className }: { overview: CampaignOverview; className?: string }) {
  const t = useTranslations("CampaignOverviewCards");
  const { rows, filtered } = opensRows(overview.opens);
  return (
    <Card className={cn("flex flex-col gap-3 p-4", className)}>
      <CardHeader
        title={t("openQuality")}
        subtitle={t("openSubtitle")}
        actions={filtered === null ? null : <Pill tone={filtered > 0.2 ? "warn" : "neutral"} className="h-[22px] px-[9px]">{t("filtered", {value: formatPercent(filtered)})}</Pill>}
      />
      {overview.opens.raw === 0 ? (
        <p className="py-4 text-12 text-ink-3">{t("opensNone")}</p>
      ) : (
        <>
          <div className="flex items-end gap-2">
            <span className="text-[27px] font-semibold leading-none tracking-[-0.8px] text-ink">{formatCount(overview.opens.human)}</span>
            <span className="flex flex-col gap-px">
              <span className="text-115 text-ink-2">{t("humanOpens")}</span>
              <span className="text-105 text-ink-3">{t("rawEvents", {count: overview.opens.raw})}</span>
            </span>
          </div>
          <div className="flex h-2.5 w-full gap-0.5" aria-hidden="true">
            {rows.filter((row) => row.count > 0).map((row) => (
              <span key={row.key} style={{ flexGrow: row.count, flexBasis: 0, minWidth: 4 }} className={cn("h-full rounded-[3px]", row.fill)} />
            ))}
          </div>
          <ul className="flex flex-col gap-[7px]">
            {rows.map((row) => (
              <li key={row.key} className="flex items-center gap-2">
                <span className={cn("size-[7px] shrink-0 rounded-full", row.fill)} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-11 text-ink-2">{t(("opens_" + row.key) as "opens_human" | "opens_scanners" | "opens_prefetch" | "opens_automation")}</span>
                <span className="font-mono text-11 text-ink">{formatCount(row.count)}</span>
                <span className="w-10 text-right text-105 text-ink-3">{formatPercent(row.share)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="rounded-md bg-subtle p-2.5 text-11 leading-4 text-ink-2">
        {t("opensNote")}
      </p>
    </Card>
  );
}
