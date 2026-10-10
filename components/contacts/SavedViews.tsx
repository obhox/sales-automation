import { useState } from "react";
import { Bookmark, BookmarkPlus, Check, ChevronDown, Pencil, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, MenuLabel, MenuSeparator, Pill, Select, Switch, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { DialogForm } from "./ContactDialogs";
import { SAVED_VIEWS_PATH, type SavedView } from "./model";

const NEW = "new";

export interface ViewsProps {
  /** Which list screen these views belong to: the `resource` the API keeps them under. */
  resource: string;
  views: SavedView[];
  /** The view the screen is showing right now, when its filters and layout match one. */
  current: SavedView | null;
  /** What saving stores: the address-bar entries and the table's layout. */
  state: SavedView["state"];
  canSave: boolean;
  canShare: boolean;
  onApply: (view: SavedView) => void;
  onChanged: () => void;
}

/** "Save view" and, once there are views, the menu that lists them. */
export function SavedViews({ resource, views, current, state, canSave, canShare, onApply, onChanged }: ViewsProps) {
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const shared = views.filter((view) => view.shared);
  const own = views.filter((view) => !view.shared);

  return (
    <>
      {views.length > 0 ? (
        <Menu
          width={232}
          trigger={
            <button type="button" className="inline-flex h-7 max-w-[200px] shrink-0 items-center gap-[5px] rounded-md border border-line-strong bg-surface px-[9px] text-11 font-medium text-ink hover:bg-subtle">
              <Bookmark size={12} className="shrink-0 text-ink-2" aria-hidden="true" />
              <span className="truncate">{current ? current.name : "Views"}</span>
              <ChevronDown size={12} className="shrink-0 text-ink-2" aria-hidden="true" />
            </button>
          }
        >
          {own.length > 0 ? <MenuLabel>Your views</MenuLabel> : null}
          {own.map((view) => <MenuItem key={view.id} icon={current?.id === view.id ? Check : undefined} onSelect={() => onApply(view)}>{view.name}</MenuItem>)}
          {shared.length > 0 ? <MenuLabel>Shared with the workspace</MenuLabel> : null}
          {shared.map((view) => <MenuItem key={view.id} icon={current?.id === view.id ? Check : Users} onSelect={() => onApply(view)}>{view.name}</MenuItem>)}
          <MenuSeparator />
          <MenuItem icon={Pencil} onSelect={() => setManaging(true)}>Manage views</MenuItem>
        </Menu>
      ) : null}
      {canSave ? (
        <button type="button" onClick={() => setSaving(true)} className="inline-flex h-7 shrink-0 items-center gap-[5px] rounded-md border border-line-strong bg-surface px-[9px] text-11 font-medium text-ink hover:bg-subtle">
          <BookmarkPlus size={12} className="text-ink-2" aria-hidden="true" />
          Save view
        </button>
      ) : null}

      <Dialog open={saving} onOpenChange={(next) => { if (!next) setSaving(false); }} title="Save view" description="The filters, search, sort, columns and density as they are now" size="sm" padded={false}>
        {saving ? <SaveViewForm resource={resource} views={views} current={current} state={state} canShare={canShare} onClose={() => setSaving(false)} onSaved={onChanged} /> : null}
      </Dialog>
      <Dialog open={managing} onOpenChange={(next) => { if (!next) setManaging(false); }} title="Saved views" size="sm">
        {managing ? (
          views.length === 0 ? <EmptyState title="No saved views" /> : (
            <ul className="flex flex-col gap-px">
              {views.map((view) => <ViewRow key={view.id} view={view} canShare={canShare} onChanged={onChanged} />)}
            </ul>
          )
        ) : null}
      </Dialog>
    </>
  );
}

function SaveViewForm({ resource, views, current, state, canShare, onClose, onSaved }: { resource: string; views: SavedView[]; current: SavedView | null; state: SavedView["state"]; canShare: boolean; onClose: () => void; onSaved: () => void }) {
  const replaceable = views.filter((view) => view.editable);
  const [target, setTarget] = useState(NEW);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = target !== NEW || name.trim() !== "";

  async function save() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (target === NEW) {
        await api(SAVED_VIEWS_PATH, { method: "POST", body: { resource, name: name.trim(), state, shared } });
        toast.success(`View "${name.trim()}" saved`);
      } else {
        await api(SAVED_VIEWS_PATH, { method: "PATCH", body: { id: target, state } });
        toast.success(`View "${replaceable.find((view) => view.id === target)?.name ?? ""}" updated`);
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={busy} disabled={!ready}>{target === NEW ? "Save view" : "Update view"}</Button>}>
      {replaceable.length > 0 ? (
        <Field label="Save as">
          {(id) => (
            <Select
              id={id} value={target} onChange={setTarget} className="w-full"
              options={[{ value: NEW, label: "A new view" }, ...replaceable.map((view) => ({ value: view.id, label: `Replace "${view.name}"`, hint: view.shared ? "Shared with the workspace" : undefined }))]}
            />
          )}
        </Field>
      ) : null}
      {target === NEW ? (
        <>
          <Field label="Name">{(id) => <Input id={id} data-autofocus value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder={current ? `${current.name} copy` : "Hot leads in Germany"} autoComplete="off" />}</Field>
          {canShare ? (
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
              <span className="flex flex-col gap-0.5">
                <span className="text-12 font-medium text-ink">Share with the workspace</span>
                <span className="text-105 text-ink-3">Everyone sees it. A manager or above can change it.</span>
              </span>
              <Switch checked={shared} onChange={setShared} label="Share with the workspace" />
            </label>
          ) : null}
        </>
      ) : null}
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

function ViewRow({ view, canShare, onChanged }: { view: SavedView; canShare: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(view.name);
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      await api(SAVED_VIEWS_PATH, { method: "PATCH", body: { id: view.id, ...body } });
      toast.success(done);
      setEditing(false);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({ title: `Delete the view "${view.name}"?`, body: view.shared ? "It is removed for everyone in the workspace. No contact is changed." : "No contact is changed.", confirmLabel: "Delete view", tone: "danger" });
    if (!ok) return;
    try {
      await api(SAVED_VIEWS_PATH, { method: "DELETE", query: { id: view.id } });
      toast.success(`View "${view.name}" deleted`);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  if (editing) {
    return (
      <li className="rounded-md bg-subtle p-2">
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void patch({ name: name.trim() }, "View renamed"); }}>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} aria-label="View name" autoFocus frameClassName="flex-1" />
          <IconButton type="submit" icon={Check} label="Save" size={28} variant="outline" disabled={busy || !name.trim()} />
          <IconButton icon={X} label="Cancel" size={28} onClick={() => { setEditing(false); setName(view.name); }} />
        </form>
      </li>
    );
  }
  return (
    <li className="flex h-9 items-center justify-between gap-2 rounded-md px-2 hover:bg-subtle">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-12 font-medium text-ink">{view.name}</span>
        {view.shared ? <Pill size="sm" tone="brand" icon={Users}>Shared</Pill> : null}
      </span>
      {view.editable ? (
        <span className="flex shrink-0 items-center gap-1">
          {canShare ? (
            <button type="button" disabled={busy} onClick={() => void patch({ shared: !view.shared }, view.shared ? "The view is yours alone again" : "The view is shared with the workspace")} className="rounded-md px-1.5 text-11 font-semibold text-brand-strong hover:underline disabled:opacity-50">
              {view.shared ? "Stop sharing" : "Share"}
            </button>
          ) : null}
          <IconButton icon={Pencil} label={`Rename ${view.name}`} size={24} onClick={() => setEditing(true)} />
          <IconButton icon={Trash2} label={`Delete ${view.name}`} size={24} onClick={() => void remove()} />
        </span>
      ) : (
        <span className="text-105 text-ink-3">A manager changes shared views</span>
      )}
    </li>
  );
}
