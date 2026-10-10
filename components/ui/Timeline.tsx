import type { ReactNode } from "react";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";
import { TONE_TINT, type Tone } from "./Pill";

export interface TimelineEvent {
  key: string;
  icon: Icon;
  tone?: Tone;
  title: ReactNode;
  /** Sits beside the title (a verdict pill, a campaign name). */
  badge?: ReactNode;
  time: ReactNode;
  detail?: ReactNode;
}

/** Events down a rail, newest first, each with an icon in its channel colour. */
export function Timeline({ events, className }: { events: TimelineEvent[]; className?: string }) {
  return (
    <ol className={cn("flex flex-col", className)}>
      {events.map((event, index) => {
        const Glyph = event.icon;
        return (
          <li key={event.key} className="flex gap-2.5">
            <div className="flex w-6 shrink-0 flex-col items-center gap-1">
              <span className={cn("inline-flex size-6 items-center justify-center rounded-full", TONE_TINT[event.tone ?? "neutral"])}>
                <Glyph size={12} aria-hidden="true" />
              </span>
              {index < events.length - 1 ? <span className="w-[1.5px] flex-1 bg-line" aria-hidden="true" /> : null}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-[3px] pb-3.5 pt-0.5">
              <div className="flex items-center justify-between gap-[7px]">
                <div className="flex min-w-0 items-center gap-[7px]">
                  <span className="truncate text-115 font-semibold text-ink">{event.title}</span>
                  {event.badge}
                </div>
                <span className="shrink-0 text-105 text-ink-3">{event.time}</span>
              </div>
              {event.detail ? <div className="text-11 leading-[15px] text-ink-2">{event.detail}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
