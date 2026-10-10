import { useRouter } from "next/router";
import { signOut, useSession } from "next-auth/react";
import { EllipsisVertical, LogOut, Settings2, ShieldUser, Layers, UserRound } from "lucide-react";
import { Avatar, Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui";
import { ACCOUNT_HREF } from "@/lib/client/nav";
import { ROLE_LABEL, isWorkspaceRole } from "@/lib/roles";
import { useShell } from "./useShell";

/**
 * Parts of the old Settings and Platform pages that no rebuilt screen has taken over
 * yet. Listed here so nothing becomes unreachable in the meantime; each phase that
 * moves the last of a page's contents removes its entry.
 */
const LEGACY_ENTRIES = [
  { label: "Settings (old screens)", href: "/settings", icon: Settings2 },
  { label: "Platform (old screens)", href: "/platform", icon: Layers },
];

/** The signed-in member at the foot of the sidebar, with their account links and sign out. */
export function UserMenu() {
  const { data: session } = useSession();
  const { data: shell } = useShell();
  const name = shell?.user.name ?? session?.user?.email ?? "";
  const role = shell?.user.role ?? session?.user?.role;

  return (
    <Menu
      side="top"
      align="start"
      width={228}
      trigger={
        <button type="button" className="flex w-full items-center justify-between gap-[9px] rounded-md px-1.5 py-[5px] text-left transition-colors hover:bg-control" aria-label={`Account menu for ${name}`}>
          <span className="flex min-w-0 items-center gap-[9px]">
            <Avatar name={name} size={26} tint="bg-control" />
            <span className="flex min-w-0 flex-col gap-px">
              <span className="truncate text-12 font-medium text-ink">{name}</span>
              <span className="text-105 text-ink-3">{isWorkspaceRole(role) ? ROLE_LABEL[role] : ""}</span>
            </span>
          </span>
          <EllipsisVertical size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
        </button>
      }
    >
      <MenuLabel>{shell?.user.email ?? session?.user?.email}</MenuLabel>
      <MenuLink href={ACCOUNT_HREF} icon={UserRound}>Your account</MenuLink>
      {session?.user?.isSuperadmin ? <MenuLink href="/admin" icon={ShieldUser}>Instance admin</MenuLink> : null}
      <MenuSeparator />
      {LEGACY_ENTRIES.map(entry => (
        <MenuLink key={entry.href} href={entry.href} icon={entry.icon}>{entry.label}</MenuLink>
      ))}
      <MenuSeparator />
      <MenuItem icon={LogOut} onSelect={() => void signOut({ callbackUrl: "/login" })}>Sign out</MenuItem>
    </Menu>
  );
}

function MenuLink({ href, icon, children }: { href: string; icon: Parameters<typeof MenuItem>[0]["icon"]; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <MenuItem icon={icon} onSelect={() => void router.push(href)}>
      {children}
    </MenuItem>
  );
}
