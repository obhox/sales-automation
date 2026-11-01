import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/router";
import {useTranslations} from "next-intl";
import { FileUp } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, Field, Input, LoadingState, Meter, Switch, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount, formatDateTime } from "@/lib/client/format";
import { recordHref } from "@/lib/client/nav";
import { DialogForm } from "@/components/contacts/ContactDialogs";
import {
  COMPANIES_PATH, COMPANY_ENRICH_PATH, COMPANY_IMPORT_PATH, EMPTY_COMPANY, addOutcome, bounceDetail, bouncesPath, changedFields, clearOutcome, companyPath, creditsNoun, enrichNotes, enrichOutcome,
  formOf, importOutcome, reverifyOutcome, searchOutcome, suggestionsPath,
  type BounceFigures, type CompanyBounce, type CompanyDetail, type CompanyForm, type CompanySuggestion, type EnrichPreview, type EnrichProgress, type ImportResult,
} from "./model";

/** A cost, said before anything is spent. */
function Cost({ amount, children }: { amount: string; children: ReactNode }) {
  const t = useTranslations("CompanyDialogs");
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-subtle p-3">
      <span className="text-10 font-semibold uppercase tracking-label text-ink-3">{t("cost")}</span>
      <span className="text-18 font-semibold tracking-figure text-ink">{amount}</span>
      <span className="text-11 leading-4 text-ink-2">{children}</span>
    </div>
  );
}

function ApolloMissing({ href, what }: { href: string; what: string }) {
  const t = useTranslations("CompanyDialogs");
  const router = useRouter();
  return (
    <Alert tone="warn" title={t("apolloMissing")} actions={<Button size="xs" onClick={() => void router.push(href)}>{t("openIntegrations")}</Button>}>
      {t("apolloHint", {what})}
    </Alert>
  );
}

/** Ask a route what something would cost, once, when its dialog opens. Asking spends nothing. */
function usePreview<T>(path: string, body: Record<string, unknown>): { preview: T | null; error: string | null } {
  const [preview, setPreview] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(JSON.stringify(body));
  useEffect(() => {
    let cancelled = false;
    api<T>(path, { method: "POST", body: { ...JSON.parse(sent.current), dry_run: true } })
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((cause) => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; };
  }, [path]);
  return { preview, error };
}

// ── Add or edit a company ─────────────────────────────────────────────────────

