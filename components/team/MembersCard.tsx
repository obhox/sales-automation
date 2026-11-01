import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Ban, Ellipsis, Link2, Send, ShieldCheck, Trash2, UserMinus, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Card, EmptyState, IconButton, Menu, MenuItem, MenuSeparator, Pill, SearchInput, Select, TextAction, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatRelativeByLocale } from "@/lib/client/localize-relative";
import { ROLE_ORDER, activityLine, allowedOn, grantableRoles, personRows, statusBadge, type PersonRow, type TeamOverview, type WorkspaceRole } from "./model";

const GRID = "grid grid-cols-[minmax(170px,1fr)_150px_118px_118px_82px_28px] items-center gap-3 px-3.5";

interface Renewed {
  invite_url: string;
  email_sent: boolean;
  delivery_warning: string | null;
}

/** Everyone in the workspace and everyone invited to it: role, state, last activity, campaigns. */
export function MembersCard({ overview, onChanged }: { overview: TeamOverview; onChanged: () => void }) {
  const t = useTranslations("TeamMembers");
  const locale = useLocale();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<WorkspaceRole | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const rows = personRows(overview, search, role);
  const actorRole = overview.your_role;
  const filtering = search.trim() !== "" || role !== "all";
  const roleLabel: Record<WorkspaceRole, string> = {
    owner: t("roleOwner"), admin: t("roleAdmin"), manager: t("roleManager"),
    member: t("roleMember"), viewer: t("roleViewer"),
  };
  const statusLabel = (row: PersonRow) => row.kind === "invitation"
    ? row.invitation.status === "expired" ? t("expired") : t("invited")
    : row.member.suspended ? t("suspended") : t("active");
  const activityLabel = (row: PersonRow) => {
    if (locale !== "pt-BR") return activityLine(row);
    if (row.kind === "member") return row.member.last_active_at
      ? t("activeAt", {when: formatRelativeByLocale(row.member.last_active_at, locale)}) : t("notActive");
    return row.invitation.status === "expired"
      ? t("invitationExpired", {when: formatRelativeByLocale(row.invitation.expires_at, locale)})
      : t("invitationSent", {when: formatRelativeByLocale(row.invitation.last_sent_at ?? row.invitation.created_at, locale)});
  };

  async function run(key: string, work: () => Promise<string | void>) {
    setBusy(key);
    try {
      const message = await work();
      if (message) toast.success(message);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const patch = (userId: string, body: Record<string, unknown>) => api("/api/platform/members", { method: "PATCH", body: { user_id: userId, ...body } });

  async function changeRole(row: Extract<PersonRow, { kind: "member" }>, next: WorkspaceRole) {
    const { member } = row;
    if (next === member.role) return;
    if (next === "owner") {
      const ok = await confirm({
        title: t("makeOwnerTitle", {name: member.name}),
        body: t("makeOwnerBody"),
        confirmLabel: t("makeOwner"),
      });
      if (!ok) return;
    }
    await run(row.key, async () => {
      await patch(member.id, { role: next });
      return t("roleChanged", {name: member.name, role: roleLabel[next]});
    });
  }

  async function suspend(row: Extract<PersonRow, { kind: "member" }>) {
    const { member } = row;
    const keys = overview.active_api_keys[member.id] ?? 0;
    const ok = await confirm({
      title: t("suspendTitle", {name: member.name}),
      body: t("suspendBody") + (keys > 0 ? " " + t("activeKeys", {count: keys}) : "") + " " + t("restoreAnytime"),
      confirmLabel: t("suspendAccess"),
      tone: "danger",
    });
    if (!ok) return;
    await run(row.key, async () => {
      await patch(member.id, { suspended: true });
      return t("suspendedMessage", {name: member.name});
    });
  }

  async function remove(row: Extract<PersonRow, { kind: "member" }>) {
    const { member } = row;
    const ok = await confirm({
      title: t("removeTitle", {name: member.name}),
      body: t("removeBody"),
      confirmLabel: t("removeMember"),
      tone: "danger",
    });
    if (!ok) return;
    await run(row.key, async () => {
      await api("/api/platform/workspace", { method: "DELETE", query: { user_id: member.id } });
      return t("memberRemoved", {name: member.name});
    });
  }

  /** A new link for an invitation. Only a hash of a link is kept, so the earlier one cannot be shown again. */
  async function renew(row: Extract<PersonRow, { kind: "invitation" }>, send: boolean) {
    await run(row.key, async () => {
      const renewed = await api<Renewed>("/api/platform/invitations", { method: "PUT", body: { id: row.invitation.id, send_email: send } });
      let copied = false;
      try {
        await navigator.clipboard.writeText(renewed.invite_url);
        copied = true;
      } catch {
        // No clipboard access (an insecure page, or the browser said no): the link is shown instead.
      }
      if (send && renewed.email_sent) return t("sentAgain", {email: row.invitation.email, clipboard: copied ? " " + t("copiedHint") : ""});
      if (send) {
        toast.warning(t("sendFailed", {email: row.invitation.email}), { description: `${renewed.delivery_warning ?? t("noReason")} ${copied ? t("linkClipboard") : renewed.invite_url}`, duration: 12_000 });
        return;
      }
      if (copied) return t("copiedNew");
      toast.message(t("newLink"), { description: renewed.invite_url, duration: 20_000 });
    });
  }

  async function revoke(row: Extract<PersonRow, { kind: "invitation" }>) {
    const ok = await confirm({ title: t("revokeTitle", {email: row.invitation.email}), body: t("revokeBody"), confirmLabel: t("revokeInvitation"), tone: "danger" });
    if (!ok) return;
    await run(row.key, async () => {
      await api("/api/platform/invitations", { method: "DELETE", query: { id: row.invitation.id } });
      return t("revokeSuccess", {email: row.invitation.email});
    });
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3.5 py-[11px]">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("members")}</h2>
          <p className="text-11 text-ink-3">{t("rolesHint")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SearchInput value={search} onChange={setSearch} placeholder={t("search")} frameClassName="h-7 w-[180px] border-transparent bg-subtle text-11" />
          <Select
            size="sm" label={t("role")} value={role} onChange={setRole}
            options={[{ value: "all", label: t("allRoles") }, ...ROLE_ORDER.map((value) => ({ value, label: roleLabel[value] }))]}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <div role="table" aria-label={t("membersInvites")} className="min-w-[740px]">
          <div role="row" className={cn(GRID, "h-[31px] bg-subtle text-10 font-semibold uppercase tracking-label text-ink-3")}>
            <span role="columnheader">{t("member")}</span>
            <span role="columnheader">{t("roleHeader")}</span>
            <span role="columnheader">{t("status")}</span>
            <span role="columnheader">{t("lastActive")}</span>
            <span role="columnheader">{t("campaigns")}</span>
            <span role="columnheader"><span className="sr-only">{t("actions")}</span></span>
          </div>
          {rows.map((row) => {
            const allowed = allowedOn(actorRole, row);
            const badge = statusBadge(row);
            const name = row.kind === "member" ? row.member.name : row.invitation.email;
            const email = row.kind === "member" ? row.member.email : row.invitation.invited_by_email ? t("invitedBy", {email: row.invitation.invited_by_email}) : t("invited");
            const currentRole = row.kind === "member" ? row.member.role : row.invitation.role;
            const working = busy === row.key;
            return (
              <div key={row.key} role="row" aria-busy={working || undefined} className={cn(GRID, "min-h-[52px] border-t border-line py-1.5", working && "opacity-60")}>
                <div role="cell" className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={name} size={26} tint={row.kind === "member" && !row.member.suspended ? "bg-brand-tint" : "bg-control"} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-12 font-semibold text-ink">{name}</span>
                      {row.kind === "member" && row.you ? <Pill size="sm">{t("you")}</Pill> : null}
                    </div>
                    <span className="truncate text-105 text-ink-3">{email}</span>
                  </div>
                </div>

                <div role="cell">
                  {row.kind === "member" && allowed.role ? (
                    <Select
                      size="sm" tone="sunken" className="w-full" label={t("roleOf", {name})} value={currentRole} disabled={working}
                      onChange={(next) => void changeRole(row, next)}
                      options={grantableRoles(actorRole).map((value) => ({ value, label: roleLabel[value] }))}
                    />
                  ) : (
                    <span className={cn("inline-flex h-7 items-center rounded-md px-[9px] text-11 font-semibold", currentRole === "owner" ? "bg-brand-tint text-brand-strong" : "bg-control text-ink")}>
                      {roleLabel[currentRole]}
                    </span>
                  )}
                </div>

                <div role="cell"><Pill tone={badge.tone} dot>{statusLabel(row)}</Pill></div>

                <div role="cell" className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-11 text-ink-2">{activityLabel(row)}</span>
                  {row.kind === "invitation" && allowed.remove ? (
                    <span className="flex items-center gap-2">
                      <TextAction className="text-105" onClick={() => void renew(row, false)}>{t("copyLink")}</TextAction>
                      <TextAction className="text-105" onClick={() => void renew(row, true)}>{t("resend")}</TextAction>
                    </span>
                  ) : null}
                </div>

                <span role="cell" className="text-115 font-medium text-ink">
                  {row.kind === "member" && row.member.campaigns > 0 ? row.member.campaigns : <span className="font-normal text-ink-3">—</span>}
                </span>

                <div role="cell" className="flex justify-end">
                  {row.kind === "member" && (allowed.suspend || allowed.remove) ? (
                    <Menu trigger={<IconButton icon={Ellipsis} label={t("actionsFor", {name})} size={28} disabled={working} />}>
                      {allowed.suspend ? (
                        row.member.suspended
                          ? <MenuItem icon={ShieldCheck} onSelect={() => void run(row.key, async () => { await patch(row.member.id, { suspended: false }); return t("accessRestored", {name}); })}>{t("restoreAccess")}</MenuItem>
                          : <MenuItem icon={Ban} onSelect={() => void suspend(row)}>{t("suspendAccess")}</MenuItem>
                      ) : null}
                      {allowed.suspend && allowed.remove ? <MenuSeparator /> : null}
                      {allowed.remove ? <MenuItem icon={UserMinus} tone="danger" onSelect={() => void remove(row)}>{t("removeFromWorkspace")}</MenuItem> : null}
                    </Menu>
                  ) : row.kind === "invitation" && allowed.remove ? (
                    <Menu trigger={<IconButton icon={Ellipsis} label={t("inviteActions", {name})} size={28} disabled={working} />}>
                      <MenuItem icon={Link2} onSelect={() => void renew(row, false)}>{t("copyNewLink")}</MenuItem>
                      <MenuItem icon={Send} onSelect={() => void renew(row, true)}>{t("sendAgain")}</MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={Trash2} tone="danger" onSelect={() => void revoke(row)}>{t("revokeInvitation")}</MenuItem>
                    </Menu>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={UsersRound} title={filtering ? t("noMatches") : t("noMembers")} className="border-t border-line">
          {filtering ? t("noMatchHint") : t("noMembersHint")}
        </EmptyState>
      ) : null}
    </Card>
  );
}
