import type { ReactNode } from "react";
import { DropdownMenu, Popover as RadixPopover, Tooltip as RadixTooltip } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";

const SURFACE = "z-50 rounded-lg border border-line-strong bg-surface shadow-card outline-none data-[state=open]:animate-pop-in";
const ITEM =
  "flex h-7 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-115 font-medium text-ink outline-none " +
  "data-[highlighted]:bg-brand-tint data-[highlighted]:text-brand-strong data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/** A dropdown of actions. `trigger` must be a single element that accepts a ref (a Button or IconButton). */
export function Menu({
  trigger,
  align = "end",
  side = "bottom",
  width,
  children,
}: {
  trigger: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  width?: number;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          side={side}
          sideOffset={4}
          style={width ? { width } : undefined}
          className={cn(SURFACE, "flex min-w-[168px] flex-col gap-px p-[5px]")}
          // A menu gives focus back to its trigger when it closes. If the chosen item opened
          // a dialog, that would pull focus out of the dialog a moment after it opened.
          onCloseAutoFocus={event => {
            if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) event.preventDefault();
          }}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  icon: IconGlyph,
  tone,
  disabled,
  onSelect,
  children,
}: {
  icon?: Icon;
  tone?: "danger";
  disabled?: boolean;
  onSelect?: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(ITEM, tone === "danger" && "text-bad data-[highlighted]:bg-bad-tint data-[highlighted]:text-bad")}
    >
      {IconGlyph ? <IconGlyph size={13} className={tone === "danger" ? undefined : "text-ink-2 [[data-highlighted]_&]:text-brand-strong"} aria-hidden="true" /> : null}
      <span className="truncate">{children}</span>
    </DropdownMenu.Item>
  );
}

/** A menu row that toggles on and off and keeps the menu open. */
export function MenuCheckItem({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <DropdownMenu.CheckboxItem checked={checked} onCheckedChange={onChange} onSelect={event => event.preventDefault()} className={ITEM}>
      <span className="inline-flex size-[13px] items-center justify-center">
        <DropdownMenu.ItemIndicator>
          <Check size={12} strokeWidth={3} aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="truncate">{children}</span>
    </DropdownMenu.CheckboxItem>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-10 font-semibold uppercase tracking-label text-ink-3">{children}</DropdownMenu.Label>;
}

/** A floating panel for richer content than a menu (filters, pickers, small forms). */
export function Popover({
  trigger,
  align = "start",
  side = "bottom",
  open,
  onOpenChange,
  className,
  children,
}: {
  trigger: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content align={align} side={side} sideOffset={4} className={cn(SURFACE, "p-3", className)}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** A short hint on hover or focus. For anything a user must read, use visible text instead. */
export function Tooltip({ label, side = "top", children }: { label: ReactNode; side?: "top" | "bottom" | "left" | "right"; children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={300}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content side={side} sideOffset={5} className="z-50 max-w-[260px] rounded-md bg-ink px-2 py-1 text-11 leading-[15px] text-white data-[state=delayed-open]:animate-fade-in">
            {label}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
