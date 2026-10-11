import type { ReactNode } from "react";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";

export type Tone = "neutral" | "brand" | "good" | "warn" | "bad" | "li" | "mail";

export const TONE_TINT: Record<Tone, string> = {
  neutral: "bg-control text-ink-2",
  brand: "bg-brand-tint text-brand-strong",
  good: "bg-good-tint text-good",
  warn: "bg-warn-tint text-warn",
  bad: "bg-bad-tint text-bad",
  li: "bg-li-tint text-li",
  mail: "bg-mail-tint text-mail",
};

export const TONE_SOLID: Record<Tone, string> = {
  neutral: "bg-ink-3",
  brand: "bg-brand",
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  li: "bg-li",
  mail: "bg-mail",
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink-2",
  brand: "text-brand-strong",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  li: "text-li",
  mail: "text-mail",
};

/** A rounded status label. `dot` adds the small filled circle used for live states. */
export function Pill({
  tone = "neutral",
  dot,
  icon: IconGlyph,
  size = "md",
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  icon?: Icon;
  size?: "md" | "sm";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full font-semibold",
        size === "md" ? "h-5 gap-[5px] px-2 text-105" : "h-[17px] gap-1 px-[7px] text-95",
        TONE_TINT[tone],
        className,
      )}
    >
      {dot ? <span className={cn("size-1.5 rounded-full", TONE_SOLID[tone])} aria-hidden="true" /> : null}
      {IconGlyph ? <IconGlyph size={size === "md" ? 11 : 10} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
