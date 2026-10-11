import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Card, Checkbox, Eyebrow, Input, Pill, Select, Textarea, TextAction } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { formatCount, plural } from "@/lib/client/format";
import { recordHref } from "@/lib/client/nav";
import { CUSTOM_FIELDS_PATH, FIELD_TYPE_LABEL } from "../model";
import {
  campaignPill, campaignSummary, careerDates, customValueText, dueBadge, emailCheckedLine, employeesText, linkedinHandle, notesByLine, notesSavedLine, profilePath, stepDate, stepLabel, stepLine,
  type CampaignHistory, type ContactProfile,
} from "./model";

type Contact = ContactProfile["contact"];

/** A card of the profile's side columns: a title, an optional action in the brand colour, then the content. */
export function SideCard({ title, action, onAction, actionHref, className, children }: { title: string; action?: string | null; onAction?: () => void; actionHref?: string; className?: string; children: ReactNode }) {
  return (
    <Card className={cn("flex flex-col gap-2.5 p-3.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-13 font-semibold tracking-snug text-ink">{title}</h2>
        {action && actionHref ? <Link href={actionHref} className="text-11 font-semibold text-brand-strong hover:underline">{action}</Link> : action && onAction ? <TextAction onClick={onAction}>{action}</TextAction> : null}
      </div>
      {children}
    </Card>
  );
}

/** A sentence standing in for content a card does not have. */
const Quiet = ({ children }: { children: ReactNode }) => <p className="text-11 leading-4 text-ink-3">{children}</p>;

function FieldBox({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        {aside}
      </div>
      <div className="flex h-[30px] items-center justify-between gap-[7px] rounded-md border border-line bg-subtle px-[9px] text-115 font-medium text-ink">{children}</div>
    </div>
  );
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("It could not be copied. Select it and copy it by hand.");
  }
}

const CopyButton = ({ text, what }: { text: string; what: string }) => (
  <button type="button" onClick={() => void copy(text, what)} aria-label={`Copy ${what.toLowerCase()}`} className="shrink-0 rounded-sm text-ink-3 hover:text-ink">
    <Copy size={12} aria-hidden="true" />
  </button>
);

// ── Details ───────────────────────────────────────────────────────────────────

export function DetailsCard({ contact, canEdit, onEdit, onSaved }: { contact: Contact; canEdit: boolean; onEdit: () => void; onSaved: () => Promise<unknown> }) {
  const checked = emailCheckedLine(contact);
  return (
    <SideCard title="Details" action={canEdit ? "Edit all" : null} onAction={onEdit}>
      <FieldBox label="Email" aside={checked ? <Pill size="sm" tone={checked.tone}>{checked.label}</Pill> : null}>
        {contact.email ? (
          <>
            <a href={`mailto:${contact.email}`} className="truncate hover:text-brand-strong">{contact.email}</a>
            <CopyButton text={contact.email} what="Email address" />
          </>
        ) : <span className="font-normal text-ink-3">No email address</span>}
      </FieldBox>
      <FieldBox label="Phone">
        {contact.phone ? (
          <>
            <a href={`tel:${contact.phone.replace(/[^+\d]/g, "")}`} className="truncate tabular-nums hover:text-brand-strong">{contact.phone}</a>
            <CopyButton text={contact.phone} what="Phone number" />
          </>
        ) : <span className="font-normal text-ink-3">No phone number</span>}
      </FieldBox>
      <FieldBox label="LinkedIn">
        {contact.linkedin_url ? (
          <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 flex-1 items-center justify-between gap-2 hover:text-brand-strong">
            <span className="truncate">{linkedinHandle(contact.linkedin_url)}</span>
            <ExternalLink size={12} className="shrink-0 text-ink-3" aria-label="Opens LinkedIn in a new tab" />
          </a>
        ) : <span className="font-normal text-ink-3">No LinkedIn profile</span>}
      </FieldBox>
      <NotesField key={contact.id} contact={contact} canEdit={canEdit} onSaved={onSaved} />
    </SideCard>
  );
}

/** Notes save themselves a moment after the typing stops, and when the box is left. */
function NotesField({ contact, canEdit, onSaved }: { contact: Contact; canEdit: boolean; onSaved: () => Promise<unknown> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const stored = contact.notes ?? "";
  const dirty = draft !== null && draft.trim() !== stored;

  async function save(text: string) {
    setState("saving");
    try {
      await api(profilePath(contact.id), { method: "PATCH", body: { notes: text } });
      await onSaved();
      setState("idle");
      // Typed further while it saved: keep what is in the box, and it saves again.
      setDraft((current) => (current === text ? null : current));
    } catch (cause) {
      setState("failed");
      toast.error(`The notes were not saved. ${errorMessage(cause)}`);
    }
  }

  useEffect(() => {
    if (!dirty || draft === null) return;
    const timer = setTimeout(() => void save(draft), 900);
    return () => clearTimeout(timer);
    // `save` is rebuilt each render and reads only what is passed to it.
  }, [draft, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const by = notesByLine(contact.notes_updated_by, contact.notes_updated_at);
  const id = `notes-${contact.id}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-10 font-semibold uppercase tracking-label text-ink-3">Notes</label>
        <span className={cn("text-10", state === "failed" ? "text-bad" : "text-ink-3")} aria-live="polite">{notesSavedLine(state === "idle" && dirty ? "typing" : state, contact.notes_updated_at)}</span>
      </div>
      {canEdit ? (
        <Textarea
          id={id} tone="sunken" rows={4} value={draft ?? stored} placeholder="What is worth remembering about this contact"
          onChange={(event) => { setDraft(event.target.value); if (state === "failed") setState("idle"); }}
          onBlur={() => { if (dirty && draft !== null && state !== "saving") void save(draft); }}
          className="border-line text-11 leading-[15px]"
        />
      ) : (
        <p id={id} className="min-h-[52px] whitespace-pre-wrap rounded-md border border-line bg-subtle p-[9px] text-11 leading-[15px] text-ink">{stored || <span className="text-ink-3">No notes</span>}</p>
      )}
      {by && stored ? <span className="text-10 text-ink-3">{by}</span> : null}
    </div>
  );
}

// ── Company and career ────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[18px] items-center justify-between gap-3">
      <span className="shrink-0 text-11 text-ink-3">{label}</span>
      <span className="min-w-0 truncate text-right text-11 font-medium text-ink-2">{children}</span>
    </div>
  );
}

export function CompanyCard({ profile }: { profile: ContactProfile }) {
  const { company, contact } = profile;
  if (!company) {
    return (
      <SideCard title="Company">
        {contact.company
          ? <><p className="text-13 font-semibold tracking-snug text-ink">{contact.company}</p><Quiet>Linki has no company record for it yet. One is made when the contact is enriched.</Quiet></>
          : <Quiet>This contact has no company.</Quiet>}
      </SideCard>
    );
  }
  return (
    <SideCard title="Company" action="View" actionHref={recordHref("company", company.id)}>
      <div className="flex items-center gap-2.5">
        <Avatar name={company.name} size={34} square tint="bg-control" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-13 font-semibold tracking-snug text-ink">{company.name}</span>
          {company.domain ? <span className="truncate text-11 text-ink-3">{company.domain}</span> : null}
        </div>
      </div>
      <Row label="Industry">{company.industry ?? "—"}</Row>
      <Row label="Employees">{employeesText(company.employee_count)}</Row>
      <Row label="HQ">{company.location ?? "—"}</Row>
      {company.other_count > 0 ? (
        <Link href={recordHref("company", company.id)} className="flex items-center justify-between gap-2 rounded-md bg-subtle px-[9px] py-[7px] hover:bg-control">
          <span className="flex items-center gap-[7px]">
            <span className="flex gap-[3px]">{company.others.map((other) => <Avatar key={other.id} name={other.full_name} size={18} />)}</span>
            <span className="text-11 font-medium text-ink-2">{formatCount(company.other_count)} other {plural(company.other_count, "contact", "contacts")}</span>
          </span>
          <ChevronRight size={13} className="text-ink-3" aria-hidden="true" />
        </Link>
      ) : null}
    </SideCard>
  );
}

export function CareerCard({ contact }: { contact: Contact }) {
  return (
    <SideCard title="Career history">
      {contact.positions.length === 0 ? <Quiet>{contact.sales_nav_url ? "Nothing read yet. Refresh the profile from LinkedIn to read it." : "Not known. It is read from the contact's Sales Navigator profile, or from Apollo."}</Quiet> : (
        <ol className="flex flex-col">
          {contact.positions.map((position, index) => (
            <li key={`${position.title}-${position.company}-${index}`} className="flex gap-[9px]">
              <div className="flex w-3.5 shrink-0 flex-col items-center gap-[3px] pt-1">
                <span className={cn("size-2 shrink-0 rounded-full ring-[2.5px]", index === 0 && position.current ? "bg-brand ring-brand-tint" : "bg-line-strong ring-surface")} aria-hidden="true" />
                {index < contact.positions.length - 1 ? <span className="w-[1.5px] flex-1 bg-line" aria-hidden="true" /> : null}
              </div>
              <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", index < contact.positions.length - 1 && "pb-2.5")}>
                <span className="text-115 font-semibold leading-[15px] text-ink">{position.title || "Role not known"}</span>
                {position.company ? <span className="text-11 leading-[14px] text-ink-2">{position.company}</span> : null}
                {careerDates(position) ? <span className="text-105 leading-[14px] text-ink-3">{careerDates(position)}</span> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </SideCard>
  );
}

// ── Campaign history ──────────────────────────────────────────────────────────

const STEP_DOT: Record<string, string> = { sent: "bg-good", next: "bg-brand", upcoming: "bg-line-strong", skipped: "bg-line-strong", stopped: "bg-line-strong", failed: "bg-bad" };

function CampaignBlock({ campaign, startOpen }: { campaign: CampaignHistory; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const pill = campaignPill(campaign);
  return (
    <div className="flex flex-col gap-[7px] rounded-lg border border-line bg-subtle p-2.5">
      <div className="flex items-center justify-between gap-[7px]">
        <Link href={recordHref("campaign", campaign.workflow_id)} className="min-w-0 truncate text-115 font-semibold text-ink hover:text-brand-strong">{campaign.name}</Link>
        <Pill size="sm" tone={pill.tone}>{pill.label}</Pill>
      </div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center justify-between gap-2 text-left text-105 text-ink-3 hover:text-ink">
        <span>{campaignSummary(campaign)}</span>
        <ChevronDown size={12} className={cn("shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <ol className="flex flex-col gap-[7px]">
          {campaign.steps.map((step) => (
            <li key={step.id} className="flex items-start gap-[7px]">
              <span className={cn("mt-[5px] size-1.5 shrink-0 rounded-full", STEP_DOT[step.status])} aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className={cn("truncate text-11 leading-[14px]", step.status === "sent" || step.status === "next" ? "font-medium text-ink" : "text-ink-3")} title={stepLabel(step)}>{stepLabel(step)}</span>
                <span className={cn("text-10 leading-[13px]", step.status === "failed" ? "text-bad" : "text-ink-3")}>{stepLine(step)}</span>
              </div>
              <span className="shrink-0 text-10 text-ink-3">{stepDate(step)}</span>
            </li>
          ))}
          {campaign.steps.length === 0 ? <li className="text-105 text-ink-3">This campaign has no steps.</li> : null}
        </ol>
      ) : null}
    </div>
  );
}

export function CampaignHistoryCard({ campaigns }: { campaigns: CampaignHistory[] }) {
  return (
    <SideCard title="Campaign history">
      {campaigns.length === 0 ? <Quiet>Not in any campaign yet.</Quiet> : campaigns.map((campaign, index) => <CampaignBlock key={campaign.run_id} campaign={campaign} startOpen={index === 0} />)}
    </SideCard>
  );
}

// ── Lists ─────────────────────────────────────────────────────────────────────

export function ListsCard({ lists, canEdit, onAdd, onRemove }: { lists: ContactProfile["lists"]; canEdit: boolean; onAdd: () => void; onRemove: (list: { id: string; name: string }) => void }) {
  return (
    <SideCard title="List membership">
      <div className="flex flex-wrap gap-1.5">
        {lists.map((list) => (
          <span key={list.id} className="inline-flex h-6 max-w-full items-center gap-[5px] rounded-md border border-line bg-subtle pl-2 pr-1 text-105 font-medium text-ink-2">
            <Link href={recordHref("list", list.id)} className="truncate hover:text-brand-strong">{list.name}</Link>
            {canEdit ? (
              <button type="button" onClick={() => onRemove(list)} aria-label={`Remove from ${list.name}`} className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-control hover:text-ink">
                <X size={10} aria-hidden="true" />
              </button>
            ) : <span className="w-1" />}
          </span>
        ))}
        {canEdit ? (
          <button type="button" onClick={onAdd} className="inline-flex h-6 items-center gap-[5px] rounded-md border border-line-strong bg-surface px-2 text-105 font-medium text-ink-3 hover:bg-subtle hover:text-ink">
            <Plus size={11} aria-hidden="true" />
            Add to list
          </button>
        ) : lists.length === 0 ? <Quiet>In no list.</Quiet> : null}
      </div>
    </SideCard>
  );
}

// ── Custom fields ─────────────────────────────────────────────────────────────

type CustomValue = string | number | boolean | null;
const UNSET = "unset";

function CustomFieldEditor({ contactId, field, value, onSaved }: { contactId: string; field: ContactProfile["custom"]["fields"][number]; value: CustomValue | undefined; onSaved: () => Promise<unknown> }) {
  const stored = value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);

  async function save(next: CustomValue) {
    setSaving(true);
    try {
      await api(CUSTOM_FIELDS_PATH, { method: "PUT", body: { target_id: contactId, field_id: field.id, value: next } });
      await onSaved();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  if (field.field_type === "boolean") {
    return (
      <Select
        size="sm" tone="sunken" label={field.name} disabled={saving} className="w-[120px]"
        value={value === true ? "yes" : value === false ? "no" : UNSET} onChange={(next) => void save(next === UNSET ? null : next === "yes")}
        options={[{ value: UNSET, label: "Not set" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
      />
    );
  }
  const commit = () => { if (draft.trim() !== stored) void save(draft.trim() === "" ? null : field.field_type === "number" ? Number(draft) : draft.trim()); };
  return (
    <Input
      tone="sunken" aria-label={field.name} disabled={saving} frameClassName="h-7 w-[150px]" className="text-11"
      type={field.field_type === "number" ? "number" : field.field_type === "date" ? "date" : "text"}
      value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } if (event.key === "Escape") setDraft(stored); }}
      trailing={saving ? null : draft.trim() !== stored ? <Check size={11} className="shrink-0 text-ink-3" aria-hidden="true" /> : null}
    />
  );
}

export function CustomFieldsCard({ profile, canEdit, onManage, onSaved }: { profile: ContactProfile; canEdit: boolean; onManage: () => void; onSaved: () => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const { fields, values } = profile.custom;
  return (
    <SideCard title="Custom fields" action={fields.length === 0 ? "Manage" : canEdit ? (editing ? "Done" : "Edit") : null} onAction={fields.length === 0 ? onManage : () => setEditing(!editing)}>
      {fields.length === 0 ? <Quiet>This workspace has no custom fields yet.</Quiet> : fields.map((field) => (
        <div key={field.id} className="flex min-h-[18px] items-center justify-between gap-3">
          <span className="min-w-0 truncate text-11 text-ink-3" title={`${FIELD_TYPE_LABEL[field.field_type] ?? field.field_type} · {{${field.key}}}`}>{field.name}</span>
          {editing
            ? <CustomFieldEditor key={`${field.id}:${String(values[field.id] ?? "")}`} contactId={profile.contact.id} field={field} value={values[field.id]} onSaved={onSaved} />
            : <span className="min-w-0 truncate text-right text-11 font-medium text-ink-2">{customValueText(field.field_type, values[field.id])}</span>}
        </div>
      ))}
      {editing ? <TextAction className="self-start" onClick={onManage}>Manage fields</TextAction> : null}
    </SideCard>
  );
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

type Task = ContactProfile["tasks"][number];

export function TasksCard({ tasks, canEdit, onAdd, onOpen, onToggle }: { tasks: Task[]; canEdit: boolean; onAdd: () => void; onOpen: (task: Task) => void; onToggle: (task: Task) => void }) {
  const [showDone, setShowDone] = useState(false);
  const open = tasks.filter((task) => task.status === "open");
  const done = tasks.filter((task) => task.status === "done");
  const row = (task: Task) => {
    const due = task.status === "open" ? dueBadge(task.due_date) : null;
    return (
      <li key={task.id} className="flex items-start gap-2">
        <Checkbox checked={task.status === "done"} onChange={() => onToggle(task)} disabled={!canEdit} label={task.status === "done" ? `Reopen: ${task.title}` : `Mark done: ${task.title}`} className="mt-px size-3.5" />
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          {canEdit
            ? <button type="button" onClick={() => onOpen(task)} className={cn("truncate text-left text-115 font-medium leading-[14px] hover:text-brand-strong", task.status === "done" ? "text-ink-3 line-through" : "text-ink")}>{task.title}</button>
            : <span className={cn("truncate text-115 font-medium leading-[14px]", task.status === "done" ? "text-ink-3 line-through" : "text-ink")}>{task.title}</span>}
          {due ? <span><Pill size="sm" tone={due.tone} className="h-4">{due.label}</Pill></span> : null}
        </div>
      </li>
    );
  };
  return (
    <SideCard title="Open tasks" action={canEdit ? "Add task" : null} onAction={onAdd}>
      {open.length === 0 ? <Quiet>Nothing to do for this contact.</Quiet> : <ul className="flex flex-col gap-[9px]">{open.map(row)}</ul>}
      {done.length > 0 ? (
        <>
          <button type="button" onClick={() => setShowDone(!showDone)} aria-expanded={showDone} className="flex items-center gap-1 self-start text-105 font-medium text-ink-3 hover:text-ink">
            <ChevronDown size={11} className={cn("transition-transform", showDone && "rotate-180")} aria-hidden="true" />
            {done.length} done
          </button>
          {showDone ? <ul className="flex flex-col gap-[9px]">{done.map(row)}</ul> : null}
        </>
      ) : null}
    </SideCard>
  );
}
