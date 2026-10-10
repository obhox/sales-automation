import {
  Building2, CodeXml, FileText, Inbox, LayoutDashboard, ListChecks, Mail, Plug, Radar, SendHorizontal, ShieldCheck, Sparkles, CircleCheck, Users, UsersRound,
  type LucideIcon,
} from "lucide-react";
import { LinkedinIcon } from "@/components/ui/icons";

// The app's navigation, as the design lays it out.
//
// `href` is where a screen will finally live. Until a phase of the rebuild has built
// that screen, `legacy` says where the same thing is in the old UI, and the link goes
// there instead. A phase that builds a screen deletes its `legacy` entry (and adds a
// redirect from the old address); when none are left, `legacy` and LEGACY_ENTRIES go.

export type CountKey = "inbox" | "tasks" | "signals";

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  /**
   * Where this lives in the old UI: a path, and the tab on that page when it has tabs.
   * Two items can share one old tab; `quiet` keeps the second from lighting up beside
   * the first while both still point there.
   */
  legacy?: { path: string; tab?: string; quiet?: boolean };
  count?: CountKey;
  /** Hidden unless the build includes this capability. */
  requires?: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { key: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/" },
      { key: "inbox", label: "Inbox", icon: Inbox, href: "/inbox", count: "inbox" },
      { key: "tasks", label: "Tasks", icon: CircleCheck, href: "/pipeline", count: "tasks", requires: "crm" },
    ],
  },
  {
    label: "Outreach",
    items: [
      { key: "campaigns", label: "Campaigns", icon: SendHorizontal, href: "/campaigns", legacy: { path: "/workflows" } },
      { key: "templates", label: "Templates", icon: FileText, href: "/templates", legacy: { path: "/settings", tab: "templates" } },
      { key: "signals", label: "Signals", icon: Radar, href: "/signals", count: "signals", legacy: { path: "/platform", tab: "automation" } },
    ],
  },
  {
    label: "Audience",
    items: [
      { key: "contacts", label: "Contacts", icon: Users, href: "/contacts" },
      { key: "lists", label: "Lists", icon: ListChecks, href: "/lists" },
      { key: "companies", label: "Companies", icon: Building2, href: "/companies" },
    ],
  },
  {
    label: "Channels",
    items: [
      { key: "linkedin-accounts", label: "LinkedIn accounts", icon: LinkedinIcon, href: "/linkedin-accounts" },
      { key: "mailboxes", label: "Mailboxes", icon: Mail, href: "/mailboxes", legacy: { path: "/settings", tab: "email" } },
      { key: "deliverability", label: "Deliverability", icon: ShieldCheck, href: "/deliverability", legacy: { path: "/email-health" } },
    ],
  },
  {
    label: "Configure",
    items: [
      { key: "ai", label: "AI & models", icon: Sparkles, href: "/ai", legacy: { path: "/settings", tab: "ai" }, requires: "ai" },
      { key: "integrations", label: "Integrations", icon: Plug, href: "/integrations", legacy: { path: "/settings", tab: "integrations" } },
      { key: "team", label: "Team & roles", icon: UsersRound, href: "/team", legacy: { path: "/platform", tab: "admin" } },
      { key: "developers", label: "Developer API", icon: CodeXml, href: "/developers", legacy: { path: "/platform", tab: "admin", quiet: true } },
    ],
  },
];

/** Where "New campaign" goes until the wizard is rebuilt. */
export const NEW_CAMPAIGN_HREF = "/workflows";

/** Where a member's own settings (name, password) are until /account exists. */
export const ACCOUNT_HREF = "/settings?tab=general";

/** The link to follow for a nav item today. */
export function navHref(item: NavItem): string {
  if (!item.legacy) return item.href;
  return item.legacy.tab ? `${item.legacy.path}?tab=${item.legacy.tab}` : item.legacy.path;
}

/**
 * Whether a nav item is the current place. A path matches itself and anything beneath
 * it ("/contacts/abc" is under Contacts). An item still living on a tabbed old page
 * matches only when that tab is the one open.
 */
export function isNavItemActive(item: NavItem, pathname: string, tab: string | undefined): boolean {
  const under = (base: string) => (base === "/" ? pathname === "/" : pathname === base || pathname.startsWith(`${base}/`));
  if (under(item.href)) return true;
  if (!item.legacy || item.legacy.quiet) return false;
  if (!under(item.legacy.path)) return false;
  if (!item.legacy.tab) return true;
  // The old settings page opens on its first tab when none is named.
  const firstTab = item.legacy.path === "/settings" ? "email" : item.legacy.path === "/platform" ? "overview" : undefined;
  return (tab ?? firstTab) === item.legacy.tab;
}

export type RecordKind = "contact" | "company" | "campaign" | "list" | "template";

/** The page for one record, given what kind of thing it is. */
export function recordHref(kind: RecordKind, id: string): string {
  switch (kind) {
    case "contact":
      return `/contacts/${id}`;
    case "company":
      return `/companies/${id}`;
    case "campaign":
      return `/workflows/${id}`; // becomes /campaigns/[id] when the campaign screens are rebuilt
    case "list":
      return `/lists/${id}`;
    case "template":
      return "/settings?tab=templates"; // becomes /templates when that screen exists
  }
}

export const RECORD_KIND_LABEL: Record<RecordKind, string> = { contact: "Contacts", company: "Companies", campaign: "Campaigns", list: "Lists", template: "Templates" };
