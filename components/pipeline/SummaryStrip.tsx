import { Card, Eyebrow, Skeleton } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { currencyNote, summaryStats, type PipelineSummary } from "./model";

/** The five figures above the board. They follow the owner filter. */
export function SummaryStrip({ summary }: { summary: PipelineSummary | undefined }) {
  if (!summary) {
    return (
      <Card className="grid shrink-0 grid-cols-5 divide-x divide-line" aria-busy="true" aria-label="Loading the pipeline's figures">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 px-4 py-3.5"><Skeleton className="h-2.5 w-24" /><Skeleton className="h-6 w-20" /><Skeleton className="h-2.5 w-28" /></div>
        ))}
      </Card>
    );
  }
  const note = currencyNote(summary);
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <Card className="grid grid-cols-5 divide-x divide-line">
        {summaryStats(summary).map((stat) => (
          <div key={stat.key} className="flex min-w-0 flex-col gap-1 px-4 py-3.5">
            <Eyebrow className="truncate">{stat.label}</Eyebrow>
            <span className="truncate text-22 font-semibold tracking-[-0.3px] text-ink">{stat.value}</span>
            <span className={cn("truncate text-11", stat.tone === "good" ? "text-good" : "text-ink-3")}>{stat.note}</span>
          </div>
        ))}
      </Card>
      {note ? <p className="px-1 text-105 text-ink-3">{note}</p> : null}
    </div>
  );
}
