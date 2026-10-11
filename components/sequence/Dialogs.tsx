import { useEffect, useState } from "react";
import { Eye, Mail, MessageSquare, Send, SendHorizontal, Sparkles, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button, Dialog, ErrorState, Field, Input, LoadingState, SearchInput, Select, type Icon } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import { useDebounced } from "@/lib/client/table-state";
import type { StepPreview } from "@/lib/outreach/preview";
import { STEP_KIND_LABEL, TRACK_LABEL, letter, versionsOf, type BuilderData, type Row, type StepInput, type Track } from "./model";

const STEP_ICON: Record<string, Icon> = { visit: Eye, connect: UserPlus, message: MessageSquare, sales_inmail: Send, email: Mail };

interface Contact { id: string; name: string; detail: string | null }
interface SearchAnswer { results: Array<{ kind: string; id: string; title: string; subtitle: string | null }> }
interface PreviewAnswer {
  contact: { id: string; name: string; title: string | null; company: string | null; email: string | null };
  senders: { linkedin: { id: string; name: string } | null; email: { id: string; name: string; email: string } | null };
  steps: StepPreview[];
}

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
                {own.map((step, index) => <PreviewStep key={`${step.ref ?? index}`} step={step} to={track === "email" ? answer.contact.email : null} />)}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PreviewStep({ step, to }: { step: StepPreview; to: string | null }) {
  const Glyph = STEP_ICON[step.step_type] ?? Mail;
  return (
    <article className="flex gap-3">
      <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 pt-0.5">
        <span className={cn("inline-flex size-7 items-center justify-center rounded-md", step.track === "email" ? "bg-mail-tint text-mail" : "bg-li-tint text-li")}><Glyph size={14} aria-hidden="true" /></span>
        <span className="text-10 font-semibold uppercase text-ink-3">Day {step.day}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border border-line bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-115 font-semibold text-ink">{step.step_type === "email" ? "Email" : STEP_KIND_LABEL[step.step_type]}</span>
          {step.shown ? <span className="text-105 text-ink-3">{step.shown.label}{step.shown.of > 1 ? ` · one of ${step.shown.of}` : ""}</span> : null}
        </div>
        {step.content === "none" ? (
          <p className="text-115 text-ink-2">{step.step_type === "visit" ? "Their profile is viewed. Nothing is written." : step.step_type === "connect" ? "A connection request, with no note." : "Nothing to send yet."}</p>
        ) : step.content === "ai" ? (
          <p className="flex items-center gap-1.5 text-115 text-brand-strong"><Sparkles size={13} aria-hidden="true" />Written by AI for this contact when the step is sent.</p>
        ) : (
          <>
            {step.subject !== null ? <p className="text-12 font-semibold text-ink">{step.subject || <span className="font-normal text-ink-3">(no subject)</span>}</p> : null}
            {to ? <p className="text-105 text-ink-3">To {to}</p> : null}
            <p className="whitespace-pre-wrap break-words text-115 leading-[18px] text-ink-2">{step.body}</p>
            {step.signature ? <p className="whitespace-pre-wrap border-t border-line pt-1.5 text-11 leading-4 text-ink-3">{step.signature}</p> : null}
          </>
        )}
        {step.warnings.map((warning) => <p key={warning} className="rounded-md bg-warn-tint px-2 py-1 text-11 leading-4 text-warn">{warning}</p>)}
      </div>
    </article>
  );
}

/** Send one email step, as written for a chosen contact, to your own address. */
export function TestSendDialog({ open, onClose, workflowId, data, row, pick }: { open: boolean; onClose: () => void; workflowId: string; data: BuilderData; row: Row | null; pick: number }) {
  return (
    <Dialog open={open && row !== null} onOpenChange={(next) => { if (!next) onClose(); }} title="Send a test" description="This email, written out for one contact and sent to you. The contact receives nothing." icon={SendHorizontal} size="md">
      {open && row ? <TestSendForm workflowId={workflowId} data={data} row={row} pick={pick} onClose={onClose} /> : null}
    </Dialog>
  );
}

function TestSendForm({ workflowId, data, row, pick, onClose }: { workflowId: string; data: BuilderData; row: Row; pick: number; onClose: () => void }) {
  const isAdmin = useCan("admin");
  const samples = data.sample_contacts.map(fromSample);
  const versions = versionsOf(row);
  const [contact, setContact] = useState<Contact | null>(samples[0] ?? null);
  const [mailbox, setMailbox] = useState<string | undefined>(data.mailboxes[0]?.id);
  const [version, setVersion] = useState(String(Math.min(pick, versions.length - 1)));
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (data.mailboxes.length === 0) return <p className="text-115 leading-[18px] text-ink-2">Connect a mailbox first: a test has to be sent from one.</p>;
  return (
    <form className="flex flex-col gap-3.5" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <Field label="Written for">{() => <ContactPicker samples={samples} value={contact} onChange={setContact} />}</Field>
      <div className={cn("grid gap-2.5", versions.length > 1 ? "grid-cols-[1fr_140px]" : "grid-cols-1")}>
        <Field label="Sent from">
          {(id) => <Select id={id} className="w-full" value={mailbox} onChange={setMailbox} options={data.mailboxes.map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.email}` }))} />}
        </Field>
        {versions.length > 1 ? (
          <Field label="Version">
            {(id) => <Select id={id} className="w-full" value={version} onChange={setVersion} options={versions.map((entry) => ({ value: String(entry.index), label: `Version ${letter(entry.index)}` }))} />}
          </Field>
        ) : null}
      </div>
      {isAdmin ? (
        <Field label="Send it to" hint="Leave empty to send it to the address you are signed in with.">
          {(id) => <Input id={id} type="email" value={to} onChange={(event) => setTo(event.target.value)} placeholder="Your own address" autoComplete="off" />}
        </Field>
      ) : (
        <p className="text-11 leading-4 text-ink-3">It goes to the address you are signed in with.</p>
      )}
      <p className="text-11 leading-4 text-ink-3">The subject is marked [Test], nothing is tracked, and the unsubscribe link is replaced by words so the test cannot opt anyone out.</p>
      {error ? <p role="alert" className="rounded-md bg-bad-tint px-2.5 py-1.5 text-11 leading-4 text-bad">{error}</p> : null}
      <div className="flex justify-end gap-2.5">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" icon={SendHorizontal} loading={sending} disabled={!contact || !mailbox}>Send test</Button>
      </div>
    </form>
  );
}
