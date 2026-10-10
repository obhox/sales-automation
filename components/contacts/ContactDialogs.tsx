import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/router";
import { toast } from "sonner";
import { Alert, Button, Checkbox, Dialog, Field, Input, LoadingState, Meter, Pill, Segmented, Select, TONE_SOLID } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatCount, plural } from "@/lib/client/format";
import {
  CONTACTS_PATH, CONTACT_TAGS_PATH, ENRICH_PATH, LISTS_PATH, TAG_COLORS, TAG_COLOR_NAME,
  campaignStatusLabel, contactsNoun, enrichOutcome, enrichSkips, enrolOutcome, tagTone,
  type ContactFacets, type EnrichPreview, type EnrichProgress,
} from "./model";

const NONE = "none";

/**
 * The body and button strip of a dialog. It is mounted when the dialog opens, so whatever
 * state the form inside keeps starts fresh each time.
 */
export function DialogForm({ onSubmit, onCancel, cancelLabel = "Cancel", actions, children }: { onSubmit?: () => void; onCancel: () => void; cancelLabel?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5">{children}</div>
      <div className="flex h-16 shrink-0 items-center justify-between gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
        <div className="flex items-center gap-2">{actions}</div>
      </div>
    </form>
  );
}

// ── Add a contact ─────────────────────────────────────────────────────────────

const EMPTY_CONTACT = { full_name: "", linkedin_url: "", email: "", title: "", company: "", location: "", phone: "" };

