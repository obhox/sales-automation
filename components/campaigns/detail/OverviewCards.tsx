import type { ReactNode } from "react";
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
  return (
    <div className="grid shrink-0 grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-5">
      {kpiViews(overview).map((kpi) => (
        <div key={kpi.key} title={kpi.basis} className="flex min-w-0">
          <KpiCard
            label={kpi.label}
            value={kpi.value}
            delta={kpi.change ? <Delta value={kpi.change.label} direction={kpi.change.direction} /> : null}
            spark={kpi.spark}
            sparkTone={kpi.tone}
          />
          <span className="sr-only">{kpi.basis}</span>
        </div>
      ))}
    </div>
  );
}

const DAY_OF_MONTH = new Intl.DateTimeFormat("en", { day: "2-digit", timeZone: "UTC" });
const FULL_DAY = new Intl.DateTimeFormat("en", { day: "numeric", month: "long", timeZone: "UTC" });

/** What went out and came back each day. */
export function ActivityCard({ overview, className }: { overview: CampaignOverview; className?: string }) {
  const series: BarSeries[] = [
    ...(overview.channel === "email" ? [] : [{ key: "linkedin", label: "LinkedIn", tone: "li" as const }]),
    ...(overview.channel === "linkedin" ? [] : [{ key: "email", label: "Email", tone: "mail" as const }]),
    { key: "replies", label: "Replies", tone: "brand" },
  ];
  // Thirty days of labels would run together: name every third.
  const every = overview.daily.length > 16 ? 3 : 1;
  const points = overview.daily.map((day, index) => {
    const date = new Date(`${day.day}T00:00:00Z`);
    return { label: index % every === 0 ? DAY_OF_MONTH.format(date) : "", title: FULL_DAY.format(date), values: { linkedin: day.linkedin, email: day.email, replies: day.replies } };
  });
  return (
    <Card className={cn("flex min-h-[300px] flex-col gap-4 p-4", className)}>
      <CardHeader title="Daily activity" subtitle={chartSubtitle(overview)} actions={<Legend series={series} />} />
      {chartIsEmpty(overview.daily) ? (
        <p className="flex flex-1 items-center justify-center text-12 text-ink-3">Nothing has been sent in these days.</p>
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
function VariantTable({ test, verdict, action }: { test: VariantTest; verdict: VariantVerdict; action: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-11 text-ink-3">{verdict.subtitle}</p>
        <Pill tone={verdict.pill.tone} className="h-6 px-2.5 text-11">{verdict.pill.text}</Pill>
      </div>
      <div role="table" aria-label={`Versions of email ${test.email_number}`} className="flex flex-col">
        <div role="row" className="flex h-[18px] items-center gap-3">
          <Eyebrow role="columnheader" className="min-w-0 flex-1">Variant &amp; subject</Eyebrow>
          <Eyebrow role="columnheader" className="w-14 shrink-0">Sent</Eyebrow>
          <Eyebrow role="columnheader" className="w-[92px] shrink-0">Open rate</Eyebrow>
          <Eyebrow role="columnheader" className="w-[92px] shrink-0">Reply rate</Eyebrow>
          <Eyebrow role="columnheader" className="w-[60px] shrink-0">Positive</Eyebrow>
          <Eyebrow role="columnheader" className="w-[100px] shrink-0">Status</Eyebrow>
        </div>
        {test.rows.map((row) => {
          const ahead = row.status === "leading" || row.status === "winner";
          const quiet = row.status === "paused" || row.status === "removed";
          return (
            <div key={row.variant_id ?? "control"} role="row" className={cn("flex min-h-[42px] items-center gap-3 border-t border-line", quiet && "opacity-60")}>
              <span role="cell" className="flex min-w-0 flex-1 items-center gap-[9px]">
                <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md text-115 font-semibold", ahead ? "bg-good text-white" : "bg-control text-ink-2")}>{row.label === "Removed" ? "–" : row.label}</span>
                <span className="truncate text-115 text-ink">{row.subject || "No subject"}</span>
              </span>
              <span role="cell" className="w-14 shrink-0 font-mono text-115 text-ink">{formatCount(row.sent)}</span>
              <span role="cell"><RateCell value={row.open_rate} fill="bg-li" /></span>
              <span role="cell"><RateCell value={row.reply_rate} fill="bg-mail" /></span>
              <span role="cell" className="w-[60px] shrink-0 font-mono text-115 text-ink">{formatCount(row.positive)}</span>
              <span role="cell" className="w-[100px] shrink-0"><Pill tone={VARIANT_STATUS[row.status].tone}>{VARIANT_STATUS[row.status].label}</Pill></span>
            </div>
          );
        })}
      </div>
      <div className="flex min-h-7 items-center justify-between gap-3 rounded-md bg-subtle px-2.5 py-1.5">
        <span className="flex min-w-0 items-center gap-[7px] text-11 text-ink-2">
          <Info size={12} className="shrink-0 text-ink-3" aria-hidden="true" />
          {verdict.note}
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
  return (
    <Card className={cn("flex flex-col gap-4 p-4", className)}>
      <CardHeader title="A/B variant results" subtitle={overview.variants.length === 0 ? undefined : "Every send each version has had, whatever period is shown"} />
      {overview.variants.length === 0 ? (
        <p className="py-6 text-center text-12 text-ink-3">
          {overview.channel === "linkedin" ? "A/B tests are on emails. Show both channels to see them." : "No email in this campaign has a second version yet. Add one in the sequence builder to test a subject or an opening."}
        </p>
      ) : (
        overview.variants.map((test, index) => {
          const verdict = variantVerdict(test, overview.auto_promote);
          return (
            <div key={test.step_id} className={cn(index > 0 && "border-t border-line pt-4")}>
              <VariantTable
                test={test}
                verdict={verdict}
                action={verdict.action && onAct ? (
                  <button type="button" disabled={busy === test.step_id} onClick={() => onAct(test, verdict.action!)} className="shrink-0 text-11 font-semibold text-brand-strong hover:underline disabled:opacity-50">
                    {verdict.action.label}
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
  const stages = overview.funnel[view];
  const rows = funnelRows(stages, view);
  const next: Record<OverviewChannel, OverviewChannel> = { both: "linkedin", linkedin: "email", email: "both" };
  return (
    <Card className={cn("flex flex-col gap-3.5 p-4", className)}>
      <CardHeader
        title="Conversion funnel"
        subtitle={funnelSubtitle(stages, view)}
        actions={onViewChange ? (
          <Tooltip label="Switch between both channels, LinkedIn and email">
            <button type="button" onClick={() => onViewChange(next[view])} className="h-7 rounded-md px-2 text-115 font-semibold text-brand-strong hover:bg-brand-tint">
              {view === "both" ? "By channel" : view === "linkedin" ? "LinkedIn" : "Email"}
            </button>
          </Tooltip>
        ) : null}
      />
      <ol className="flex flex-1 flex-col justify-between gap-2">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-12 font-medium text-ink">{row.label}</span>
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
  const { rows, filtered } = opensRows(overview.opens);
  return (
    <Card className={cn("flex flex-col gap-3 p-4", className)}>
      <CardHeader
        title="Open-tracking quality"
        subtitle="Opens by machines are counted apart"
        actions={filtered === null ? null : <Pill tone={filtered > 0.2 ? "warn" : "neutral"} className="h-[22px] px-[9px]">{formatPercent(filtered)} filtered</Pill>}
      />
      {overview.opens.raw === 0 ? (
        <p className="py-4 text-12 text-ink-3">No open has been recorded. Opens are only seen on emails sent with open tracking switched on.</p>
      ) : (
        <>
          <div className="flex items-end gap-2">
            <span className="text-[27px] font-semibold leading-none tracking-[-0.8px] text-ink">{formatCount(overview.opens.human)}</span>
            <span className="flex flex-col gap-px">
              <span className="text-115 text-ink-2">human opens</span>
              <span className="text-105 text-ink-3">of {formatCount(overview.opens.raw)} raw events</span>
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
                <span className="min-w-0 flex-1 truncate text-11 text-ink-2">{row.label}</span>
                <span className="font-mono text-11 text-ink">{formatCount(row.count)}</span>
                <span className="w-10 text-right text-105 text-ink-3">{formatPercent(row.share)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="rounded-md bg-subtle p-2.5 text-11 leading-4 text-ink-2">
        Replies are what this campaign is judged on. Open rate is shown with machines taken out, and should not decide an A/B test by itself.
      </p>
    </Card>
  );
}
