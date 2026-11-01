import { useState } from "react";
import {useTranslations} from "next-intl";
import { toast } from "sonner";
import { Alert, Button, Dialog, Drawer, EmptyState, ErrorState, Field, Input, LoadingState, Pill, Select, Textarea, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
import { DialogForm } from "@/components/contacts/ContactDialogs";
import {
  IMPORTS_PATH, IMPORT_CAP_PATH, LISTS_PATH, capLine, jobIsLive, jobLine, jobState, listPath,
  type ImportsOverview, type ListDetail, type ListRow,
} from "./model";

const NOBODY = "none";

// ── New list, edit list ───────────────────────────────────────────────────────

export function ListFormDialog({ open, list, members, onClose, onSaved }: { open: boolean; list: ListRow | null; members: { id: string; name: string }[]; onClose: () => void; onSaved: (id: string) => void }) {
  const t = useTranslations("ListDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={list ? t("edit") : t("new")} description={list ? undefined : t("newHint")} size="sm" padded={false}>
      {open ? <ListForm list={list} members={members} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function ListForm({ list, members, onClose, onSaved }: { list: ListRow | null; members: { id: string; name: string }[]; onClose: () => void; onSaved: (id: string) => void }) {
  const t = useTranslations("ListDialogs");
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
        toast.success(t("saved"));
        onSaved(list.id);
      } else {
        const created = await api<{ id: string }>(LISTS_PATH, { method: "POST", body: { name: name.trim(), description: description.trim() || undefined } });
        toast.success(t("created", {name: name.trim()}));
        onSaved(created.id);
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>{list ? t("save") : t("create")}</Button>}>
      <Field label={t("name")}>{(id) => <Input id={id} data-autofocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Series B SaaS · VP Sales" autoComplete="off" />}</Field>
      <Field label={t("description")}>{(id) => <Textarea id={id} value={description} onChange={(event) => setDescription(event.target.value)} rows={2} placeholder={t("descriptionPlaceholder")} />}</Field>
      {list ? (
        <Field label={t("owner")}>
          {(id) => <Select id={id} value={owner} onChange={setOwner} className="w-full" options={[{ value: NOBODY, label: t("noOwner") }, ...members.map((member) => ({ value: member.id, label: member.name }))]} />}
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
  const t = useTranslations("ListDialogs");
  return (
    <Drawer open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("imports")} description={t("importsHint")}>
      {open ? <ImportsPanel canCancel={canCancel} canSetCap={canSetCap} onChanged={onChanged} /> : null}
    </Drawer>
  );
}

function ImportsPanel({ canCancel, canSetCap, onChanged }: { canCancel: boolean; canSetCap: boolean; onChanged: () => void }) {
  const t = useTranslations("ListDialogs");
  // Watched while the panel is open, since a batch moves on by itself.
  const { data, error, mutate } = useApi<ImportsOverview>(IMPORTS_PATH, undefined, { refreshInterval: 5000 });
  const [busy, setBusy] = useState<string | null>(null);

  async function cancel(id: string, name: string | null) {
    const ok = await confirm({ title: t("cancelTitle", {name: name ?? t("deletedList")}), body: t("cancelBody"), confirmLabel: t("cancelConfirm"), cancelLabel: t("keep"), tone: "danger" });
    if (!ok) return;
    setBusy(id);
    try {
      await api(`${IMPORTS_PATH}/${id}/cancel`, { method: "POST" });
      toast.success(t("cancelled"));
      await mutate();
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) return <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />;
  if (!data) return <LoadingState label={t("loading")} />;
  const live = data.jobs.filter(jobIsLive);
  const past = data.jobs.filter((job) => !jobIsLive(job));
  const row = (job: ImportsOverview["jobs"][number]) => {
    const state = jobState(job.status);
    return (
      <li key={job.id} className="flex items-start justify-between gap-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-12 font-semibold text-ink">{job.list_name ?? t("deletedList")}</span>
            <Pill size="sm" tone={state.tone} dot={job.status === "running"}>{state.label}</Pill>
          </span>
          <span className="text-11 leading-4 text-ink-2">{jobLine(job)}</span>
        </div>
        {jobIsLive(job) && canCancel ? <Button size="sm" variant="danger" loading={busy === job.id} onClick={() => void cancel(job.id, job.list_name)}>{t("cancel")}</Button> : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <DailyCap key={data.dailyCap} cap={data.dailyCap} today={data.importedToday} canSet={canSetCap} onSaved={() => { void mutate(); onChanged(); }} />
      <section className="flex flex-col gap-1">
        <h3 className="text-10 font-semibold uppercase tracking-label text-ink-3">{t("running")}</h3>
        {live.length === 0 ? <p className="py-2 text-115 text-ink-2">{t("noneRunning")}</p> : <ul className="flex flex-col divide-y divide-line">{live.map(row)}</ul>}
      </section>
      {past.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-10 font-semibold uppercase tracking-label text-ink-3">{t("recent")}</h3>
          <ul className="flex flex-col divide-y divide-line">{past.map(row)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function DailyCap({ cap, today, canSet, onSaved }: { cap: number; today: number; canSet: boolean; onSaved: () => void }) {
  const t = useTranslations("ListDialogs");
  const [value, setValue] = useState(String(cap));
  const [saving, setSaving] = useState(false);
  const number = Number(value);
  const valid = Number.isInteger(number) && number >= 1 && number <= 100_000;

  async function save() {
    if (!valid || saving || number === cap) return;
    setSaving(true);
    try {
      await api(IMPORT_CAP_PATH, { method: "PUT", body: { cap: number } });
      toast.success(t("capUpdated", {count: formatCount(number)}));
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
        <h3 className="text-12 font-semibold text-ink">{t("dailyCap")}</h3>
        <span className="text-11 text-ink-3">{capLine(today, cap)}</span>
      </div>
      <p className="text-11 leading-4 text-ink-2">{t("dailyCapHelp")}</p>
      {canSet ? (
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input type="number" min={1} max={100000} value={value} onChange={(event) => setValue(event.target.value)} aria-label={t("perDay")} frameClassName="w-[120px]" invalid={!valid} />
          <Button type="submit" size="sm" loading={saving} disabled={!valid || number === cap}>{t("saveCap")}</Button>
        </form>
      ) : <p className="text-11 text-ink-3">{t("adminOnly")}</p>}
    </section>
  );
}

// ── Import from Sales Navigator ───────────────────────────────────────────────

export function SalesNavImportDialog({ open, detail, onClose, onQueued }: { open: boolean; detail: ListDetail; onClose: () => void; onQueued: () => void }) {
  const t = useTranslations("ListDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("salesNav")} description={t("into", {name: detail.list.name})} size="md" padded={false}>
      {open ? <SalesNavImportForm detail={detail} onClose={onClose} onQueued={onQueued} /> : null}
    </Dialog>
  );
}

function SalesNavImportForm({ detail, onClose, onQueued }: { detail: ListDetail; onClose: () => void; onQueued: () => void }) {
  const t = useTranslations("ListDialogs");
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
      toast.success(t("queued"), {description: t("queuedHelp")});
      onQueued();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  if (signedIn.length === 0) {
    return <DialogForm onCancel={onClose} cancelLabel={t("close")}><Alert tone="warn" title={t("noLinkedin")}>{t("noLinkedinHelp")}</Alert></DialogForm>;
  }
  return (
    <DialogForm onSubmit={() => void queue()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>{t("queue")}</Button>}>
      <Field label={t("searchUrl")} hint={t("searchUrlHint")}>
        {(id) => <Input id={id} data-autofocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.linkedin.com/sales/search/people?…" autoComplete="off" spellCheck={false} />}
      </Field>
      <Field label={t("readUsing")}>
        {(id) => <Select id={id} value={account} onChange={setAccount} placeholder={t("chooseLinkedin")} options={signedIn.map((item) => ({ value: item.id, label: item.name }))} className="w-full" />}
      </Field>
      <Alert tone="info" title={capLine(detail.imports.today, detail.imports.daily_cap)}>
        {t("importInfo")}
      </Alert>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Connection status, move ───────────────────────────────────────────────────

/** Read the list's Sales Navigator search again and update who is now a connection. */
export function SyncStatusDialog({ open, detail, onClose, onSynced }: { open: boolean; detail: ListDetail; onClose: () => void; onSynced: () => void }) {
  const t = useTranslations("ListDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("syncStatus")} description={detail.list.name} size="sm" padded={false}>
      {open ? <SyncStatusForm detail={detail} onClose={onClose} onSynced={onSynced} /> : null}
    </Dialog>
  );
}

function SyncStatusForm({ detail, onClose, onSynced }: { detail: ListDetail; onClose: () => void; onSynced: () => void }) {
  const t = useTranslations("ListDialogs");
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
      toast.success(t("syncResult", {count: formatCount(result.updated)}));
      onSynced();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setRunning(false);
    }
  }

  if (!detail.list.sales_nav_url) {
    return <DialogForm onCancel={onClose} cancelLabel={t("close")}><Alert tone="info" title={t("missingSearch")}>{t("missingSearchHelp")}</Alert></DialogForm>;
  }
  if (signedIn.length === 0) return <DialogForm onCancel={onClose} cancelLabel={t("close")}><Alert tone="warn" title={t("noLinkedin")} /></DialogForm>;
  return (
    <DialogForm onSubmit={() => void sync()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={running} disabled={!account}>{t("readLinkedin")}</Button>}>
      <p className="text-12 leading-[17px] text-ink-2">{t("syncHelp")}</p>
      <Field label={t("readUsing")} hint={t("syncAccountHint")}>
        {(id) => <Select id={id} value={account} onChange={setAccount} placeholder={t("chooseLinkedin")} options={signedIn.map((item) => ({ value: item.id, label: item.name }))} className="w-full" />}
      </Field>
      {running ? <p className="text-11 text-ink-3">{t("syncRunning")}</p> : null}
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

export function MoveContactsDialog({ ids, from, lists, onClose, onMoved }: { ids: string[] | null; from: ListRow; lists: { id: string; name: string }[]; onClose: () => void; onMoved: () => void }) {
  const t = useTranslations("ListDialogs");
  return (
    <Dialog open={ids !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={t("moveTitle")} description={ids ? t("moveFrom", {count: formatCount(ids.length), name: from.name}) : undefined} size="sm" padded={false}>
      {ids ? <MoveContactsForm ids={ids} from={from} lists={lists} onClose={onClose} onMoved={onMoved} /> : null}
    </Dialog>
  );
}

function MoveContactsForm({ ids, from, lists, onClose, onMoved }: { ids: string[]; from: ListRow; lists: { id: string; name: string }[]; onClose: () => void; onMoved: () => void }) {
  const t = useTranslations("ListDialogs");
  const [destination, setDestination] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move() {
    if (!destination || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ moved: number }>(`${listPath(from.id)}/move-targets`, { method: "POST", body: { target_ids: ids, destination_list_id: destination } });
      toast.success(t("moved", {count: formatCount(result.moved), name: lists.find((list) => list.id === destination)?.name ?? t("destinationFallback")}));
      onMoved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  if (lists.length === 0) return <DialogForm onCancel={onClose} cancelLabel={t("close")}><EmptyState title={t("noOtherList")}>{t("noOtherListHelp")}</EmptyState></DialogForm>;
  return (
    <DialogForm onSubmit={() => void move()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!destination}>{t("move")}</Button>}>
      <Field label={t("moveTo")} hint={t("moveHint")}>
        {(id) => <Select id={id} value={destination} onChange={setDestination} placeholder={t("chooseList")} options={lists.map((list) => ({ value: list.id, label: list.name }))} className="w-full" />}
      </Field>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}
