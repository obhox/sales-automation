import { useId, type ReactNode } from "react";
import { cn } from "@/lib/client/cn";

/** A control under the small uppercase caption the design uses on this screen, with a note beneath. */
export function Captioned({ label, hint, className, children }: { label: string; hint?: ReactNode; className?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-10 font-semibold uppercase tracking-label text-ink-3">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-105 text-ink-3">{hint}</p> : null}
    </div>
  );
}

/** The heading every card on this screen opens with: a title, a line under it, and something on the right. */
export function CardHead({ title, subtitle, aside }: { title: string; subtitle?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:flex-nowrap">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{title}</h2>
        {subtitle ? <p className="text-11 text-ink-3">{subtitle}</p> : null}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
    </div>
  );
}
