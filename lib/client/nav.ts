import {
  Building2, CodeXml, FileText, Inbox, LayoutDashboard, ListChecks, Mail, Plug, Radar, SendHorizontal, ShieldCheck, Sparkles, CircleCheck, Users, UsersRound,
  type LucideIcon,
} from "lucide-react";
import { LinkedinIcon } from "@/components/ui/icons";

// The app's navigation, as the design lays it out.

export type CountKey = "inbox" | "tasks" | "signals";

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
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
      { key: "campaigns", label: "Campaigns", icon: SendHorizontal, href: "/campaigns" },
      { key: "templates", label: "Templates", icon: FileText, href: "/templates" },
      { key: "signals", label: "Signals", icon: Radar, href: "/signals", count: "signals" },
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
      { key: "mailboxes", label: "Mailboxes", icon: Mail, href: "/mailboxes" },
      { key: "deliverability", label: "Deliverability", icon: ShieldCheck, href: "/deliverability" },
    ],
  },
  {
    label: "Configure",
    items: [
      { key: "ai", label: "AI & models", icon: Sparkles, href: "/ai", requires: "ai" },
      { key: "integrations", label: "Integrations", icon: Plug, href: "/integrations" },
      { key: "team", label: "Team & roles", icon: UsersRound, href: "/team" },
      { key: "developers", label: "Developer API", icon: CodeXml, href: "/developers" },
    ],
  },
];

/** "New campaign" opens the campaigns list with the setup wizard up. */
export const NEW_CAMPAIGN_HREF = "/campaigns?new=1";

/** Where a member's own settings (name, password) are. */
export const ACCOUNT_HREF = "/account";

/** The address of a screen, by its key in the navigation ("integrations", "signals"). */
export function navPath(key: string): string {
  const item = NAV.flatMap(section => section.items).find(candidate => candidate.key === key);
  if (!item) throw new Error(`No screen is called ${key}`);
  return item.href;
}

/** Whether a nav item is the current place. A path matches itself and anything beneath it ("/contacts/abc" is under Contacts). */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
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
      return `/campaigns/${id}`;
    case "list":
      return `/lists/${id}`;
    case "template":
      return `/templates?template=${encodeURIComponent(id)}`; // the library, with that template open
  }
}

export const RECORD_KIND_LABEL: Record<RecordKind, string> = { contact: "Contacts", company: "Companies", campaign: "Campaigns", list: "Lists", template: "Templates" };
