import { cn } from "@/lib/client/cn";

/** A small spinning ring. `label` is read by screen readers; it is not shown. */
export function Spinner({ size = 16, label = "Loading", className }: { size?: number; label?: string; className?: string }) {
  return (
    <span role="status" aria-label={label} className={cn("inline-flex", className)}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="animate-spin" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.75" />
        <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    </span>
  );
}
