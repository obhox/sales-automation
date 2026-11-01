import { useState } from "react";
import {useTranslations} from "next-intl";
import { toast } from "sonner";
import { Alert, Button, Checkbox, Dialog } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
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
  const t = useTranslations("LinkedinPreset");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("title")} description={t("description")} size="md" padded={false}>
      {open ? <PresetForm preset={preset} accounts={accounts} canEdit={canEdit} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function PresetForm({ preset, accounts, canEdit, onClose, onSaved }: Omit<PresetDialogProps, "open">) {
  const t = useTranslations("LinkedinPreset");
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
        toast.success(t("savedApplied", {count: applied}));
      } else {
        toast.success(t("saved"));
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
        {!canEdit ? <Alert tone="neutral">{t("onlyAdmin")}</Alert> : null}

        <Section title={t("daily")}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <NumberField label={t("invitations")} value={form.connections} onChange={(value) => set("connections", value)} min={1} max={100} disabled={!canEdit} />
            <NumberField label={t("messages")} value={form.messages} onChange={(value) => set("messages", value)} min={1} max={200} disabled={!canEdit} />
            <NumberField label={t("visits")} value={form.visits} onChange={(value) => set("visits", value)} min={1} max={150} disabled={!canEdit} />
            <NumberField label={t("inmails")} value={form.inmails} onChange={(value) => set("inmails", value)} min={1} max={100} disabled={!canEdit} />
          </div>
        </Section>

        <Section title={t("weekly")}>
          <SwitchRow label={t("weeklySwitch")} hint={t("weeklyHint")} checked={form.weeklyOn} onChange={(on) => set("weeklyOn", on)} disabled={!canEdit} />
          {form.weeklyOn ? <NumberField label={t("weeklyCount")} value={form.weekly} onChange={(value) => set("weekly", value)} min={1} max={400} disabled={!canEdit} /> : null}
        </Section>

        <Section title={t("schedule")} hint={t("scheduleHint")}>
          <HoursField start={form.start} end={form.end} onChange={(start, end) => setForm((current) => ({ ...current, start, end }))} disabled={!canEdit} />
          <DaysField value={form.days} onChange={(value) => set("days", value)} disabled={!canEdit} />
        </Section>

        <Section title={t("unanswered")}>
          <div className="grid grid-cols-2 gap-2.5">
            <NumberField label={t("withdrawAfter")} value={form.waitDays} onChange={(value) => set("waitDays", value)} min={3} max={180} unit={t("days")} placeholder={t("default")} hint={t("defaultHint")} disabled={!canEdit} />
            <NumberField label={t("withdrawals")} value={form.withdrawals} onChange={(value) => set("withdrawals", value)} min={1} max={50} unit={t("perDay")} placeholder={t("default")} hint={t("defaultHint")} disabled={!canEdit} />
          </div>
          <SwitchRow label={t("withdrawSwitch")} hint={t("withdrawHint")} checked={form.autoWithdraw} onChange={(on) => set("autoWithdraw", on)} disabled={!canEdit} />
        </Section>

        <Section title={t("warmup")}>
          <SwitchRow label={t("warmupSwitch")} hint={t("warmupHint")} checked={form.rampOn} onChange={(on) => set("rampOn", on)} disabled={!canEdit} />
          {form.rampOn ? (
            <div className="grid grid-cols-2 gap-2.5">
              <NumberField label={t("startAt")} value={form.rampStart} onChange={(value) => set("rampStart", value)} min={1} max={100} unit={t("perDay")} hint={rampTooHigh ? <span className="text-bad">{t("rampTooHigh")}</span> : undefined} disabled={!canEdit} />
              <NumberField label={t("rampDays")} value={form.rampDays} onChange={(value) => set("rampDays", value)} min={2} max={60} unit={t("days")} disabled={!canEdit} />
            </div>
          ) : null}
        </Section>

        {canEdit && accounts.length > 0 ? (
          <Section title={t("applyExisting")} hint={t("applyExistingHint")}>
            <div className="flex flex-col gap-2 rounded-md border border-line p-2.5">
              {accounts.map((account) => (
                <label key={account.id} className="flex cursor-pointer items-center gap-2 text-12 text-ink">
                  <Checkbox
                    checked={apply.has(account.id)} label={t("applyTo", {name: account.name})}
                    onChange={(checked) => setApply((current) => {
                      const next = new Set(current);
                      if (checked) next.add(account.id);
                      else next.delete(account.id);
                      return next;
                    })}
                  />
                  <span className="min-w-0 flex-1 truncate">{account.name}</span>
                  <span className="shrink-0 text-105 text-ink-3">{t("currentInvites", {count: account.limits.connections_full})}</span>
                </label>
              ))}
            </div>
          </Section>
        ) : null}

        {error ? <Alert tone="bad">{error}</Alert> : null}
      </fieldset>

      <div className="flex h-16 shrink-0 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="secondary" onClick={onClose}>{canEdit ? t("cancel") : t("close")}</Button>
        {canEdit ? (
          <Button type="submit" variant="primary" loading={saving} disabled={hasProblem(form) || (!dirty && apply.size === 0)}>
            {apply.size > 0 ? t("saveApply", {count: apply.size}) : t("save")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
