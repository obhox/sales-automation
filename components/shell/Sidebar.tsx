import Link from "next/link";
import { useRouter } from "next/router";
import { Plus, Search } from "lucide-react";
import { Button, Kbd } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatCount } from "@/lib/client/format";
import { NAV, NEW_CAMPAIGN_HREF, isNavItemActive, navHref } from "@/lib/client/nav";
import { useCan } from "@/lib/client/roles";
import { useShellControls } from "./ShellContext";
import { UserMenu } from "./UserMenu";
import { useShell } from "./useShell";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const HEALTH_DOT: Record<string, string> = { healthy: "bg-good", degraded: "bg-warn", off: "bg-ink-3", idle: "bg-ink-3" };

/** The fixed navigation column. `onNavigate` lets a small-screen drawer close itself when a link is followed. */
export function Sidebar({ onNavigate, className }: { onNavigate?: () => void; className?: string }) {
  const router = useRouter();
  const { data: shell } = useShell();
  const { openPalette } = useShellControls();
  const canWrite = useCan("member");
  const tab = typeof router.query.tab === "string" ? router.query.tab : undefined;
  const capabilities = shell?.capabilities;

  return (
    <aside className={cn("flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-page", className)}>
      <WorkspaceSwitcher />

      {canWrite ? (
        <div className="px-3.5 pb-2.5">
          <Button asChild variant="primary" className="w-full">
            <Link href={NEW_CAMPAIGN_HREF} onClick={onNavigate}>
              <Plus size={14} aria-hidden="true" />
              New campaign
            </Link>
          </Button>
        </div>
      ) : null}

      <div className="px-3.5 pb-3">
        <button
          type="button"
          onClick={openPalette}
          className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 text-left transition-colors hover:border-line-strong"
        >
          <span className="flex items-center gap-[7px] text-12 text-ink-2">
            <Search size={13} aria-hidden="true" />
            Search anything
          </span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2.5 pb-3">
        {NAV.map(section => {
          // A capability that is definitely off hides the item; while the answer is loading it stays.
          const items = section.items.filter(item => !item.requires || capabilities?.[item.requires] !== false);
          if (items.length === 0) return null;
          return (
            <div key={section.label} className="flex flex-col gap-0.5">
              <p className="flex h-[22px] items-center px-2.5 text-10 font-semibold uppercase tracking-label text-ink-3">{section.label}</p>
              {items.map(item => {
                const active = isNavItemActive(item, router.pathname, tab);
                const count = item.count ? shell?.counts[item.count] : undefined;
                const Glyph = item.icon;
                return (
                  <Link
                    key={item.key}
                    href={navHref(item)}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-[30px] items-center justify-between rounded-md px-2.5 transition-colors",
                      active ? "bg-brand-tint" : "hover:bg-control",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-[9px]">
                      <Glyph size={15} className={cn("shrink-0", active ? "text-brand" : "text-ink-2")} aria-hidden="true" />
                      <span className={cn("truncate text-125", active ? "font-semibold text-brand-strong" : "font-medium text-ink-2")}>{item.label}</span>
                    </span>
                    {count ? (
                      <span className={cn("text-105 font-semibold", active ? "text-brand-strong" : "text-ink-3")} aria-label={`${count} waiting`}>
                        {formatCount(count)}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="flex flex-col gap-2 border-t border-line p-2.5">
        <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-[9px] py-[7px]" role="status">
          <span className="flex min-w-0 items-center gap-[7px]">
            <span className={cn("size-1.5 shrink-0 rounded-full", HEALTH_DOT[shell?.health.status ?? "idle"] ?? "bg-ink-3")} aria-hidden="true" />
            <span className="truncate text-115 font-medium text-ink-2">{shell?.health.summary ?? "Checking runners"}</span>
          </span>
          {shell ? (
            <span className="shrink-0 text-105 text-ink-3" title={shell.version.update_available && shell.version.latest ? `Version ${shell.version.latest} is available` : undefined}>
              {/^\d/.test(shell.version.current) ? `v${shell.version.current}` : shell.version.current}
              {shell.version.update_available ? <span className="ml-1 font-semibold text-brand-strong">· update</span> : null}
            </span>
          ) : null}
        </div>
        <UserMenu />
      </div>
    </aside>
  );
}
