import { RadioGroup } from "radix-ui";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number | string;
  icon?: Icon;
}

/** A row of mutually exclusive choices on a grey track. Arrow keys move between them. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Names the group for screen readers ("Status", "Date range"). */
  label: string;
  size?: "md" | "sm";
  className?: string;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={next => onChange(next as T)}
      aria-label={label}
      orientation="horizontal"
      className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-control p-0.5", size === "md" ? "h-8" : "h-7", className)}
    >
      {options.map(option => {
        const IconGlyph = option.icon;
        return (
          <RadioGroup.Item
            key={option.value}
            value={option.value}
            className={cn(
              "inline-flex items-center gap-[5px] whitespace-nowrap rounded-md font-medium text-ink-2 transition-colors hover:text-ink",
              "data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-seg",
              size === "md" ? "h-7 px-2.5 text-12" : "h-6 px-2 text-115",
            )}
          >
            {IconGlyph ? <IconGlyph size={12} aria-hidden="true" /> : null}
            {option.label}
            {option.count !== undefined ? <span className="text-105 font-semibold text-ink-3">{option.count}</span> : null}
          </RadioGroup.Item>
        );
      })}
    </RadioGroup.Root>
  );
}
