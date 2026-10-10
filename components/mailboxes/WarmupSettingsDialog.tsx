import { useState } from "react";
import { Flame } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, Pill, Segmented, Switch } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { Section, SwitchRow } from "@/components/linkedin-accounts/SettingsFields";
import { ROTATION_HINT, ROTATION_LABEL, warmupBadge, warmupSub, type MailboxRotation, type MailboxSettings, type MailboxView } from "./model";

export interface WarmupSettingsDialogProps {
  open: boolean;
  settings: MailboxSettings;
  mailboxes: MailboxView[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/** What the workspace has chosen for its mailboxes as a group: the warm-up pool, and how campaigns share contacts between mailboxes. */
export function WarmupSettingsDialog({ open, settings, mailboxes, canEdit, onClose, onSaved }: WarmupSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Warm-up and rotation" description="Settings for all of this workspace's mailboxes" icon={Flame} size="md">
      {open ? <SettingsForm settings={settings} mailboxes={mailboxes} canEdit={canEdit} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function SettingsForm({ settings, mailboxes, canEdit, onClose, onSaved }: Omit<WarmupSettingsDialogProps, "open">) {
  const [form, setForm] = useState<MailboxSettings>(settings);
  const [pool, setPool] = useState<Record<string, boolean>>(() => Object.fromEntries(mailboxes.map((mailbox) => [mailbox.id, mailbox.warmup.enabled])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changedSettings = (Object.keys(form) as Array<keyof MailboxSettings>).filter((key) => form[key] !== settings[key]);
  const changedPool = mailboxes.filter((mailbox) => pool[mailbox.id] !== mailbox.warmup.enabled);
  const dirty = changedSettings.length > 0 || changedPool.length > 0;
  const inPool = mailboxes.filter((mailbox) => pool[mailbox.id]).length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (changedSettings.length > 0) await api("/api/email-accounts/settings", { method: "PUT", body: Object.fromEntries(changedSettings.map((key) => [key, form[key]])) });
      for (const mailbox of changedPool) {
        await api("/api/platform/deliverability", { method: "POST", body: { action: "configure_warmup", email_account_id: mailbox.id, enabled: pool[mailbox.id], daily_target: mailbox.warmup.daily_target, reply_rate: mailbox.warmup.reply_rate } });
      }
      toast.success("Mailbox settings saved");
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
    <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (dirty && !saving && canEdit) void save(); }}>
      {!canEdit ? <Alert tone="neutral">An admin changes these settings.</Alert> : null}

      <Section title="Warm-up pool" hint={`${inPool} of ${mailboxes.length} ${mailboxes.length === 1 ? "mailbox" : "mailboxes"} in the pool. Each sends its daily number of warm-up emails to the others, inside its own sending hours. A mailbox's number and reply rate are in its settings.`}>
        <SwitchRow
          label="Exchange warm-up mail with other workspaces" checked={form.shared_pool} disabled={!canEdit} onChange={(on) => setForm((current) => ({ ...current, shared_pool: on }))}
          hint="A bigger pool warms a mailbox better than a few of your own writing to each other. Each side sees the other's sending address. Off keeps warm-up between this workspace's own mailboxes."
        />
        {mailboxes.length > 0 ? (
          <ul className="flex flex-col rounded-lg border border-line">
            {mailboxes.map((mailbox) => {
              const badge = warmupBadge(mailbox);
              return (
                <li key={mailbox.id} className="flex min-h-10 items-center gap-2.5 border-b border-line px-3 py-1.5 last:border-b-0">
                  <div className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-12 font-medium text-ink">{mailbox.from_email}</span>
                    <span className="truncate text-105 text-ink-3">{pool[mailbox.id] ? `${mailbox.warmup.daily_target} a day · ${mailbox.warmup.reply_rate}% replied to · ${warmupSub(mailbox)}` : "not in the pool"}</span>
                  </div>
                  {pool[mailbox.id] === mailbox.warmup.enabled ? <Pill tone={badge.tone} className="h-[19px] text-10">{badge.label}</Pill> : null}
                  <Switch checked={pool[mailbox.id] ?? false} disabled={!canEdit} label={`${mailbox.from_email} in the warm-up pool`} onChange={(on) => setPool((current) => ({ ...current, [mailbox.id]: on }))} />
                </li>
              );
            })}
          </ul>
        ) : null}
      </Section>

      <Section title="Sharing a campaign's contacts between mailboxes" hint="Applies when a campaign is started with more than one mailbox, and to contacts added to it later. Either way everyone at one company hears from the same mailbox.">
        <Segmented
          label="Rotation" value={form.rotation} className="self-start"
          onChange={(value: MailboxRotation) => { if (canEdit) setForm((current) => ({ ...current, rotation: value })); }}
          options={[{ value: "round_robin", label: ROTATION_LABEL.round_robin }, { value: "capacity", label: ROTATION_LABEL.capacity }]}
        />
        <p className="text-11 leading-4 text-ink-2">{ROTATION_HINT[form.rotation]}</p>
      </Section>

      <Section title="When a mailbox's guard pauses it">
        <SwitchRow
          label="Move contacts it has not emailed to the campaign's other mailboxes" checked={form.failover} disabled={!canEdit} onChange={(on) => setForm((current) => ({ ...current, failover: on }))}
          hint="Off, every contact waits for the mailbox to resume. On, only contacts with no email sent yet move, and a company moves together or not at all: a follow-up has to come from the mailbox that started the conversation. If the mailbox was paused for bounces, the list may be what is bouncing, and moving it takes that to the next mailbox."
        />
      </Section>

      {error ? <Alert tone="bad">{error}</Alert> : null}

      <div className="sticky -bottom-5 -mx-5 -mb-5 flex h-16 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="secondary" onClick={onClose}>{canEdit ? "Cancel" : "Close"}</Button>
        {canEdit ? <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>Save settings</Button> : null}
      </div>
    </form>
  );
}
