import { Fragment, type ReactNode } from "react";
import { Check, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/client/cn";

export interface StepItem {
  key: string;
  label: string;
  sub?: ReactNode;
}

type StepState = "done" | "current" | "upcoming";
const stateOf = (index: number, current: number): StepState => (index < current ? "done" : index === current ? "current" : "upcoming");

/** Horizontal progress through a multi-step flow (CSV import). `current` is the 0-based index. */
export function Steps({ items, current, className }: { items: StepItem[]; current: number; className?: string }) {
  return (
    <ol className={cn("flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-card", className)}>
      {items.map((item, index) => {
        const state = stateOf(index, current);
        return (
          <Fragment key={item.key}>
            {index > 0 ? <li aria-hidden="true" className="h-px min-w-4 flex-1 bg-line" /> : null}
            <li aria-current={state === "current" ? "step" : undefined} className="flex shrink-0 items-center gap-[9px]">
              <span
                className={cn(
                  "inline-flex size-[22px] items-center justify-center rounded-full text-11 font-semibold",
                  state === "done" && "bg-good text-white",
                  state === "current" && "bg-brand text-white",
                  state === "upcoming" && "border border-line-strong bg-control text-ink-3",
                )}
              >
                {state === "done" ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : index + 1}
              </span>
              <span className="flex flex-col gap-px">
                <span className={cn("text-125 font-semibold", state === "upcoming" ? "text-ink-3" : "text-ink")}>{item.label}</span>
                {item.sub ? <span className="text-105 text-ink-3">{item.sub}</span> : null}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** Vertical list of steps down the side of a wizard. Finished steps can be reopened. */
export function StepRail({
  items,
  current,
  onSelect,
  heading,
  footer,
  className,
}: {
  items: StepItem[];
  current: number;
  /** Called with the index when a finished step's "Edit" is used. */
  onSelect?: (index: number) => void;
  heading?: string;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <nav aria-label={heading ?? "Steps"} className={cn("flex w-[248px] shrink-0 flex-col border-r border-line bg-subtle", className)}>
      {heading ? <p className="px-3.5 pb-1.5 pt-3.5 text-10 font-semibold uppercase tracking-label text-ink-3">{heading}</p> : null}
      <ol className="flex flex-col">
        {items.map((item, index) => {
          const state = stateOf(index, current);
          return (
            <li key={item.key} aria-current={state === "current" ? "step" : undefined} className={cn("flex h-[54px] items-center gap-2.5 px-3.5", state === "current" && "bg-brand-tint")}>
              <span
                className={cn(
                  "inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-11 font-semibold",
                  state === "done" && "bg-good-tint text-good",
                  state === "current" && "bg-brand text-white",
                  state === "upcoming" && "border border-line-strong bg-control text-ink-3",
                )}
              >
                {state === "done" ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn("truncate text-12 font-semibold", state === "current" ? "text-brand-strong" : state === "upcoming" ? "text-ink-3" : "text-ink")}>{item.label}</span>
                {item.sub ? <span className="truncate text-105 text-ink-3">{item.sub}</span> : null}
              </span>
              {state === "done" && onSelect ? (
                <button type="button" onClick={() => onSelect(index)} className="shrink-0 text-11 font-semibold text-brand-strong hover:underline">
                  Edit
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {footer ? <div className="mt-auto p-3.5">{footer}</div> : null}
    </nav>
  );
}

/** A number with minus and plus buttons (day delays, limits). */
export function NumberStepper({
  value,
  onChange,
  min = 0,
  max = 999,
  step = 1,
  label,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  className?: string;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const side = "inline-flex h-[30px] w-7 items-center justify-center text-ink-2 hover:bg-subtle disabled:opacity-40";
  return (
    <div role="group" aria-label={label} className={cn("inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md border border-line-strong bg-surface", className)}>
      <button type="button" aria-label="Decrease" disabled={value <= min} onClick={() => onChange(clamp(value - step))} className={side}>
        <Minus size={13} aria-hidden="true" />
      </button>
      <span className="h-[30px] w-px bg-line" aria-hidden="true" />
      <input
        inputMode="numeric"
        aria-label={label}
        value={value}
        onChange={event => {
          const next = Number(event.target.value.replace(/[^0-9]/g, ""));
          if (Number.isFinite(next)) onChange(clamp(next));
        }}
        className="h-[30px] w-[38px] bg-transparent text-center text-125 font-semibold text-ink outline-none"
      />
      <span className="h-[30px] w-px bg-line" aria-hidden="true" />
      <button type="button" aria-label="Increase" disabled={value >= max} onClick={() => onChange(clamp(value + step))} className={side}>
        <Plus size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
