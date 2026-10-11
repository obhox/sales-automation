import { useState } from "react";
import { toast } from "sonner";
import { Alert, Button, Dialog, Drawer, EmptyState, ErrorState, Field, Input, LoadingState, Pill, Select, Textarea, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
import { DialogForm } from "@/components/contacts/ContactDialogs";
import {
  IMPORTS_PATH, IMPORT_CAP_PATH, LISTS_PATH, capLine, contactsNoun, jobIsLive, jobLine, jobState, listPath,
  type ImportsOverview, type ListDetail, type ListRow,
} from "./model";

const NOBODY = "none";

// ── New list, edit list ───────────────────────────────────────────────────────

export function ListFormDialog({ open, list, members, onClose, onSaved }: { open: boolean; list: ListRow | null; members: { id: string; name: string }[]; onClose: () => void; onSaved: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={list ? "Edit list" : "New list"} description={list ? undefined : "Contacts are added by import, or from the Contacts screen"} size="sm" padded={false}>
      {open ? <ListForm list={list} members={members} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function ListForm({ list, members, onClose, onSaved }: { list: ListRow | null; members: { id: string; name: string }[]; onClose: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [owner, setOwner] = useState(list?.owner?.id ?? NOBODY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (list) {
        await api(listPath(list.id), { method: "PUT", body: { name: name.trim(), description: description.trim(), owner_id: owner === NOBODY ? null : owner } });
        toast.success("List saved");
        onSaved(list.id);
      } else {
        const created = await api<{ id: string }>(LISTS_PATH, { method: "POST", body: { name: name.trim(), description: description.trim() || undefined } });
        toast.success(`List "${name.trim()}" made`);
        onSaved(created.id);
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>{list ? "Save" : "Make list"}</Button>}>
      <Field label="Name">{(id) => <Input id={id} data-autofocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Series B SaaS · VP Sales" autoComplete="off" />}</Field>
      <Field label="Description">{(id) => <Textarea id={id} value={description} onChange={(event) => setDescription(event.target.value)} rows={2} placeholder="Who is in it, and why" />}</Field>
      {list ? (
        <Field label="Owner">
          {(id) => <Select id={id} value={owner} onChange={setOwner} className="w-full" options={[{ value: NOBODY, label: "No owner" }, ...members.map((member) => ({ value: member.id, label: member.name }))]} />}
        </Field>
      ) : null}
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Import jobs and the daily cap ─────────────────────────────────────────────

/**
 * Every Sales Navigator import that is running, queued or lately finished, and the cap on
 * how many contacts are imported in a day. A list larger than the cap is imported over
 * several days, a batch each.
 */
export function ImportsDrawer({ open, canCancel, canSetCap, onClose, onChanged }: { open: boolean; canCancel: boolean; canSetCap: boolean; onClose: () => void; onChanged: () => void }) {
  return (
    <Drawer open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Imports" description="Sales Navigator imports, and how many contacts a day may bring in">
      {open ? <ImportsPanel canCancel={canCancel} canSetCap={canSetCap} onChanged={onChanged} /> : null}
    </Drawer>
  );
}

function ImportsPanel({ canCancel, canSetCap, onChanged }: { canCancel: boolean; canSetCap: boolean; onChanged: () => void }) {
  // Watched while the panel is open, since a batch moves on by itself.
  const { data, error, mutate } = useApi<ImportsOverview>(IMPORTS_PATH, undefined, { refreshInterval: 5000 });
  const [busy, setBusy] = useState<string | null>(null);

  async function cancel(id: string, name: string | null) {
    const ok = await confirm({ title: `Cancel the import into ${name ?? "this list"}?`, body: "A batch that is running stops at its next page. Contacts already imported stay in the list.", confirmLabel: "Cancel import", cancelLabel: "Keep it", tone: "danger" });
    if (!ok) return;
    setBusy(id);
    try {
      await api(`${IMPORTS_PATH}/${id}/cancel`, { method: "POST" });
      toast.success("Import cancelled");
      await mutate();
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) return <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />;
  if (!data) return <LoadingState label="Loading imports" />;
  const live = data.jobs.filter(jobIsLive);
  const past = data.jobs.filter((job) => !jobIsLive(job));
  const row = (job: ImportsOverview["jobs"][number]) => {
    const state = jobState(job.status);
    return (
      <li key={job.id} className="flex items-start justify-between gap-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-12 font-semibold text-ink">{job.list_name ?? "A deleted list"}</span>
            <Pill size="sm" tone={state.tone} dot={job.status === "running"}>{state.label}</Pill>
          </span>
          <span className="text-11 leading-4 text-ink-2">{jobLine(job)}</span>
        </div>
        {jobIsLive(job) && canCancel ? <Button size="sm" variant="danger" loading={busy === job.id} onClick={() => void cancel(job.id, job.list_name)}>Cancel</Button> : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <DailyCap key={data.dailyCap} cap={data.dailyCap} today={data.importedToday} canSet={canSetCap} onSaved={() => { void mutate(); onChanged(); }} />
      <section className="flex flex-col gap-1">
        <h3 className="text-10 font-semibold uppercase tracking-label text-ink-3">Running and queued</h3>
        {live.length === 0 ? <p className="py-2 text-115 text-ink-2">No import is running.</p> : <ul className="flex flex-col divide-y divide-line">{live.map(row)}</ul>}
      </section>
      {past.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-10 font-semibold uppercase tracking-label text-ink-3">Finished in the last two days</h3>
          <ul className="flex flex-col divide-y divide-line">{past.map(row)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function DailyCap({ cap, today, canSet, onSaved }: { cap: number; today: number; canSet: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(String(cap));
  const [saving, setSaving] = useState(false);
  const number = Number(value);
  const valid = Number.isInteger(number) && number >= 1 && number <= 100_000;

  async function save() {
    if (!valid || saving || number === cap) return;
    setSaving(true);
    try {
      await api(IMPORT_CAP_PATH, { method: "PUT", body: { cap: number } });
      toast.success(`Daily import cap set to ${formatCount(number)}`);
      onSaved();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line bg-subtle p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-12 font-semibold text-ink">Daily import cap</h3>
        <span className="text-11 text-ink-3">{capLine(today, cap)}</span>
      </div>
      <p className="text-11 leading-4 text-ink-2">The most contacts imported from Sales Navigator in one day, across every list. A larger list carries on the next day. Reading too many profiles in a day is what LinkedIn restricts accounts for.</p>
      {canSet ? (
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input type="number" min={1} max={100000} value={value} onChange={(event) => setValue(event.target.value)} aria-label="Contacts a day" frameClassName="w-[120px]" invalid={!valid} />
          <Button type="submit" size="sm" loading={saving} disabled={!valid || number === cap}>Save cap</Button>
        </form>
      ) : <p className="text-11 text-ink-3">An admin changes the cap.</p>}
    </section>
  );
}

// ── Import from Sales Navigator ───────────────────────────────────────────────

export function SalesNavImportDialog({ open, detail, onClose, onQueued }: { open: boolean; detail: ListDetail; onClose: () => void; onQueued: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Import from Sales Navigator" description={`Into ${detail.list.name}`} size="md" padded={false}>
      {open ? <SalesNavImportForm detail={detail} onClose={onClose} onQueued={onQueued} /> : null}
    </Dialog>
  );
}

function SalesNavImportForm({ detail, onClose, onQueued }: { detail: ListDetail; onClose: () => void; onQueued: () => void }) {
  const signedIn = detail.accounts.filter((account) => account.signed_in);
  const [url, setUrl] = useState(detail.list.sales_nav_url ?? "");
  const [account, setAccount] = useState<string | undefined>(signedIn.length === 1 ? signedIn[0].id : undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = url.trim() !== "" && Boolean(account);

  async function queue() {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api(`${listPath(detail.list.id)}/import`, { method: "POST", body: { sales_nav_url: url.trim(), account_id: account } });
      toast.success("Import queued", { description: "It runs from the LinkedIn account in turn with other imports. This page follows its progress." });
      onQueued();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  if (signedIn.length === 0) {
    return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="warn" title="No LinkedIn account is signed in">An import reads the search with one of the workspace&apos;s LinkedIn accounts. Sign one in under LinkedIn accounts first.</Alert></DialogForm>;
  }
  return (
    <DialogForm onSubmit={() => void queue()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>Queue import</Button>}>
      <Field label="Sales Navigator search or list address" hint="Open the search or saved list in Sales Navigator and copy the address from the browser.">
        {(id) => <Input id={id} data-autofocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.linkedin.com/sales/search/people?…" autoComplete="off" spellCheck={false} />}
      </Field>
      <Field label="Read it with">
        {(id) => <Select id={id} value={account} onChange={setAccount} placeholder="Choose a LinkedIn account" options={signedIn.map((item) => ({ value: item.id, label: item.name }))} className="w-full" />}
      </Field>
      <Alert tone="info" title={capLine(detail.imports.today, detail.imports.daily_cap)}>
        One import runs at a time. A search with more contacts than the daily cap allows is imported over several days, a batch a day, and can be cancelled at any point.
      </Alert>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Connection status, move ───────────────────────────────────────────────────

/** Read the list's Sales Navigator search again and update who is now a connection. */
export function SyncStatusDialog({ open, detail, onClose, onSynced }: { open: boolean; detail: ListDetail; onClose: () => void; onSynced: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Sync connection status" description={detail.list.name} size="sm" padded={false}>
      {open ? <SyncStatusForm detail={detail} onClose={onClose} onSynced={onSynced} /> : null}
    </Dialog>
  );
}

function SyncStatusForm({ detail, onClose, onSynced }: { detail: ListDetail; onClose: () => void; onSynced: () => void }) {
  const signedIn = detail.accounts.filter((account) => account.signed_in);
  const [account, setAccount] = useState<string | undefined>(signedIn.length === 1 ? signedIn[0].id : undefined);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    if (!account || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await api<{ updated: number }>(`${listPath(detail.list.id)}/sync-status`, { method: "POST", body: { account_id: account } });
      toast.success(`Connection status read for ${contactsNoun(result.updated)}`);
      onSynced();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setRunning(false);
    }
  }

  if (!detail.list.sales_nav_url) {
    return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="info" title="This list has no Sales Navigator search">Connection status is read from the search a list was imported from. Import this list from Sales Navigator first.</Alert></DialogForm>;
  }
  if (signedIn.length === 0) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="warn" title="No LinkedIn account is signed in" /></DialogForm>;
  return (
    <DialogForm onSubmit={() => void sync()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={running} disabled={!account}>Read from LinkedIn</Button>}>
      <p className="text-12 leading-[17px] text-ink-2">The account opens this list&apos;s Sales Navigator search and reads each person&apos;s connection degree. Contacts who have connected since the import are marked as connected. Nothing is sent to anyone.</p>
      <Field label="Read it with" hint="Degrees are as this account sees them, so use the account that sent the invitations.">
        {(id) => <Select id={id} value={account} onChange={setAccount} placeholder="Choose a LinkedIn account" options={signedIn.map((item) => ({ value: item.id, label: item.name }))} className="w-full" />}
      </Field>
      {running ? <p className="text-11 text-ink-3">Reading the search. A long list takes a few minutes; keep this window open.</p> : null}
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

export function MoveContactsDialog({ ids, from, lists, onClose, onMoved }: { ids: string[] | null; from: ListRow; lists: { id: string; name: string }[]; onClose: () => void; onMoved: () => void }) {
  return (
    <Dialog open={ids !== null} onOpenChange={(next) => { if (!next) onClose(); }} title="Move to another list" description={ids ? `${contactsNoun(ids.length)} from ${from.name}` : undefined} size="sm" padded={false}>
      {ids ? <MoveContactsForm ids={ids} from={from} lists={lists} onClose={onClose} onMoved={onMoved} /> : null}
    </Dialog>
  );
}

function MoveContactsForm({ ids, from, lists, onClose, onMoved }: { ids: string[]; from: ListRow; lists: { id: string; name: string }[]; onClose: () => void; onMoved: () => void }) {
  const [destination, setDestination] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move() {
    if (!destination || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ moved: number }>(`${listPath(from.id)}/move-targets`, { method: "POST", body: { target_ids: ids, destination_list_id: destination } });
      toast.success(`${contactsNoun(result.moved)} moved to ${lists.find((list) => list.id === destination)?.name ?? "the list"}`);
      onMoved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  if (lists.length === 0) return <DialogForm onCancel={onClose} cancelLabel="Close"><EmptyState title="There is no other list to move to">Make another list first.</EmptyState></DialogForm>;
  return (
    <DialogForm onSubmit={() => void move()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!destination}>Move</Button>}>
      <Field label="Move to" hint="They leave this list and join the other. A contact already in the other list simply leaves this one.">
        {(id) => <Select id={id} value={destination} onChange={setDestination} placeholder="Choose a list" options={lists.map((list) => ({ value: list.id, label: list.name }))} className="w-full" />}
      </Field>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}
