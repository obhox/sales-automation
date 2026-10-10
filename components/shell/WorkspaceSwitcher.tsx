import { useState } from "react";
import { useSession } from "next-auth/react";
import { ChevronsUpDown, Plus, SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button, Dialog, Field, Input, Menu, MenuCheckItem, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { ROLE_LABEL, isWorkspaceRole } from "@/lib/roles";
import { useShell } from "./useShell";

/** The square mark that stands for the product wherever the name is not spelled out. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <span style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-lg bg-brand text-white" aria-hidden="true">
      <SendHorizontal size={Math.round(size * 0.54)} />
    </span>
  );
}

/** Product name and current workspace at the top of the sidebar; opens the list of workspaces. */
export function WorkspaceSwitcher() {
  const { data: session, update } = useSession();
  const { data: shell } = useShell();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const current = shell?.workspace.name ?? session?.user?.workspaceName ?? "Workspace";

  // The workspace is part of the session. Refreshing the session with another id checks
  // membership on the server; a full reload then drops everything cached for the old one.
  const switchTo = async (workspaceId: string) => {
    if (workspaceId === shell?.workspace.id) return;
    try {
      await update({ workspaceId });
      window.location.assign("/");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const created = await api<{ id: string; name: string }>("/api/platform/workspaces", { method: "POST", body: { name } });
      await update({ workspaceId: created.id });
      window.location.assign("/");
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <>
      <Menu
        align="start"
        width={232}
        trigger={
          <button type="button" className="flex h-14 w-full shrink-0 items-center justify-between gap-2 px-3.5 text-left" aria-label={`Workspace: ${current}. Switch workspace`}>
            <span className="flex min-w-0 items-center gap-[9px]">
              <BrandMark />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="text-135 font-medium tracking-title text-ink">Linki</span>
                <span className="truncate text-105 font-medium text-ink-3">{current}</span>
              </span>
            </span>
            <ChevronsUpDown size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
          </button>
        }
      >
        <MenuLabel>Workspaces</MenuLabel>
        {(shell?.workspaces ?? []).map(workspace => (
          <MenuCheckItem key={workspace.id} checked={workspace.id === shell?.workspace.id} onChange={() => void switchTo(workspace.id)}>
            <span className="flex items-center justify-between gap-2">
              <span className="truncate">{workspace.name}</span>
              <span className="shrink-0 text-105 font-normal text-ink-3">{isWorkspaceRole(workspace.role) ? ROLE_LABEL[workspace.role] : workspace.role}</span>
            </span>
          </MenuCheckItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={Plus} onSelect={() => { setName(""); setCreating(true); }}>
          New workspace
        </MenuItem>
      </Menu>

      <Dialog
        open={creating}
        onOpenChange={open => (busy ? undefined : setCreating(open))}
        title="New workspace"
        description="Contacts, campaigns, mailboxes and LinkedIn accounts stay separate in each workspace."
        size="sm"
        footer={
          <>
            <span />
            <span className="flex items-center gap-2">
              <Button onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={() => void create()} loading={busy} disabled={!name.trim()}>Create and switch</Button>
            </span>
          </>
        }
      >
        <form onSubmit={event => { event.preventDefault(); if (name.trim() && !busy) void create(); }}>
          <Field label="Name" hint="You will be its owner.">
            {id => <Input id={id} value={name} onChange={event => setName(event.target.value)} placeholder="Acme EMEA" maxLength={80} data-autofocus />}
          </Field>
        </form>
      </Dialog>
    </>
  );
}
