import { useState } from "react";
import { PlugZap } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Drawer, Field, Input, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { DaysField, HoursField, NumberField, Section, SwitchRow, TimezoneField, numberProblem } from "@/components/linkedin-accounts/SettingsFields";
import type { MailboxView } from "./model";

interface Form {
  name: string; fromName: string; replyTo: string;
  limit: string; start: number; end: number; days: string; timezone: string;
  rampOn: boolean; rampLength: "original" | "custom"; rampDays: string; rampStart: string;
  bounce: string; complaint: string; sample: string;
  warmupOn: boolean; warmupTarget: string; warmupReplies: string;
  smtpHost: string; smtpPort: string; security: "starttls" | "ssl"; username: string; password: string;
  imapHost: string; imapPort: string; imapUsername: string; imapPassword: string; selfSigned: boolean;
}

/** 0.03 → "3", 0.001 → "0.1": a rate as the percentage a person types. */
const percentText = (rate: number) => String(Number((rate * 100).toFixed(3)));
const rateOf = (text: string) => Number(text) / 100;

function formFor(mailbox: MailboxView): Form {
  return {
    name: mailbox.name, fromName: mailbox.from_name ?? "", replyTo: mailbox.reply_to ?? "",
    limit: String(mailbox.sending.limit_full), start: mailbox.schedule.start, end: mailbox.schedule.end, days: mailbox.schedule.days, timezone: mailbox.schedule.timezone,
    rampOn: mailbox.ramp_enabled, rampLength: mailbox.ramp?.custom_days ? "custom" : "original",
    rampDays: String(mailbox.ramp?.custom_days ?? 21), rampStart: String(mailbox.ramp?.start_limit ?? 5),
    bounce: percentText(mailbox.guard.bounce_threshold), complaint: percentText(mailbox.guard.complaint_threshold), sample: String(mailbox.guard.min_health_sample),
    warmupOn: mailbox.warmup.enabled, warmupTarget: String(mailbox.warmup.daily_target), warmupReplies: String(mailbox.warmup.reply_rate),
    smtpHost: mailbox.connection.smtp_host, smtpPort: String(mailbox.connection.smtp_port), security: mailbox.connection.smtp_secure ? "ssl" : "starttls",
    username: mailbox.connection.username, password: "",
    imapHost: mailbox.connection.imap_host ?? "", imapPort: String(mailbox.connection.imap_port ?? 993), imapUsername: mailbox.connection.imap_username ?? "", imapPassword: "",
    selfSigned: mailbox.connection.allow_self_signed,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

/** Only what changed is sent, so saving one field never rewrites another. */
function changes(mailbox: MailboxView, form: Form): { mailbox: Record<string, unknown>; warmup: Record<string, unknown> | null; connection: boolean } {
  const before = formFor(mailbox);
  const body: Record<string, unknown> = {};
  if (form.name.trim() !== before.name) body.name = form.name.trim();
  if (form.fromName.trim() !== before.fromName) body.from_name = form.fromName.trim() || null;
  if (form.replyTo.trim() !== before.replyTo) body.reply_to = form.replyTo.trim() || null;
  if (form.limit !== before.limit) body.daily_email_limit = Number(form.limit);
  if (form.start !== before.start) body.active_hours_start = form.start;
  if (form.end !== before.end) body.active_hours_end = form.end;
  if (form.days !== before.days) body.working_days = form.days;
  if (form.timezone !== before.timezone) body.timezone = form.timezone;

  const rampChanged = form.rampOn !== before.rampOn || (form.rampOn && (form.rampLength !== before.rampLength || (form.rampLength === "custom" && (form.rampDays !== before.rampDays || form.rampStart !== before.rampStart))));
  if (rampChanged) {
    body.ramp_up_enabled = form.rampOn;
    if (form.rampOn) {
      body.ramp_days = form.rampLength === "custom" ? Number(form.rampDays) : null;
      body.ramp_start_limit = form.rampLength === "custom" ? Number(form.rampStart) : null;
      // A ramp being adjusted keeps its first day; one being switched on starts today.
      if (!before.rampOn || !mailbox.ramp) body.ramp_start_date = today();
    }
  }
  if (form.bounce !== before.bounce) body.bounce_threshold = rateOf(form.bounce);
  if (form.complaint !== before.complaint) body.complaint_threshold = rateOf(form.complaint);
  if (form.sample !== before.sample) body.min_health_sample = Number(form.sample);

  let connection = false;
  const connectionField = (key: string, now: unknown, was: unknown) => { if (now !== was) { body[key] = now; connection = true; } };
  connectionField("smtp_host", form.smtpHost.trim(), before.smtpHost);
  connectionField("smtp_port", Number(form.smtpPort), Number(before.smtpPort));
  connectionField("smtp_secure", form.security === "ssl" ? 1 : 0, before.security === "ssl" ? 1 : 0);
  connectionField("username", form.username.trim(), before.username);
  connectionField("imap_host", form.imapHost.trim() || null, before.imapHost || null);
  if (form.imapHost.trim()) connectionField("imap_port", Number(form.imapPort), Number(before.imapPort));
  connectionField("imap_username", form.imapUsername.trim() || null, before.imapUsername || null);
  connectionField("allow_self_signed", form.selfSigned, before.selfSigned);
  if (form.password) { body.password = form.password; connection = true; }
  if (form.imapPassword) { body.imap_password = form.imapPassword; connection = true; }

  const warmupChanged = form.warmupOn !== before.warmupOn || form.warmupTarget !== before.warmupTarget || form.warmupReplies !== before.warmupReplies;
  return {
    mailbox: body,
    warmup: warmupChanged ? { action: "configure_warmup", email_account_id: mailbox.id, enabled: form.warmupOn, daily_target: Number(form.warmupTarget), reply_rate: Number(form.warmupReplies) } : null,
    connection,
  };
}

function rateProblem(text: string, min: number, max: number): string | null {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value) || value < min || value > max) return `From ${min}% to ${max}%`;
  return null;
}

