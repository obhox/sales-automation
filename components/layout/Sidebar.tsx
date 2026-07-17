import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/router";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import {
  RiArrowUpCircleLine,
  RiBuildingLine,
  RiCheckboxCircleLine,
  RiCompassLine,
  RiContactsLine,
  RiFileList3Line,
  RiFlowChart,
  RiInboxLine,
  RiLayoutGridLine,
  RiLogoutBoxLine,
  RiMailCheckLine,
  RiPlayCircleLine,
  RiQuestionLine,
  RiSettings4Line,
  RiStackLine,
} from "react-icons/ri";
import { pathToTourPage, replayPageTour } from "@/lib/tour";

const LEARNING_PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLBf6xNJOmsIQ";

const workspaceNav = [
  { href: "/", label: "Overview", icon: RiLayoutGridLine, tour: "nav-dashboard" },
  { href: "/inbox", label: "Inbox", icon: RiInboxLine, tour: "nav-inbox" },
  { href: "/todos", label: "Tasks", icon: RiCheckboxCircleLine, tour: "nav-todos", premium: true },
];

const growthNav = [
  { href: "/lists", label: "Lists", icon: RiFileList3Line, tour: "nav-lists" },
  { href: "/contacts", label: "People", icon: RiContactsLine, tour: "nav-contacts" },
  { href: "/companies", label: "Companies", icon: RiBuildingLine, tour: "nav-companies" },
  { href: "/workflows", label: "Campaigns", icon: RiFlowChart, tour: "nav-workflows" },
];

const systemNav = [
  { href: "/email-health", label: "Deliverability", icon: RiMailCheckLine, tour: "nav-email-health" },
  { href: "/platform", label: "Platform", icon: RiStackLine, tour: "nav-platform" },
];

const mobileNav = [workspaceNav[0], growthNav[0], growthNav[3], workspaceNav[1], systemNav[1]];

export const SIDEBAR_WIDTH_EXPANDED = 264;
export const SIDEBAR_WIDTH_COLLAPSED = 264;

type NavItem = (typeof workspaceNav)[number] | (typeof growthNav)[number] | (typeof systemNav)[number];

