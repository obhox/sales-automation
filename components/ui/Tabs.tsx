import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/client/cn";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  count?: number | string;
  /** With an href the tab is a link (page-level tabs); without one it is a button. */
  href?: string;
}

/** Underlined tabs for the bar beneath the page header. */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
}: {
  value: T;
  onChange?: (value: T) => void;
  items: TabItem<T>[];
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn("flex h-full items-stretch gap-1", className)}>
      {items.map(item => {
        const active = item.value === value;
        const classes = cn(
          "-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-125 font-medium text-ink-2 transition-colors hover:text-ink",
          active && "border-brand font-semibold text-brand-strong hover:text-brand-strong",
        );
        const inner: ReactNode = (
          <>
            {item.label}
            {item.count !== undefined ? <span className="text-105 font-semibold text-ink-3">{item.count}</span> : null}
          </>
        );
        return item.href ? (
          <Link key={item.value} href={item.href} aria-current={active ? "page" : undefined} className={classes}>
            {inner}
          </Link>
        ) : (
          <button key={item.value} type="button" aria-current={active ? "page" : undefined} onClick={() => onChange?.(item.value)} className={classes}>
            {inner}
          </button>
        );
      })}
    </nav>
  );
}
