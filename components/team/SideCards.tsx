import { useState } from "react";
import { useSession } from "next-auth/react";
import { CircleCheckBig, Crown, Eye, Lock, Pencil, Shield, User, UserCog, Check, Minus } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Dialog, Field, IconButton, Input, Pill, TextAction, type Icon } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { plural } from "@/lib/client/format";
import { CAPABILITIES, ROLE_LABEL, ROLE_ORDER, ROLE_SUMMARY, can, roleCounts, type TeamOverview, type WorkspaceRole } from "./model";

const MARK_TINTS = ["bg-brand", "bg-li", "bg-mail", "bg-good", "bg-warn"];
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";

/** The workspaces the reader belongs to: switch, rename this one, or make another. */
export function WorkspacesCard({ overview, onChanged }: { overview: TeamOverview; onChanged: () => void }) {
  const { update } = useSession();
  const [dialog, setDialog] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const canRename = overview.your_role === "owner" || overview.your_role === "admin";

  // The workspace is part of the session. Refreshing the session with another id checks
  // membership on the server; a full reload then drops everything cached for the old one.
  async function switchTo(id: string) {
    try {
      await update({ workspaceId: id });
      window.location.assign("/");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  async function submit() {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    try {
      if (dialog === "rename") {
        await api("/api/platform/workspace", { method: "PATCH", body: { name: clean } });
        toast.success(`The workspace is now called ${clean}`);
        setDialog(null);
        onChanged();
      } else {
        const created = await api<{ id: string }>("/api/platform/workspaces", { method: "POST", body: { name: clean } });
        await update({ workspaceId: created.id });
        window.location.assign("/");
        return;
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
    setBusy(false);
  }

  return (
    <Card className="flex flex-col gap-[11px] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Workspaces</h2>
          <p className="text-11 text-ink-3">Data, mailboxes and accounts stay separate</p>
        </div>
        <TextAction onClick={() => { setName(""); setDialog("new"); }}>+ New</TextAction>
      </div>
      <ul className="flex flex-col gap-[7px]">
        {/* The one you are in comes first; the tint of each mark stays with its place in the full list. */}
        {overview.workspaces.map((workspace, index) => ({ workspace, index })).sort((a, b) => Number(b.workspace.id === overview.workspace.id) - Number(a.workspace.id === overview.workspace.id)).map(({ workspace, index }) => {
          const current = workspace.id === overview.workspace.id;
          return (
            <li key={workspace.id} className={cn("flex items-center gap-2.5 rounded-lg p-[9px]", current ? "bg-brand-tint" : "bg-subtle")}>
              <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md text-105 font-semibold text-white", MARK_TINTS[index % MARK_TINTS.length])} aria-hidden="true">{initials(workspace.name)}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-12 font-semibold text-ink">{workspace.name}</span>
                <span className="truncate text-105 text-ink-3">
                  {workspace.members} {plural(workspace.members, "member", "members")} · you are {workspace.role === "owner" || workspace.role === "admin" ? "an" : "a"} {ROLE_LABEL[workspace.role].toLowerCase()}
                </span>
              </div>
              {current ? (
                <>
                  {canRename ? <IconButton icon={Pencil} label="Rename this workspace" size={24} onClick={() => { setName(overview.workspace.name); setDialog("rename"); }} /> : null}
                  <CircleCheckBig size={16} className="shrink-0 text-brand" aria-label="The workspace you are in" />
                </>
              ) : workspace.suspended ? (
                <Pill tone="bad" size="sm">Access suspended</Pill>
              ) : (
                <TextAction className="text-105" onClick={() => void switchTo(workspace.id)}>Switch</TextAction>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => (open || busy ? undefined : setDialog(null))}
        size="sm"
        title={dialog === "rename" ? "Rename the workspace" : "New workspace"}
        description={dialog === "rename" ? "Everyone in it sees the new name" : "Contacts, campaigns, mailboxes and LinkedIn accounts stay separate in each workspace."}
        footer={
          <>
            <span />
            <div className="flex items-center gap-2">
              <Button onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
              <Button variant="primary" loading={busy} disabled={!name.trim() || (dialog === "rename" && name.trim() === overview.workspace.name)} onClick={() => void submit()}>{dialog === "rename" ? "Rename" : "Create and switch"}</Button>
            </div>
          </>
        }
      >
        <form onSubmit={(event) => { event.preventDefault(); if (!busy) void submit(); }}>
          <Field label="Name" hint={dialog === "rename" ? undefined : "You will be its owner."}>
            {(id) => <Input id={id} data-autofocus value={name} maxLength={80} placeholder="Acme EMEA" onChange={(event) => setName(event.target.value)} />}
          </Field>
        </form>
      </Dialog>
    </Card>
  );
}

const ROLE_ICON: Record<WorkspaceRole, Icon> = { owner: Crown, admin: Shield, manager: UserCog, member: User, viewer: Eye };

/** The five roles, how many members hold each, and a comparison of what each can do. */
export function RolesCard({ overview }: { overview: TeamOverview }) {
  const [comparing, setComparing] = useState(false);
  const counts = roleCounts(overview.members);
  return (
    <Card className="flex flex-col gap-[11px] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Roles & permissions</h2>
          <p className="text-11 text-ink-3">Five fixed roles, enforced everywhere</p>
        </div>
        <TextAction onClick={() => setComparing(true)}>Compare</TextAction>
      </div>
      <ul className="flex flex-col">
        {ROLE_ORDER.map((role) => {
          const Glyph = ROLE_ICON[role];
          return (
            <li key={role} className="flex gap-2.5 border-t border-line py-2.5 first:border-t-0 first:pt-0.5">
              <span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-md bg-subtle text-ink-2" aria-hidden="true"><Glyph size={13} /></span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-12 font-semibold text-ink">{ROLE_LABEL[role]}</span>
                  <Pill size="sm">{counts[role]}</Pill>
                  {role === overview.your_role ? <span className="text-105 text-ink-3">your role</span> : null}
                </div>
                <p className="text-105 leading-[14px] text-ink-2">{ROLE_SUMMARY[role]}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="flex items-start gap-[9px] rounded-lg bg-subtle p-2.5 text-105 leading-[15px] text-ink-2">
        <Lock size={13} className="mt-px shrink-0 text-ink-3" aria-hidden="true" />
        Roles are enforced on the API and the MCP server, not only in the interface.
      </p>

      <Dialog open={comparing} onOpenChange={setComparing} size="lg" title="What each role can do" description="A role includes everything the roles to its right can do">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              <th scope="col" className="pb-2 text-10 font-semibold uppercase tracking-label text-ink-3">Can</th>
              {ROLE_ORDER.map((role) => (
                <th key={role} scope="col" className={cn("w-[76px] pb-2 text-center text-11 font-semibold", role === overview.your_role ? "text-brand-strong" : "text-ink")}>
                  {ROLE_LABEL[role]}
                </th>
              ))}
            </tr>
          </thead>
          {CAPABILITIES.map((group) => (
            <tbody key={group.title}>
              <tr>
                <th scope="colgroup" colSpan={ROLE_ORDER.length + 1} className="border-t border-line bg-subtle px-2 py-1.5 text-10 font-semibold uppercase tracking-label text-ink-3">{group.title}</th>
              </tr>
              {group.capabilities.map((capability) => (
                <tr key={capability.key} className="border-t border-line">
                  <th scope="row" className="py-[7px] pr-3 text-115 font-normal text-ink">{capability.label}</th>
                  {ROLE_ORDER.map((role) => (
                    <td key={role} className={cn("text-center", role === overview.your_role && "bg-brand-tint/50")}>
                      {can(role, capability) ? (
                        <Check size={13} strokeWidth={3} className="mx-auto text-good" aria-label="Yes" />
                      ) : (
                        <Minus size={12} className="mx-auto text-line-strong" aria-label="No" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        <p className="mt-3 text-105 leading-[15px] text-ink-3">
          A member who is suspended keeps their role and can do none of this until they are restored. API keys act for the workspace within the scopes they were given, whatever the role of whoever created them.
        </p>
      </Dialog>
    </Card>
  );
}