function problems(form: Form): boolean {
  return Boolean(
    !form.name.trim() || !form.timezone || numberProblem(form.limit, 1, 999, false)
    || (form.replyTo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.replyTo.trim()))
    || (form.rampOn && form.rampLength === "custom" && (numberProblem(form.rampDays, 2, 90, false) || numberProblem(form.rampStart, 1, 999, false) || Number(form.rampStart) > Number(form.limit)))
    || rateProblem(form.bounce, 0.5, 20) || rateProblem(form.complaint, 0.01, 2) || numberProblem(form.sample, 10, 999, false)
    || numberProblem(form.warmupTarget, 1, 50, false) || numberProblem(form.warmupReplies, 0, 100, false)
    || !form.smtpHost.trim() || !form.username.trim() || !(Number(form.smtpPort) > 0) || (form.imapHost.trim() && !(Number(form.imapPort) > 0)),
  );
}

export interface EditMailboxDrawerProps {
  /** The mailbox being edited; null closes the drawer. */
  mailbox: MailboxView | null;
  onClose: () => void;
  onSaved: () => void;
}

export function EditMailboxDrawer({ mailbox, onClose, onSaved }: EditMailboxDrawerProps) {
  return (
    <Drawer open={mailbox !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={mailbox ? mailbox.from_email : "Mailbox settings"} description="Limit, hours, ramp, guard, warm-up and connection" width={480} footer={null}>
      {mailbox ? <EditForm key={mailbox.id} mailbox={mailbox} onClose={onClose} onSaved={onSaved} /> : null}
    </Drawer>
  );
}

function EditForm({ mailbox, onClose, onSaved }: { mailbox: MailboxView; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Form>(() => formFor(mailbox));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const change = changes(mailbox, form);
  const dirty = Object.keys(change.mailbox).length > 0 || change.warmup !== null;
  const provider = mailbox.provider.key === "google" && mailbox.provider.method === "App password";
  const rampTooHigh = form.rampOn && form.rampLength === "custom" && form.rampStart !== "" && form.limit !== "" && Number(form.rampStart) > Number(form.limit);
  const originalDays = Math.max(1, Math.ceil(Number(form.limit || "0") / 2));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (Object.keys(change.mailbox).length > 0) await api(`/api/email-accounts/${mailbox.id}`, { method: "PUT", body: change.mailbox });
      if (change.warmup) await api("/api/platform/deliverability", { method: "POST", body: change.warmup });
      // New connection details are only as good as the sign-in they produce.
      if (change.connection) {
        try {
          await api(`/api/email-accounts/${mailbox.id}/test`, { method: "POST" });
          toast.success(`Settings saved and ${mailbox.from_email} signs in`);
        } catch (cause) {
          toast.warning(`Settings saved, but ${mailbox.from_email} could not sign in`, { description: errorMessage(cause) });
        }
      } else {
        toast.success(`Settings saved for ${mailbox.from_email}`);
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (dirty && !problems(form) && !saving) void save(); }}>
      <Section title="Sending" hint="Campaign emails go out only inside these hours and days, spaced through the day, up to the daily limit.">
        <NumberField label="Daily limit" value={form.limit} onChange={(value) => set("limit", value)} min={1} max={999} unit="emails a day" hint={`${mailbox.sending.sent_today} sent today.`} />
        <HoursField start={form.start} end={form.end} onChange={(start, end) => setForm((current) => ({ ...current, start, end }))} />
        <DaysField value={form.days} onChange={(value) => set("days", value)} />
        <TimezoneField value={form.timezone} onChange={(value) => set("timezone", value)} />
      </Section>

      <Section title="Ramp" hint="A mailbox that starts sending at its full limit on day one looks like a spammer. A ramp starts it low and raises the limit a little each day.">
        <SwitchRow
          label={mailbox.ramp ? `${mailbox.ramp.complete ? "Ramp complete" : "Ramping"} · day ${mailbox.ramp.day} of ${mailbox.ramp.days}` : "Ramp this mailbox up"}
          checked={form.rampOn} onChange={(on) => set("rampOn", on)}
          hint={mailbox.ramp ? `${mailbox.ramp.limit} emails allowed today. Began ${mailbox.ramp.start_date}.` : "Starts today."}
        />
        {form.rampOn ? (
          <>
            <Field label="Length">
              {(id) => (
                <Select
                  id={id} className="w-full" value={form.rampLength} onChange={(value) => set("rampLength", value)}
                  options={[
                    { value: "original", label: `Two more emails each day (${originalDays} ${originalDays === 1 ? "day" : "days"} to reach ${form.limit || "the limit"})` },
                    { value: "custom", label: "A set number of days" },
                  ]}
                />
              )}
            </Field>
            {form.rampLength === "custom" ? (
              <div className="grid grid-cols-2 gap-2.5">
                <NumberField label="Start at" value={form.rampStart} onChange={(value) => set("rampStart", value)} min={1} max={999} unit="a day" hint={rampTooHigh ? <span className="text-bad">Cannot start above the daily limit.</span> : undefined} />
                <NumberField label="Reach the full limit in" value={form.rampDays} onChange={(value) => set("rampDays", value)} min={2} max={90} unit="days" />
              </div>
            ) : null}
          </>
        ) : null}
      </Section>

      <Section title="Guard" hint="When either rate over the last 30 days reaches its threshold, Linki pauses this mailbox and tells you. It waits for the minimum number of emails first, so two bounces out of ten do not stop a new mailbox.">
        <div className="grid grid-cols-3 gap-2.5">
          <RateField label="Bounces" value={form.bounce} onChange={(value) => set("bounce", value)} min={0.5} max={20} />
          <RateField label="Spam complaints" value={form.complaint} onChange={(value) => set("complaint", value)} min={0.01} max={2} />
          <NumberField label="After at least" value={form.sample} onChange={(value) => set("sample", value)} min={10} max={999} unit="emails" />
        </div>
        <p className="text-105 text-ink-3">
          Last 30 days: {mailbox.health.sent} sent, {mailbox.health.bounces} bounced, {mailbox.health.complaints} marked as spam.
        </p>
      </Section>

      <Section title="Warm-up" hint="Exchanges a few ordinary-looking emails a day with other mailboxes in the pool, which open them, reply to some, and move any that land in spam back to the inbox.">
        <SwitchRow label="In the warm-up pool" checked={form.warmupOn} onChange={(on) => set("warmupOn", on)} hint={`${mailbox.warmup.peers} other ${mailbox.warmup.peers === 1 ? "mailbox" : "mailboxes"} to exchange with. ${mailbox.warmup.sent_week} sent in the last seven days.`} />
        {form.warmupOn ? (
          <div className="grid grid-cols-2 gap-2.5">
            <NumberField label="Warm-up emails" value={form.warmupTarget} onChange={(value) => set("warmupTarget", value)} min={1} max={50} unit="a day" />
            <NumberField label="Replied to" value={form.warmupReplies} onChange={(value) => set("warmupReplies", value)} min={0} max={100} unit="%" />
          </div>
        ) : null}
      </Section>

      <Section title="Identity">
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Name in Linki">
            {(id) => <Input id={id} value={form.name} onChange={(event) => set("name", event.target.value)} maxLength={120} required />}
          </Field>
          <Field label="Name people see">
            {(id) => <Input id={id} value={form.fromName} onChange={(event) => set("fromName", event.target.value)} maxLength={120} placeholder="Ada Lovelace" />}
          </Field>
        </div>
        <Field label="Reply-to address" hint="Empty: replies come back to this mailbox, where Linki reads them. Replies sent elsewhere are not seen.">
          {(id) => <Input id={id} type="email" value={form.replyTo} onChange={(event) => set("replyTo", event.target.value)} placeholder={mailbox.from_email} autoComplete="off" spellCheck={false} />}
        </Field>
      </Section>

      <Section title="Connection" hint={provider ? "Connected with a Google app password. To replace it, paste the new one below." : "How Linki signs in. A change is tested as soon as it is saved."}>
        <div className="grid grid-cols-[1fr_92px_132px] gap-2.5">
          <Field label="SMTP server">
            {(id) => <Input id={id} value={form.smtpHost} onChange={(event) => set("smtpHost", event.target.value)} autoComplete="off" spellCheck={false} required />}
          </Field>
          <Field label="Port">
            {(id) => <Input id={id} inputMode="numeric" value={form.smtpPort} onChange={(event) => set("smtpPort", event.target.value.replace(/[^0-9]/g, "").slice(0, 5))} required />}
          </Field>
          <Field label="Security">
            {(id) => <Select id={id} className="w-full" value={form.security} onChange={(value) => set("security", value)} options={[{ value: "starttls", label: "STARTTLS" }, { value: "ssl", label: "SSL / TLS" }]} />}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="User name">
            {(id) => <Input id={id} value={form.username} onChange={(event) => set("username", event.target.value)} autoComplete="off" spellCheck={false} required />}
          </Field>
          <Field label={provider ? "App password" : "Password"} hint="Never shown. Empty keeps the one in use.">
            {(id) => <Input id={id} type="password" value={form.password} onChange={(event) => set("password", event.target.value)} placeholder="Unchanged" autoComplete="new-password" />}
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_92px] gap-2.5">
          <Field label="IMAP server" hint="Empty: this mailbox sends, and replies to it are never seen.">
            {(id) => <Input id={id} value={form.imapHost} onChange={(event) => set("imapHost", event.target.value)} autoComplete="off" spellCheck={false} />}
          </Field>
          <Field label="Port">
            {(id) => <Input id={id} inputMode="numeric" value={form.imapPort} onChange={(event) => set("imapPort", event.target.value.replace(/[^0-9]/g, "").slice(0, 5))} disabled={!form.imapHost.trim()} />}
          </Field>
        </div>
        {form.imapHost.trim() ? (
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="IMAP user name" hint="Empty uses the SMTP one.">
              {(id) => <Input id={id} value={form.imapUsername} onChange={(event) => set("imapUsername", event.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="IMAP password" hint="Empty keeps the one in use.">
              {(id) => <Input id={id} type="password" value={form.imapPassword} onChange={(event) => set("imapPassword", event.target.value)} placeholder="Unchanged" autoComplete="new-password" />}
            </Field>
          </div>
        ) : null}
        <SwitchRow label="Accept a self-signed certificate" hint="Only for a mail server you run yourself." checked={form.selfSigned} onChange={(on) => set("selfSigned", on)} />
        {change.connection ? <Alert tone="info" icon={PlugZap}>Saving signs in with the new details. If the server refuses them the mailbox is marked disconnected and sends nothing until they are put right.</Alert> : null}
      </Section>

      {error ? <Alert tone="bad">{error}</Alert> : null}

      <div className="sticky -bottom-5 -mx-5 -mb-5 flex h-16 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty || problems(form)}>Save changes</Button>
      </div>
    </form>
  );
}

function RateField({ label, value, onChange, min, max }: { label: string; value: string; onChange: (value: string) => void; min: number; max: number }) {
  const problem = rateProblem(value, min, max);
  return (
    <Field label={label} error={problem}>
      {(id) => (
        <Input
          id={id} inputMode="decimal" value={value} invalid={problem !== null}
          onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, "").slice(0, 6))}
          trailing={<span className="shrink-0 text-105 text-ink-3">%</span>}
        />
      )}
    </Field>
  );
}
