import Head from "next/head";
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Tabs, type TabItem } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { HelpMenu } from "./HelpMenu";
import { NotificationsMenu } from "./NotificationsMenu";

export interface Crumb {
  label: string;
  href: string;
}

export interface PageProps<T extends string = string> {
  title: string;
  /** For a detail page: where it sits ("Campaigns" → /campaigns). Shows a back arrow and the trail. */
  crumbs?: Crumb[];
  /** Pills and small facts beside the title ("14 total", "6 running"). */
  meta?: ReactNode;
  /** Buttons at the right of the topbar, before the bell and help. */
  actions?: ReactNode;
  /** Section tabs in a bar under the topbar. */
  tabs?: { items: TabItem<T>[]; value: T; onChange?: (value: T) => void; label: string };
  /** Shown at the right of the tab bar (a date range, a "last published" note). */
  tabsAside?: ReactNode;
  /** Set false when the body lays itself out edge to edge (split panes that scroll on their own). */
  padded?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The frame of one screen: the white topbar with the title and actions, an optional
 * tab bar, and the scrolling body. Every rebuilt page renders exactly one.
 */
export function Page<T extends string = string>({ title, crumbs, meta, actions, tabs, tabsAside, padded = true, className, children }: PageProps<T>) {
  const parent = crumbs?.[crumbs.length - 1];
  return (
    <>
      <Head>
        <title>{`${title} — Linki`}</title>
      </Head>
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          {parent ? (
            <Link href={parent.href} aria-label={`Back to ${parent.label}`} className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-2 hover:bg-subtle">
              <ChevronLeft size={14} aria-hidden="true" />
            </Link>
          ) : null}
          {crumbs?.map(crumb => (
            <span key={crumb.href} className="flex shrink-0 items-center gap-2.5">
              <Link href={crumb.href} className="text-125 font-medium text-ink-2 hover:text-ink">
                {crumb.label}
              </Link>
              <span className="text-125 text-ink-3" aria-hidden="true">/</span>
            </span>
          ))}
          <h1 className="truncate text-15 font-semibold tracking-[-0.15px] text-ink">{title}</h1>
          {meta ? <div className="flex shrink-0 items-center gap-2">{meta}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <NotificationsMenu />
          <HelpMenu />
        </div>
      </header>
      {tabs ? (
        <div className="flex h-[42px] shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-5">
          <Tabs items={tabs.items} value={tabs.value} onChange={tabs.onChange} label={tabs.label} />
          {tabsAside ? <div className="flex shrink-0 items-center gap-2.5">{tabsAside}</div> : null}
        </div>
      ) : null}
      <main className={cn("min-h-0 flex-1", padded ? "flex flex-col gap-3.5 overflow-y-auto p-5" : "flex overflow-hidden", className)}>{children}</main>
    </>
  );
}