/** One contact, typed in. A file of them goes through a list's CSV import. */
export function AddContactDialog({ open, lists, listId, onClose, onCreated }: { open: boolean; lists: ContactFacets["lists"]; listId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Add a contact" description="For a file of contacts, import a CSV into a list" size="md" padded={false}>
      {open ? <AddContactForm lists={lists} listId={listId} onClose={onClose} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function AddContactForm({ lists, listId, onClose, onCreated }: { lists: ContactFacets["lists"]; listId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState(EMPTY_CONTACT);
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
      const created = await api<{ id: string }>(CONTACTS_PATH, { method: "POST", body: { ...body, list_id: list === NONE ? undefined : list } });
      toast.success(`${form.full_name.trim()} added`);
      onCreated(created.id);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>Add contact</Button>}>
      <div className="grid grid-cols-2 gap-3.5">
        <Field label="Full name" className="col-span-2">{(id) => <Input id={id} data-autofocus value={form.full_name} onChange={set("full_name")} placeholder="Jane Smith" autoComplete="off" />}</Field>
        <Field label="LinkedIn profile" className="col-span-2" hint="A contact needs a LinkedIn profile or an email address. Either is enough.">
          {(id) => <Input id={id} value={form.linkedin_url} onChange={set("linkedin_url")} placeholder="https://www.linkedin.com/in/…" autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label="Email">{(id) => <Input id={id} type="email" value={form.email} onChange={set("email")} placeholder="jane@example.com" autoComplete="off" />}</Field>
        <Field label="Phone">{(id) => <Input id={id} type="tel" value={form.phone} onChange={set("phone")} autoComplete="off" />}</Field>
        <Field label="Title">{(id) => <Input id={id} value={form.title} onChange={set("title")} autoComplete="off" />}</Field>
        <Field label="Company">{(id) => <Input id={id} value={form.company} onChange={set("company")} autoComplete="off" />}</Field>
        <Field label="Location">{(id) => <Input id={id} value={form.location} onChange={set("location")} autoComplete="off" />}</Field>
        <Field label="Add to list">
          {(id) => <Select id={id} value={list} onChange={setList} className="w-full" options={[{ value: NONE, label: "No list" }, ...lists.map((item) => ({ value: item.id, label: item.name }))]} />}
        </Field>
      </div>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Add to a list ─────────────────────────────────────────────────────────────

const NEW_LIST = "new";

export function AddToListDialog({ ids, lists, onClose, onDone }: { ids: string[] | null; lists: ContactFacets["lists"]; onClose: () => void; onDone: () => void }) {
  return (
    <Dialog open={ids !== null} onOpenChange={(next) => { if (!next) onClose(); }} title="Add to list" description={ids ? `${contactsNoun(ids.length)}. Anyone already in the list is passed over.` : undefined} size="sm" padded={false}>
      {ids ? <AddToListForm ids={ids} lists={lists} onClose={onClose} onDone={onDone} /> : null}
    </Dialog>
  );
}

/** A list to choose, or the name of a new one. */
function ListChoice({ label, lists, list, name, onList, onName }: { label: string; lists: ContactFacets["lists"]; list: string | undefined; name: string; onList: (list: string) => void; onName: (name: string) => void }) {
  return (
    <>
      <Field label={label}>
        {(id) => (
          <Select
            id={id} value={list} onChange={onList} placeholder="Choose a list" className="w-full"
            options={[...lists.map((item) => ({ value: item.id, label: item.name, hint: contactsNoun(item.count) })), { value: NEW_LIST, label: "New list…" }]}
          />
        )}
      </Field>
      {list === NEW_LIST ? <Field label="Name of the new list">{(id) => <Input id={id} value={name} onChange={(event) => onName(event.target.value)} autoComplete="off" />}</Field> : null}
    </>
  );
}

function AddToListForm({ ids, lists, onClose, onDone }: { ids: string[]; lists: ContactFacets["lists"]; onClose: () => void; onDone: () => void }) {
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
      let targetName = lists.find((item) => item.id === list)?.name ?? "the list";
      if (list === NEW_LIST) {
        const created = await api<{ id: string; name: string }>(LISTS_PATH, { method: "POST", body: { name: name.trim() } });
        target = created.id;
        targetName = created.name;
      }
      const result = await api<{ added: number; already_members: number }>(`/api/lists/${target}/add-members`, { method: "POST", body: { contact_ids: ids } });
      toast.success(`${contactsNoun(result.added)} added to ${targetName}`, { description: result.already_members ? `${formatCount(result.already_members)} already there` : undefined });
      onDone();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>Add to list</Button>}>
      <ListChoice label="List" lists={lists} list={list} name={name} onList={setList} onName={setName} />
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Add to a campaign ─────────────────────────────────────────────────────────

/** Enrol a selection in a campaign that is already going. A campaign not started yet takes its contacts from its list. */
export function AddToCampaignDialog({ ids, campaigns, canEnrol, onClose, onDone }: { ids: string[] | null; campaigns: ContactFacets["campaigns"]; canEnrol: boolean; onClose: () => void; onDone: () => void }) {
  return (
    <Dialog open={ids !== null} onOpenChange={(next) => { if (!next) onClose(); }} title="Add to campaign" description={ids ? contactsNoun(ids.length) : undefined} size="sm" padded={false}>
      {ids ? <AddToCampaignForm ids={ids} campaigns={campaigns} canEnrol={canEnrol} onClose={onClose} onDone={onDone} /> : null}
    </Dialog>
  );
}

function AddToCampaignForm({ ids, campaigns, canEnrol, onClose, onDone }: { ids: string[]; campaigns: ContactFacets["campaigns"]; canEnrol: boolean; onClose: () => void; onDone: () => void }) {
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
      if (result.enrolled > 0) toast.success(enrolOutcome(result, chosen.name));
      else toast.message(`Nobody was added to ${chosen.name}`, { description: enrolOutcome(result, chosen.name).split(" · ").slice(1).join(" · ") || undefined });
      onDone();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!campaign || !canEnrol}>Add to campaign</Button>}>
      {!canEnrol ? (
        <Alert tone="info" title="A manager adds contacts to a running campaign">Ask a manager or admin in this workspace, or add these contacts to the campaign&apos;s list before it starts.</Alert>
      ) : live.length === 0 ? (
        <Alert tone="info" title="No campaign is running">Contacts can be added to a campaign that is running or paused. A campaign that has not started takes its contacts from its list.</Alert>
      ) : (
        <>
          <Field label="Campaign" hint="Each contact starts at the first step. Anyone already in this campaign, or still active in another, is passed over.">
            {(id) => (
              <Select
                id={id} value={campaign} onChange={setCampaign} placeholder="Choose a campaign" className="w-full"
                options={live.map((item) => ({ value: item.id, label: item.name, hint: campaignStatusLabel(item.status) }))}
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
  return (
    <Dialog open={ids !== null} onOpenChange={(next) => { if (!next) onClose(); }} title="Tag contacts" description={ids ? contactsNoun(ids.length) : undefined} size="sm" padded={false}>
      {ids ? <TagForm ids={ids} tags={tags} onClose={onClose} onDone={onDone} onManage={onManage} /> : null}
    </Dialog>
  );
}

function TagForm({ ids, tags, onClose, onDone, onManage }: { ids: string[]; tags: ContactFacets["tags"]; onClose: () => void; onDone: () => void; onManage: () => void }) {
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
      toast.success(mode === "add" ? `${count} ${plural(count, "tag", "tags")} added to ${contactsNoun(ids.length)}` : `${count} ${plural(count, "tag", "tags")} taken off ${contactsNoun(ids.length)}`, {
        description: mode === "add" && result.added === 0 ? "They all had it already" : mode === "remove" && result.removed === 0 ? "None of them had it" : undefined,
      });
      onDone();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>{mode === "add" ? "Add tags" : "Remove tags"}</Button>}>
      <div className="flex items-center justify-between gap-2">
        <Segmented label="What to do" size="sm" value={mode} onChange={(next) => { setMode(next); setChosen(new Set()); }} options={[{ value: "add", label: "Add" }, { value: "remove", label: "Remove" }]} />
        {tags.length > 0 ? <button type="button" onClick={onManage} className="text-11 font-semibold text-brand-strong hover:underline">Manage tags</button> : null}
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
                  <span className="text-105 text-ink-3">{contactsNoun(tag.count)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : mode === "remove" ? (
        <p className="text-115 text-ink-2">This workspace has no tags yet.</p>
      ) : null}
      {mode === "add" ? (
        <Field label={tags.length ? "Or a new tag" : "New tag"}>
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
  return (
    <div role="radiogroup" aria-label="Tag colour" className="flex shrink-0 items-center gap-1">
      {TAG_COLORS.map((tone) => (
        <button
          key={tone} type="button" role="radio" aria-checked={value === tone} aria-label={TAG_COLOR_NAME[tone]} title={TAG_COLOR_NAME[tone]} onClick={() => onChange(tone)}
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
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Enrich from Apollo" description={progress ? undefined : `${contactsNoun(ids.length)} selected`} size="sm" padded={false}>
      {!open ? null : progress ? (
        <EnrichRun progress={progress} onStop={onStop} onClose={onClose} />
      ) : (
        <EnrichCost ids={ids} integrationsHref={integrationsHref} onStart={onStart} onClose={onClose} />
      )}
    </Dialog>
  );
}

function EnrichCost({ ids, integrationsHref, onStart, onClose }: { ids: string[]; integrationsHref: string; onStart: (ids: string[], batch: number) => void; onClose: () => void }) {
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

  if (error) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="bad" title={error} /></DialogForm>;
  if (!preview) return <DialogForm onCancel={onClose} actions={<Button variant="primary" disabled>Enrich</Button>}><LoadingState label="Working out the cost" /></DialogForm>;

  const skips = enrichSkips(preview);
  return (
    <DialogForm
      onSubmit={() => { if (preview.apollo_connected && preview.eligible > 0) onStart(preview.eligible_ids, preview.batch); }} onCancel={onClose}
      actions={<Button type="submit" variant="primary" disabled={!preview.apollo_connected || preview.eligible === 0}>{preview.eligible > 0 ? `Enrich ${contactsNoun(preview.eligible)}` : "Enrich"}</Button>}
    >
      {preview.eligible > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-subtle p-3">
          <span className="text-10 font-semibold uppercase tracking-label text-ink-3">Cost</span>
          <span className="text-18 font-semibold tracking-figure text-ink">Up to {formatCount(preview.credits)} Apollo {plural(preview.credits, "credit", "credits")}</span>
          <span className="text-11 leading-4 text-ink-2">
            One for each of {contactsNoun(preview.eligible)} looked up by LinkedIn address. Apollo takes the credits from your Apollo plan; Linki does not see your balance.
          </span>
        </div>
      ) : (
        <Alert tone="info" title="None of these contacts can be looked up">Apollo is asked only about contacts that have a LinkedIn address and no email yet.</Alert>
      )}
      {skips.length > 0 ? (
        <ul className="flex flex-col gap-1 text-115 text-ink-2">
          {skips.map((line) => <li key={line}>{line}, so {preview.eligible > 0 ? "they are left out" : "nothing is spent"}.</li>)}
        </ul>
      ) : null}
      {preview.tried_before > 0 ? (
        <Alert tone="warn" title={`${contactsNoun(preview.tried_before)} ${plural(preview.tried_before, "was", "were")} looked up before and no email came back`}>
          Asking again spends another credit each, and usually returns the same answer.
        </Alert>
      ) : null}
      {!preview.apollo_connected ? (
        <Alert tone="warn" title="Apollo is not connected" actions={<Button size="xs" onClick={() => void router.push(integrationsHref)}>Open integrations</Button>}>
          Add your Apollo API key under Integrations to enrich contacts. Nothing has been spent.
        </Alert>
      ) : null}
    </DialogForm>
  );
}

function EnrichRun({ progress, onStop, onClose }: { progress: EnrichProgress; onStop: () => void; onClose: () => void }) {
  const running = progress.state === "running" || progress.state === "stopping";
  return (
    <DialogForm onCancel={onClose} cancelLabel={running ? "Hide" : "Close"} actions={running ? <Button variant="danger" loading={progress.state === "stopping"} onClick={onStop}>Stop</Button> : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-125 font-semibold text-ink">{running ? `Looking up ${contactsNoun(progress.total)}` : progress.state === "finished" ? "Finished" : progress.state === "stopped" ? "Stopped" : "Stopped by a problem"}</span>
        <span className="text-11 tabular-nums text-ink-3">{formatCount(progress.done)} of {formatCount(progress.total)}</span>
      </div>
      <Meter value={progress.done} max={progress.total} tone={progress.state === "failed" ? "bad" : "brand"} label="Contacts looked up" />
      <p className="text-115 leading-[17px] text-ink-2">{enrichOutcome(progress)}.</p>
      {progress.error ? <Alert tone="bad" title={progress.error} /> : null}
      {running ? <p className="text-11 text-ink-3">This runs from this page. Hiding this window is fine; leaving the Contacts page stops it after the batch in hand.</p> : null}
    </DialogForm>
  );
}

// ── Import a CSV ──────────────────────────────────────────────────────────────

/** A CSV goes into a list, so this only asks which one and hands over to that list's import. */
export function ImportCsvDialog({ open, lists, listId, onClose }: { open: boolean; lists: ContactFacets["lists"]; listId: string | null; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Import a CSV" description="Imported contacts go into a list" size="sm" padded={false}>
      {open ? <ImportCsvForm lists={lists} listId={listId} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ImportCsvForm({ lists, listId, onClose }: { lists: ContactFacets["lists"]; listId: string | null; onClose: () => void }) {
  const router = useRouter();
  const [list, setList] = useState<string | undefined>(listId ?? (lists.length ? undefined : NEW_LIST));
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = list === NEW_LIST ? name.trim() !== "" : Boolean(list);

  async function go() {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const target = list === NEW_LIST ? (await api<{ id: string }>(LISTS_PATH, { method: "POST", body: { name: name.trim() } })).id : list;
      await router.push(`/lists/${target}?import=csv`);
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void go()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!ready}>Continue</Button>}>
      <ListChoice label="Import into" lists={lists} list={list} name={name} onList={setList} onName={setName} />
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}
