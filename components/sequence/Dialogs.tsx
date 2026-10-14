import { useEffect, useState } from "react";
import { Eye, Mail, MessageSquare, RefreshCw, Send, SendHorizontal, Sparkles, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button, Dialog, ErrorState, Field, Input, LoadingState, SearchInput, Select, type Icon } from "@/components/ui";
import { formatRequestCost } from "@/components/ai/model";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import { useDebounced } from "@/lib/client/table-state";
import type { StepPreview } from "@/lib/outreach/preview";
import { SpamNote } from "./SpamCheck";
import { STEP_KIND_LABEL, TRACK_LABEL, letter, versionsOf, type BuilderData, type Row, type StepInput, type Track } from "./model";

const STEP_ICON: Record<string, Icon> = { visit: Eye, connect: UserPlus, message: MessageSquare, sales_inmail: Send, email: Mail };

interface Contact { id: string; name: string; detail: string | null }
interface SearchAnswer { results: Array<{ kind: string; id: string; title: string; subtitle: string | null }> }
interface PreviewAnswer {
  contact: { id: string; name: string; title: string | null; company: string | null; email: string | null };
  senders: { linkedin: { id: string; name: string } | null; email: { id: string; name: string; email: string } | null };
  steps: StepPreview[];
}

/** One sample written by AI for one contact, as `/ai-sample` answers. */
interface WrittenSample {
  sample: StepPreview;
  model: string;
  used_fallback: boolean;
  without_previous: boolean;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}
/** A sample of one step: being written, failed, or done. */
type SampleState = { status: "writing" } | { status: "failed"; error: string } | { status: "done"; written: WrittenSample };

const writeSample = (workflowId: string, body: Record<string, unknown>) => api<WrittenSample>(`/api/workflows/${workflowId}/ai-sample`, { method: "POST", body });

const fromSample = (sample: BuilderData["sample_contacts"][number]): Contact => ({ id: sample.id, name: sample.name || "Unnamed contact", detail: [sample.title, sample.company].filter(Boolean).join(" · ") || null });

