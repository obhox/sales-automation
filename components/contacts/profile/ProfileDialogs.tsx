import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Alert, Button, Dialog, Field, Input, LoadingState, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { DialogForm } from "../ContactDialogs";
import {
  ACTIVITY_PATH, ACTIVITY_TYPES, BOOKING_PATH, LINKEDIN_MESSAGE_MAX, LINKEDIN_SEND_PATH, LINKEDIN_THREAD_PATH, MAILBOXES_PATH, TASKS_PATH, profilePath,
  type ContactProfile,
} from "./model";

type Contact = ContactProfile["contact"];
type Task = ContactProfile["tasks"][number];

// ── Details ───────────────────────────────────────────────────────────────────

const DETAIL_FIELDS = [
  ["full_name", "Full name"], ["first_name", "First name"], ["last_name", "Last name"], ["title", "Title"], ["company", "Company"], ["location", "Location"],
  ["email", "Email"], ["phone", "Phone"], ["time_zone", "Time zone"], ["headline", "Headline"],
] as const;
type DetailKey = (typeof DETAIL_FIELDS)[number][0];

/** Every hand-editable field of the contact in one form. Only what changed is sent. */
export function EditDetailsDialog({ contact, open, onClose, onSaved }: { contact: Contact; open: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("editDetails")} description={contact.full_name ?? undefined} size="md" padded={false}>
      {open ? <EditDetailsForm contact={contact} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function EditDetailsForm({ contact, onClose, onSaved }: { contact: Contact; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  const [form, setForm] = useState<Record<DetailKey, string>>(() => Object.fromEntries(DETAIL_FIELDS.map(([key]) => [key, contact[key] ?? ""])) as Record<DetailKey, string>);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailLabels: Record<DetailKey, string> = {full_name: t("fieldFullName"), first_name: t("fieldFirstName"), last_name: t("fieldLastName"), title: t("fieldTitle"), company: t("fieldCompany"), location: t("fieldLocation"), email: t("fieldEmail"), phone: t("fieldPhone"), time_zone: t("fieldTimeZone"), headline: t("fieldHeadline")};
  const changed = DETAIL_FIELDS.filter(([key]) => form[key].trim() !== (contact[key] ?? ""));

  async function save() {
    if (saving || changed.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await api(profilePath(contact.id), { method: "PATCH", body: Object.fromEntries(changed.map(([key]) => [key, form[key].trim()])) });
      toast.success(t("detailsSaved"));
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={changed.length === 0}>{t("save")}</Button>}>
      <div className="grid grid-cols-2 gap-3.5">
        {DETAIL_FIELDS.map(([key]) => (
          <Field
            key={key} label={detailLabels[key]} className={key === "full_name" || key === "headline" ? "col-span-2" : undefined}
            hint={key === "time_zone" ? t("zoneHint") : undefined}
          >
            {(id) => (
              <Input
                id={id} value={form[key]} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} autoComplete="off"
                type={key === "email" ? "email" : key === "phone" ? "tel" : "text"} data-autofocus={key === "full_name" || undefined}
              />
            )}
          </Field>
        ))}
      </div>
      <p className="text-11 leading-4 text-ink-3">{t("linkedInEditHint")}</p>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Log an activity ───────────────────────────────────────────────────────────

export interface ActivityDraft {
  id: string | null;
  type: string;
  body: string;
}

/** A call, an email, a meeting or a note that happened outside Linki, written down on the contact. */
export function ActivityDialog({ contactId, draft, onClose, onSaved }: { contactId: string; draft: ActivityDraft | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  return (
    <Dialog open={draft !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={draft?.id ? t("editActivity") : t("logActivity")} description={t("activityHint")} size="sm" padded={false}>
      {draft ? <ActivityForm contactId={contactId} draft={draft} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function ActivityForm({ contactId, draft, onClose, onSaved }: { contactId: string; draft: ActivityDraft; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  const typeLabels: Record<(typeof ACTIVITY_TYPES)[number]["value"], string> = {note: t("typeNote"), call: t("typeCall"), email: t("typeEmail"), meeting: t("typeMeeting"), other: t("typeOther")};
  const [type, setType] = useState(draft.type);
  const [body, setBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving || !body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (draft.id) await api(ACTIVITY_PATH, { method: "PATCH", query: { id: draft.id }, body: { type, body: body.trim() } });
      else await api(ACTIVITY_PATH, { method: "POST", body: { target_id: contactId, type, body: body.trim() } });
      toast.success(draft.id ? t("activitySaved") : t("activityLogged"));
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!body.trim()}>{draft.id ? t("save") : t("logActivity")}</Button>}>
      <Field label={t("activityType")}>{(id) => <Select id={id} value={type} onChange={setType} options={ACTIVITY_TYPES.map((option) => ({ ...option, label: typeLabels[option.value] }))} className="w-full" />}</Field>
      <Field label={t("activityDetails")}>{(id) => <Textarea id={id} data-autofocus value={body} onChange={(event) => setBody(event.target.value)} rows={5} placeholder={t("activityExample")} />}</Field>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function TaskDialog({ contactId, task, open, onClose, onSaved }: { contactId: string; task: Task | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={task ? t("editTask") : t("addTask")} size="sm" padded={false}>
      {open ? <TaskForm contactId={contactId} task={task} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function TaskForm({ contactId, task, onClose, onSaved }: { contactId: string; task: Task | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [due, setDue] = useState(task?.due_date?.slice(0, 10) ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "save" | "delete") {
    if (busy || (action === "save" && !title.trim())) return;
    setBusy(action);
    setError(null);
    try {
      if (action === "delete" && task) await api(`${TASKS_PATH}/${task.id}`, { method: "DELETE" });
      else if (task) await api(`${TASKS_PATH}/${task.id}`, { method: "PATCH", body: { title: title.trim(), description, due_date: due } });
      else await api(TASKS_PATH, { method: "POST", body: { target_id: contactId, title: title.trim(), description, due_date: due || undefined } });
      toast.success(action === "delete" ? t("taskDeleted") : task ? t("taskSaved") : t("taskAdded"));
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(null);
    }
  }

  return (
    <DialogForm
      onSubmit={() => void run("save")} onCancel={onClose}
      actions={
        <>
          {task ? <Button variant="danger" loading={busy === "delete"} onClick={() => void run("delete")}>{t("delete")}</Button> : null}
          <Button type="submit" variant="primary" loading={busy === "save"} disabled={!title.trim()}>{task ? t("save") : t("addTask")}</Button>
        </>
      }
    >
      <Field label={t("task")}>{(id) => <Input id={id} data-autofocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("taskExample")} autoComplete="off" />}</Field>
      <Field label={t("due")}>{(id) => <Input id={id} type="date" value={due} onChange={(event) => setDue(event.target.value)} />}</Field>
      <Field label={t("details")}>{(id) => <Textarea id={id} value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />}</Field>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── LinkedIn message ──────────────────────────────────────────────────────────

interface LinkedinThread {
  account: { id: string; name: string } | null;
  accounts: { id: string; name: string }[];
  can_reply: boolean;
  why_not: string | null;
}

/**
 * Write to the contact on LinkedIn. The message is queued: the loop that drives the
 * LinkedIn session sends it inside the account's working hours, and the timeline shows
 * what became of it.
 */
export function LinkedinMessageDialog({ contact, open, onClose, onSent }: { contact: Contact; open: boolean; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("linkedinMessage")} description={contact.full_name ? t("toContact", {name: contact.full_name}) : undefined} size="md" padded={false}>
      {open ? <LinkedinMessageForm contact={contact} onClose={onClose} onSent={onSent} /> : null}
    </Dialog>
  );
}

function LinkedinMessageForm({ contact, onClose, onSent }: { contact: Contact; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  const { data, error: loadError } = useApi<LinkedinThread>(LINKEDIN_THREAD_PATH, { target_id: contact.id });
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = chosen ?? data?.account?.id;
  const ready = Boolean(data?.can_reply && from && text.trim() && text.length <= LINKEDIN_MESSAGE_MAX);

  async function send() {
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    try {
      await api(LINKEDIN_SEND_PATH, { method: "POST", body: { target_id: contact.id, text: text.trim(), account_id: from } });
      toast.success(t("messageQueued"), { description: t("messageQueuedBody") });
      onSent();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSending(false);
    }
  }

  if (loadError && !data) return <DialogForm onCancel={onClose} cancelLabel={t("close")}><Alert tone="bad" title={errorMessage(loadError)} /></DialogForm>;
  if (!data) return <DialogForm onCancel={onClose}><LoadingState label={t("checkingLinkedin")} /></DialogForm>;
  if (!data.can_reply) return <DialogForm onCancel={onClose} cancelLabel={t("close")}><Alert tone="warn" title={data.why_not ?? t("noLinkedinReply")} /></DialogForm>;

  return (
    <DialogForm onSubmit={() => void send()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={sending} disabled={!ready}>{t("queueMessage")}</Button>}>
      {data.accounts.length > 1 || !data.account ? (
        <Field label={t("sendFrom")} hint={data.account ? undefined : t("selectAccountHint")}>
          {(id) => <Select id={id} value={from} onChange={setChosen} placeholder={t("chooseLinkedin")} options={data.accounts.map((account) => ({ value: account.id, label: account.name }))} className="w-full" />}
        </Field>
      ) : (
        <p className="text-11 text-ink-3">{t("sentFrom")} <span className="font-medium text-ink-2">{data.account.name}</span>.</p>
      )}
      <Field label={t("message")} aside={t("characterCount", {count: text.length, max: LINKEDIN_MESSAGE_MAX})} error={text.length > LINKEDIN_MESSAGE_MAX ? t("tooLong") : undefined}>
        {(id) => <Textarea id={id} data-autofocus value={text} onChange={(event) => setText(event.target.value)} rows={7} invalid={text.length > LINKEDIN_MESSAGE_MAX} />}
      </Field>
      {contact.linkedin_status !== "connected" ? <Alert tone="info" title={t("notConnected")}>{t("notConnectedBody")}</Alert> : null}
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Email ─────────────────────────────────────────────────────────────────────

interface Mailbox {
  id: string;
  name: string | null;
  from_email: string;
  is_verified: number;
  paused_at: string | null;
}

const AUTO = "auto";

/** One email to the contact from one of the workspace's mailboxes. Sent as written: no campaign wording is applied. */
export function EmailDialog({ contact, open, onClose, onSent }: { contact: Contact; open: boolean; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("email")} description={contact.email ? t("toContact", {name: contact.email}) : undefined} size="md" padded={false}>
      {open ? <EmailForm contact={contact} onClose={onClose} onSent={onSent} /> : null}
    </Dialog>
  );
}

function EmailForm({ contact, onClose, onSent }: { contact: Contact; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  const { data: mailboxes, error: loadError } = useApi<Mailbox[]>(MAILBOXES_PATH);
  const [mailbox, setMailbox] = useState(AUTO);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usable = (mailboxes ?? []).filter((box) => box.is_verified && !box.paused_at);

  async function send() {
    if (sending || !body.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api(`${profilePath(contact.id)}/emails`, { method: "POST", body: { subject: subject.trim() || undefined, body, email_account_id: mailbox === AUTO ? undefined : mailbox } });
      toast.success(t("emailSent", {email: contact.email ?? ""}));
      onSent();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSending(false);
    }
  }

  if (loadError && !mailboxes) return <DialogForm onCancel={onClose} cancelLabel={t("close")}><Alert tone="bad" title={errorMessage(loadError)} /></DialogForm>;
  if (!mailboxes) return <DialogForm onCancel={onClose}><LoadingState label={t("loadingMailboxes")} /></DialogForm>;
  if (usable.length === 0) return <DialogForm onCancel={onClose} cancelLabel={t("close")}><Alert tone="warn" title={t("noMailboxes")}>{t("noMailboxesBody")}</Alert></DialogForm>;

  return (
    <DialogForm onSubmit={() => void send()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={sending} disabled={!body.trim()}>{t("sendEmail")}</Button>}>
      <Field label={t("from")} hint={mailbox === AUTO ? t("autoHint") : undefined}>
        {(id) => (
          <Select
            id={id} value={mailbox} onChange={setMailbox} className="w-full"
            options={[{ value: AUTO, label: usable.length === 1 ? usable[0].from_email : t("autoMailbox") }, ...(usable.length > 1 ? usable.map((box) => ({ value: box.id, label: box.from_email, hint: box.name ?? undefined })) : [])]}
          />
        )}
      </Field>
      <Field label={t("subject")} hint={t("subjectHint")}>
        {(id) => <Input id={id} data-autofocus value={subject} onChange={(event) => setSubject(event.target.value)} autoComplete="off" />}
      </Field>
      <Field label={t("message")}>{(id) => <Textarea id={id} value={body} onChange={(event) => setBody(event.target.value)} rows={8} />}</Field>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Booking link ──────────────────────────────────────────────────────────────

/** The workspace's booking page, set once by an admin and opened by "Book meeting" on every contact. */
export function BookingLinkDialog({ open, url, onClose, onSaved }: { open: boolean; url: string | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("bookingLink")} description={t("bookingHint")} size="sm" padded={false}>
      {open ? <BookingLinkForm url={url} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function BookingLinkForm({ url, onClose, onSaved }: { url: string | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("ContactProfileDialogs");
  const [value, setValue] = useState(url ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await api(BOOKING_PATH, { method: "PUT", body: { url: value.trim() } });
      toast.success(value.trim() ? t("bookingSaved") : t("bookingRemoved"));
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={value.trim() === (url ?? "")}>{t("save")}</Button>}>
      <Field label={t("address")} hint={t("addressHint")}>
        {(id) => <Input id={id} data-autofocus type="url" value={value} onChange={(event) => setValue(event.target.value)} placeholder="https://cal.com/your-team/intro" autoComplete="off" spellCheck={false} />}
      </Field>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}
