import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/router";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Alert, Button, Checkbox, Dialog, Field, Input, LoadingState, Meter, Pill, Segmented, Select, TONE_SOLID } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import {
  CONTACTS_PATH, CONTACT_TAGS_PATH, ENRICH_PATH, LISTS_PATH, RESEARCH_PATH, TAG_COLORS, TAG_COLOR_NAME,
  campaignStatusLabel, researchReady, tagTone,
  type ContactFacets, type EnrichPreview, type EnrichProgress, type ResearchPreview, type ResearchProgress,
} from "./model";

const NONE = "none";

/**
 * The body and button strip of a dialog. It is mounted when the dialog opens, so whatever
 * state the form inside keeps starts fresh each time.
 */
export function DialogForm({ onSubmit, onCancel, cancelLabel, actions, children }: { onSubmit?: () => void; onCancel: () => void; cancelLabel?: string; actions?: ReactNode; children: ReactNode }) {
  const t = useTranslations("ContactDialogs");
  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5">{children}</div>
      <div className="flex h-16 shrink-0 items-center justify-between gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="ghost" onClick={onCancel}>{cancelLabel ?? t("cancel")}</Button>
        <div className="flex items-center gap-2">{actions}</div>
      </div>
    </form>
  );
}

// ── Add a contact ─────────────────────────────────────────────────────────────

const EMPTY_CONTACT = { full_name: "", linkedin_url: "", email: "", title: "", company: "", location: "", phone: "" };

