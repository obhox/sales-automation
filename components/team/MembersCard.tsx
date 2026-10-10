import { useState } from "react";
import { Ban, Ellipsis, Link2, Send, ShieldCheck, Trash2, UserMinus, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Card, EmptyState, IconButton, Menu, MenuItem, MenuSeparator, Pill, SearchInput, Select, TextAction, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { plural } from "@/lib/client/format";
import { ROLE_LABEL, ROLE_ORDER, activityLine, allowedOn, grantableRoles, personRows, statusBadge, type PersonRow, type TeamOverview, type WorkspaceRole } from "./model";

const GRID = "grid grid-cols-[minmax(170px,1fr)_150px_118px_118px_82px_28px] items-center gap-3 px-3.5";

interface Renewed {
  invite_url: string;
  email_sent: boolean;
  delivery_warning: string | null;
}

/** Everyone in the workspace and everyone invited to it: role, state, last activity, campaigns. */
export function MembersCard({ overview, onChanged }: { overview: TeamOverview; onChanged: () => void }) {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<WorkspaceRole | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const rows = personRows(overview, search, role);
  const actorRole = overview.your_role;
  const filtering = search.trim() !== "" || role !== "all";

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
        title: `Make ${member.name} an owner?`,
        body: "An owner can do everything, including making other owners and changing your role. Only an owner can undo this.",
        confirmLabel: "Make owner",
      });
      if (!ok) return;
    }
    await run(row.key, async () => {
      await patch(member.id, { role: next });
      return `${member.name} is now ${next === "owner" || next === "admin" ? "an" : "a"} ${ROLE_LABEL[next].toLowerCase()}`;
    });
  }

  async function suspend(row: Extract<PersonRow, { kind: "member" }>) {
    const { member } = row;
    const keys = overview.active_api_keys[member.id] ?? 0;
    const ok = await confirm({
      title: `Suspend ${member.name}?`,
      body: `They are refused everywhere in this workspace from their next click: the app, the MCP server and every route behind them. Their role is kept, their campaigns keep running and nothing of theirs is deleted. ${
        keys > 0 ? `${keys} API ${plural(keys, "key", "keys")} they created ${plural(keys, "keeps", "keep")} working: revoke ${plural(keys, "it", "them")} on the Developer API page if ${plural(keys, "it", "they")} should not. ` : ""
      }You can restore their access at any time.`,
      confirmLabel: "Suspend access",
      tone: "danger",
    });
    if (!ok) return;
    await run(row.key, async () => {
      await patch(member.id, { suspended: true });
      return `${member.name} is suspended`;
    });
  }

  async function remove(row: Extract<PersonRow, { kind: "member" }>) {
    const { member } = row;
    const ok = await confirm({
      title: `Remove ${member.name} from the workspace?`,
      body: "They lose all access to this workspace and would need a new invitation to come back. Their campaigns, contacts and replies stay. To stop their access for a while, suspend them instead.",
      confirmLabel: "Remove member",
      tone: "danger",
    });
    if (!ok) return;
    await run(row.key, async () => {
      await api("/api/platform/workspace", { method: "DELETE", query: { user_id: member.id } });
      return `${member.name} was removed`;
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
      if (send && renewed.email_sent) return `Invitation sent again to ${row.invitation.email}${copied ? ". The new link is also on your clipboard." : ""}`;
      if (send) {
        toast.warning(`The email to ${row.invitation.email} could not be sent`, { description: `${renewed.delivery_warning ?? "No reason was given."} ${copied ? "The new link is on your clipboard to send yourself." : renewed.invite_url}`, duration: 12_000 });
        return;
      }
      if (copied) return "A new invitation link is on your clipboard. The earlier link no longer works.";
      toast.message("New invitation link", { description: renewed.invite_url, duration: 20_000 });
    });
  }

  async function revoke(row: Extract<PersonRow, { kind: "invitation" }>) {
    const ok = await confirm({ title: `Revoke the invitation for ${row.invitation.email}?`, body: "The link they were sent stops working. You can invite them again later.", confirmLabel: "Revoke invitation", tone: "danger" });
    if (!ok) return;
    await run(row.key, async () => {
      await api("/api/platform/invitations", { method: "DELETE", query: { id: row.invitation.id } });
      return `The invitation for ${row.invitation.email} was revoked`;
    });
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3.5 py-[11px]">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Members</h2>
          <p className="text-11 text-ink-3">Roles apply to this workspace only</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SearchInput value={search} onChange={setSearch} placeholder="Search members" frameClassName="h-7 w-[180px] border-transparent bg-subtle text-11" />
          <Select
            size="sm" label="Role" value={role} onChange={setRole}
            options={[{ value: "all", label: "All roles" }, ...ROLE_ORDER.map((value) => ({ value, label: ROLE_LABEL[value] }))]}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <div role="table" aria-label="Members and invitations" className="min-w-[740px]">
          <div role="row" className={cn(GRID, "h-[31px] bg-subtle text-10 font-semibold uppercase tracking-label text-ink-3")}>
            <span role="columnheader">Member</span>
            <span role="columnheader">Role</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Last active</span>
            <span role="columnheader">Campaigns</span>
            <span role="columnheader"><span className="sr-only">Actions</span></span>
          </div>
          {rows.map((row) => {
            const allowed = allowedOn(actorRole, row);
            const badge = statusBadge(row);
            const name = row.kind === "member" ? row.member.name : row.invitation.email;
            const email = row.kind === "member" ? row.member.email : `Invited${row.invitation.invited_by_email ? ` by ${row.invitation.invited_by_email}` : ""}`;
            const currentRole = row.kind === "member" ? row.member.role : row.invitation.role;
            const working = busy === row.key;
            return (
              <div key={row.key} role="row" aria-busy={working || undefined} className={cn(GRID, "min-h-[52px] border-t border-line py-1.5", working && "opacity-60")}>
                <div role="cell" className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={name} size={26} tint={row.kind === "member" && !row.member.suspended ? "bg-brand-tint" : "bg-control"} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-12 font-semibold text-ink">{name}</span>
                      {row.kind === "member" && row.you ? <Pill size="sm">You</Pill> : null}
                    </div>
                    <span className="truncate text-105 text-ink-3">{email}</span>
                  </div>
                </div>

                <div role="cell">
                  {row.kind === "member" && allowed.role ? (
                    <Select
                      size="sm" tone="sunken" className="w-full" label={`Role of ${name}`} value={currentRole} disabled={working}
                      onChange={(next) => void changeRole(row, next)}
                      options={grantableRoles(actorRole).map((value) => ({ value, label: ROLE_LABEL[value] }))}
                    />
                  ) : (
                    <span className={cn("inline-flex h-7 items-center rounded-md px-[9px] text-11 font-semibold", currentRole === "owner" ? "bg-brand-tint text-brand-strong" : "bg-control text-ink")}>
                      {ROLE_LABEL[currentRole]}
                    </span>
                  )}
                </div>

                <div role="cell"><Pill tone={badge.tone} dot>{badge.label}</Pill></div>

                <div role="cell" className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-11 text-ink-2">{activityLine(row)}</span>
                  {row.kind === "invitation" && allowed.remove ? (
                    <span className="flex items-center gap-2">
                      <TextAction className="text-105" onClick={() => void renew(row, false)}>Copy link</TextAction>
                      <TextAction className="text-105" onClick={() => void renew(row, true)}>Resend</TextAction>
                    </span>
                  ) : null}
                </div>

                <span role="cell" className="text-115 font-medium text-ink">
                  {row.kind === "member" && row.member.campaigns > 0 ? row.member.campaigns : <span className="font-normal text-ink-3">—</span>}
                </span>

                <div role="cell" className="flex justify-end">
                  {row.kind === "member" && (allowed.suspend || allowed.remove) ? (
                    <Menu trigger={<IconButton icon={Ellipsis} label={`Actions for ${name}`} size={28} disabled={working} />}>
                      {allowed.suspend ? (
                        row.member.suspended
                          ? <MenuItem icon={ShieldCheck} onSelect={() => void run(row.key, async () => { await patch(row.member.id, { suspended: false }); return `${name} has access again`; })}>Restore access</MenuItem>
                          : <MenuItem icon={Ban} onSelect={() => void suspend(row)}>Suspend access</MenuItem>
                      ) : null}
                      {allowed.suspend && allowed.remove ? <MenuSeparator /> : null}
                      {allowed.remove ? <MenuItem icon={UserMinus} tone="danger" onSelect={() => void remove(row)}>Remove from workspace</MenuItem> : null}
                    </Menu>
                  ) : row.kind === "invitation" && allowed.remove ? (
                    <Menu trigger={<IconButton icon={Ellipsis} label={`Actions for the invitation to ${name}`} size={28} disabled={working} />}>
                      <MenuItem icon={Link2} onSelect={() => void renew(row, false)}>Copy a new link</MenuItem>
                      <MenuItem icon={Send} onSelect={() => void renew(row, true)}>Send again</MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={Trash2} tone="danger" onSelect={() => void revoke(row)}>Revoke invitation</MenuItem>
                    </Menu>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={UsersRound} title={filtering ? "Nobody matches" : "Nobody here yet"} className="border-t border-line">
          {filtering ? "No member or invitation matches the search and the role chosen." : "Invite a teammate to share campaigns, the inbox and reports."}
        </EmptyState>
      ) : null}
    </Card>
  );
}
