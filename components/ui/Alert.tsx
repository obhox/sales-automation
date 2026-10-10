import type { ReactNode } from "react";
import { CircleCheck, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";

export type AlertTone = "bad" | "warn" | "good" | "info" | "neutral";

const TONES: Record<AlertTone, { box: string; icon: string; glyph: Icon }> = {
  bad: { box: "bg-bad-tint", icon: "text-bad", glyph: OctagonAlert },
  warn: { box: "bg-warn-tint", icon: "text-warn", glyph: TriangleAlert },
  good: { box: "bg-good-tint", icon: "text-good", glyph: CircleCheck },
  info: { box: "bg-brand-tint", icon: "text-brand", glyph: Info },
  neutral: { box: "bg-subtle", icon: "text-ink-3", glyph: Info },
};

/**
 * A tinted notice. `banner` is the full-width form across the top of a page
 * (actions on the right); the default is the compact form used inside cards
 * (actions underneath).
 */
export function Alert({
  tone = "warn",
  title,
  children,
  icon,
  actions,
  onDismiss,
  banner,
  className,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: Icon;
  actions?: ReactNode;
  onDismiss?: () => void;
  banner?: boolean;
  className?: string;
}) {
  const t = TONES[tone];
  const Glyph = icon ?? t.glyph;
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cn("flex gap-[9px]", banner ? "items-center rounded-[10px] p-3" : "rounded-lg p-2.5", t.box, className)}>
      <Glyph size={banner ? 16 : 15} className={cn("shrink-0", !banner && "mt-px", t.icon)} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        {title ? <p className={cn("text-ink", banner ? "text-125 font-semibold" : "text-12 font-medium leading-4")}>{title}</p> : null}
        {children ? <div className={cn("text-ink-2", banner ? "text-11" : "text-105 leading-[14px]")}>{children}</div> : null}
        {!banner && actions ? <div className="mt-1 flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {banner && actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-black/5 hover:text-ink">
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
