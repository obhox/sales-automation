import { useState } from "react";
import { toast } from "sonner";
import { Alert, Button, Checkbox, Dialog } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { plural } from "@/lib/client/format";
import { DaysField, HoursField, NumberField, Section, SwitchRow, fromNumber, numberProblem, toNumber } from "./SettingsFields";
import type { LinkedinAccountView, LinkedinPreset } from "./model";

interface Form {
  connections: string; messages: string; visits: string; inmails: string;
  weeklyOn: boolean; weekly: string; withdrawals: string; waitDays: string; autoWithdraw: boolean;
  start: number; end: number; days: string;
  rampOn: boolean; rampDays: string; rampStart: string;
}

function formFor(preset: LinkedinPreset): Form {
  return {
    connections: String(preset.daily_connection_limit), messages: String(preset.daily_message_limit), visits: String(preset.daily_visit_limit), inmails: String(preset.daily_inmail_limit),
    weeklyOn: preset.weekly_connection_limit !== null, weekly: fromNumber(preset.weekly_connection_limit ?? 100),
    withdrawals: fromNumber(preset.daily_withdraw_limit), waitDays: fromNumber(preset.invite_max_wait_days), autoWithdraw: preset.withdraw_stale_invites,
    start: preset.active_hours_start, end: preset.active_hours_end, days: preset.working_days,
    rampOn: preset.ramp_days !== null, rampDays: fromNumber(preset.ramp_days ?? 14), rampStart: fromNumber(preset.ramp_start_limit ?? 5),
  };
}

function presetFrom(form: Form): LinkedinPreset {
  return {
    daily_connection_limit: Number(form.connections), daily_message_limit: Number(form.messages), daily_visit_limit: Number(form.visits), daily_inmail_limit: Number(form.inmails),
    weekly_connection_limit: form.weeklyOn ? toNumber(form.weekly) : null, daily_withdraw_limit: toNumber(form.withdrawals), invite_max_wait_days: toNumber(form.waitDays),
    active_hours_start: form.start, active_hours_end: form.end, working_days: form.days, withdraw_stale_invites: form.autoWithdraw,
    ramp_days: form.rampOn ? toNumber(form.rampDays) : null, ramp_start_limit: form.rampOn ? toNumber(form.rampStart) : null,
  };
}

function hasProblem(form: Form): boolean {
  return Boolean(
    numberProblem(form.connections, 1, 100, false) || numberProblem(form.messages, 1, 200, false) || numberProblem(form.visits, 1, 150, false) || numberProblem(form.inmails, 1, 100, false)
    || (form.weeklyOn && numberProblem(form.weekly, 1, 400, false)) || numberProblem(form.withdrawals, 1, 50, true) || numberProblem(form.waitDays, 3, 180, true)
    || (form.rampOn && (numberProblem(form.rampDays, 2, 60, false) || numberProblem(form.rampStart, 1, 100, false) || Number(form.rampStart) > Number(form.connections))),
  );
}

