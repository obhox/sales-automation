import { Select as RadixSelect } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Second line under the label inside the list. */
  hint?: string;
  icon?: Icon;
  disabled?: boolean;
}

/**
 * The white dropdown used for both filters ("All channels") and form fields.
 * Values must be non-empty strings; use a named value such as "all" for "no filter".
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  placeholder,
  icon: LeadingIcon,
  size = "md",
  tone = "outline",
  disabled,
  id,
  className,
}: {
  value: T | undefined;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  /** Names the control for screen readers when there is no visible label. */
  label?: string;
  placeholder?: string;
  icon?: Icon;
  size?: "md" | "sm";
  tone?: "outline" | "sunken";
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <RadixSelect.Root value={value} onValueChange={next => onChange(next as T)} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        aria-label={label}
        className={cn(
          "inline-flex shrink-0 items-center gap-[7px] whitespace-nowrap rounded-md font-medium text-ink outline-none transition-colors",
          "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand-tint disabled:opacity-50 data-[placeholder]:text-ink-3",
          size === "md" ? "h-8 px-3 text-12" : "h-7 px-2.5 text-115",
          tone === "outline" ? "border border-line-strong bg-surface hover:bg-subtle" : "border border-transparent bg-subtle",
          className,
        )}
      >
        {LeadingIcon ? <LeadingIcon size={14} className="shrink-0 text-ink-2" aria-hidden="true" /> : null}
        <span className="min-w-0 flex-1 truncate text-left">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon className="shrink-0 text-ink-2">
          <ChevronDown size={13} aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line-strong bg-surface shadow-card data-[state=open]:animate-pop-in"
        >
          <RadixSelect.Viewport className="flex flex-col gap-px p-[5px]">
            {options.map(option => {
              const OptionIcon = option.icon;
              return (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={cn(
                    "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 text-115 font-medium text-ink outline-none",
                    "data-[highlighted]:bg-brand-tint data-[highlighted]:text-brand-strong data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                    option.hint ? "py-1.5" : "h-7",
                  )}
                >
                  {OptionIcon ? <OptionIcon size={13} className="shrink-0 text-ink-2" aria-hidden="true" /> : null}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                    {option.hint ? <span className="truncate text-105 font-normal text-ink-3">{option.hint}</span> : null}
                  </span>
                  <RadixSelect.ItemIndicator>
                    <Check size={12} strokeWidth={3} aria-hidden="true" />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              );
            })}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
