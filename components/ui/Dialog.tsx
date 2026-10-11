import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog as RadixDialog, VisuallyHidden } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/client/cn";
import { Button, type ButtonVariant } from "./Button";
import type { Icon } from "./icons";

const WIDTH = { sm: "w-[420px]", md: "w-[560px]", lg: "w-[760px]", xl: "w-[1060px]" };

/**
 * Radix only returns focus to a `Dialog.Trigger`. These dialogs are opened from
 * state, so there is none, and focus would be dropped on <body> at close.
 * Remember what had focus when the dialog opened and give it back.
 */
function useFocusReturn() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Opened from a menu item: the item is about to disappear with its menu, so the
      // thing to go back to is the button that opened the menu.
      const menu = active?.closest('[role="menu"]');
      const menuTrigger = menu ? document.getElementById(menu.getAttribute("aria-labelledby") ?? "") : null;
      opener.current = menuTrigger ?? active;
      // Radix would focus the first focusable thing, which is the close button. A dialog
      // that is about one field marks it with data-autofocus to start there instead.
      const preferred = event.currentTarget instanceof HTMLElement ? event.currentTarget.querySelector<HTMLElement>("[data-autofocus]") : null;
      if (preferred) {
        event.preventDefault();
        preferred.focus();
      }
    },
    onCloseAutoFocus: (event: Event) => {
      const target = opener.current;
      opener.current = null;
      if (target && target.isConnected) {
        event.preventDefault();
        target.focus();
      }
    },
  };
}

function Header({ title, description, icon: IconGlyph, aside }: { title: ReactNode; description?: ReactNode; icon?: Icon; aside?: ReactNode }) {
  return (
    <div className="flex h-[60px] shrink-0 items-center justify-between gap-4 border-b border-line px-5">
      <div className="flex min-w-0 items-center gap-[11px]">
        {IconGlyph ? (
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand">
            <IconGlyph size={15} aria-hidden="true" />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <RadixDialog.Title className="truncate text-15 font-semibold tracking-[-0.15px] text-ink">{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="truncate text-11 text-ink-3">{description}</RadixDialog.Description>
          ) : (
            <VisuallyHidden.Root asChild>
              <RadixDialog.Description>{typeof title === "string" ? title : "Dialog"}</RadixDialog.Description>
            </VisuallyHidden.Root>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {aside}
        <RadixDialog.Close aria-label="Close" className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-control hover:text-ink">
          <X size={16} aria-hidden="true" />
        </RadixDialog.Close>
      </div>
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: Icon;
  /** Shown beside the close button ("Draft saved 12 s ago"). */
  aside?: ReactNode;
  size?: keyof typeof WIDTH;
  /** Fixed height for tall flows such as the campaign wizard. */
  height?: number;
  /** Buttons on the grey strip at the bottom. */
  footer?: ReactNode;
  /** Set false when the body manages its own padding and scrolling (split layouts). */
  padded?: boolean;
  children: ReactNode;
}

/** A centred modal: focus is trapped, Escape and the scrim close it. */
export function Dialog({ open, onOpenChange, title, description, icon, aside, size = "md", height, footer, padded = true, children }: DialogProps) {
  const focusReturn = useFocusReturn();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          {...focusReturn}
          style={height ? { height } : undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
            "rounded-lg border border-line-strong bg-surface shadow-card outline-none data-[state=open]:animate-fade-in",
            WIDTH[size],
          )}
        >
          <Header title={title} description={description} icon={icon} aside={aside} />
          <div className={cn("min-h-0 flex-1", padded ? "overflow-y-auto p-5" : "flex overflow-hidden")}>{children}</div>
          {footer ? <div className="flex h-16 shrink-0 items-center justify-between gap-2.5 border-t border-line bg-subtle px-5">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A panel that slides in from the right for detail and logs, leaving the page visible behind it. */
export function Drawer({ open, onOpenChange, title, description, icon, width = 440, footer, children }: Omit<DialogProps, "size" | "height" | "aside" | "padded"> & { width?: number }) {
  const focusReturn = useFocusReturn();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim/40 data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          {...focusReturn}
          style={{ width }}
          className="fixed inset-y-0 right-0 z-50 flex max-w-[calc(100vw-32px)] flex-col border-l border-line-strong bg-surface outline-none data-[state=open]:animate-slide-in"
        >
          <Header title={title} description={description} icon={icon} />
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
          {footer ? <div className="flex h-16 shrink-0 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ── Confirmation ──────────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" colours the confirm button red for deletes and other things that cannot be undone. */
  tone?: "default" | "danger";
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
let present: ((request: Pending) => void) | null = null;

/**
 * Ask the user to confirm. Resolves true on confirm, false on cancel, Escape or
 * a click outside. Replaces `window.confirm`; needs <ConfirmHost /> mounted once.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    if (!present) return resolve(window.confirm(options.title));
    present({ ...options, resolve });
  });
}

export function ConfirmHost() {
  const [request, setRequest] = useState<Pending | null>(null);
  const focusReturn = useFocusReturn();

  useEffect(() => {
    present = setRequest;
    return () => {
      present = null;
    };
  }, []);

  const settle = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };
  const confirmVariant: ButtonVariant = request?.tone === "danger" ? "danger" : "primary";

  return (
    <RadixDialog.Root open={request !== null} onOpenChange={open => (open ? undefined : settle(false))}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[60] bg-scrim data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          {...focusReturn}
          role="alertdialog"
          className="fixed left-1/2 top-1/2 z-[60] flex w-[400px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-line-strong bg-surface p-5 shadow-card outline-none data-[state=open]:animate-fade-in"
        >
          <div className="flex flex-col gap-1.5">
            <RadixDialog.Title className="text-15 font-semibold tracking-[-0.15px] text-ink">{request?.title}</RadixDialog.Title>
            <RadixDialog.Description asChild>
              <div className="text-12 leading-[17px] text-ink-2">{request?.body ?? "This needs your confirmation."}</div>
            </RadixDialog.Description>
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => settle(false)}>{request?.cancelLabel ?? "Cancel"}</Button>
            <Button variant={confirmVariant} onClick={() => settle(true)}>
              {request?.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