export interface PresetDialogProps {
  open: boolean;
  preset: LinkedinPreset;
  accounts: LinkedinAccountView[];
  /** Admins change the preset; everyone else reads it. */
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/** The limits and schedule a new LinkedIn account starts with, and a way to copy them onto existing accounts. */
export function PresetDialog({ open, preset, accounts, canEdit, onClose, onSaved }: PresetDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Limit presets" description="What a new LinkedIn account in this workspace starts with" size="md" padded={false}>
      {open ? <PresetForm preset={preset} accounts={accounts} canEdit={canEdit} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function PresetForm({ preset, accounts, canEdit, onClose, onSaved }: Omit<PresetDialogProps, "open">) {
  const [form, setForm] = useState<Form>(() => formFor(preset));
  const [apply, setApply] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const next = presetFrom(form);
  const dirty = (Object.keys(next) as Array<keyof LinkedinPreset>).some((key) => next[key] !== preset[key]);
  const rampTooHigh = form.rampOn && form.rampStart !== "" && form.connections !== "" && Number(form.rampStart) > Number(form.connections);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (dirty) await api("/api/accounts/preset", { method: "PUT", body: next });
      if (apply.size > 0) {
        const { applied } = await api<{ applied: number }>("/api/accounts/preset", { method: "POST", body: { account_ids: [...apply] } });
        toast.success(`Preset saved and applied to ${applied} ${plural(applied, "account", "accounts")}`);
      } else {
        toast.success("Preset saved");
      }
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
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (canEdit && !saving && !hasProblem(form) && (dirty || apply.size > 0)) void save();
      }}
    >
      <fieldset disabled={!canEdit} className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        {!canEdit ? <Alert tone="neutral">Only an admin can change the preset.</Alert> : null}

        <Section title="Daily limits">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <NumberField label="Invitations" value={form.connections} onChange={(value) => set("connections", value)} min={1} max={100} disabled={!canEdit} />
            <NumberField label="Messages" value={form.messages} onChange={(value) => set("messages", value)} min={1} max={200} disabled={!canEdit} />
            <NumberField label="Profile visits" value={form.visits} onChange={(value) => set("visits", value)} min={1} max={150} disabled={!canEdit} />
            <NumberField label="InMails" value={form.inmails} onChange={(value) => set("inmails", value)} min={1} max={100} disabled={!canEdit} />
          </div>
        </Section>

        <Section title="Weekly invitation limit">
          <SwitchRow label="Limit invitations over seven days" hint="Counts the last seven days. When it is reached an account's invitations wait; its messages and visits carry on." checked={form.weeklyOn} onChange={(on) => set("weeklyOn", on)} disabled={!canEdit} />
          {form.weeklyOn ? <NumberField label="Invitations in any seven days" value={form.weekly} onChange={(value) => set("weekly", value)} min={1} max={400} disabled={!canEdit} /> : null}
        </Section>

        <Section title="Schedule" hint="Each account keeps its own time zone.">
          <HoursField start={form.start} end={form.end} onChange={(start, end) => setForm((current) => ({ ...current, start, end }))} disabled={!canEdit} />
          <DaysField value={form.days} onChange={(value) => set("days", value)} disabled={!canEdit} />
        </Section>

        <Section title="Unanswered invitations">
          <div className="grid grid-cols-2 gap-2.5">
            <NumberField label="Withdraw after" value={form.waitDays} onChange={(value) => set("waitDays", value)} min={3} max={180} unit="days" placeholder="Default" hint="Empty uses the instance default." disabled={!canEdit} />
            <NumberField label="Withdrawals" value={form.withdrawals} onChange={(value) => set("withdrawals", value)} min={1} max={50} unit="a day" placeholder="Default" hint="Empty uses the instance default." disabled={!canEdit} />
          </div>
          <SwitchRow label="Take back old invitations automatically" hint="For new accounts. An existing account keeps its own switch." checked={form.autoWithdraw} onChange={(on) => set("autoWithdraw", on)} disabled={!canEdit} />
        </Section>

        <Section title="Warm-up">
          <SwitchRow label="Warm new accounts up" hint="A new account starts on fewer invitations and rises to the daily limit, beginning the day it first signs in." checked={form.rampOn} onChange={(on) => set("rampOn", on)} disabled={!canEdit} />
          {form.rampOn ? (
            <div className="grid grid-cols-2 gap-2.5">
              <NumberField label="Start at" value={form.rampStart} onChange={(value) => set("rampStart", value)} min={1} max={100} unit="a day" hint={rampTooHigh ? <span className="text-bad">Cannot start above the daily limit.</span> : undefined} disabled={!canEdit} />
              <NumberField label="Reach the full limit in" value={form.rampDays} onChange={(value) => set("rampDays", value)} min={2} max={60} unit="days" disabled={!canEdit} />
            </div>
          ) : null}
        </Section>

        {canEdit && accounts.length > 0 ? (
          <Section title="Also apply to existing accounts" hint="Copies the daily limits, weekly limit, withdrawal numbers and schedule. An account's warm-up, clean-up switch, time zone and proxy are left as they are.">
            <div className="flex flex-col gap-2 rounded-md border border-line p-2.5">
              {accounts.map((account) => (
                <label key={account.id} className="flex cursor-pointer items-center gap-2 text-12 text-ink">
                  <Checkbox
                    checked={apply.has(account.id)} label={`Apply to ${account.name}`}
                    onChange={(checked) => setApply((current) => {
                      const next = new Set(current);
                      if (checked) next.add(account.id);
                      else next.delete(account.id);
                      return next;
                    })}
                  />
                  <span className="min-w-0 flex-1 truncate">{account.name}</span>
                  <span className="shrink-0 text-105 text-ink-3">{account.limits.connections_full} invitations a day now</span>
                </label>
              ))}
            </div>
          </Section>
        ) : null}

        {error ? <Alert tone="bad">{error}</Alert> : null}
      </fieldset>

      <div className="flex h-16 shrink-0 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="secondary" onClick={onClose}>{canEdit ? "Cancel" : "Close"}</Button>
        {canEdit ? (
          <Button type="submit" variant="primary" loading={saving} disabled={hasProblem(form) || (!dirty && apply.size === 0)}>
            {apply.size > 0 ? `Save and apply to ${apply.size}` : "Save preset"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
