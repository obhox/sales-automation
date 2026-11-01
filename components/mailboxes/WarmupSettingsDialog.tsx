import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Flame } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, Pill, Segmented, Switch } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { Section, SwitchRow } from "@/components/linkedin-accounts/SettingsFields";
import { warmupBadge, warmupSub, type MailboxRotation, type MailboxSettings, type MailboxView } from "./model";

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
  const t = useTranslations("MailboxWarmup");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("title")} description={t("description")} icon={Flame} size="md">
      {open ? <SettingsForm settings={settings} mailboxes={mailboxes} canEdit={canEdit} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function SettingsForm({ settings, mailboxes, canEdit, onClose, onSaved }: Omit<WarmupSettingsDialogProps, "open">) {
  const t = useTranslations("MailboxWarmup");
  const locale = useLocale();
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
      toast.success(t("saved"));
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
      {!canEdit ? <Alert tone="neutral">{t("adminOnly")}</Alert> : null}

      <Section title={t("poolTitle")} hint={t("poolHint", {count: inPool, total: mailboxes.length})}>
        <SwitchRow
          label={t("sharedPool")} checked={form.shared_pool} disabled={!canEdit} onChange={(on) => setForm((current) => ({ ...current, shared_pool: on }))}
          hint={t("sharedHint")}
        />
        {mailboxes.length > 0 ? (
          <ul className="flex flex-col rounded-lg border border-line">
            {mailboxes.map((mailbox) => {
              const badge = warmupBadge(mailbox);
              const statusLabels: Record<string, string> = {
                warmed: t("warmed"), warming: t("warming"), paused: t("paused"),
                stopped: t("stopped"), off: t("off"),
              };
              const sub = locale === "pt-BR"
                ? mailbox.warmup.state === "off" ? t("notInPool")
                  : ["paused", "stopped"].includes(mailbox.warmup.state) ? t("warmupHalted")
                    : mailbox.warmup.state === "warming" || mailbox.warmup.sent_week > 0
                      ? t("warmupStats", {sent: mailbox.warmup.sent_week, rescued: mailbox.warmup.rescued_week})
                      : mailbox.warmup.peers === 0 ? t("noPeers") : t("peers", {count: mailbox.warmup.peers})
                : warmupSub(mailbox);
              return (
                <li key={mailbox.id} className="flex min-h-10 items-center gap-2.5 border-b border-line px-3 py-1.5 last:border-b-0">
                  <div className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-12 font-medium text-ink">{mailbox.from_email}</span>
                    <span className="truncate text-105 text-ink-3">{pool[mailbox.id] ? t("dailySummary", {daily: mailbox.warmup.daily_target, rate: mailbox.warmup.reply_rate, detail: sub}) : t("notInPool")}</span>
                  </div>
                  {pool[mailbox.id] === mailbox.warmup.enabled ? <Pill tone={badge.tone} className="h-[19px] text-10">{locale === "pt-BR" ? statusLabels[mailbox.warmup.state] ?? badge.label : badge.label}</Pill> : null}
                  <Switch checked={pool[mailbox.id] ?? false} disabled={!canEdit} label={t("mailboxInPool", {email: mailbox.from_email})} onChange={(on) => setPool((current) => ({ ...current, [mailbox.id]: on }))} />
                </li>
              );
            })}
          </ul>
        ) : null}
      </Section>

      <Section title={t("sharingTitle")} hint={t("sharingHint")}>
        <Segmented
          label={t("rotation")} value={form.rotation} className="self-start"
          onChange={(value: MailboxRotation) => { if (canEdit) setForm((current) => ({ ...current, rotation: value })); }}
          options={[{ value: "round_robin", label: t("rotationRound") }, { value: "capacity", label: t("rotationCapacity") }]}
        />
        <p className="text-11 leading-4 text-ink-2">{t(form.rotation === "round_robin" ? "rotationRoundHint" : "rotationCapacityHint")}</p>
      </Section>

      <Section title={t("guardTitle")}>
        <SwitchRow
          label={t("failover")} checked={form.failover} disabled={!canEdit} onChange={(on) => setForm((current) => ({ ...current, failover: on }))}
          hint={t("failoverHint")}
        />
      </Section>

      {error ? <Alert tone="bad">{error}</Alert> : null}

      <div className="sticky -bottom-5 -mx-5 -mb-5 flex h-16 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="secondary" onClick={onClose}>{canEdit ? t("cancel") : t("close")}</Button>
        {canEdit ? <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>{t("save")}</Button> : null}
      </div>
    </form>
  );
}
