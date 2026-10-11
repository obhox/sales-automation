import type { ReactNode } from "react";
import { cn } from "@/lib/client/cn";

/** The head of a card on the import page. The design sets these smaller than the kit's card header, to fit a dense page. */
export function PanelHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="truncate text-125 font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="truncate text-105 text-ink-3">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
