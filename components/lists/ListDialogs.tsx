import { useRef, useState } from "react";
import Papa from "papaparse";
import { Download, FileUp } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, Drawer, EmptyState, ErrorState, Field, Input, LoadingState, Pill, Select, Textarea, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
import { DialogForm } from "@/components/contacts/ContactDialogs";
import {
  CSV_FIELDS, IMPORTS_PATH, IMPORT_CAP_PATH, LISTS_PATH, capLine, contactsNoun, csvOutcome, initialMapping, jobIsLive, jobLine, jobState, listPath, mappingForServer, mappingProblem,
  type ColumnChoice, type CsvResult, type ImportsOverview, type ListDetail, type ListRow,
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

// ── Import a CSV ──────────────────────────────────────────────────────────────

/**
 * A CSV into the list in three moves: choose the file, say what each column is, read what
 * happened. Columns the importer recognises are mapped already; any other column can
 * fill a custom field or be left out.
 */
export function CsvImportDialog({ open, list, onClose, onImported }: { open: boolean; list: ListRow; onClose: () => void; onImported: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Import a CSV" description={`Into ${list.name}`} size="lg" padded={false}>
      {open ? <CsvImportForm list={list} onClose={onClose} onImported={onImported} /> : null}
    </Dialog>
  );
}

const KIND_OPTIONS = [{ value: "standard", label: "A contact field" }, { value: "custom", label: "A custom field" }, { value: "ignore", label: "Leave out" }];
const TYPE_OPTIONS = [{ value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "boolean", label: "Yes / no" }];
const FIELD_OPTIONS = CSV_FIELDS.map(([value, label]) => ({ value, label }));

function CsvImportForm({ list, onClose, onImported }: { list: ListRow; onClose: () => void; onImported: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [columns, setColumns] = useState<ColumnChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CsvResult | null>(null);

  async function choose(chosen: File | null) {
    setError(null);
    setResult(null);
    if (!chosen) return;
    try {
      const text = await chosen.text();
      const rows = (Papa.parse<string[]>(text, { skipEmptyLines: true }).data as string[][]).filter((row) => Array.isArray(row));
      if (rows.length < 2) return setError("The file has no rows under its header line.");
      setColumns(initialMapping(rows));
      setFile({ name: chosen.name, text, rows: rows.length - 1 });
    } catch {
      setError("The file could not be read. Save it as CSV (comma separated) and try again.");
    }
  }

  const update = (index: number, change: Partial<ColumnChoice>) => setColumns((current) => current.map((column, at) => (at === index ? { ...column, ...change } : column)));
  const problem = file ? mappingProblem(columns) : null;

  async function run() {
    if (!file || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await api<CsvResult>(`${listPath(list.id)}/import-csv`, { method: "POST", body: { csv: file.text, mapping: mappingForServer(columns), filename: file.name } });
      setResult(outcome);
      onImported();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <DialogForm onCancel={onClose} cancelLabel="Close" actions={<Button onClick={() => { setResult(null); setFile(null); setColumns([]); }}>Import another file</Button>}>
        <Alert tone={result.imported + result.updated > 0 ? "good" : "info"} title={result.imported + result.updated > 0 ? `Imported from ${file?.name ?? "the file"}` : "Nothing new in this file"}>{csvOutcome(result)}.</Alert>
        {result.errors.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-12 font-semibold text-ink">{result.errors.length} {result.errors.length === 1 ? "row was" : "rows were"} left out</span>
            <ul className="max-h-[200px] overflow-y-auto rounded-md border border-line bg-subtle p-2.5 font-mono text-105 leading-[15px] text-ink-2">
              {result.errors.slice(0, 100).map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          </div>
        ) : null}
      </DialogForm>
    );
  }

  if (!file) {
    return (
      <DialogForm onCancel={onClose}>
        <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(event) => void choose(event.target.files?.[0] ?? null)} />
        <button
          type="button" onClick={() => input.current?.click()}
          onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void choose(event.dataTransfer.files?.[0] ?? null); }}
          className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong bg-subtle px-6 py-10 text-center hover:border-brand hover:bg-brand-tint"
        >
          <FileUp size={20} className="text-ink-3" aria-hidden="true" />
          <span className="text-13 font-semibold text-ink">Choose a CSV file</span>
          <span className="max-w-[420px] text-115 leading-[17px] text-ink-2">Or drop one here. Each row needs a LinkedIn URL or an email address; every other column is up to you.</span>
        </button>
        <a href={`${listPath(list.id)}/csv-template`} className="inline-flex items-center gap-1.5 self-start text-11 font-semibold text-brand-strong hover:underline">
          <Download size={12} aria-hidden="true" />
          Download a template with the columns Linki recognises
        </a>
        {error ? <Alert tone="bad" title={error} /> : null}
      </DialogForm>
    );
  }

  return (
    <DialogForm
      onSubmit={() => void run()} onCancel={() => { setFile(null); setColumns([]); setError(null); }} cancelLabel="Choose another file"
      actions={<Button type="submit" variant="primary" loading={busy} disabled={Boolean(problem)}>Import {formatCount(file.rows)} {file.rows === 1 ? "row" : "rows"}</Button>}
    >
      <p className="text-12 text-ink-2"><span className="font-semibold text-ink">{file.name}</span> · {formatCount(file.rows)} {file.rows === 1 ? "row" : "rows"} · {columns.length} columns. Say what each column is.</p>
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="grid grid-cols-[minmax(0,1.2fr)_150px_minmax(0,1.4fr)] gap-3 border-b border-line bg-subtle px-3 py-2 text-10 font-semibold uppercase tracking-label text-ink-3">
          <span>Column in the file</span><span>It is</span><span>Goes to</span>
        </div>
        <ul className="flex max-h-[340px] flex-col divide-y divide-line overflow-y-auto">
          {columns.map((column, index) => (
            <li key={`${column.column}-${index}`} className="grid grid-cols-[minmax(0,1.2fr)_150px_minmax(0,1.4fr)] items-center gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-col gap-px">
                <span className="truncate font-mono text-115 font-medium text-ink">{column.column || "(no header)"}</span>
                <span className="truncate text-105 text-ink-3">{column.sample ? `e.g. ${column.sample}` : "empty in the first rows"}</span>
              </div>
              <Select size="sm" label={`What ${column.column} is`} value={column.kind} onChange={(kind) => update(index, { kind: kind as ColumnChoice["kind"] })} options={KIND_OPTIONS} className="w-full" />
              {column.kind === "standard" ? (
                <Select size="sm" label={`Field for ${column.column}`} value={column.field} onChange={(field) => update(index, { field })} options={FIELD_OPTIONS} className="w-full" />
              ) : column.kind === "custom" ? (
                <div className="flex items-center gap-2">
                  <Input aria-label={`Key for ${column.column}`} value={column.key} onChange={(event) => update(index, { key: event.target.value })} frameClassName="h-7 min-w-0 flex-1" className="font-mono text-11" spellCheck={false} />
                  <Select size="sm" label={`Type of ${column.column}`} value={column.fieldType} onChange={(fieldType) => update(index, { fieldType: fieldType as ColumnChoice["fieldType"] })} options={TYPE_OPTIONS} className="w-[104px]" />
                </div>
              ) : <span className="text-11 text-ink-3">Not imported</span>}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-11 leading-4 text-ink-3">A row that matches a contact already in Linki, by LinkedIn URL or by email, updates that contact and adds it to this list. A custom field can be written into campaign wording by its key.</p>
      {problem ? <Alert tone="warn" title={problem} /> : null}
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
