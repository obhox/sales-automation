import { useState, type ReactNode } from "react";
import { Command } from "cmdk";
import { Popover as RadixPopover } from "radix-ui";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";
import { TONE_SOLID, type Tone } from "./Pill";

export interface PickerOption {
  value: string;
  label: string;
  /** Quiet text at the right of the row (a count, a status). */
  aside?: ReactNode;
  icon?: Icon;
  /** A small filled circle in this tone before the label. */
  dot?: Tone;
  disabled?: boolean;
  /** Draws a rule above this option, to set a group apart ("Anyone" above the names). */
  separated?: boolean;
}

/**
 * Pick one option from a list that may be long: a popover with a search box (shown once
 * the list is longer than a screenful of menu) and arrow-key movement. `trigger` must be
 * a single element that accepts a ref, such as a FilterChip or a Button.
 */
export function OptionPicker({
  trigger,
  options,
  value,
  onChange,
  label,
  searchPlaceholder = "Search",
  empty = "Nothing matches.",
  searchable,
  align = "start",
  width = 240,
  footer,
}: {
  trigger: ReactNode;
  options: PickerOption[];
  value?: string;
  onChange: (value: string) => void;
  /** Names the list for screen readers ("Filter by campaign"). */
  label: string;
  searchPlaceholder?: string;
  empty?: ReactNode;
  /** Defaults to on when there are more than eight options. */
  searchable?: boolean;
  align?: "start" | "center" | "end";
  width?: number;
  /** Sits under the list ("Manage tags"). Receives a way to close the popover. */
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const withSearch = searchable ?? options.length > 8;
  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align={align}
          sideOffset={4}
          style={{ width }}
          className="z-50 overflow-hidden rounded-lg border border-line-strong bg-surface shadow-card outline-none data-[state=open]:animate-pop-in"
        >
          <Command label={label} loop>
            {withSearch ? (
              <div className="flex h-9 items-center gap-2 border-b border-line px-2.5">
                <Search size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
                <Command.Input placeholder={searchPlaceholder} className="h-full min-w-0 flex-1 bg-transparent text-12 text-ink outline-none placeholder:text-ink-3" />
              </div>
            ) : (
              // cmdk moves through the list from its input; without a search box an unseen one still takes the keys.
              <Command.Input aria-label={label} className="sr-only" />
            )}
            <Command.List className="max-h-[280px] overflow-y-auto p-[5px]">
              <Command.Empty className="px-2 py-4 text-center text-115 text-ink-3">{empty}</Command.Empty>
              {options.map(option => {
                const Glyph = option.icon;
                const chosen = option.value === value;
                return (
                  <Command.Item
                    key={option.value}
                    // cmdk filters on this text, so it carries the label, not the id.
                    value={`${option.label} ${option.value}`}
                    disabled={option.disabled}
                    onSelect={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex min-h-7 cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1 text-115 font-medium text-ink outline-none",
                      "data-[selected=true]:bg-brand-tint data-[selected=true]:text-brand-strong data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
                      option.separated && "mt-1 before:absolute before:inset-x-0 before:-top-[3px] before:h-px before:bg-line relative",
                    )}
                  >
                    {option.dot ? <span className={cn("size-1.5 shrink-0 rounded-full", TONE_SOLID[option.dot])} aria-hidden="true" /> : null}
                    {Glyph ? <Glyph size={13} className="shrink-0 text-ink-2" aria-hidden="true" /> : null}
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.aside !== undefined ? <span className="shrink-0 text-105 font-normal text-ink-3">{option.aside}</span> : null}
                    {chosen ? <Check size={12} strokeWidth={3} className="shrink-0" aria-hidden="true" /> : null}
                  </Command.Item>
                );
              })}
            </Command.List>
          </Command>
          {footer ? <div className="border-t border-line bg-subtle px-2.5 py-1.5">{footer(() => setOpen(false))}</div> : null}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
