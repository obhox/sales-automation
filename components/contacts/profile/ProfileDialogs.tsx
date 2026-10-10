import { useState } from "react";
import { toast } from "sonner";
import { Alert, Button, Dialog, Field, Input, LoadingState, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
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
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Edit details" description={contact.full_name ?? undefined} size="md" padded={false}>
      {open ? <EditDetailsForm contact={contact} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function EditDetailsForm({ contact, onClose, onSaved }: { contact: Contact; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Record<DetailKey, string>>(() => Object.fromEntries(DETAIL_FIELDS.map(([key]) => [key, contact[key] ?? ""])) as Record<DetailKey, string>);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = DETAIL_FIELDS.filter(([key]) => form[key].trim() !== (contact[key] ?? ""));

  async function save() {
    if (saving || changed.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await api(profilePath(contact.id), { method: "PATCH", body: Object.fromEntries(changed.map(([key]) => [key, form[key].trim()])) });
      toast.success("Details saved");
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={changed.length === 0}>Save</Button>}>
      <div className="grid grid-cols-2 gap-3.5">
        {DETAIL_FIELDS.map(([key, label]) => (
          <Field
            key={key} label={label} className={key === "full_name" || key === "headline" ? "col-span-2" : undefined}
            hint={key === "time_zone" ? "A zone name such as Europe/Berlin. Emails can be timed to it." : undefined}
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
      <p className="text-11 leading-4 text-ink-3">The LinkedIn address is not edited here: what the automation knows about the profile is tied to it.</p>
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
  return (
    <Dialog open={draft !== null} onOpenChange={(next) => { if (!next) onClose(); }} title={draft?.id ? "Edit activity" : "Log activity"} description="It joins the contact's timeline under your name" size="sm" padded={false}>
      {draft ? <ActivityForm contactId={contactId} draft={draft} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function ActivityForm({ contactId, draft, onClose, onSaved }: { contactId: string; draft: ActivityDraft; onClose: () => void; onSaved: () => void }) {
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
      toast.success(draft.id ? "Activity saved" : "Activity logged");
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={!body.trim()}>{draft.id ? "Save" : "Log activity"}</Button>}>
      <Field label="What it was">{(id) => <Select id={id} value={type} onChange={setType} options={ACTIVITY_TYPES.map((option) => ({ ...option }))} className="w-full" />}</Field>
      <Field label="What happened">{(id) => <Textarea id={id} data-autofocus value={body} onChange={(event) => setBody(event.target.value)} rows={5} placeholder="Spoke for ten minutes. Budget is set in November." />}</Field>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function TaskDialog({ contactId, task, open, onClose, onSaved }: { contactId: string; task: Task | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={task ? "Edit task" : "Add task"} size="sm" padded={false}>
      {open ? <TaskForm contactId={contactId} task={task} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function TaskForm({ contactId, task, onClose, onSaved }: { contactId: string; task: Task | null; onClose: () => void; onSaved: () => void }) {
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
      toast.success(action === "delete" ? "Task deleted" : task ? "Task saved" : "Task added");
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
          {task ? <Button variant="danger" loading={busy === "delete"} onClick={() => void run("delete")}>Delete</Button> : null}
          <Button type="submit" variant="primary" loading={busy === "save"} disabled={!title.trim()}>{task ? "Save" : "Add task"}</Button>
        </>
      }
    >
      <Field label="Task">{(id) => <Input id={id} data-autofocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Send pricing for nine seats" autoComplete="off" />}</Field>
      <Field label="Due">{(id) => <Input id={id} type="date" value={due} onChange={(event) => setDue(event.target.value)} />}</Field>
      <Field label="Details">{(id) => <Textarea id={id} value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />}</Field>
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
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="LinkedIn message" description={contact.full_name ? `To ${contact.full_name}` : undefined} size="md" padded={false}>
      {open ? <LinkedinMessageForm contact={contact} onClose={onClose} onSent={onSent} /> : null}
    </Dialog>
  );
}

function LinkedinMessageForm({ contact, onClose, onSent }: { contact: Contact; onClose: () => void; onSent: () => void }) {
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
      toast.success("Message queued", { description: "It is sent from the LinkedIn account inside its working hours. The timeline shows when it has gone." });
      onSent();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSending(false);
    }
  }

  if (loadError && !data) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="bad" title={errorMessage(loadError)} /></DialogForm>;
  if (!data) return <DialogForm onCancel={onClose}><LoadingState label="Checking the LinkedIn accounts" /></DialogForm>;
  if (!data.can_reply) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="warn" title={data.why_not ?? "This contact cannot be messaged on LinkedIn"} /></DialogForm>;

  return (
    <DialogForm onSubmit={() => void send()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={sending} disabled={!ready}>Queue message</Button>}>
      {data.accounts.length > 1 || !data.account ? (
        <Field label="Send from" hint={data.account ? undefined : "This contact has not been worked from any one account, so say which should write."}>
          {(id) => <Select id={id} value={from} onChange={setChosen} placeholder="Choose a LinkedIn account" options={data.accounts.map((account) => ({ value: account.id, label: account.name }))} className="w-full" />}
        </Field>
      ) : (
        <p className="text-11 text-ink-3">Sent from <span className="font-medium text-ink-2">{data.account.name}</span>.</p>
      )}
      <Field label="Message" aside={`${formatCount(text.length)} of ${formatCount(LINKEDIN_MESSAGE_MAX)}`} error={text.length > LINKEDIN_MESSAGE_MAX ? "This is longer than LinkedIn takes" : undefined}>
        {(id) => <Textarea id={id} data-autofocus value={text} onChange={(event) => setText(event.target.value)} rows={7} invalid={text.length > LINKEDIN_MESSAGE_MAX} />}
      </Field>
      {contact.linkedin_status !== "connected" ? <Alert tone="info" title="Not a connection yet">LinkedIn only delivers a message to a connection. If this contact has not accepted an invitation, the message will fail and say so on the timeline.</Alert> : null}
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
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Email" description={contact.email ? `To ${contact.email}` : undefined} size="md" padded={false}>
      {open ? <EmailForm contact={contact} onClose={onClose} onSent={onSent} /> : null}
    </Dialog>
  );
}

function EmailForm({ contact, onClose, onSent }: { contact: Contact; onClose: () => void; onSent: () => void }) {
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
      toast.success(`Email sent to ${contact.email}`);
      onSent();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSending(false);
    }
  }

  if (loadError && !mailboxes) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="bad" title={errorMessage(loadError)} /></DialogForm>;
  if (!mailboxes) return <DialogForm onCancel={onClose}><LoadingState label="Loading mailboxes" /></DialogForm>;
  if (usable.length === 0) return <DialogForm onCancel={onClose} cancelLabel="Close"><Alert tone="warn" title="No mailbox can send right now">Connect a mailbox, or resume one that is paused, under Mailboxes.</Alert></DialogForm>;

  return (
    <DialogForm onSubmit={() => void send()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={sending} disabled={!body.trim()}>Send email</Button>}>
      <Field label="From" hint={mailbox === AUTO ? "The mailbox that last wrote to this contact in a campaign, when there is one." : undefined}>
        {(id) => (
          <Select
            id={id} value={mailbox} onChange={setMailbox} className="w-full"
            options={[{ value: AUTO, label: usable.length === 1 ? usable[0].from_email : "The mailbox this contact knows" }, ...(usable.length > 1 ? usable.map((box) => ({ value: box.id, label: box.from_email, hint: box.name ?? undefined })) : [])]}
          />
        )}
      </Field>
      <Field label="Subject" hint="Left empty, the email goes as a reply in the thread this contact last wrote in.">
        {(id) => <Input id={id} data-autofocus value={subject} onChange={(event) => setSubject(event.target.value)} autoComplete="off" />}
      </Field>
      <Field label="Message">{(id) => <Textarea id={id} value={body} onChange={(event) => setBody(event.target.value)} rows={8} />}</Field>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}

// ── Booking link ──────────────────────────────────────────────────────────────

/** The workspace's booking page, set once by an admin and opened by "Book meeting" on every contact. */
export function BookingLinkDialog({ open, url, onClose, onSaved }: { open: boolean; url: string | null; onClose: () => void; onSaved: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Booking link" description="The page where a contact picks a meeting time" size="sm" padded={false}>
      {open ? <BookingLinkForm url={url} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function BookingLinkForm({ url, onClose, onSaved }: { url: string | null; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(url ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await api(BOOKING_PATH, { method: "PUT", body: { url: value.trim() } });
      toast.success(value.trim() ? "Booking link saved" : "Booking link removed");
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <DialogForm onSubmit={() => void save()} onCancel={onClose} actions={<Button type="submit" variant="primary" loading={saving} disabled={value.trim() === (url ?? "")}>Save</Button>}>
      <Field label="Address" hint="Your Calendly, Cal.com or similar page. It is the same for the whole workspace. Leave it empty to remove the link.">
        {(id) => <Input id={id} data-autofocus type="url" value={value} onChange={(event) => setValue(event.target.value)} placeholder="https://cal.com/your-team/intro" autoComplete="off" spellCheck={false} />}
      </Field>
      {error ? <Alert tone="bad" title={error} /> : null}
    </DialogForm>
  );
}
