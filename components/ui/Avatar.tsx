import { cn } from "@/lib/client/cn";

const TINTS = ["bg-li-tint", "bg-mail-tint", "bg-warn-tint", "bg-good-tint", "bg-control", "bg-brand-tint"];

export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function tintFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return TINTS[hash % TINTS.length];
}

/** Initials on a soft tint. The tint is picked from the name, so one person keeps one colour. */
export function Avatar({
  name,
  size = 22,
  square,
  tint,
  className,
}: {
  name: string | null | undefined;
  size?: 18 | 22 | 24 | 26 | 32 | 40;
  /** Company logos use a rounded square. */
  square?: boolean;
  /** Override the automatic tint with a background class. */
  tint?: string;
  className?: string;
}) {
  const text = size >= 40 ? "text-13" : size >= 32 ? "text-12" : size >= 26 ? "text-105" : size >= 22 ? "text-9" : "text-85";
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center font-semibold text-ink",
        square ? "rounded-md" : "rounded-full",
        text,
        tint ?? tintFor(name ?? ""),
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