/** One contact, typed in. A file of them goes through a list's CSV import. */
export function AddContactDialog({ open, lists, listId, company, onClose, onCreated }: {
  open: boolean; lists: ContactFacets["lists"]; listId: string | null;
  /** Opened from a company's page: the contact is linked to it. */
  company?: { id: string; name: string } | null;
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const t = useTranslations("ContactDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("addContactTitle")} description={company ? t("atCompany", {name: company.name}) : t("importCsvHint")} size="md" padded={false}>
      {open ? <AddContactForm lists={lists} listId={listId} company={company ?? null} onClose={onClose} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function AddContactForm({ lists, listId, company, onClose, onCreated }: { lists: ContactFacets["lists"]; listId: string | null; company: { id: string; name: string } | null; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("ContactDialogs");
  const [form, setForm] = useState({ ...EMPTY_CONTACT, company: company?.name ?? "" });
  const [list, setList] = useState(listId ?? NONE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof EMPTY_CONTACT) => (event: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const reachable = form.linkedin_url.trim() !== "" || form.email.trim() !== "";
  const ready = form.full_name.trim() !== "" && reachable;

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim() || undefined]));
      const created = await api<{ id: string }>(CONTACTS_PATH, { method: "POST", body: { ...body, list_id: list === NONE ? undefined : list, company_id: company?.id } });
      toast.success(t("contactAdded", {name: form.full_name.trim()}));
      onCreated(created.id);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>{t("addContactButton")}</Button>}>
      <div className="grid grid-cols-2 gap-3.5">
        <Field label={t("fullName")} className="col-span-2">{(id) => <Input id={id} data-autofocus value={form.full_name} onChange={set("full_name")} placeholder="Jane Smith" autoComplete="off" />}</Field>
        <Field label={t("linkedinProfile")} className="col-span-2" hint={t("linkedinHint")}>
          {(id) => <Input id={id} value={form.linkedin_url} onChange={set("linkedin_url")} placeholder="https://www.linkedin.com/in/…" autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label={t("email")}>{(id) => <Input id={id} type="email" value={form.email} onChange={set("email")} placeholder="jane@example.com" autoComplete="off" />}</Field>
        <Field label={t("phone")}>{(id) => <Input id={id} type="tel" value={form.phone} onChange={set("phone")} autoComplete="off" />}</Field>
        <Field label={t("jobTitle")}>{(id) => <Input id={id} value={form.title} onChange={set("title")} autoComplete="off" />}</Field>
        <Field label={t("company")}>{(id) => <Input id={id} value={form.company} onChange={set("company")} autoComplete="off" />}</Field>
        <Field label={t("location")}>{(id) => <Input id={id} value={form.location} onChange={set("location")} autoComplete="off" />}</Field>
        <Field label={t("addToList")}>
          {(id) => <Select id={id} value={list} onChange={setList} className="w-full" options={[{ value: NONE, label: t("noList") }, ...lists.map((item) => ({ value: item.id, label: item.name }))]} />}
        </Field>
      </div>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Add to a list ─────────────────────────────────────────────────────────────

const NEW_LIST = "new";

export function AddToListDialog({ ids, lists, onClose, onDone }: { ids: string[] | null; lists: ContactFacets["lists"]; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("ContactDialogs");
  return (
    <Dialog open={ids !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={t("addToListTitle")} description={ids ? t("addToListDescription", {count: ids.length}) : undefined} size="sm" padded={false}>
      {ids ? <AddToListForm ids={ids} lists={lists} onClose={onClose} onDone={onDone} /> : null}
    </Dialog>
  );
}

/** A list to choose, or the name of a new one. */
function ListChoice({ label, lists, list, name, onList, onName }: { label: string; lists: ContactFacets["lists"]; list: string | undefined; name: string; onList: (list: string) => void; onName: (name: string) => void }) {
  const t = useTranslations("ContactDialogs");
  return (
    <>
      <Field label={label}>
        {(id) => (
          <Select
            id={id} value={list} onChange={onList} placeholder={t("chooseList")} className="w-full"
            options={[...lists.map((item) => ({ value: item.id, label: item.name, hint: t("contactsCount", {count: item.count}) })), { value: NEW_LIST, label: t("newList") }]}
          />
        )}
      </Field>
      {list === NEW_LIST ? <Field label={t("newListName")}>{(id) => <Input id={id} value={name} onChange={(event) => onName(event.target.value)} autoComplete="off" />}</Field> : null}
    </>
  );
}

function AddToListForm({ ids, lists, onClose, onDone }: { ids: string[]; lists: ContactFacets["lists"]; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("ContactDialogs");
  const [list, setList] = useState<string | undefined>(lists.length ? undefined : NEW_LIST);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = list === NEW_LIST ? name.trim() !== "" : Boolean(list);

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      let target = list;
      let targetName = lists.find((item) => item.id === list)?.name ?? t("defaultListName");
      if (list === NEW_LIST) {
        const created = await api<{ id: string; name: string }>(LISTS_PATH, { method: "POST", body: { name: name.trim() } });
        target = created.id;
        targetName = created.name;
      }
      const result = await api<{ added: number; already_members: number }>(`/api/lists/${target}/add-members`, { method: "POST", body: { contact_ids: ids } });
      toast.success(t("listAdded", {count: result.added, name: targetName}), { description: result.already_members ? t("alreadyThere", {count: result.already_members}) : undefined });
      onDone();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>{t("addToListButton")}</Button>}>
      <ListChoice label={t("list")} lists={lists} list={list} name={name} onList={setList} onName={setName} />
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Add to a campaign ─────────────────────────────────────────────────────────

/** Enrol a selection in a campaign that is already going. A campaign not started yet takes its contacts from its list. */
export function AddToCampaignDialog({ ids, campaigns, canEnrol, onClose, onDone }: { ids: string[] | null; campaigns: ContactFacets["campaigns"]; canEnrol: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("ContactDialogs");
  return (
    <Dialog open={ids !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={t("addToCampaignTitle")} description={ids ? t("contactsCount", {count: ids.length}) : undefined} size="sm" padded={false}>
      {ids ? <AddToCampaignForm ids={ids} campaigns={campaigns} canEnrol={canEnrol} onClose={onClose} onDone={onDone} /> : null}
    </Dialog>
  );
}

function AddToCampaignForm({ ids, campaigns, canEnrol, onClose, onDone }: { ids: string[]; campaigns: ContactFacets["campaigns"]; canEnrol: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("ContactDialogs");
  const statusLabels: Record<string, string> = { running: t("statusRunning"), paused: t("statusPaused"), completed: t("statusCompleted"), pending: t("statusPending"), failed: t("statusStopped"), cancelled: t("statusStopped"), canceled: t("statusStopped") };
  const live = useMemo(() => campaigns.filter((campaign) => campaign.run_id), [campaigns]);
  const [campaign, setCampaign] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const chosen = live.find((item) => item.id === campaign);
    if (!chosen?.run_id || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ enrolled: number; skipped_already_enrolled: number; skipped_active_elsewhere: number }>(`/api/runs/${chosen.run_id}/enroll`, { method: "POST", body: { target_ids: ids } });
      if (result.enrolled > 0) toast.success(t("enrolledSummary", {count: result.enrolled, name: chosen.name, already: result.skipped_already_enrolled, elsewhere: result.skipped_active_elsewhere}));
      else toast.message(t("nobodyEnrolled", {name: chosen.name}), { description: t("enrollmentSkipped", {already: result.skipped_already_enrolled, elsewhere: result.skipped_active_elsewhere}) });
      onDone();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!campaign || !canEnrol}>{t("addToCampaignButton")}</Button>}>
      {!canEnrol ? (
        <Alert tone="info" title={t("managerRequired")}>{t("managerRequiredBody")}</Alert>
      ) : live.length === 0 ? (
        <Alert tone="info" title={t("noCampaign")}>{t("noCampaignBody")}</Alert>
      ) : (
        <>
          <Field label={t("campaign")} hint={t("campaignHint")}>
            {(id) => (
              <Select
                id={id} value={campaign} onChange={setCampaign} placeholder={t("chooseCampaign")} className="w-full"
                options={live.map((item) => ({ value: item.id, label: item.name, hint: item.status ? statusLabels[item.status] ?? campaignStatusLabel(item.status) : t("statusPending") }))}
              />
            )}
          </Field>
          {error ? <Alert tone="bad" title={error} /> : null}
        </>
      )}
    </DialogForm>
  );
}

// ── Tag ───────────────────────────────────────────────────────────────────────

export function TagDialog({ ids, tags, onClose, onDone, onManage }: { ids: string[] | null; tags: ContactFacets["tags"]; onClose: () => void; onDone: () => void; onManage: () => void }) {
  const t = useTranslations("ContactDialogs");
  return (
    <Dialog open={ids !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={t("tagContactsTitle")} description={ids ? t("contactsCount", {count: ids.length}) : undefined} size="sm" padded={false}>
      {ids ? <TagForm ids={ids} tags={tags} onClose={onClose} onDone={onDone} onManage={onManage} /> : null}
    </Dialog>
  );
}

function TagForm({ ids, tags, onClose, onDone, onManage }: { ids: string[]; tags: ContactFacets["tags"]; onClose: () => void; onDone: () => void; onManage: () => void }) {
  const t = useTranslations("ContactDialogs");
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("neutral");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const making = mode === "add" && name.trim() !== "";
  const ready = chosen.size > 0 || making;
  const toggle = (id: string, on: boolean) => setChosen((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = mode === "add" ? { target_ids: ids, add: [...chosen], ...(making ? { create: name.trim(), color } : {}) } : { target_ids: ids, remove: [...chosen] };
      const result = await api<{ added: number; removed: number }>(CONTACT_TAGS_PATH, { method: "PUT", body });
      const count = chosen.size + (making ? 1 : 0);
      toast.success(mode === "add" ? t("tagsAdded", {count, contacts: t("contactsCount", {count: ids.length})}) : t("tagsRemoved", {count, contacts: t("contactsCount", {count: ids.length})}), {
        description: mode === "add" && result.added === 0 ? t("alreadyTagged") : mode === "remove" && result.removed === 0 ? t("notTagged") : undefined,
      });
      onDone();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>{mode === "add" ? t("addTags") : t("removeTags")}</Button>}>
      <div className="flex items-center justify-between gap-2">
        <Segmented label={t("tagAction")} size="sm" value={mode} onChange={(next) => { setMode(next); setChosen(new Set()); }} options={[{ value: "add", label: t("add") }, { value: "remove", label: t("remove") }]} />
        {tags.length > 0 ? <button type="button" onClick={onManage} className="text-11 font-semibold text-brand-strong hover:underline">{t("manageTags")}</button> : null}
      </div>
      {tags.length > 0 ? (
        <ul className="flex max-h-[220px] shrink-0 flex-col gap-px overflow-y-auto rounded-md border border-line p-1">
          {tags.map((tag) => {
            const id = `tag-choice-${tag.id}`;
            return (
              <li key={tag.id} className="flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 hover:bg-subtle">
                <Checkbox id={id} checked={chosen.has(tag.id)} onChange={(on) => toggle(tag.id, on)} />
                <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2">
                  <Pill tone={tagTone(tag.color)} className="max-w-[220px] truncate">{tag.name}</Pill>
                  <span className="text-105 text-ink-3">{t("contactsCount", {count: tag.count})}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : mode === "remove" ? (
        <p className="text-115 text-ink-2">{t("noTags")}</p>
      ) : null}
      {mode === "add" ? (
        <Field label={tags.length ? t("orNewTag") : t("newTag")}>
          {(id) => (
            <div className="flex items-center gap-2">
              <Input id={id} value={name} onChange={(event) => setName(event.target.value)} placeholder="Champion" maxLength={32} autoComplete="off" frameClassName="flex-1" data-autofocus={tags.length === 0 || undefined} />
              <ColorDots value={color} onChange={setColor} />
            </div>
          )}
        </Field>
      ) : null}
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

/** The seven tones a tag can take, as a row of dots. */
export function ColorDots({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const t = useTranslations("ContactDialogs");
  const colorLabels: Record<string, string> = {neutral: t("colorNeutral"), brand: t("colorBrand"), good: t("colorGood"), warn: t("colorWarn"), bad: t("colorBad"), li: t("colorLi"), mail: t("colorMail")};
  return (
    <div role="radiogroup" aria-label={t("tagColorAria")} className="flex shrink-0 items-center gap-1">
      {TAG_COLORS.map((tone) => (
        <button
          key={tone} type="button" role="radio" aria-checked={value === tone} aria-label={colorLabels[tone] ?? TAG_COLOR_NAME[tone]} title={colorLabels[tone] ?? TAG_COLOR_NAME[tone]} onClick={() => onChange(tone)}
          className={cn("inline-flex size-5 items-center justify-center rounded-full border", value === tone ? "border-ink" : "border-transparent hover:border-line-strong")}
        >
          <span className={cn("size-3 rounded-full", TONE_SOLID[tone])} />
        </button>
      ))}
    </div>
  );
}

// ── Enrich a selection ────────────────────────────────────────────────────────

/**
 * Shows what looking a selection up on Apollo would cost before anything is spent, then
 * follows the run. The run itself belongs to the screen, so it carries on (and can be
 * stopped) with this dialog closed.
 */
export function EnrichDialog({
  open, ids, progress, integrationsHref, onStart, onStop, onClose,
}: {
  open: boolean;
  /** The selection to price. Not needed once a run is under way. */
  ids: string[];
  progress: EnrichProgress | null;
  integrationsHref: string;
  onStart: (ids: string[], batch: number) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("ContactDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("enrichTitle")} description={progress ? undefined : t("selectedContacts", {count: ids.length})} size="sm" padded={false}>
      {!open ? null : progress ? (
        <EnrichRun progress={progress} onStop={onStop} onClose={onClose} />
      ) : (
        <EnrichCost ids={ids} integrationsHref={integrationsHref} onStart={onStart} onClose={onClose} />
      )}
    </Dialog>
  );
}

/**
 * Researching a selection into a hook line each. Same two-body shape as EnrichDialog: the
 * cost first, then the run, with the run owned by the screen so it survives this closing.
 */
export function ResearchDialog({
  open, ids, progress, integrationsHref, onStart, onStop, onClose,
}: {
  open: boolean;
  /** The selection to price. Not needed once a run is under way. */
  ids: string[];
  progress: ResearchProgress | null;
  integrationsHref: string;
  onStart: (ids: string[], batch: number) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("ContactDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("researchTitle")} description={progress ? undefined : t("selectedContacts", {count: ids.length})} size="sm" padded={false}>
      {!open ? null : progress ? (
        <ResearchRun progress={progress} onStop={onStop} onClose={onClose} />
      ) : (
        <ResearchCost ids={ids} integrationsHref={integrationsHref} onStart={onStart} onClose={onClose} />
      )}
    </Dialog>
  );
}

function ResearchCost({ ids, integrationsHref, onStart, onClose }: { ids: string[]; integrationsHref: string; onStart: (ids: string[], batch: number) => void; onClose: () => void }) {
  const t = useTranslations("ContactDialogs");
  const router = useRouter();
  const [preview, setPreview] = useState<ResearchPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Asked once, when the dialog opens: nothing is read or spent by asking.
  useEffect(() => {
    let cancelled = false;
    api<ResearchPreview>(RESEARCH_PATH, { method: "POST", body: { target_ids: ids, dry_run: true } })
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((cause) => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; };
  }, [ids]);

  if (error) return <DialogForm onCancel={onClose} cancelLabel={t("close")}><Alert tone="bad" title={error} /></DialogForm>;
  if (!preview) return <DialogForm onCancel={onClose} actions={<Button variant="primary" disabled>{t("research")}</Button>}><LoadingState label={t("workingCost")} /></DialogForm>;

  const ready = researchReady(preview);
  const can = ready && preview.eligible > 0;
  const skips = preview.no_website ? [t("researchSkippedNoSite", {count: preview.no_website})] : [];
  return (
    <DialogForm
      onSubmit={() => { if (can) onStart(preview.eligible_ids, preview.batch); }} onCancel={onClose}
      actions={<Button type="submit" variant="primary" disabled={!can}>{preview.eligible > 0 ? t("researchEligible", {count: preview.eligible}) : t("research")}</Button>}
    >
      {preview.eligible > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-subtle p-3">
          <span className="text-10 font-semibold uppercase tracking-label text-ink-3">{t("cost")}</span>
          <span className="text-18 font-semibold tracking-figure text-ink">{t("researchCost", {count: preview.credits})}</span>
          <span className="text-11 leading-4 text-ink-2">
            {t("researchPricingBody")}
          </span>
        </div>
      ) : (
        <Alert tone="info" title={t("researchUnavailable")}>{t("researchUnavailableBody")}</Alert>
      )}
      {skips.length > 0 ? (
        <ul className="flex flex-col gap-1 text-115 text-ink-2">
          {skips.map((line) => <li key={line}>{line}, {preview.eligible > 0 ? t("skipExcluded") : t("skipNothing")}.</li>)}
        </ul>
      ) : null}
      {preview.eligible > 0 ? (
        <p className="text-11 leading-4 text-ink-3">
          {t("researchMergeTagBefore")} <span className="font-medium text-ink-2">{`{{${preview.field_key}}}`}</span>{t("researchMergeTagAfter")}
        </p>
      ) : null}
      {!ready ? (
        <Alert tone="warn" title={t("readerMissing")} actions={<Button size="xs" onClick={() => void router.push(integrationsHref)}>{t("integrations")}</Button>}>
          {t("readerMissingBody")}
        </Alert>
      ) : null}
    </DialogForm>
  );
}

function ResearchRun({ progress, onStop, onClose }: { progress: ResearchProgress; onStop: () => void; onClose: () => void }) {
  const t = useTranslations("ContactDialogs");
  const running = progress.state === "running" || progress.state === "stopping";
  return (
    <DialogForm onCancel={onClose} cancelLabel={running ? t("hide") : t("close")} actions={running ? <Button variant="danger" loading={progress.state === "stopping"} onClick={onStop}>{t("stop")}</Button> : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-125 font-semibold text-ink">{running ? t("researchingNow", {count: progress.total}) : progress.state === "finished" ? t("finished") : progress.state === "stopped" ? t("stopped") : t("failed")}</span>
        <span className="text-11 tabular-nums text-ink-3">{t("progressOf", {done: progress.done, total: progress.total})}</span>
      </div>
      <Meter value={progress.done} max={progress.total} tone={progress.state === "failed" ? "bad" : "brand"} label={t("contactsResearched")} />
      <p className="text-115 leading-[17px] text-ink-2">{t("researchOutcome", {done: progress.done, written: progress.written, noHook: progress.noHook, skipped: progress.skipped})}.</p>
      {progress.error ? <Alert tone="bad" title={progress.error} /> : null}
      {running ? <p className="text-11 text-ink-3">{t("runHideNote")}</p> : null}
    </DialogForm>
  );
}

function EnrichCost({ ids, integrationsHref, onStart, onClose }: { ids: string[]; integrationsHref: string; onStart: (ids: string[], batch: number) => void; onClose: () => void }) {
  const t = useTranslations("ContactDialogs");
  const router = useRouter();
  const [preview, setPreview] = useState<EnrichPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Asked once, when the dialog opens: nothing is looked up or spent by asking.
  useEffect(() => {
    let cancelled = false;
    api<EnrichPreview>(ENRICH_PATH, { method: "POST", body: { target_ids: ids, dry_run: true } })
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((cause) => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; };
  }, [ids]);

  if (error) return <DialogForm onCancel={onClose} cancelLabel={t("close")}><Alert tone="bad" title={error} /></DialogForm>;
  if (!preview) return <DialogForm onCancel={onClose} actions={<Button variant="primary" disabled>{t("enrich")}</Button>}><LoadingState label={t("workingCost")} /></DialogForm>;

  const skips = [...(preview.have_email ? [t("enrichSkippedEmail", {count: preview.have_email})] : []), ...(preview.no_profile_address ? [t("enrichSkippedLinkedin", {count: preview.no_profile_address})] : [])];
  return (
    <DialogForm
      onSubmit={() => { if (preview.apollo_connected && preview.eligible > 0) onStart(preview.eligible_ids, preview.batch); }} onCancel={onClose}
      actions={<Button type="submit" variant="primary" disabled={!preview.apollo_connected || preview.eligible === 0}>{preview.eligible > 0 ? t("enrichEligible", {count: preview.eligible}) : t("enrich")}</Button>}
    >
      {preview.eligible > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-subtle p-3">
          <span className="text-10 font-semibold uppercase tracking-label text-ink-3">{t("cost")}</span>
          <span className="text-18 font-semibold tracking-figure text-ink">{t("enrichCost", {count: preview.credits})}</span>
          <span className="text-11 leading-4 text-ink-2">
            {t("enrichPricingBody", {count: preview.eligible})}
          </span>
        </div>
      ) : (
        <Alert tone="info" title={t("enrichUnavailable")}>{t("enrichUnavailableBody")}</Alert>
      )}
      {skips.length > 0 ? (
        <ul className="flex flex-col gap-1 text-115 text-ink-2">
          {skips.map((line) => <li key={line}>{line}, {preview.eligible > 0 ? t("skipExcluded") : t("skipNothing")}.</li>)}
        </ul>
      ) : null}
      {preview.tried_before > 0 ? (
        <Alert tone="warn" title={t("alreadyTried", {count: preview.tried_before})}>
          {t("alreadyTriedWarning")}
        </Alert>
      ) : null}
      {!preview.apollo_connected ? (
        <Alert tone="warn" title={t("apolloMissing")} actions={<Button size="xs" onClick={() => void router.push(integrationsHref)}>{t("integrations")}</Button>}>
          {t("apolloMissingBody")}
        </Alert>
      ) : null}
    </DialogForm>
  );
}

function EnrichRun({ progress, onStop, onClose }: { progress: EnrichProgress; onStop: () => void; onClose: () => void }) {
  const t = useTranslations("ContactDialogs");
  const running = progress.state === "running" || progress.state === "stopping";
  return (
    <DialogForm onCancel={onClose} cancelLabel={running ? t("hide") : t("close")} actions={running ? <Button variant="danger" loading={progress.state === "stopping"} onClick={onStop}>{t("stop")}</Button> : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-125 font-semibold text-ink">{running ? t("enrichingNow", {count: progress.total}) : progress.state === "finished" ? t("finished") : progress.state === "stopped" ? t("stopped") : t("failed")}</span>
        <span className="text-11 tabular-nums text-ink-3">{t("progressOf", {done: progress.done, total: progress.total})}</span>
      </div>
      <Meter value={progress.done} max={progress.total} tone={progress.state === "failed" ? "bad" : "brand"} label={t("contactsEnriched")} />
      <p className="text-115 leading-[17px] text-ink-2">{t("enrichOutcome", {done: progress.done, emails: progress.emails, notFound: progress.notFound, failed: progress.failed})}.</p>
      {progress.error ? <Alert tone="bad" title={progress.error} /> : null}
      {running ? <p className="text-11 text-ink-3">{t("runHideNote")}</p> : null}
    </DialogForm>
  );
}