function initials(value?: string | null) {
  if (!value) return "LK";
  return value.split(/\s|@/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

export default function Sidebar({ onCollapse }: { onCollapse?: (collapsed: boolean) => void }) {
  const router = useRouter();
  const { data: session } = useSession();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [hasCrm, setHasCrm] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const tourPage = pathToTourPage(router.pathname);

  useEffect(() => { onCollapse?.(false); }, [onCollapse]);

  useEffect(() => {
    if (!helpOpen) return;
    function onClick(event: MouseEvent) {
      if (helpRef.current && !helpRef.current.contains(event.target as Node)) setHelpOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [helpOpen]);

  useEffect(() => {
    fetch("/api/premium-status").then((response) => response.ok ? response.json() : null)
      .then((data) => { if (data) setHasCrm(Boolean(data.capabilities?.crm)); }).catch(() => {});
    fetch("/api/system/update").then((response) => response.json()).then((data) => {
      setCurrentVersion(data.current ?? null);
      setUpdateAvailable(Boolean(data.updateAvailable));
      setLatestVersion(data.latest ?? null);
    }).catch(() => {});
  }, []);

  function isActive(href: string) {
    if (href === "/") return router.pathname === "/";
    if (href === "/settings") return ["/settings", "/accounts"].some((path) => router.pathname.startsWith(path));
    return router.pathname.startsWith(href);
  }

  function NavLink({ item }: { item: NavItem }) {
    const active = isActive(item.href);
    if ("premium" in item && item.premium && !hasCrm) return null;
    return (
      <Link
        href={item.href}
        data-tour={item.tour}
        aria-current={active ? "page" : undefined}
        className={`group relative flex h-10 items-center gap-3 rounded-[10px] px-3 text-[14px] transition-colors ${
          active
            ? "bg-primary font-semibold text-primary-content"
            : "font-medium text-base-content/65 hover:bg-base-300 hover:text-base-content"
        }`}
      >
        <item.icon size={18} className={active ? "text-primary-content" : "text-base-content/45 group-hover:text-base-content/75"} />
        <span>{item.label}</span>
      </Link>
    );
  }

  const accountName = session?.user?.email ?? "Linki workspace";

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] flex-col border-r border-[var(--border-subtle)] bg-base-200 md:flex">
        <div className="flex h-16 shrink-0 items-center gap-3 px-5">
          <Image src="/logo_linki.svg" alt="Linki" width={28} height={28} priority />
          <span className="text-[19px] font-semibold tracking-[-0.02em] text-base-content">Linki</span>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          <NavSection label="Workspace" items={workspaceNav} renderItem={(item) => <NavLink key={item.href} item={item} />} />
          <NavSection label="Build pipeline" items={growthNav} renderItem={(item) => <NavLink key={item.href} item={item} />} />
          <NavSection label="Operations" items={systemNav} renderItem={(item) => <NavLink key={item.href} item={item} />} />
        </div>

        <div className="shrink-0 p-3">
          {updateAvailable && (
            <div className="mb-2 rounded-[10px] border border-warning/25 bg-warning/[0.08] p-3">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-warning">
                <RiArrowUpCircleLine size={15} /> Update available
              </div>
              <p className="mt-1 text-[10px] text-warning/70">Linki {latestVersion ? `v${latestVersion}` : "has a new release"}</p>
            </div>
          )}

          <div className="relative" ref={helpRef}>
            <button
              type="button"
              onClick={() => setHelpOpen((open) => !open)}
              className="flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-[14px] font-medium text-base-content/65 transition-colors hover:bg-base-300 hover:text-base-content"
            >
              <RiQuestionLine size={18} className="text-base-content/45" /> Help & learning
            </button>
            {helpOpen && (
              <div className="absolute bottom-12 left-0 w-full overflow-hidden rounded-[12px] border border-[var(--border-subtle)] bg-base-100 p-1.5 shadow-[var(--shadow-popover)]">
                {tourPage && (
                  <button
                    type="button"
                    onClick={() => { replayPageTour(tourPage); setHelpOpen(false); }}
                    className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[13px] text-base-content/70 hover:bg-base-200 hover:text-base-content"
                  >
                    <RiCompassLine size={15} /> Replay page tour
                  </button>
                )}
                <a href={LEARNING_PLAYLIST_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13px] text-base-content/70 hover:bg-base-200 hover:text-base-content">
                  <RiPlayCircleLine size={15} /> Learning resources
                </a>
              </div>
            )}
          </div>

          <Link href="/settings" className={`flex h-10 items-center gap-3 rounded-[10px] px-3 text-[14px] transition-colors ${isActive("/settings") ? "bg-primary font-semibold text-primary-content" : "font-medium text-base-content/65 hover:bg-base-300 hover:text-base-content"}`}>
            <RiSettings4Line size={18} className={isActive("/settings") ? "text-primary-content" : "text-base-content/45"} /> Settings
          </Link>

          <div className="mt-3 flex items-center gap-3 rounded-[12px] border border-[var(--border-subtle)] bg-base-100 p-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-primary text-[11px] font-semibold text-primary-content">
              {initials(accountName)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-base-content/85">{accountName}</p>
              <p className="text-[10px] text-base-content/45">{currentVersion ? `v${currentVersion}` : "Self-hosted"}</p>
            </div>
            <button type="button" onClick={() => signOut({ callbackUrl: "/login" })} title="Sign out" className="flex h-8 w-8 items-center justify-center rounded-[9px] text-base-content/50 transition-colors hover:bg-error/10 hover:text-error">
              <RiLogoutBoxLine size={15} />
            </button>
          </div>
        </div>
      </aside>

      <nav aria-label="Primary navigation" className="fixed inset-x-3 bottom-3 z-40 flex h-16 items-center justify-around rounded-[16px] border border-[var(--border-subtle)] bg-base-100 px-2 shadow-[var(--shadow-popover)] md:hidden">
        {mobileNav.map((item) => {
          const active = isActive(item.href);
          return (
            <Link key={item.href} href={item.href} aria-label={item.label} aria-current={active ? "page" : undefined} className={`flex h-11 w-11 items-center justify-center rounded-[12px] transition-colors ${active ? "bg-primary text-primary-content" : "text-base-content/55"}`}>
              <item.icon size={20} />
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function NavSection<T>({ label, items, renderItem }: { label: string; items: readonly T[]; renderItem: (item: T) => React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 px-3 text-[11px] font-semibold tracking-[0.04em] text-base-content/40">{label}</h2>
      <nav className="space-y-1">{items.map(renderItem)}</nav>
    </section>
  );
}
