import { useState } from "react";
import { toast } from "sonner";
import { Alert, Button, Drawer, Field, Input, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { DaysField, HoursField, NumberField, Section, SwitchRow, TimezoneField, fromNumber, numberProblem, toNumber } from "./SettingsFields";
import type { LinkedinAccountView, Member } from "./model";

const NO_OWNER = "none";

interface Form {
  name: string; plan: string; owner: string;
  connections: string; messages: string; visits: string; inmails: string;
  weeklyOn: boolean; weekly: string;
  withdrawals: string; waitDays: string; autoWithdraw: boolean;
  start: number; end: number; days: string; timezone: string;
  rampOn: boolean; rampDays: string; rampStart: string;
  proxyUrl: string; proxyUser: string; proxyPassword: string; proxyLabel: string;
}

function formFor(account: LinkedinAccountView): Form {
  return {
    name: account.name, plan: account.plan ?? "", owner: account.owner?.id ?? NO_OWNER,
    connections: String(account.limits.connections_full), messages: String(account.limits.messages), visits: String(account.limits.visits), inmails: String(account.limits.inmails),
    weeklyOn: account.weekly.limit !== null, weekly: fromNumber(account.weekly.limit ?? 100),
    withdrawals: fromNumber(account.invites.withdraw_limit_own), waitDays: fromNumber(account.invites.wait_days_own), autoWithdraw: account.invites.auto_withdraw,
    start: account.schedule.start, end: account.schedule.end, days: account.schedule.days, timezone: account.schedule.timezone,
    rampOn: account.ramp !== null || account.ramp_planned !== null,
    rampDays: fromNumber(account.ramp?.days ?? account.ramp_planned?.days ?? 14), rampStart: fromNumber(account.ramp?.start_limit ?? account.ramp_planned?.start_limit ?? 5),
    proxyUrl: account.proxy?.server ?? "", proxyUser: "", proxyPassword: "", proxyLabel: account.proxy?.label ?? "",
  };
}

/** Today as the server stores a warm-up's first day. */
const today = () => new Date().toISOString().slice(0, 10);

/** Only what changed is sent, so saving one field never rewrites another. */
function changes(account: LinkedinAccountView, form: Form): Record<string, unknown> {
  const before = formFor(account);
  const body: Record<string, unknown> = {};
  if (form.name.trim() !== before.name) body.name = form.name.trim();
  if (form.plan.trim() !== before.plan) body.plan = form.plan.trim() || null;
  if (form.owner !== before.owner) body.owner_id = form.owner === NO_OWNER ? null : form.owner;
  if (form.connections !== before.connections) body.daily_connection_limit = toNumber(form.connections);
  if (form.messages !== before.messages) body.daily_message_limit = toNumber(form.messages);
  if (form.visits !== before.visits) body.daily_visit_limit = toNumber(form.visits);
  if (form.inmails !== before.inmails) body.daily_inmail_limit = toNumber(form.inmails);
  const weekly = form.weeklyOn ? toNumber(form.weekly) : null;
  if (weekly !== account.weekly.limit) body.weekly_connection_limit = weekly;
  if (form.withdrawals !== before.withdrawals) body.daily_withdraw_limit = toNumber(form.withdrawals);
  if (form.waitDays !== before.waitDays) body.invite_max_wait_days = toNumber(form.waitDays);
  if (form.autoWithdraw !== before.autoWithdraw) body.withdraw_stale_invites = form.autoWithdraw;
  if (form.start !== before.start) body.active_hours_start = form.start;
  if (form.end !== before.end) body.active_hours_end = form.end;
  if (form.days !== before.days) body.working_days = form.days;
  if (form.timezone !== before.timezone) body.timezone = form.timezone;
  if (form.rampOn !== before.rampOn || (form.rampOn && (form.rampDays !== before.rampDays || form.rampStart !== before.rampStart))) {
    if (form.rampOn) {
      body.ramp_days = toNumber(form.rampDays);
      body.ramp_start_limit = toNumber(form.rampStart);
      // A warm-up being adjusted keeps its first day. One being switched on starts today,
      // or on the day the account first signs in if it has not yet.
      body.ramp_start_date = account.ramp?.start_date ?? (account.session.signed_in ? today() : null);
    } else {
      body.ramp_days = null;
      body.ramp_start_limit = null;
      body.ramp_start_date = null;
    }
  }
  if (form.proxyUrl.trim() !== before.proxyUrl) body.proxy_url = form.proxyUrl.trim();
  if (form.proxyUrl.trim()) {
    if (form.proxyLabel.trim() !== before.proxyLabel) body.proxy_label = form.proxyLabel.trim() || null;
    if (form.proxyUser.trim()) body.proxy_username = form.proxyUser.trim();
    if (form.proxyPassword) body.proxy_password = form.proxyPassword;
  }
  return body;
}

function problems(form: Form): boolean {
  return Boolean(
    !form.name.trim()
    || numberProblem(form.connections, 1, 100, false) || numberProblem(form.messages, 1, 200, false)
    || numberProblem(form.visits, 1, 150, false) || numberProblem(form.inmails, 1, 100, false)
    || (form.weeklyOn && numberProblem(form.weekly, 1, 400, false))
    || numberProblem(form.withdrawals, 1, 50, true) || numberProblem(form.waitDays, 3, 180, true)
    || (form.rampOn && (numberProblem(form.rampDays, 2, 60, false) || numberProblem(form.rampStart, 1, 100, false) || Number(form.rampStart) > Number(form.connections)))
    || !form.timezone,
  );
}

export interface EditAccountDrawerProps {
  /** The account being edited; null closes the drawer. */
  account: LinkedinAccountView | null;
  members: Member[];
  onClose: () => void;
  onSaved: () => void;
}

export function EditAccountDrawer({ account, members, onClose, onSaved }: EditAccountDrawerProps) {
  return (
    <Drawer open={account !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={account ? `${account.name}` : "Account settings"} description="Limits, schedule, warm-up and proxy" width={480} footer={null}>
      {account ? <EditForm key={account.id} account={account} members={members} onClose={onClose} onSaved={onSaved} /> : null}
    </Drawer>
  );
}

function EditForm({ account, members, onClose, onSaved }: { account: LinkedinAccountView; members: Member[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Form>(() => formFor(account));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const body = changes(account, form);
  const dirty = Object.keys(body).length > 0;
  const proxyChanged = "proxy_url" in body || "proxy_username" in body || "proxy_password" in body;
  const rampTooHigh = form.rampOn && form.rampStart !== "" && form.connections !== "" && Number(form.rampStart) > Number(form.connections);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/accounts/${account.id}`, { method: "PUT", body });
      toast.success(`Settings saved for ${account.name}`);
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !problems(form) && !saving) void save();
      }}
    >
      <Section title="Daily limits" hint="What this account may do in one of its own calendar days. Numbers above these ranges are how accounts get restricted.">
        <div className="grid grid-cols-2 gap-2.5">
          <NumberField label="Invitations" value={form.connections} onChange={(value) => set("connections", value)} min={1} max={100} unit="a day" />
          <NumberField label="Messages" value={form.messages} onChange={(value) => set("messages", value)} min={1} max={200} unit="a day" />
          <NumberField label="Profile visits" value={form.visits} onChange={(value) => set("visits", value)} min={1} max={150} unit="a day" />
          <NumberField label="InMails" value={form.inmails} onChange={(value) => set("inmails", value)} min={1} max={100} unit="a day" />
        </div>
      </Section>

      <Section title="Weekly invitation limit">
        <SwitchRow
          label="Limit invitations over seven days" checked={form.weeklyOn} onChange={(on) => set("weeklyOn", on)}
          hint={`Counts the last seven days, not a calendar week. When it is reached this account's invitations wait and its messages and visits carry on. ${account.weekly.used} sent in the last seven days.`}
        />
        {form.weeklyOn ? <NumberField label="Invitations in any seven days" value={form.weekly} onChange={(value) => set("weekly", value)} min={1} max={400} /> : null}
      </Section>

      <Section title="Schedule" hint="Nothing is done on LinkedIn outside these hours and days.">
        <HoursField start={form.start} end={form.end} onChange={(start, end) => setForm((current) => ({ ...current, start, end }))} />
        <DaysField value={form.days} onChange={(value) => set("days", value)} />
        <TimezoneField value={form.timezone} onChange={(value) => set("timezone", value)} />
      </Section>

      <Section title="Unanswered invitations">
        <div className="grid grid-cols-2 gap-2.5">
          <NumberField label="Withdraw after" value={form.waitDays} onChange={(value) => set("waitDays", value)} min={3} max={180} unit="days" placeholder={String(account.invites.wait_days_own === null ? account.invites.wait_days : 30)} hint="Empty uses the instance default." />
          <NumberField label="Withdrawals" value={form.withdrawals} onChange={(value) => set("withdrawals", value)} min={1} max={50} unit="a day" placeholder={String(account.invites.withdraw_limit_own === null ? account.limits.withdrawals : 10)} hint="Empty uses the instance default." />
        </div>
        <SwitchRow
          label="Take back old invitations automatically" checked={form.autoWithdraw} onChange={(on) => set("autoWithdraw", on)}
          hint={`Invitations left over from finished campaigns are looked up on LinkedIn and withdrawn if still pending, a few a day inside working hours. ${account.invites.stale.waiting} waiting now. A withdrawal cannot be undone, and LinkedIn blocks inviting that person again for about three weeks.`}
        />
      </Section>

      <Section title="Warm-up" hint="Start a new or rested account on fewer invitations and raise the number a little each day until it reaches the daily limit.">
        <SwitchRow
          label={account.ramp ? `Warming up · day ${account.ramp.day} of ${account.ramp.days}` : "Warm this account up"} checked={form.rampOn} onChange={(on) => set("rampOn", on)}
          hint={account.ramp ? `${account.ramp.limit} invitations allowed today.` : account.session.signed_in ? "Starts today." : "Starts on the day this account first signs in."}
        />
        {form.rampOn ? (
          <div className="grid grid-cols-2 gap-2.5">
            <NumberField label="Start at" value={form.rampStart} onChange={(value) => set("rampStart", value)} min={1} max={100} unit="a day" hint={rampTooHigh ? <span className="text-bad">Cannot start above the daily limit.</span> : undefined} />
            <NumberField label="Reach the full limit in" value={form.rampDays} onChange={(value) => set("rampDays", value)} min={2} max={60} unit="days" />
          </div>
        ) : null}
      </Section>

      <Section title="Account">
        <Field label="Name">
          {(id) => <Input id={id} value={form.name} onChange={(event) => set("name", event.target.value)} maxLength={120} required />}
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="LinkedIn plan" hint="A label for your own reference.">
            {(id) => <Input id={id} value={form.plan} onChange={(event) => set("plan", event.target.value)} placeholder="Sales Navigator Core" maxLength={80} />}
          </Field>
          <Field label="Owner">
            {(id) => (
              <Select
                id={id} className="w-full" value={form.owner} onChange={(value) => set("owner", value)}
                options={[{ value: NO_OWNER, label: "Nobody" }, ...members.map((member) => ({ value: member.id, label: member.name }))]}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section title="Proxy" hint="An address you supply. Once an account has signed in through a proxy it is always used through it, and never without it.">
        <Field label="Proxy address" hint="http://, https:// or socks5://, host and port. Empty removes the proxy.">
          {(id) => <Input id={id} value={form.proxyUrl} onChange={(event) => set("proxyUrl", event.target.value)} placeholder="http://host:port" autoComplete="off" spellCheck={false} />}
        </Field>
        {form.proxyUrl.trim() ? (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="User name">
                {(id) => <Input id={id} value={form.proxyUser} onChange={(event) => set("proxyUser", event.target.value)} placeholder={account.proxy?.has_credentials ? "Unchanged" : ""} autoComplete="off" />}
              </Field>
              <Field label="Password">
                {(id) => <Input id={id} type="password" value={form.proxyPassword} onChange={(event) => set("proxyPassword", event.target.value)} placeholder={account.proxy?.has_credentials ? "Unchanged" : ""} autoComplete="new-password" />}
              </Field>
            </div>
            <Field label="Label" hint="Shown on the account, for example a city.">
              {(id) => <Input id={id} value={form.proxyLabel} onChange={(event) => set("proxyLabel", event.target.value)} placeholder="Frankfurt" maxLength={80} />}
            </Field>
          </>
        ) : null}
        {proxyChanged && account.session.signed_in ? (
          <Alert tone="info">The session this account is signed in with keeps the connection it was made on. Sign the account in again to move it to the new proxy setting.</Alert>
        ) : account.proxy && account.session.signed_in && !account.proxy.in_use ? (
          <Alert tone="warn">The live session is not using this proxy yet. Sign the account in again to apply it.</Alert>
        ) : null}
      </Section>

      {error ? <Alert tone="bad">{error}</Alert> : null}

      <div className="sticky -bottom-5 -mx-5 -mb-5 flex h-16 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty || problems(form)}>Save changes</Button>
      </div>
    </form>
  );
}
