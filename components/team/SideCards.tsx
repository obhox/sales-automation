import { useState } from "react";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { CircleCheckBig, Crown, Eye, Lock, Pencil, Shield, User, UserCog, Check, Minus } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Dialog, Field, IconButton, Input, Pill, TextAction, type Icon } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { CAPABILITIES, ROLE_ORDER, can, roleCounts, type TeamOverview, type WorkspaceRole } from "./model";

const MARK_TINTS = ["bg-brand", "bg-li", "bg-mail", "bg-good", "bg-warn"];
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";

/** The workspaces the reader belongs to: switch, rename this one, or make another. */
export function WorkspacesCard({ overview, onChanged }: { overview: TeamOverview; onChanged: () => void }) {
  const t = useTranslations("TeamSideCards");
  const roleLabels: Record<WorkspaceRole, string> = {
    owner: t("roleOwner"), admin: t("roleAdmin"), manager: t("roleManager"),
    member: t("roleMember"), viewer: t("roleViewer"),
  };
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
        toast.success(t("renamed", {name: clean}));
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
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("workspaces")}</h2>
          <p className="text-11 text-ink-3">{t("separation")}</p>
        </div>
        <TextAction onClick={() => { setName(""); setDialog("new"); }}>{t("new")}</TextAction>
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
                  {t("memberSummary", {count: workspace.members, role: roleLabels[workspace.role]})}
                </span>
              </div>
              {current ? (
                <>
                  {canRename ? <IconButton icon={Pencil} label={t("renameWorkspace")} size={24} onClick={() => { setName(overview.workspace.name); setDialog("rename"); }} /> : null}
                  <CircleCheckBig size={16} className="shrink-0 text-brand" aria-label={t("currentWorkspace")} />
                </>
              ) : workspace.suspended ? (
                <Pill tone="bad" size="sm">{t("suspended")}</Pill>
              ) : (
                <TextAction className="text-105" onClick={() => void switchTo(workspace.id)}>{t("switch")}</TextAction>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => (open || busy ? undefined : setDialog(null))}
        size="sm"
        title={dialog === "rename" ? t("renameTitle") : t("newTitle")}
        description={dialog === "rename" ? t("renameDescription") : t("newDescription")}
        footer={
          <>
            <span />
            <div className="flex items-center gap-2">
              <Button onClick={() => setDialog(null)} disabled={busy}>{t("cancel")}</Button>
              <Button variant="primary" loading={busy} disabled={!name.trim() || (dialog === "rename" && name.trim() === overview.workspace.name)} onClick={() => void submit()}>{dialog === "rename" ? t("rename") : t("createSwitch")}</Button>
            </div>
          </>
        }
      >
        <form onSubmit={(event) => { event.preventDefault(); if (!busy) void submit(); }}>
          <Field label={t("name")} hint={dialog === "rename" ? undefined : t("ownerHint")}>
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
  const t = useTranslations("TeamSideCards");
  const roleLabels: Record<WorkspaceRole, string> = {
    owner: t("roleOwner"), admin: t("roleAdmin"), manager: t("roleManager"),
    member: t("roleMember"), viewer: t("roleViewer"),
  };
  const [comparing, setComparing] = useState(false);
  const counts = roleCounts(overview.members);
  const roleSummaries: Record<WorkspaceRole, string> = {
    owner: t("summaryOwner"), admin: t("summaryAdmin"), manager: t("summaryManager"),
    member: t("summaryMember"), viewer: t("summaryViewer"),
  };
  const groupTitles: Record<string, string> = {
    "Everyday work": t("groupEveryday"), "Running campaigns": t("groupCampaigns"),
    "Setting up the workspace": t("groupSettings"),
  };
  const capabilities: Record<string, string> = {
    read: t("capRead"), contacts: t("capContacts"), inbox: t("capInbox"),
    campaigns: t("capCampaigns"), "publish-idle": t("capPublishIdle"),
    "ai-steps": t("capAiSteps"), pipeline: t("capPipeline"),
    "publish-live": t("capPublishLive"), runs: t("capRuns"),
    imports: t("capImports"), export: t("capExport"), rules: t("capRules"),
    "pause-account": t("capPauseAccount"), senders: t("capSenders"),
    ai: t("capAi"), developers: t("capDevelopers"), members: t("capMembers"),
    audit: t("capAudit"), owners: t("capOwners"),
  };
  return (
    <Card className="flex flex-col gap-[11px] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("rolesTitle")}</h2>
          <p className="text-11 text-ink-3">{t("rolesSubtitle")}</p>
        </div>
        <TextAction onClick={() => setComparing(true)}>{t("compare")}</TextAction>
      </div>
      <ul className="flex flex-col">
        {ROLE_ORDER.map((role) => {
          const Glyph = ROLE_ICON[role];
          return (
            <li key={role} className="flex gap-2.5 border-t border-line py-2.5 first:border-t-0 first:pt-0.5">
              <span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-md bg-subtle text-ink-2" aria-hidden="true"><Glyph size={13} /></span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-12 font-semibold text-ink">{roleLabels[role]}</span>
                  <Pill size="sm">{counts[role]}</Pill>
                  {role === overview.your_role ? <span className="text-105 text-ink-3">{t("yourRole")}</span> : null}
                </div>
                <p className="text-105 leading-[14px] text-ink-2">{roleSummaries[role]}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="flex items-start gap-[9px] rounded-lg bg-subtle p-2.5 text-105 leading-[15px] text-ink-2">
        <Lock size={13} className="mt-px shrink-0 text-ink-3" aria-hidden="true" />
        {t("permissionNote")}
      </p>

      <Dialog open={comparing} onOpenChange={setComparing} size="lg" title={t("compareTitle")} description={t("compareDescription")}>
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              <th scope="col" className="pb-2 text-10 font-semibold uppercase tracking-label text-ink-3">{t("can")}</th>
              {ROLE_ORDER.map((role) => (
                <th key={role} scope="col" className={cn("w-[76px] pb-2 text-center text-11 font-semibold", role === overview.your_role ? "text-brand-strong" : "text-ink")}>
                  {roleLabels[role]}
                </th>
              ))}
            </tr>
          </thead>
          {CAPABILITIES.map((group) => (
            <tbody key={group.title}>
              <tr>
                <th scope="colgroup" colSpan={ROLE_ORDER.length + 1} className="border-t border-line bg-subtle px-2 py-1.5 text-10 font-semibold uppercase tracking-label text-ink-3">{groupTitles[group.title] ?? group.title}</th>
              </tr>
              {group.capabilities.map((capability) => (
                <tr key={capability.key} className="border-t border-line">
                  <th scope="row" className="py-[7px] pr-3 text-115 font-normal text-ink">{capabilities[capability.key] ?? capability.label}</th>
                  {ROLE_ORDER.map((role) => (
                    <td key={role} className={cn("text-center", role === overview.your_role && "bg-brand-tint/50")}>
                      {can(role, capability) ? (
                        <Check size={13} strokeWidth={3} className="mx-auto text-good" aria-label={t("yes")} />
                      ) : (
                        <Minus size={12} className="mx-auto text-line-strong" aria-label={t("no")} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        <p className="mt-3 text-105 leading-[15px] text-ink-3">
          {t("suspensionNote")}
        </p>
      </Dialog>
    </Card>
  );
}
