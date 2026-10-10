import Head from "next/head";
import type { GetServerSideProps } from "next";
import { useState } from "react";
import { ActivityCard, FunnelCard, KpiRow, OpensCard, VariantsCard } from "@/components/campaigns/detail/OverviewCards";
import { RANGE_OPTIONS, isRange, periodWords, type CampaignOverview, type OverviewChannel, type OverviewRange } from "@/components/campaigns/detail/model";
import { STATUS_LABEL, STATUS_TONE, type CampaignStatus } from "@/components/campaigns/model";
import { Pill } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatCount, formatDateTime } from "@/lib/client/format";

interface Report {
  name: string;
  workspace: string;
  status: CampaignStatus;
  enrolled: number;
  overview: CampaignOverview;
}

/**
 * A campaign's report, as a link shows it to someone with no account: the same figures as
 * the Overview tab, with nothing that can be changed and no way further into the
 * workspace. Read on the server each time it is opened, so a link that has been switched
 * off shows nothing.
 */
export const getServerSideProps: GetServerSideProps<{ report: Report | null; range: OverviewRange; token: string }> = async ({ params, query, res }) => {
  // Kept out of search engines and out of any cache between here and the reader.
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const token = typeof params?.token === "string" ? params.token : "";
  const range: OverviewRange = isRange(query.range) ? query.range : "all";
  const { getDb } = await import("@/lib/db");
  const { openShare } = await import("@/lib/campaigns/share");
  const { campaignOverview } = await import("@/lib/campaigns/overview");
  const { campaignSummaries } = await import("@/lib/campaigns/summary");
  const db = getDb();
  const share = openShare(db, token);
  const campaign = share ? campaignSummaries(db, share.workspace_id).find((candidate) => candidate.id === share.workflow_id) : undefined;
  if (!share || !campaign) {
    res.statusCode = 404;
    return { props: { report: null, range, token } };
  }
  const workspace = (db.prepare("SELECT name FROM workspaces WHERE id = ?").get(share.workspace_id) as { name: string } | undefined)?.name ?? "";
  return {
    props: {
      report: { name: campaign.name, workspace, status: campaign.status, enrolled: campaign.enrolled, overview: campaignOverview(db, share.workspace_id, share.workflow_id, { range, channel: "both" }) },
      range,
      token,
    },
  };
};

export default function SharedReport({ report, range, token }: { report: Report | null; range: OverviewRange; token: string }) {
  const [funnelView, setFunnelView] = useState<OverviewChannel>("both");
  if (!report) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-page px-6 text-center">
        <Head>
          <title>Report not available — Linki</title>
          <meta name="robots" content="noindex, nofollow" />
        </Head>
        <h1 className="text-15 font-semibold text-ink">This report is not available</h1>
        <p className="max-w-[380px] text-125 leading-[19px] text-ink-2">The link has been switched off, or it was not copied in full. Ask whoever sent it for a new one.</p>
      </main>
    );
  }
  const { overview } = report;
  return (
    <div className="min-h-screen bg-page">
      <Head>
        <title>{`${report.name} — report`}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1192px] flex-wrap items-center justify-between gap-3 px-5 py-3.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2.5">
              <h1 className="truncate text-15 font-semibold tracking-[-0.15px] text-ink">{report.name}</h1>
              <Pill tone={STATUS_TONE[report.status]} dot={report.status === "active"}>{STATUS_LABEL[report.status]}</Pill>
            </div>
            <p className="text-11 text-ink-3">
              {report.workspace ? `${report.workspace} · ` : ""}{formatCount(report.enrolled)} enrolled · rates for what was sent in {periodWords(range)} · as of {formatDateTime(overview.generated_at)}
            </p>
          </div>
          <nav aria-label="Period" className="inline-flex h-7 items-center gap-0.5 rounded-lg bg-control p-0.5">
            {RANGE_OPTIONS.map((option) => (
              <a
                key={option.value}
                href={`/r/${encodeURIComponent(token)}${option.value === "all" ? "" : `?range=${option.value}`}`}
                aria-current={option.value === range ? "page" : undefined}
                className={cn("inline-flex h-6 items-center rounded-md px-2.5 text-115 font-medium", option.value === range ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink")}
              >
                {option.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto flex max-w-[1192px] flex-col gap-3.5 p-5">
        <KpiRow overview={overview} />
        <div className="flex flex-col gap-3.5 xl:flex-row xl:items-stretch">
          <div className="flex min-w-0 flex-1 flex-col gap-3.5">
            <ActivityCard overview={overview} className="flex-1" />
            <VariantsCard overview={overview} />
          </div>
          <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[380px]">
            <FunnelCard overview={overview} view={funnelView} onViewChange={setFunnelView} className="flex-1" />
            <OpensCard overview={overview} />
          </div>
        </div>
        <p className="py-2 text-center text-11 text-ink-3">A read-only report shared from Linki. It shows figures only.</p>
      </main>
    </div>
  );
}