/** Choose whose eyes to read the sequence through: one of the campaign's own contacts, or anyone found by name. */
function ContactPicker({ samples, value, onChange }: { samples: Contact[]; value: Contact | null; onChange: (contact: Contact) => void }) {
  const [search, setSearch] = useState("");
  const settled = useDebounced(search.trim());
  const { data } = useApi<SearchAnswer>(settled.length >= 2 ? "/api/search" : null, { q: settled });
  const found = (data?.results ?? []).filter((result) => result.kind === "contact").map((result): Contact => ({ id: result.id, name: result.title, detail: result.subtitle }));
  const options = value && !samples.some((sample) => sample.id === value.id) ? [value, ...samples] : samples;

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Select
          className="w-full" label="Contact to preview as" placeholder="Choose a contact" value={value?.id}
          onChange={(id) => { const next = options.find((option) => option.id === id); if (next) onChange(next); }}
          options={options.map((option) => ({ value: option.id, label: option.name, hint: option.detail ?? undefined }))}
        />
        <SearchInput value={search} onChange={setSearch} placeholder="Or find someone by name" />
      </div>
      {settled.length >= 2 ? (
        <div className="flex flex-wrap gap-1.5">
          {found.length === 0 ? <span className="text-11 text-ink-3">{data ? "Nobody by that name." : "Searching…"}</span> : found.map((contact) => (
            <button key={contact.id} type="button" onClick={() => { onChange(contact); setSearch(""); }} className="inline-flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface px-2 text-11 font-medium text-ink outline-none hover:bg-subtle focus-visible:border-brand">
              {contact.name}{contact.detail ? <span className="text-ink-3">· {contact.detail}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The whole sequence as one contact would receive it, read from what is in the editor right now. */
export function PreviewDialog({ open, onClose, workflowId, data, steps }: { open: boolean; onClose: () => void; workflowId: string; data: BuilderData; steps: StepInput[] }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Preview as prospect" description="What one contact would receive, step by step. Nothing is sent." icon={Eye} size="lg" height={720}>
      {open ? <PreviewBody workflowId={workflowId} data={data} steps={steps} /> : null}
    </Dialog>
  );
}

function PreviewBody({ workflowId, data, steps }: { workflowId: string; data: BuilderData; steps: StepInput[] }) {
  const samples = data.sample_contacts.map(fromSample);
  const [contact, setContact] = useState<Contact | null>(samples[0] ?? null);
  const [mailbox, setMailbox] = useState<string>("auto");
  const [account, setAccount] = useState<string>("auto");
  /** The last answer or failure, with the request it belongs to. */
  const [result, setResult] = useState<{ key: string; answer?: PreviewAnswer; error?: string } | null>(null);
  const [round, setRound] = useState(0);
  /** Samples written in this dialog, by step. They belong to one contact, so a new contact starts clean. */
  const [drafted, setSamples] = useState<{ contact: string | null; byRef: Record<string, SampleState> }>({ contact: contact?.id ?? null, byRef: {} });
  const written = drafted.contact === (contact?.id ?? null) ? drafted.byRef : {};
  const key = contact ? `${contact.id}|${mailbox}|${account}|${round}` : null;

  useEffect(() => {
    if (!contact || !key) return;
    const controller = new AbortController();
    api<PreviewAnswer>(`/api/workflows/${workflowId}/preview`, {
      method: "POST", signal: controller.signal,
      body: { target_id: contact.id, steps, email_account_id: mailbox === "auto" ? undefined : mailbox, account_id: account === "auto" ? undefined : account },
    })
      .then((answer) => setResult({ key, answer }))
      .catch((cause) => { if (!(cause instanceof DOMException)) setResult({ key, error: errorMessage(cause) }); });
    return () => controller.abort();
    // `steps` is what the editor held when the dialog opened; it cannot change while the dialog is up.
  }, [key, workflowId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Write one AI step's sample. A follow-up is given the email before it, as shown in this dialog, when there is one. */
  async function write(step: StepPreview) {
    if (!contact || step.ref === null) return;
    const ref = step.ref;
    const source = steps.find((candidate) => (candidate.id ?? candidate.key) === ref);
    if (!source) return;
    const shownBefore = (answer?.steps ?? []).filter((other) => other.track === "email" && other.step_type === "email");
    const earlier = shownBefore.slice(0, shownBefore.findIndex((other) => other.ref === ref)).reverse()
      .map((other) => { const done = written[other.ref ?? ""]; return done?.status === "done" ? done.written.sample : other.content === "text" ? other : null; })
      .find((other): other is StepPreview => other !== null && Boolean(other.body));
    const owner = contact.id;
    const patch = (state: SampleState) => setSamples((current) => ({ contact: owner, byRef: { ...(current.contact === owner ? current.byRef : {}), [ref]: state } }));
    patch({ status: "writing" });
    try {
      const result = await writeSample(workflowId, {
        step: source, target_id: owner,
        email_account_id: mailbox === "auto" ? undefined : mailbox, account_id: account === "auto" ? undefined : account,
        previous: earlier ? { subject: earlier.subject ?? "", body: earlier.body } : undefined,
      });
      patch({ status: "done", written: result });
    } catch (cause) {
      patch({ status: "failed", error: errorMessage(cause) });
    }
  }

  // While the next one is on its way the last answer stays up, dimmed.
  const loading = key !== null && result?.key !== key;
  const error = result?.key === key ? result.error ?? null : null;
  const answer = result?.answer ?? null;

  const tracks: Track[] = ["linkedin", "email"];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2.5 rounded-lg bg-subtle p-3">
        <ContactPicker samples={samples} value={contact} onChange={setContact} />
        <div className="grid grid-cols-2 gap-2">
          <Select className="w-full" label="LinkedIn account it is sent from" value={account} onChange={setAccount} options={[{ value: "auto", label: "The campaign's LinkedIn account" }, ...data.linkedin_accounts.map((entry) => ({ value: entry.id, label: entry.name }))]} />
          <Select className="w-full" label="Mailbox it is sent from" value={mailbox} onChange={setMailbox} options={[{ value: "auto", label: "The campaign's mailbox" }, ...data.mailboxes.map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.email}` }))]} />
        </div>
      </div>

      {!contact ? (
        <p className="py-8 text-center text-115 text-ink-2">Add a contact to the workspace to preview the sequence as them.</p>
      ) : error ? (
        <ErrorState message={error} onRetry={() => setRound(round + 1)} />
      ) : !answer ? (
        <LoadingState label="Writing it out" />
      ) : answer.steps.length === 0 ? (
        <p className="py-8 text-center text-115 text-ink-2">This sequence has no steps yet.</p>
      ) : (
        <div className={cn("flex flex-col gap-5", loading && "opacity-60")}>
          {tracks.map((track) => {
            const own = answer.steps.filter((step) => step.track === track);
            if (own.length === 0) return null;
            const sender = track === "email" ? answer.senders.email : answer.senders.linkedin;
            return (
              <section key={track} className="flex flex-col gap-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-125 font-semibold text-ink">{TRACK_LABEL[track]}</h3>
                  <span className="text-11 text-ink-3">{sender ? `From ${sender.name}${"email" in sender ? ` · ${sender.email}` : ""}` : "No sender chosen yet"}</span>
                </div>
                {own.map((step, index) => <PreviewStep key={`${step.ref ?? index}`} step={step} to={track === "email" ? answer.contact.email : null} sample={written[step.ref ?? ""]} onWrite={step.content === "ai" ? () => void write(step) : undefined} />)}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PreviewStep({ step: original, to, sample, onWrite, bare }: { step: StepPreview; to: string | null; sample?: SampleState; onWrite?: () => void; /** One step on its own: no day marker beside it. */ bare?: boolean }) {
  // Once a sample is written the step is shown as that text, with the same layout as any other.
  const done = sample?.status === "done" ? sample.written : null;
  const step: StepPreview = done ? { ...done.sample, day: original.day } : original;
  const Glyph = STEP_ICON[step.step_type] ?? Mail;
  return (
    <article className="flex gap-3">
      {bare ? null : (
        <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 pt-0.5">
          <span className={cn("inline-flex size-7 items-center justify-center rounded-md", step.track === "email" ? "bg-mail-tint text-mail" : "bg-li-tint text-li")}><Glyph size={14} aria-hidden="true" /></span>
          <span className="text-10 font-semibold uppercase text-ink-3">Day {step.day}</span>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border border-line bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-115 font-semibold text-ink">{step.step_type === "email" ? "Email" : STEP_KIND_LABEL[step.step_type]}</span>
          {step.shown ? <span className="text-105 text-ink-3">{step.shown.label}{step.shown.of > 1 ? ` · one of ${step.shown.of}` : ""}</span> : null}
        </div>
        {step.content === "none" ? (
          <p className="text-115 text-ink-2">{step.step_type === "visit" ? "Their profile is viewed. Nothing is written." : step.step_type === "connect" ? "A connection request, with no note." : "Nothing to send yet."}</p>
        ) : step.content === "ai" ? (
          <div className="flex flex-col items-start gap-2">
            <p className="flex items-center gap-1.5 text-115 text-brand-strong"><Sparkles size={13} aria-hidden="true" />Written by AI for this contact when the step is sent.</p>
            {onWrite ? <Button size="sm" icon={Sparkles} loading={sample?.status === "writing"} onClick={onWrite}>Write a sample</Button> : null}
            {sample?.status === "failed" ? <p role="alert" className="rounded-md bg-bad-tint px-2 py-1 text-11 leading-4 text-bad">{sample.error}</p> : null}
          </div>
        ) : (
          <>
            {step.subject !== null ? <p className="text-12 font-semibold text-ink">{step.subject || <span className="font-normal text-ink-3">(no subject)</span>}</p> : null}
            {to ? <p className="text-105 text-ink-3">To {to}</p> : null}
            <p className="whitespace-pre-wrap break-words text-115 leading-[18px] text-ink-2">{step.body}</p>
            {step.signature ? <p className="whitespace-pre-wrap border-t border-line pt-1.5 text-11 leading-4 text-ink-3">{step.signature}</p> : null}
            {step.spam ? <SpamNote spam={step.spam} /> : null}
            {done ? (
              <div className="flex items-center justify-between gap-2 border-t border-line pt-1.5">
                <span className="flex items-center gap-1.5 text-105 text-brand-strong"><Sparkles size={12} aria-hidden="true" />A sample, written by {done.model}. The real one is written when the step is sent.</span>
                {onWrite ? <Button size="sm" variant="ghost" icon={RefreshCw} loading={sample?.status === "writing"} onClick={onWrite}>Write another</Button> : null}
              </div>
            ) : null}
          </>
        )}
        {step.warnings.map((warning) => <p key={warning} className="rounded-md bg-warn-tint px-2 py-1 text-11 leading-4 text-warn">{warning}</p>)}
      </div>
    </article>
  );
}

/** Send one email step, as written for a chosen contact, to your own address. */
export function TestSendDialog({ open, onClose, workflowId, data, row, pick }: { open: boolean; onClose: () => void; workflowId: string; data: BuilderData; row: Row | null; pick: number }) {
  const email = row?.step_type === "email";
  return (
    <Dialog
      open={open && row !== null} onOpenChange={(next) => { if (!next) onClose(); }} icon={email ? SendHorizontal : Eye} size="md"
      title={email ? "Preview and send a test" : row?.step_type === "connect" ? "Preview the note" : "Preview this message"}
      description={email ? "This email, written out for one contact. Send it to yourself, or just read it." : "This step, written out for one contact. Nothing is sent."}
    >
      {open && row ? <TestSendForm workflowId={workflowId} data={data} row={row} pick={pick} onClose={onClose} /> : null}
    </Dialog>
  );
}

/**
 * What a step's dialog should be for this row: a step AI writes is tried out with a sample,
 * any other is read as written (and, for an email, sent to yourself). The sequence tab and the
 * campaign wizard both open steps through this, so they cannot disagree.
 */
export function StepTrialDialog({ open, onClose, workflowId, data, row, pick }: { open: boolean; onClose: () => void; workflowId: string; data: BuilderData; row: Row | null; pick: number }) {
  const writtenByAi = row !== null && (row.ai_enabled === 1 || row.ai_enabled === true) && (row.step_type === "email" || row.step_type === "message" || row.step_type === "sales_inmail");
  return writtenByAi
    ? <AiSampleDialog open={open} onClose={onClose} workflowId={workflowId} data={data} row={row} />
    : <TestSendDialog open={open} onClose={onClose} workflowId={workflowId} data={data} row={row} pick={pick} />;
}

function TestSendForm({ workflowId, data, row, pick, onClose }: { workflowId: string; data: BuilderData; row: Row; pick: number; onClose: () => void }) {
  const isAdmin = useCan("admin");
  const samples = data.sample_contacts.map(fromSample);
  const isEmail = row.step_type === "email";
  const versions = isEmail ? versionsOf(row) : [];
  const [contact, setContact] = useState<Contact | null>(samples[0] ?? null);
  const [mailbox, setMailbox] = useState<string | undefined>(data.mailboxes[0]?.id);
  /** A LinkedIn step's sender, for the sender tags in its text. "auto" is the campaign's own account. */
  const [account, setAccount] = useState<string>("auto");
  const [version, setVersion] = useState(String(Math.min(pick, Math.max(0, versions.length - 1))));
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The email as the chosen contact would read it, with the request it answers. */
  const [shown, setShown] = useState<{ key: string; step?: StepPreview; to?: string | null; error?: string } | null>(null);
  const key = contact ? `${contact.id}|${isEmail ? mailbox ?? "" : account}|${version}` : null;

  useEffect(() => {
    if (!contact || !key) return;
    const controller = new AbortController();
    // The step goes as the editor holds it, so the preview and the test are of the same text.
    const { ref: _ref, ...step } = row;
    void _ref;
    api<PreviewAnswer>(`/api/workflows/${workflowId}/preview`, {
      method: "POST", signal: controller.signal,
      body: { target_id: contact.id, steps: [step], pick: Number(version), ...(isEmail ? { email_account_id: mailbox } : { account_id: account === "auto" ? undefined : account }) },
    })
      .then((answer) => setShown({ key, step: answer.steps[0], to: answer.contact.email }))
      .catch((cause) => { if (!(cause instanceof DOMException)) setShown({ key, error: errorMessage(cause) }); });
    return () => controller.abort();
    // `row` is what the editor held when the dialog opened; it cannot change while the dialog is up.
  }, [key, workflowId]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = shown?.key === key ? shown : null;

  async function send() {
    if (!contact || !mailbox) return;
    setSending(true);
    setError(null);
    try {
      // The step goes as the editor holds it, saved or not, so what arrives is what is on screen.
      const { ref: _ref, ...step } = row;
      void _ref;
      const result = await api<{ to: string; subject: string }>(`/api/workflows/${workflowId}/test-send`, {
        method: "POST", body: { step, target_id: contact.id, email_account_id: mailbox, pick: Number(version), to: to.trim() || undefined },
      });
      toast.success(`Test sent to ${result.to}`, { description: result.subject });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSending(false);
    }
  }

  if (isEmail && data.mailboxes.length === 0) return <p className="text-115 leading-[18px] text-ink-2">Connect a mailbox first: a test has to be sent from one.</p>;
  return (
    <form className="flex flex-col gap-3.5" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <Field label="Written for">{() => <ContactPicker samples={samples} value={contact} onChange={setContact} />}</Field>
      <div className={cn("grid gap-2.5", versions.length > 1 ? "grid-cols-[1fr_140px]" : "grid-cols-1")}>
        {isEmail ? (
          <Field label="Sent from">
            {(id) => <Select id={id} className="w-full" value={mailbox} onChange={setMailbox} options={data.mailboxes.map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.email}` }))} />}
          </Field>
        ) : (
          <Field label="LinkedIn account it is sent from">
            {(id) => <Select id={id} className="w-full" value={account} onChange={setAccount} options={[{ value: "auto", label: "The campaign's LinkedIn account" }, ...data.linkedin_accounts.map((entry) => ({ value: entry.id, label: entry.name }))]} />}
          </Field>
        )}
        {versions.length > 1 ? (
          <Field label="Version">
            {(id) => <Select id={id} className="w-full" value={version} onChange={setVersion} options={versions.map((entry) => ({ value: String(entry.index), label: `Version ${letter(entry.index)}` }))} />}
          </Field>
        ) : null}
      </div>
      {!contact ? null : current?.error ? (
        <p role="alert" className="rounded-md bg-bad-tint px-2.5 py-1.5 text-11 leading-4 text-bad">{current.error}</p>
      ) : current?.step ? (
        <PreviewStep step={current.step} to={isEmail ? current.to ?? null : null} bare />
      ) : (
        <LoadingState label="Writing it out" />
      )}
      {isEmail ? (
        <>
          {isAdmin ? (
            <Field label="Send it to" hint="Leave empty to send it to the address you are signed in with.">
              {(id) => <Input id={id} type="email" value={to} onChange={(event) => setTo(event.target.value)} placeholder="Your own address" autoComplete="off" />}
            </Field>
          ) : (
            <p className="text-11 leading-4 text-ink-3">It goes to the address you are signed in with.</p>
          )}
          <p className="text-11 leading-4 text-ink-3">The subject is marked [Test], nothing is tracked, and the unsubscribe link is replaced by words so the test cannot opt anyone out.</p>
        </>
      ) : (
        <p className="text-11 leading-4 text-ink-3">A LinkedIn message has nowhere safe to be sent as a test, so this is a read only: nothing goes to the contact or to you.</p>
      )}
      {error ? <p role="alert" className="rounded-md bg-bad-tint px-2.5 py-1.5 text-11 leading-4 text-bad">{error}</p> : null}
      <div className="flex justify-end gap-2.5">
        <Button onClick={onClose}>Close</Button>
        {isEmail ? <Button type="submit" variant="primary" icon={SendHorizontal} loading={sending} disabled={!contact || !mailbox}>Send test</Button> : null}
      </div>
    </form>
  );
}

/**
 * A step AI writes, tried out: write one sample for a contact, read it, write another, and for
 * an email send the one on screen to yourself. The step is read as the editor holds it, saved
 * or not, so changing the instruction and writing again shows what the change did.
 */
export function AiSampleDialog({ open, onClose, workflowId, data, row }: { open: boolean; onClose: () => void; workflowId: string; data: BuilderData; row: Row | null }) {
  const isEmail = row?.step_type === "email";
  return (
    <Dialog
      open={open && row !== null} onOpenChange={(next) => { if (!next) onClose(); }} icon={Sparkles} size="md"
      title={isEmail ? "Try this email" : "Try this message"}
      description={isEmail ? "A sample for one contact, sent only to you." : "A sample for one contact. Nothing is sent."}
    >
      {open && row ? <AiSampleForm workflowId={workflowId} data={data} row={row} onClose={onClose} /> : null}
    </Dialog>
  );
}

function AiSampleForm({ workflowId, data, row, onClose }: { workflowId: string; data: BuilderData; row: Row; onClose: () => void }) {
  const isAdmin = useCan("admin");
  const isEmail = row.step_type === "email";
  const samples = data.sample_contacts.map(fromSample);
  const [contact, setContact] = useState<Contact | null>(samples[0] ?? null);
  const [mailbox, setMailbox] = useState<string | undefined>(data.mailboxes[0]?.id);
  const [to, setTo] = useState("");
  /** The sample and the contact it was written for: choosing another contact makes it stale. */
  const [result, setResult] = useState<{ contact: string; written: WrittenSample } | null>(null);
  const [writing, setWriting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = result && contact && result.contact === contact.id ? result.written : null;
  // The step as the editor holds it: what is sent and what is written from must be the same thing.
  const step = (): StepInput => { const { ref: _ref, ...rest } = row; void _ref; return rest; };

  async function write() {
    if (!contact) return;
    setWriting(true);
    setError(null);
    try {
      const written = await writeSample(workflowId, { step: step(), target_id: contact.id, email_account_id: isEmail ? mailbox : undefined });
      setResult({ contact: contact.id, written });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWriting(false);
    }
  }

  async function send() {
    if (!contact || !mailbox || !current) return;
    setSending(true);
    setError(null);
    try {
      // The text that was read is the text that is sent, so the test is not a second, different draft.
      const answer = await api<{ to: string; subject: string }>(`/api/workflows/${workflowId}/test-send`, {
        method: "POST",
        body: { step: step(), target_id: contact.id, email_account_id: mailbox, to: to.trim() || undefined, sample: { subject: current.sample.subject ?? "", body: current.sample.body ?? "" } },
      });
      toast.success(`Test sent to ${answer.to}`, { description: answer.subject });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSending(false);
    }
  }

  const noMailbox = isEmail && data.mailboxes.length === 0;
  const { sample } = current ?? {};
  return (
    <div className="flex flex-col gap-3.5">
      <Field label="Written for">{() => <ContactPicker samples={samples} value={contact} onChange={(next) => { setContact(next); setError(null); }} />}</Field>
      {isEmail && data.mailboxes.length > 0 ? (
        <Field label="Sent from">
          {(id) => <Select id={id} className="w-full" value={mailbox} onChange={setMailbox} options={data.mailboxes.map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.email}` }))} />}
        </Field>
      ) : null}

      {current && sample ? (
        <article className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3">
          {sample.subject !== null ? <p className="text-12 font-semibold text-ink">{sample.subject || <span className="font-normal text-ink-3">(no subject)</span>}</p> : null}
          <p className="whitespace-pre-wrap break-words text-115 leading-[18px] text-ink-2">{sample.body}</p>
          {sample.signature ? <p className="whitespace-pre-wrap border-t border-line pt-1.5 text-11 leading-4 text-ink-3">{sample.signature}</p> : null}
          {sample.spam ? <SpamNote spam={sample.spam} /> : null}
          <p className="border-t border-line pt-1.5 text-105 leading-[14px] text-ink-3">
            Written by {current.model}{current.used_fallback ? " (the fallback model)" : ""}
            {current.cost_usd !== null ? ` · ${formatRequestCost(current.cost_usd)}` : ""} · counts towards this month&apos;s AI spend.
            {current.without_previous ? " This step follows up an earlier email; the sample is written without it in view, so it reads as a first email." : ""}
          </p>
          {sample.warnings.map((warning) => <p key={warning} className="rounded-md bg-warn-tint px-2 py-1 text-11 leading-4 text-warn">{warning}</p>)}
        </article>
      ) : (
        <p className="rounded-lg bg-subtle px-3 py-6 text-center text-115 text-ink-2">{writing ? "Writing…" : "Write a sample to see what AI would send this contact."}</p>
      )}

      {isEmail && current ? (
        isAdmin ? (
          <Field label="Send it to" hint="Leave empty to send it to the address you are signed in with.">
            {(id) => <Input id={id} type="email" value={to} onChange={(event) => setTo(event.target.value)} placeholder="Your own address" autoComplete="off" />}
          </Field>
        ) : (
          <p className="text-11 leading-4 text-ink-3">The test goes to the address you are signed in with. The subject is marked [Test], nothing is tracked, and the unsubscribe link is replaced by words.</p>
        )
      ) : null}
      {noMailbox ? <p className="text-11 leading-4 text-ink-3">Connect a mailbox to send a test from.</p> : null}
      {error ? <p role="alert" className="rounded-md bg-bad-tint px-2.5 py-1.5 text-11 leading-4 text-bad">{error}</p> : null}

      <div className="flex justify-end gap-2.5">
        <Button onClick={onClose}>Close</Button>
        <Button variant={current ? "secondary" : "primary"} icon={current ? RefreshCw : Sparkles} loading={writing} disabled={!contact || sending} onClick={() => void write()}>
          {current ? "Write another" : "Write a sample"}
        </Button>
        {isEmail ? <Button variant="primary" icon={SendHorizontal} loading={sending} disabled={!current || !mailbox || writing} onClick={() => void send()}>Send this to me</Button> : null}
      </div>
    </div>
  );
}
