import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/client/cn";
import type { Icon } from "./icons";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "tint" | "danger" | "dark";
export type ButtonSize = "md" | "sm" | "xs";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white font-semibold hover:bg-brand-strong",
  secondary: "border border-line-strong bg-surface text-ink font-medium hover:bg-subtle",
  ghost: "text-ink-2 font-medium hover:bg-control hover:text-ink",
  tint: "bg-brand-tint text-brand-strong font-semibold hover:bg-brand-tint/70",
  danger: "border border-line-strong bg-surface text-bad font-medium hover:bg-bad-tint",
  dark: "bg-code-2 text-code-ink font-semibold hover:bg-code-2/80",
};

// Heights follow the design: 32 for page actions, 28 in toolbars, 24 inside cards and alerts.
const SIZE: Record<ButtonSize, { box: string; icon: number }> = {
  md: { box: "h-8 gap-1.5 px-3 text-12", icon: 14 },
  sm: { box: "h-[26px] gap-[5px] px-[9px] text-115", icon: 12 },
  xs: { box: "h-6 gap-1 px-[9px] text-11", icon: 12 },
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: Icon;
  iconRight?: Icon;
  /** Shows a spinner in place of the icon and blocks clicks. */
  loading?: boolean;
  /** Render the child (for example a Next `<Link>`) with the button's look. */
  asChild?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: IconLeft, iconRight: IconRight, loading, asChild, className, children, disabled, type, ...props },
  ref,
) {
  const s = SIZE[size];
  const classes = cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md transition-colors",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    s.box,
    VARIANT[variant],
    className,
  );
  const iconTone = variant === "secondary" ? "text-ink-2" : undefined;

  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button ref={ref} type={type ?? "button"} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Spinner size={s.icon} /> : IconLeft ? <IconLeft size={s.icon} className={iconTone} aria-hidden="true" /> : null}
      {children}
      {IconRight ? <IconRight size={s.icon} className={iconTone} aria-hidden="true" /> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: Icon;
  /** Required: an icon-only button has no other name. */
  label: string;
  size?: 32 | 28 | 24 | 22;
  variant?: "plain" | "surface" | "outline";
  /** Small red dot in the corner (unread notifications). */
  dot?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: IconGlyph, label, size = 32, variant = "plain", dot, className, type, ...props },
  ref,
) {
  const glyph = size >= 32 ? 16 : size >= 28 ? 14 : size >= 24 ? 13 : 15;
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-control hover:text-ink",
        "disabled:pointer-events-none disabled:opacity-50",
        variant === "surface" && "bg-surface",
        variant === "outline" && "border border-line-strong bg-surface hover:bg-subtle",
        className,
      )}
      {...props}
    >
      <IconGlyph size={glyph} aria-hidden="true" />
      {dot ? <span className="absolute right-[7px] top-[7px] size-[7px] rounded-full bg-bad ring-[1.5px] ring-surface" aria-hidden="true" /> : null}
    </button>
  );
});
