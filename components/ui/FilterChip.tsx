import { forwardRef, type ButtonHTMLAttributes } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/client/cn";

export interface FilterChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The field being filtered ("Email"). */
  name: string;
  /** The chosen value ("Verified"). */
  value: string;
  /** True when the filter narrows the list; false for a chip sitting at its default. */
  active?: boolean;
}

/** One filter in a filter bar. It is a button: wrap it in a Menu or Popover to edit the value. */
export const FilterChip = forwardRef<HTMLButtonElement, FilterChipProps>(function FilterChip({ name, value, active = true, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-md border px-[9px] text-11 transition-colors",
        active ? "border-brand-tint bg-brand-tint text-brand-strong" : "border-line-strong bg-surface text-ink-2 hover:bg-subtle",
        className,
      )}
      {...props}
    >
      <span className="font-medium">{name}:</span>
      <span className={cn("font-semibold", !active && "text-ink")}>{value}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
  );
});

/** The quiet "Add filter" button at the end of a filter bar. */
export const AddFilterButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function AddFilterButton({ className, children, ...props }, ref) {
  return (
    <button ref={ref} type="button" className={cn("inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-[7px] text-11 font-medium text-ink-3 hover:bg-control hover:text-ink", className)} {...props}>
      <Plus size={12} aria-hidden="true" />
      {children ?? "Add filter"}
    </button>
  );
});
