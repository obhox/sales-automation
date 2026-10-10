import { useEffect, useRef, useState } from "react";
import { CircleCheck, CirclePause, CirclePlay, Clock, EllipsisVertical, Globe, Info, Mail, MailWarning, PlugZap, RefreshCw, Search, Send, Settings2, Signature, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, Avatar, Button, Card, Checkbox, Eyebrow, IconButton, Input, Menu, MenuItem, MenuSeparator, Pill, Skeleton, TextAction, Tooltip } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import type { MailboxAction } from "./DomainGroup";
import {
  bounceLine, connectedLine, daysLabel, limitLine, queueBadge, queueSub, queueTime, queueWhat, queueWho, reputationLabel, reputationSpoken, reputationWhy, signatureLines, statusBadge, testResult, warmupDetailBadge, windowLabel,
  type MailboxQueue, type MailboxView, type TestSend,
} from "./model";

export interface MailboxDetailProps {
  mailbox: MailboxView;
  canEdit: boolean;
  busy: boolean;
  onAction: (action: MailboxAction, mailbox: MailboxView) => void;
  /** Something about the mailbox changed on the server; read the overview again. */
  onChanged: () => void;
}

/** The selected mailbox: its window, its signature, a test send, what it is about to send, and its pause. */
export function MailboxDetail({ mailbox, canEdit, busy, onAction, onChanged }: MailboxDetailProps) {
  const status = statusBadge(mailbox);
  const warmup = warmupDetailBadge(mailbox);
  const bounce = bounceLine(mailbox);
  const lost = mailbox.status === "disconnected";
  const paused = mailbox.status === "paused" || mailbox.status === "auto_paused";
  const act = (action: MailboxAction) => () => onAction(action, mailbox);

  return (
    <Card className="flex max-h-full min-h-0 flex-col overflow-hidden" role="region" aria-label={`Details for ${mailbox.from_email}`}>
      <div className="flex flex-col gap-2.5 border-b border-line p-3.5">
        <div className="flex items-center gap-2.5">
          <span className={cn("inline-flex size-[34px] shrink-0 items-center justify-center rounded-lg", lost ? "bg-bad-tint text-bad" : "bg-mail-tint text-mail")} aria-hidden="true">
            {lost ? <MailWarning size={16} /> : <Mail size={16} />}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <h2 className="truncate text-125 font-semibold text-ink">{mailbox.from_email}</h2>
            <p className="truncate text-105 text-ink-3" title={connectedLine(mailbox)}>{connectedLine(mailbox)}</p>
          </div>
          {canEdit ? (
            <Menu align="end" width={212} trigger={<IconButton icon={EllipsisVertical} label={`More for ${mailbox.from_email}`} size={28} variant="outline" />}>
              <MenuItem icon={Settings2} onSelect={act("edit")}>Edit settings</MenuItem>
              <MenuItem icon={Signature} onSelect={act("signature")}>Edit signature</MenuItem>
              <MenuItem icon={PlugZap} disabled={busy} onSelect={act("test")}>{lost ? "Try to reconnect" : "Test the connection"}</MenuItem>
              <MenuSeparator />
              <MenuItem icon={Trash2} tone="danger" onSelect={act("delete")}>Remove mailbox</MenuItem>
            </Menu>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={status.tone} dot className="h-[19px] text-10">{status.label}</Pill>
          <Pill tone={warmup.tone} className="h-[19px] text-10">{warmup.label}</Pill>
          <Tooltip label={reputationWhy(mailbox)}>
            <span tabIndex={0} role="img" aria-label={reputationSpoken(mailbox)} className="inline-flex rounded-full"><Pill className="h-[19px] text-10">{reputationLabel(mailbox)}</Pill></span>
          </Tooltip>
          <Pill tone={bounce.bad ? "bad" : "neutral"} className="h-[19px] text-10">{bounce.text}</Pill>
        </div>
      </div>

      {mailbox.held?.reason ? (
        <div className="border-b border-line p-3.5">
          {mailbox.status === "paused" ? (
            <Alert tone="neutral" title="Paused by a person">Nothing is sent from it until it is resumed. Its contacts stay where they are in their sequences.</Alert>
          ) : (
            <Alert tone="bad" title={lost ? "This mailbox cannot sign in" : "Paused by its guard"}>
              {mailbox.held.reason.replace(/^Auto-paused:\s*/, "")}
              {lost ? " Nothing is sent from it and its contacts wait. Linki tries again every half hour; to put it right now, check its password in settings and test the connection." : null}
            </Alert>
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-b border-line bg-subtle px-3.5 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-11 text-ink-2">
          <Tooltip label={`Sends ${daysLabel(mailbox)}`}>
            <span className="inline-flex items-center gap-1.5" tabIndex={0} role="img" aria-label={`Sends ${windowLabel(mailbox)}, ${daysLabel(mailbox)}`}><Clock size={12} className="text-ink-3" aria-hidden="true" />{windowLabel(mailbox)}</span>
          </Tooltip>
          <span className="inline-flex items-center gap-1.5"><Globe size={12} className="text-ink-3" aria-hidden="true" />{mailbox.schedule.timezone}</span>
          <span className="inline-flex items-center gap-1.5"><Send size={12} className="text-ink-3" aria-hidden="true" />{limitLine(mailbox).text}</span>
        </div>
        {canEdit ? <TextAction onClick={act("edit")} aria-label="Edit the sending window and limit">Edit</TextAction> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SignatureSection mailbox={mailbox} canEdit={canEdit} onEdit={act("signature")} onChanged={onChanged} />
        <TestSendSection key={mailbox.id} mailbox={mailbox} canEdit={canEdit} onChanged={onChanged} />
        <QueueSection key={`queue:${mailbox.id}`} mailbox={mailbox} />
      </div>

      {canEdit ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-subtle p-3">
          {lost ? (
            <Button className="flex-1" icon={PlugZap} loading={busy} onClick={act("test")}>Try to reconnect</Button>
          ) : paused ? (
            <Button className="flex-1" icon={CirclePlay} loading={busy} onClick={act("resume")}>Resume sending</Button>
          ) : (
            <Button className="flex-1" icon={CirclePause} loading={busy} onClick={act("pause")}>Pause sending</Button>
          )}
          <IconButton icon={Settings2} label={`Settings for ${mailbox.from_email}`} variant="outline" onClick={act("edit")} />
        </div>
      ) : null}
    </Card>
  );
}

function SignatureSection({ mailbox, canEdit, onEdit, onChanged }: { mailbox: MailboxView; canEdit: boolean; onEdit: () => void; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const lines = signatureLines(mailbox.signature);

  async function setFirstOnly(on: boolean) {
    setSaving(true);
    try {
      await api(`/api/email-accounts/${mailbox.id}`, { method: "PUT", body: { signature_first_only: on } });
      toast.success(on ? "The signature now goes on the first email only" : "The signature now goes on every email");
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-2.5 border-b border-line p-3.5" aria-label="Signature">
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>Signature</Eyebrow>
        {canEdit ? <TextAction onClick={onEdit}>{lines ? "Edit signature" : "Add a signature"}</TextAction> : null}
      </div>
      {lines ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-line bg-subtle p-2.5">
          <Avatar name={mailbox.from_name || lines.first} size={34} tint="bg-brand-tint" className="text-brand-strong" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-115 font-semibold text-ink">{lines.first}</span>
            {lines.rest.slice(0, 3).map((line, index) => (
              <span key={index} className={cn("truncate text-105", index === 0 ? "text-ink-2" : "text-ink-3")}>{line}</span>
            ))}
            {lines.rest.length > 3 ? <span className="text-105 text-ink-3">and {lines.rest.length - 3} more {lines.rest.length - 3 === 1 ? "line" : "lines"}</span> : null}
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line-strong p-2.5 text-11 text-ink-3">No signature. Emails from this mailbox end where the step&apos;s text ends, unless a step has its own.</p>
      )}
      <label className={cn("flex items-center gap-[9px] text-11 text-ink", (!canEdit || !lines) && "text-ink-3")}>
        <Checkbox checked={mailbox.signature_first_only} onChange={(on) => void setFirstOnly(on)} disabled={!canEdit || !lines || saving} label="Append to the first email of a sequence only" />
        Append to the first email of a sequence only
      </label>
    </section>
  );
}

const TEST_BOX = { good: "bg-good-tint", warn: "bg-warn-tint", bad: "bg-bad-tint", info: "bg-brand-tint", neutral: "bg-subtle" } as const;
const TEST_ICON_TONE = { good: "text-good", warn: "text-warn", bad: "text-bad", info: "text-brand", neutral: "text-ink-3" } as const;

/** How often, and for how long, a test that has just been sent is looked for. */
const LOOK_EVERY_MS = 5_000;
const LOOK_FOR_MS = 90_000;

function TestSendSection({ mailbox, canEdit, onChanged }: { mailbox: MailboxView; canEdit: boolean; onChanged: () => void }) {
  const [to, setTo] = useState(mailbox.from_email);
  const [sending, setSending] = useState(false);
  const [test, setTest] = useState<TestSend | null>(mailbox.last_test);
  const [error, setError] = useState<string | null>(null);
  const lookingSince = useRef<number | null>(null);

  // A test that went to a mailbox Linki can read is looked for until it turns up, for a
  // minute and a half. After that the answer waits for the next visit.
  const waiting = canEdit && test?.status === "sent" && test.readable;
  useEffect(() => {
    if (!waiting || !test) return;
    lookingSince.current ??= Date.now();
    const timer = window.setTimeout(async () => {
      if (Date.now() - (lookingSince.current ?? 0) > LOOK_FOR_MS) return;
      try {
        const result = await api<{ test: TestSend }>(`/api/email-accounts/${mailbox.id}/send-test`, { method: "PUT", body: { test_id: test.id } });
        // A new object each time, so the next look is scheduled even when nothing changed.
        setTest({ ...result.test });
        if (result.test.status !== "sent") onChanged();
      } catch {
        // The next look, or the next visit, will say.
      }
    }, LOOK_EVERY_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, test, mailbox.id, onChanged]);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const result = await api<{ test: TestSend }>(`/api/email-accounts/${mailbox.id}/send-test`, { method: "POST", body: { to: to.trim() } });
      lookingSince.current = Date.now();
      setTest(result.test);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  }

  const result = test ? testResult(test) : null;
  const ResultIcon = !result ? Info : result.looking ? Search : result.tone === "good" ? CircleCheck : result.tone === "neutral" || result.tone === "info" ? Info : TriangleAlert;
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());

  return (
    <section className="flex flex-col gap-2.5 border-b border-line p-3.5" aria-label="Test send">
      <Eyebrow>Test send</Eyebrow>
      {canEdit ? (
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (valid && !sending) void send(); }}>
          <Input
            frameClassName="min-w-0 flex-1" icon={Mail} type="email" value={to} onChange={(event) => setTo(event.target.value)} aria-label="Send the test to"
            placeholder={mailbox.from_email} autoComplete="off" spellCheck={false} disabled={mailbox.status === "disconnected"}
          />
          <Button type="submit" icon={Send} loading={sending} disabled={!valid || mailbox.status === "disconnected"}>Send test</Button>
        </form>
      ) : null}
      {error ? (
        <Alert tone="bad">{error}</Alert>
      ) : result ? (
        <div role="status" className={cn("flex gap-2 rounded-lg p-[9px] text-105 leading-[15px] text-ink-2", TEST_BOX[result.tone])}>
          <ResultIcon size={13} className={cn("mt-px shrink-0", TEST_ICON_TONE[result.tone])} aria-hidden="true" />
          <span className="min-w-0 flex-1">{result.text}</span>
        </div>
      ) : (
        <p className="text-105 leading-[15px] text-ink-3">
          {canEdit
            ? "Send a real email from this mailbox. Sent to one of your connected mailboxes, such as this one, Linki reads back where it landed."
            : "No test has been sent from this mailbox yet."}
        </p>
      )}
    </section>
  );
}

function QueueSection({ mailbox }: { mailbox: MailboxView }) {
  const { data, error, isLoading, isValidating, mutate } = useApi<MailboxQueue>(`/api/email-accounts/${mailbox.id}/queue`);
  return (
    <section aria-label="Upcoming sends">
      <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-125 font-semibold text-ink">Upcoming sends</h3>
          <p className="truncate text-11 text-ink-2">{data ? queueSub(mailbox, data) : error ? "Could not be read" : "Reading…"}</p>
        </div>
        <IconButton icon={RefreshCw} label="Read the upcoming sends again" size={28} variant="outline" disabled={isValidating} onClick={() => void mutate()} className={cn(isValidating && "[&>svg]:animate-spin")} />
      </div>
      {isLoading && !data ? (
        <div className="flex flex-col gap-2 p-3.5" aria-busy="true">
          {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-8 rounded-md" />)}
        </div>
      ) : error && !data ? (
        <p className="p-3.5 text-11 text-bad" role="alert">{errorMessage(error)}</p>
      ) : data && data.items.length > 0 ? (
        <>
          <ul className="flex flex-col">
            {data.items.map((item) => {
              const badge = queueBadge(item);
              return (
                <li key={item.key} className="flex min-h-11 items-center gap-2.5 border-b border-line px-3.5 py-1.5 last:border-b-0">
                  <span className={cn("w-9 shrink-0 font-mono text-11 font-medium", item.status === "sent" ? "text-ink-3" : "text-ink")}>{queueTime(item.at)}</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-115 font-semibold text-ink">{queueWho(item)}</span>
                    <span className="truncate text-10 text-ink-3">{queueWhat(item)}</span>
                  </div>
                  <Pill tone={badge.tone} dot={badge.dot} className="h-[19px] text-10">{badge.label}</Pill>
                </li>
              );
            })}
          </ul>
          {data.items.some((item) => item.status === "due") ? (
            <p className="border-t border-line px-3.5 py-2.5 text-10 leading-[14px] text-ink-3">
              Times are estimates. An email is written at the moment it is sent, and the runner moves each contact&apos;s next step as it paces the day.
            </p>
          ) : null}
        </>
      ) : (
        <p className="p-3.5 text-11 text-ink-3">
          {data?.waiting ? `${data.waiting} ${data.waiting === 1 ? "contact is" : "contacts are"} enrolled and will be given a send time as the day's limit allows.` : "No campaign has a contact waiting on this mailbox."}
        </p>
      )}
    </section>
  );
}
