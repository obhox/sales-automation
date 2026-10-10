import type { ReactNode } from "react";
import { cn } from "@/lib/client/cn";
import { TONE_SOLID, type Tone } from "./Pill";

export interface BarSeries {
  key: string;
  label: string;
  tone: Tone;
}

export interface BarPoint {
  /** Shown under the bar (a day of the month, a week). */
  label: string;
  /** Read out for the bar ("3 October"); falls back to `label`. */
  title?: string;
  values: Record<string, number>;
}

function niceCeiling(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  // Steps whose quarters are round, so the four axis labels read cleanly (1.2k → 900, 600, 300).
  for (const step of [1, 1.2, 1.6, 2, 2.4, 3.2, 4, 6, 8, 10]) if (step * magnitude >= value) return step * magnitude;
  return 10 * magnitude;
}

function compact(value: number): string {
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`;
  return String(Math.round(value));
}

/**
 * Stacked bars per period with a value axis on the left. The first series is
 * drawn at the bottom of each stack. Includes a table for screen readers.
 */
export function BarChart({ series, points, height = 170, className }: { series: BarSeries[]; points: BarPoint[]; height?: number; className?: string }) {
  const totals = points.map(point => series.reduce((sum, s) => sum + (point.values[s.key] ?? 0), 0));
  const top = niceCeiling(Math.max(0, ...totals));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map(ratio => top * ratio);
  const stack = [...series].reverse();

  return (
    <div className={cn("flex gap-3", className)}>
      <div aria-hidden="true" style={{ height: height + 16 }} className="flex w-[30px] shrink-0 flex-col items-end justify-between pb-4 text-10 text-ink-3">
        {ticks.map(tick => (
          <span key={tick}>{compact(tick)}</span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div aria-hidden="true" style={{ height }} className="flex items-end gap-[9px] border-b border-line">
          {points.map((point, index) => (
            <div key={index} title={`${point.title ?? point.label}: ${series.map(s => `${s.label} ${point.values[s.key] ?? 0}`).join(", ")}`} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-0.5">
              {stack.map(s => {
                const value = point.values[s.key] ?? 0;
                if (value <= 0) return null;
                // Only the outer ends of a stack are rounded.
                const visible = stack.filter(other => (point.values[other.key] ?? 0) > 0);
                return (
                  <span
                    key={s.key}
                    style={{ height: `${(value / top) * 100}%`, minHeight: 2 }}
                    className={cn("w-full", TONE_SOLID[s.tone], visible[0] === s && "rounded-t-xs", visible[visible.length - 1] === s && "rounded-b-xs")}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div aria-hidden="true" className="flex gap-[9px]">
          {points.map((point, index) => (
            <span key={index} className="min-w-0 flex-1 truncate text-center text-10 text-ink-3">
              {point.label}
            </span>
          ))}
        </div>
        <table className="sr-only">
          <caption>Values per period</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              {series.map(s => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((point, index) => (
              <tr key={index}>
                <th scope="row">{point.title ?? point.label}</th>
                {series.map(s => (
                  <td key={s.key}>{point.values[s.key] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Coloured dots with names, for the corner of a chart card. */
export function Legend({ series, className }: { series: Pick<BarSeries, "key" | "label" | "tone">[]; className?: string }) {
  return (
    <ul className={cn("flex items-center gap-3.5", className)}>
      {series.map(s => (
        <li key={s.key} className="flex items-center gap-1.5 text-11 text-ink-2">
          <span className={cn("size-[7px] rounded-full", TONE_SOLID[s.tone])} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** Small note under the name ("−54 skipped", "41% of replies"). */
  note?: ReactNode;
}

// The fill lightens down the funnel, as in the design, then turns green for the outcomes.
const FUNNEL_FILL = ["bg-brand", "bg-[#7680dc]", "bg-[#8f97e5]", "bg-[#a9afee]", "bg-good", "bg-good"];

/** Stages with a count, a share of the first stage, and a bar. */
export function Funnel({ stages, className }: { stages: FunnelStage[]; className?: string }) {
  const base = stages[0]?.count ?? 0;
  return (
    <ol className={cn("flex flex-col gap-[9px]", className)}>
      {stages.map((stage, index) => {
        const share = base > 0 ? stage.count / base : 0;
        return (
          <li key={stage.key} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-12 font-medium text-ink">{stage.label}</span>
                {stage.note ? <span className="truncate text-105 text-ink-3">{stage.note}</span> : null}
              </span>
              <span className="flex shrink-0 items-center gap-2.5">
                <span className="font-mono text-115 font-medium text-ink">{stage.count.toLocaleString()}</span>
                <span className="w-[42px] text-right text-11 text-ink-3">{(share * 100).toFixed(1)}%</span>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-control" aria-hidden="true">
              <div style={{ width: `${Math.max(share * 100, stage.count > 0 ? 1 : 0)}%` }} className={cn("h-full rounded-full", FUNNEL_FILL[Math.min(index, FUNNEL_FILL.length - 1)])} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A 0–100 score drawn as a ring with the number in the middle. */
export function ScoreRing({ score, caption = "Score", size = 88, tone, className }: { score: number | null; caption?: string; size?: number; tone?: Tone; className?: string }) {
  const stroke = size * 0.12;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const value = score === null ? 0 : Math.min(100, Math.max(0, score));
  const resolved: Tone = tone ?? (score === null ? "neutral" : value >= 80 ? "good" : value >= 60 ? "warn" : "bad");
  const strokeClass = { neutral: "stroke-ink-3", brand: "stroke-brand", good: "stroke-good", warn: "stroke-warn", bad: "stroke-bad", li: "stroke-li", mail: "stroke-mail" }[resolved];
  return (
    <div role="img" aria-label={`${caption}: ${score === null ? "not available" : `${Math.round(value)} out of 100`}`} style={{ width: size, height: size }} className={cn("relative shrink-0", className)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-control" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - value / 100)}
          className={strokeClass}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
        <span className="text-[24px] font-semibold leading-none tracking-figure text-ink">{score === null ? "—" : Math.round(value)}</span>
        <span className="mt-0.5 text-9 font-semibold uppercase tracking-label text-ink-3">{caption}</span>
      </div>
    </div>
  );
}
