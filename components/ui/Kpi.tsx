import type { ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/client/cn";
import { Card, Eyebrow } from "./Card";
import type { Icon } from "./icons";
import { TONE_SOLID, type Tone } from "./Pill";

/** Change against the previous period. `good` says which direction is good news. */
export function Delta({ value, direction, good = "up", className }: { value: string; direction: "up" | "down" | "flat"; good?: "up" | "down"; className?: string }) {
  const tone = direction === "flat" ? "bg-control text-ink-2" : direction === good ? "bg-good-tint text-good" : "bg-bad-tint text-bad";
  const Arrow = direction === "down" ? TrendingDown : TrendingUp;
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-[3px] whitespace-nowrap rounded-full px-[7px] text-105 font-semibold", tone, className)}>
      {direction === "flat" ? null : <Arrow size={11} aria-hidden="true" />}
      {value}
    </span>
  );
}

/** A tiny bar series; the last bar takes the tone, the rest stay grey. */
export function Sparkbars({ values, tone = "mail", className }: { values: number[]; tone?: Tone; className?: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className={cn("flex h-[26px] w-full items-end gap-[3px]", className)} aria-hidden="true">
      {values.map((value, index) => (
        <span
          key={index}
          style={{ height: `${Math.max(8, Math.round((value / max) * 100))}%` }}
          className={cn("flex-1 rounded-xs", index === values.length - 1 ? TONE_SOLID[tone] : "bg-control")}
        />
      ))}
    </div>
  );
}

/** A headline number in a card: label, value, change, and an optional spark series or note. */
export function KpiCard({
  label,
  value,
  delta,
  spark,
  sparkTone,
  note,
  icon: IconGlyph,
  className,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  spark?: number[];
  sparkTone?: Tone;
  note?: ReactNode;
  icon?: Icon;
  className?: string;
}) {
  return (
    <Card className={cn("flex min-w-0 flex-1 flex-col gap-2.5 p-3.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Eyebrow className="truncate">{label}</Eyebrow>
        {IconGlyph ? <IconGlyph size={14} className="shrink-0 text-ink-3" aria-hidden="true" /> : null}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-25 font-semibold tracking-figure text-ink">{value}</span>
        {delta}
      </div>
      {spark ? <Sparkbars values={spark} tone={sparkTone} /> : null}
      {note ? <p className="truncate text-11 text-ink-3">{note}</p> : null}
    </Card>
  );
}

/** A thin progress track. Height 3 inside table cells, 5 for limits, 8 for funnels. */
export function Meter({
  value,
  max = 100,
  tone = "brand",
  height = 5,
  fillClassName,
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  height?: 3 | 5 | 8;
  /** Override the fill colour (funnel stages fade through brand tints). */
  fillClassName?: string;
  className?: string;
  label?: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      style={{ height }}
      className={cn("w-full overflow-hidden rounded-full bg-control", className)}
    >
      <div style={{ width: `${ratio * 100}%` }} className={cn("h-full rounded-full", fillClassName ?? TONE_SOLID[tone])} />
    </div>
  );
}