export function CompanyFormDialog({ open, company, onClose, onSaved }: { open: boolean; company: CompanyDetail["company"] | null; onClose: () => void; onSaved: (id: string) => void }) {
  const t = useTranslations("CompanyDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={company ? t("edit") : t("add")} description={company ? undefined : t("newHint")} size="md" padded={false}>
      {open ? <CompanyFormBody company={company} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function CompanyFormBody({ company, onClose, onSaved }: { company: CompanyDetail["company"] | null; onClose: () => void; onSaved: (id: string) => void }) {
  const t = useTranslations("CompanyDialogs");
  const before = company ? formOf(company) : EMPTY_COMPANY;
  const [form, setForm] = useState<CompanyForm>(before);
  const [target, setTarget] = useState(company?.is_target ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof CompanyForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const ready = form.name.trim() !== "";

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (company) {
        // Only what changed is sent: the route leaves the rest alone.
        const changed: Record<string, unknown> = changedFields(before, form);
        if (target !== company.is_target) changed.is_target = target;
        if (Object.keys(changed).length > 0) await api(companyPath(company.id), { method: "PUT", body: changed });
        toast.success(t("saved", {name: form.name.trim()}));
        onSaved(company.id);
      } else {
        const body = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim() || undefined]));
        const created = await api<{ id: string }>(COMPANIES_PATH, { method: "POST", body: { ...body, is_target: target } });
        toast.success(t("created", {name: form.name.trim()}));
        onSaved(created.id);
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>{company ? t("save") : t("add")}</Button>}>
      <div className="grid grid-cols-2 gap-3.5">
        <Field label={t("name")} className="col-span-2">{(id) => <Input id={id} data-autofocus value={form.name} onChange={set("name")} placeholder="Northwind Logistics" autoComplete="off" />}</Field>
        <Field label={t("domain")} hint={t("domainHint")}>{(id) => <Input id={id} value={form.domain} onChange={set("domain")} placeholder="northwind.com" autoComplete="off" spellCheck={false} />}</Field>
        <Field label={t("website")}>{(id) => <Input id={id} value={form.website} onChange={set("website")} placeholder="https://…" autoComplete="off" spellCheck={false} />}</Field>
        <Field label={t("industry")}>{(id) => <Input id={id} value={form.industry} onChange={set("industry")} autoComplete="off" />}</Field>
        <Field label={t("location")}>{(id) => <Input id={id} value={form.location} onChange={set("location")} autoComplete="off" />}</Field>
        <Field label={t("linkedin")} className="col-span-2">{(id) => <Input id={id} value={form.linkedin_url} onChange={set("linkedin_url")} placeholder="https://www.linkedin.com/company/…" autoComplete="off" spellCheck={false} />}</Field>
        <Field label={t("notes")} className="col-span-2">{(id) => <Textarea id={id} value={form.notes} onChange={set("notes")} rows={3} />}</Field>
      </div>
      <Switch checked={target} onChange={setTarget} label={t("target")} />
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Import a CSV of companies ─────────────────────────────────────────────────

export function ImportCompaniesDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const t = useTranslations("CompanyDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("importTitle")} description={t("importHint")} size="md" padded={false}>
      {open ? <ImportBody onClose={onClose} onImported={onImported} /> : null}
    </Dialog>
  );
}

function ImportBody({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const t = useTranslations("CompanyDialogs");
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [over, setOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function read(chosen: File | undefined) {
    if (!chosen) return;
    setError(null);
    setResult(null);
    if (chosen.size > 6 * 1024 * 1024) return setError(t("fileTooLarge"));
    const text = await chosen.text();
    setFile({ name: chosen.name, text, rows: Math.max(0, text.split(/\r?\n/).filter((line) => line.trim() !== "").length - 1) });
  }

  async function send() {
    if (!file || saving) return;
    setSaving(true);
    setError(null);
    try {
      const done = await api<ImportResult>(COMPANY_IMPORT_PATH, { method: "POST", body: { csv: file.text } });
      setResult(done);
      onImported();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  if (result) {
    return (
      <DialogForm onCancel={onClose} cancelLabel={t("close")} actions={<Button onClick={() => { setResult(null); setFile(null); }}>{t("importAnother")}</Button>}>
        <Alert tone="good" title={t("imported", {name: file?.name ?? t("theFile")})}>{importOutcome(result)}.</Alert>
        {result.ignored_columns.length > 0 ? <p className="text-115 leading-[17px] text-ink-2">{t("skippedFields", {fields: result.ignored_columns.join(", ")})}</p> : null}
        {result.errors.length > 0 ? <Alert tone="warn" title={t("skippedRows", {count: result.errors.length})}><ul className="flex flex-col gap-0.5">{result.errors.map((line) => <li key={line}>{line}</li>)}</ul></Alert> : null}
      </DialogForm>
    );
  }

  return (
    <DialogForm onSubmit={() => void send()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!file || file.rows === 0}>{file && file.rows > 0 ? t("importRows", {count: formatCount(file.rows)}) : t("import")}</Button>}>
      <input ref={picker} type="file" accept=".csv,text/csv" className="sr-only" aria-label={t("csvFile")} onChange={(event) => { void read(event.target.files?.[0]); event.target.value = ""; }} />
      <button
        type="button" onClick={() => picker.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(event) => { event.preventDefault(); setOver(false); void read(event.dataTransfer.files?.[0]); }}
        className={`flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-5 py-7 text-center transition-colors ${over ? "border-brand bg-brand-tint" : "border-line-strong bg-subtle hover:bg-control"}`}
      >
        <FileUp size={18} className="text-ink-3" aria-hidden="true" />
        <span className="text-125 font-semibold text-ink">{file ? file.name : t("chooseCsv")}</span>
        <span className="text-11 text-ink-3">{file ? t("fileSummary", {count: formatCount(file.rows)}) : t("drop")}</span>
      </button>
      <p className="text-115 leading-[17px] text-ink-2">
        {t("importRule")}
      </p>
      <a href={COMPANY_IMPORT_PATH} className="self-start text-11 font-semibold text-brand-strong hover:underline">{t("template")}</a>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Look companies up on Apollo ───────────────────────────────────────────────

/** One company, or every company the list shows as it is filtered. */
export type EnrichScope = { ids: string[]; name: string } | { q: string; filter: string };

export function EnrichCompaniesDialog({
  scope, progress, integrationsHref, onStart, onStop, onClose,
}: {
  /** What to price. Null: closed. Not read once a run is under way. */
  scope: EnrichScope | null;
  progress: EnrichProgress | null;
  integrationsHref: string;
  onStart: (ids: string[], batch: number) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("CompanyDialogs");
  // A run under way may be for other companies than the one this was opened from.
  const one = !progress && scope && "ids" in scope ? scope.name : null;
  return (
    <Dialog open={scope !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={one ? t("enrichOne", {name: one}) : t("enrichTitle")} description={t("enrichDesc")} size="sm" padded={false}>
      {!scope ? null : progress ? <EnrichRun progress={progress} onStop={onStop} onClose={onClose} /> : <EnrichCost scope={scope} integrationsHref={integrationsHref} onStart={onStart} onClose={onClose} />}
    </Dialog>
  );
}

function EnrichCost({ scope, integrationsHref, onStart, onClose }: { scope: EnrichScope; integrationsHref: string; onStart: (ids: string[], batch: number) => void; onClose: () => void }) {
  const t = useTranslations("CompanyDialogs");
  const { preview, error } = usePreview<EnrichPreview>(COMPANY_ENRICH_PATH, scope);
  if (error) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="bad" title={error} /></DialogForm>;
  if (!preview) return <DialogForm onCancel={onClose} actions={<Button variant="primary" disabled>{t("lookup")}</Button>}><LoadingState label={t("loadingCost")} /></DialogForm>;

  const can = preview.apollo_connected && preview.eligible > 0;
  return (
    <DialogForm
      onSubmit={() => { if (can) onStart(preview.eligible_ids, preview.batch); }} onCancel={onClose}
      actions={<Button type="submit" variant="primary" disabled={!can}>{preview.eligible > 0 ? t("lookupCount", {count: preview.eligible}) : "Look up"}</Button>}
    >
      {preview.eligible > 0 ? (
        <Cost amount={creditsNoun(preview.credits)}>
          {t("lookupInfo")}
          {t("lookupInfo2")}
        </Cost>
      ) : (
        <Alert tone="info" title={preview.selected === 0 ? t("noSelected") : t("noneAvailable")}>{t("needDomain")}</Alert>
      )}
      {enrichNotes(preview).length > 0 ? <ul className="flex flex-col gap-1.5 text-115 leading-[17px] text-ink-2">{enrichNotes(preview).map((line) => <li key={line}>{line}</li>)}</ul> : null}
      {!preview.apollo_connected ? <ApolloMissing href={integrationsHref} what="look companies up" /> : null}
    </DialogForm>
  );
}

function EnrichRun({ progress, onStop, onClose }: { progress: EnrichProgress; onStop: () => void; onClose: () => void }) {
  const t = useTranslations("CompanyDialogs");
  const running = progress.state === "running" || progress.state === "stopping";
  return (
    <DialogForm onCancel={onClose} cancelLabel={running ? "Hide" : "Close"} actions={running ? <Button variant="danger" loading={progress.state === "stopping"} onClick={onStop}>Stop</Button> : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-125 font-semibold text-ink">{running ? t("looking", {count: progress.total}) : progress.state === "finished" ? t("finished") : progress.state === "stopped" ? t("stopped") : t("errorStopped")}</span>
        <span className="text-11 tabular-nums text-ink-3">{formatCount(progress.done)} of {formatCount(progress.total)}</span>
      </div>
      <Meter value={progress.done} max={progress.total} tone={progress.state === "failed" ? "bad" : "brand"} label={t("progress")} />
      <p className="text-115 leading-[17px] text-ink-2">{enrichOutcome(progress)}.</p>
      {progress.error ? <Alert tone="bad" title={progress.error} /> : null}
      {running ? <p className="text-11 text-ink-3">{t("runningHint")}</p> : null}
    </DialogForm>
  );
}

// ── People Apollo suggests ────────────────────────────────────────────────────

type CompanyRef = { id: string; name: string; domain: string | null };

export function FindPeopleDialog({ company, integrationsHref, onClose, onDone }: { company: CompanyRef | null; integrationsHref: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("CompanyDialogs");
  return (
    <Dialog open={company !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={t("findPeople")} description={company ? t("who", {name: company.name}) : undefined} size="sm" padded={false}>
      {company ? <FindPeopleBody company={company} integrationsHref={integrationsHref} onClose={onClose} onDone={onDone} /> : null}
    </Dialog>
  );
}

function FindPeopleBody({ company, integrationsHref, onClose, onDone }: { company: CompanyRef; integrationsHref: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("CompanyDialogs");
  const { preview, error: previewError } = usePreview<{ apollo_connected: boolean; domain: string | null; credits: number; people: number }>(suggestionsPath(company.id), { action: "find" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (previewError) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="bad" title={previewError} /></DialogForm>;
  if (!preview) return <DialogForm onCancel={onClose} actions={<Button variant="primary" disabled>{t("searchApollo")}</Button>}><LoadingState label={t("checking")} /></DialogForm>;

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ found: number; added: number }>(suggestionsPath(company.id), { method: "POST", body: { action: "find" } });
      const said = searchOutcome(result);
      (result.added > 0 ? toast.success : toast.message)(said.title, { description: said.description });
      onDone();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  const can = preview.apollo_connected && preview.domain !== null;
  return (
    <DialogForm onSubmit={() => { if (can) void search(); }} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={busy} disabled={!can}>{t("searchApollo")}</Button>}>
      {preview.domain ? (
        <Cost amount={t("noCredits")}>
          {t("peopleInfo", {count: preview.people, domain: preview.domain})}
          {t("peopleInfo2")}
        </Cost>
      ) : (
        <Alert tone="info" title={t("noDomain")}>{t("noDomainHelp")}</Alert>
      )}
      {!preview.apollo_connected ? <ApolloMissing href={integrationsHref} what="search for people" /> : null}
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

export function AddPeopleDialog({ company, people, integrationsHref, onClose, onDone }: { company: CompanyRef; people: CompanySuggestion[] | null; integrationsHref: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("CompanyDialogs");
  return (
    <Dialog
      open={people !== null} onOpenChange={(next) => { if (!next) onClose(); }} size="sm" padded={false}
      title={people && people.length === 1 ? t("addPerson", {name: people[0].name}) : t("addSuggested")} description={t("addToCompany", {role: t(people && people.length === 1 ? "contact" : "contacts"), name: company.name})}
    >
      {people ? <AddPeopleBody company={company} people={people} integrationsHref={integrationsHref} onClose={onClose} onDone={onDone} /> : null}
    </Dialog>
  );
}

function AddPeopleBody({ company, people, integrationsHref, onClose, onDone }: { company: CompanyRef; people: CompanySuggestion[]; integrationsHref: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("CompanyDialogs");
  const ids = people.map((person) => person.id);
  const { preview, error: previewError } = usePreview<{ apollo_connected: boolean; people: number; credits: number }>(suggestionsPath(company.id), { action: "add", ids });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (previewError) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="bad" title={previewError} /></DialogForm>;
  if (!preview) return <DialogForm onCancel={onClose} actions={<Button variant="primary" disabled>{t("addAction")}</Button>}><LoadingState label={t("loadingCost")} /></DialogForm>;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ added: number; linked: number; not_found: number; failed: number }>(suggestionsPath(company.id), { method: "POST", body: { action: "add", ids } });
      const said = addOutcome(result);
      (result.added + result.linked > 0 ? toast.success : toast.message)(said.title, { description: said.description });
      onDone();
      onClose();
    } catch (cause) {
      // A refusal part-way through still made the contacts before it: show them.
      onDone();
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  const can = preview.apollo_connected && preview.people > 0;
  return (
    <DialogForm onSubmit={() => { if (can) void add(); }} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={busy} disabled={!can}>{preview.people > 0 ? t("addPeople", {count: preview.people}) : "Add"}</Button>}>
      {preview.people > 0 ? (
        <Cost amount={creditsNoun(preview.credits)}>
          {t("personInfo")}
          {t("personInfo2")}
        </Cost>
      ) : (
        <Alert tone="info" title={t("noneLeft")}>{t("noneLeftHelp")}</Alert>
      )}
      <ul className="flex flex-col gap-1 text-115 text-ink-2">
        {people.slice(0, 10).map((person) => <li key={person.id} className="truncate"><span className="font-semibold text-ink">{person.name}</span>{person.title ? ` · ${person.title}` : ""}</li>)}
      </ul>
      {!preview.apollo_connected ? <ApolloMissing href={integrationsHref} what="add suggested people" /> : null}
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── The bounces behind a company's flag ───────────────────────────────────────

interface BounceReview {
  flagged: boolean;
  cleared_at: string | null;
  figures: BounceFigures;
  bounces: CompanyBounce[];
}

export function BouncesDialog({ company, canEdit, onClose, onChanged }: { company: CompanyRef | null; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("CompanyDialogs");
  return (
    <Dialog open={company !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={t("bounces")} description={company ? t("bouncesFrom", {name: company.domain ?? company.name}) : undefined} size="md" padded={false}>
      {company ? <BouncesBody company={company} canEdit={canEdit} onClose={onClose} onChanged={onChanged} /> : null}
    </Dialog>
  );
}

function BouncesBody({ company, canEdit, onClose, onChanged }: { company: CompanyRef; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("CompanyDialogs");
  const review = useApi<BounceReview>(bouncesPath(company.id));
  const [busy, setBusy] = useState<"reverify" | "clear" | null>(null);

  async function act(action: "reverify" | "clear") {
    setBusy(action);
    try {
      if (action === "reverify") {
        const said = reverifyOutcome(await api<{ queued: number; restored: number }>(bouncesPath(company.id), { method: "POST", body: { action } }));
        toast.success(said.title, { description: said.description });
        void review.mutate();
        onChanged();
      } else {
        const said = clearOutcome(await api<{ cleared: boolean; restored: number }>(bouncesPath(company.id), { method: "POST", body: { action } }), company.name);
        toast.success(said.title, { description: said.description });
        onChanged();
        onClose();
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  if (review.error && !review.data) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="bad" title={errorMessage(review.error)} /></DialogForm>;
  if (!review.data) return <DialogForm onCancel={onClose} cancelLabel="Close"><LoadingState label={t("loadBounces")} /></DialogForm>;
  const { flagged, figures, bounces } = review.data;

  return (
    <DialogForm
      onCancel={onClose} cancelLabel="Close"
      actions={canEdit && flagged ? (
        <>
          <Button loading={busy === "reverify"} disabled={busy !== null || figures.contacts_with_email === 0} onClick={() => void act("reverify")}>{t("reverify")}</Button>
          <Button variant="primary" loading={busy === "clear"} disabled={busy !== null} onClick={() => void act("clear")}>{t("clearFlag")}</Button>
        </>
      ) : undefined}
    >
      {flagged ? <p className="text-115 leading-[17px] text-ink-2">{bounceDetail(figures)}</p> : <Alert tone="good" title={t("notFlagged")}>{t("notFlaggedHelp")}</Alert>}
      {bounces.length === 0 ? (
        <p className="rounded-lg border border-line bg-subtle p-3 text-115 leading-[17px] text-ink-2">{t("noBounces")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line">
          {bounces.map((bounce) => (
            <li key={bounce.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-12 font-semibold text-ink">
                  {bounce.contact_id ? <Link href={recordHref("contact", bounce.contact_id)} className="hover:text-brand-strong">{bounce.contact_name ?? bounce.recipient}</Link> : bounce.recipient}
                </span>
                <span className="truncate text-105 text-ink-3">{[bounce.contact_id ? bounce.recipient : t("notContact"), bounce.subject, bounce.mailbox ? t("sentFrom", {mailbox: bounce.mailbox}) : null].filter(Boolean).join(" · ")}</span>
              </div>
              <span className="shrink-0 text-105 text-ink-3">{formatDateTime(bounce.occurred_at)}</span>
            </li>
          ))}
        </ul>
      )}
      {flagged && canEdit ? (
        <div className="flex flex-col gap-1.5 text-11 leading-4 text-ink-3">
          <p><span className="font-semibold text-ink-2">{t("reverify")}</span> {t("reverifyHelp")}</p>
          <p><span className="font-semibold text-ink-2">{t("clearFlag")}</span> {t("clearHelp")}</p>
        </div>
      ) : null}
    </DialogForm>
  );
}
