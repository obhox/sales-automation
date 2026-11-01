import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslations } from "next-intl";
import { Archive, ArchiveRestore, Pause, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CampaignFrame } from "@/components/campaigns/CampaignFrame";
import { Alert, Button, Card, CardHeader, Checkbox, ErrorState, Field, Input, Pill, Segmented, Select, Skeleton, Switch, Textarea, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import type { SetupOptions } from "@/lib/campaigns/setup";
import { SPAM_MODES, type SpamMode } from "@/lib/email/spam-check";
import { type BulkResult, type CampaignSummary } from "../model";
import { NO_OWNER, changeFrom, changesSending, formFrom, formProblem, type CampaignSettings, type PoolChange, type SettingsForm } from "./model";

interface SettingsData {
  campaign: CampaignSummary;
  settings: CampaignSettings;
  options: SetupOptions;
  members: Array<{ id: string; name: string }>;
  pool: PoolChange | null;
}


/** A titled block of the settings page. */
function Section({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <CardHeader title={title} subtitle={subtitle} />
      {children}
    </Card>
  );
}

/** A switch with what it does written beside it. */
function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-125 font-medium text-ink">{label}</span>
        <span className="text-115 leading-[17px] text-ink-2">{hint}</span>
      </span>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

/** One sender that can be ticked: its name, a line of detail and how it is doing. */
function SenderRow({ on, onChange, name, detail, pill, disabled }: { on: boolean; onChange: (on: boolean) => void; name: string; detail: string; pill: ReactNode; disabled?: boolean }) {
  const t = useTranslations("CampaignSettings");
  return (
    <label className={cn("flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors", disabled ? "cursor-default" : "cursor-pointer", on ? "border-brand bg-brand-tint" : "border-line bg-surface hover:border-line-strong")}>
      <Checkbox checked={on} onChange={onChange} label={t("useSender", {name})} disabled={disabled} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-125 font-semibold text-ink">{name}</span>
        <span className="truncate text-105 text-ink-3">{detail}</span>
      </span>
      {pill}
    </label>
  );
}

/** A campaign's Settings tab: what it is called, who owns it, when and from whom it sends, who it leaves out, what it tracks. */
export function SettingsScreen() {
  const t = useTranslations("CampaignSettings");
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const can = { member: useCan("member"), manager: useCan("manager"), admin: useCan("admin") };
  const { data, error, mutate } = useApi<SettingsData>(id ? `/api/workflows/${id}/settings` : null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState<"run" | "archive" | "delete" | null>(null);
  /** What the form was filled from. New data refills it only when nothing has been typed over it. */
  const filledFrom = useRef<string | null>(null);

  const stored = useMemo(() => (data ? formFrom(data.settings) : null), [data]);
  useEffect(() => {
    if (!stored) return;
    const print = JSON.stringify(stored);
    if (filledFrom.current === print) return;
    setForm((current) => (current && filledFrom.current !== null && JSON.stringify(current) !== filledFrom.current ? current : stored));
    filledFrom.current = print;
  }, [stored]);

  const settings = data?.settings;
  const campaign = data?.campaign;
  const change = form && stored ? changeFrom(form, stored) : null;
  const inFlight = settings?.run?.in_flight ?? 0;
  const archived = Boolean(settings?.archived);
  const readOnly = !can.member || archived;
  /** How a campaign sends is a manager's to change while contacts are part-way through it. */
  const sendingLocked = readOnly || (inFlight > 0 && !can.manager);
  const problem = form && settings ? formProblem(form, settings) : null;
  const set = (patch: Partial<SettingsForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const toggleIn = (key: "account_ids" | "email_account_ids", value: string, on: boolean) => form && set({ [key]: on ? [...form[key], value] : form[key].filter((other) => other !== value) } as Partial<SettingsForm>);

  async function save() {
    if (!id || !change || problem || saving) return;
    setSaving(true);
    try {
      const saved = await api<SettingsData>(`/api/workflows/${id}/settings`, { method: "PUT", body: change });
      filledFrom.current = null;
      setForm(formFrom(saved.settings));
      await mutate(saved, { revalidate: false });
      toast.success(t("saved"));
      if (saved.pool) toast.message(t("poolChanged", {outcome: t("poolOutcome", {reassigned: saved.pool.reassigned, finishing: saved.pool.finishing_elsewhere})}));
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function setRunning(action: "pause" | "resume") {
    if (!id || working) return;
    setWorking("run");
    try {
      const [outcome] = (await api<BulkResult>("/api/workflows/bulk", { method: "POST", body: { action, ids: [id] } })).results;
      if (!outcome?.ok) toast.error(outcome?.error ?? t("cannotChange"));
      else toast.success(action === "pause" ? t("pausedMessage") : t("resumedMessage"));
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(null);
      void mutate();
    }
  }

  async function setArchived(next: boolean) {
    if (!id || !campaign || working) return;
    if (next) {
      const ok = await confirm({
        title: t("archiveTitle", {name: campaign.name}),
        body: t("archiveBody"),
        confirmLabel: t("archive"),
        tone: "danger",
      });
      if (!ok) return;
    }
    setWorking("archive");
    try {
      // The same route the campaigns list uses, so the same rule holds: a campaign that is still sending is not archived.
      const [outcome] = (await api<BulkResult>("/api/workflows/bulk", { method: "POST", body: { action: next ? "archive" : "unarchive", ids: [id] } })).results;
      if (!outcome?.ok) toast.error(outcome?.error ?? t("cannotChange"));
      else toast.success(next ? t("archivedMessage") : t("restoredMessage"));
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(null);
      void mutate();
    }
  }

  async function remove() {
    if (!id || !campaign || !settings || working) return;
    const ok = await confirm({ title: t("deleteTitle", {name: campaign.name}), body: settings.enrolled === 0 ? t("deleteEmpty") : t("deleteWithPeople", {count: settings.enrolled, inFlight: settings.run?.in_flight ?? 0}), confirmLabel: t("deleteCampaign"), tone: "danger" });
    if (!ok) return;
    setWorking("delete");
    try {
      await api(`/api/workflows/${id}`, { method: "DELETE" });
      toast.success(t("deleted", {name: campaign.name}));
      void router.push("/campaigns");
    } catch (cause) {
      toast.error(errorMessage(cause));
      setWorking(null);
    }
  }

  const spamModeLabel = (mode: SpamMode) => t(mode === "off" ? "spamOff" : mode === "flag" ? "spamFlag" : "spamRemove");
  const spamModeHint = (mode: SpamMode) => t(mode === "off" ? "spamOffHint" : mode === "flag" ? "spamFlagHint" : "spamRemoveHint");
  const accounts = data?.options.linkedin_accounts ?? [];
  const mailboxes = data?.options.mailboxes ?? [];
  const usesLinkedin = settings?.channels.includes("linkedin") ?? false;
  const usesEmail = settings?.channels.includes("email") ?? false;
  const mayDelete = settings ? (settings.enrolled > 0 ? can.manager : can.member) : false;

  return (
    <CampaignFrame
      id={id ?? ""}
      campaign={campaign}
      tab="settings"
      meta={change ? <Pill tone="warn">{t("unsaved")}</Pill> : null}
      actions={change ? (
        <>
          <Button variant="ghost" disabled={saving} onClick={() => stored && setForm(stored)}>{t("discard")}</Button>
          <Button variant="primary" disabled={Boolean(problem)} loading={saving} onClick={() => void save()}>{t("saveChanges")}</Button>
        </>
      ) : null}
      aside={change ? (
        <span role="status" className="text-11 text-ink-2">
          {problem ?? (changesSending(change) && settings?.run ? t("inFlightNotice", {count: inFlight}) : null)}
        </span>
      ) : null}
      className="!gap-0 !p-0"
    >
      {error && !data ? (
        <div className="p-5"><ErrorState message={error.status === 404 ? t("missing") : errorMessage(error)} onRetry={error.status === 404 ? undefined : () => void mutate()} /></div>
      ) : !form || !settings || !campaign ? (
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-3.5 p-5">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[150px]" />)}</div>
      ) : (
        <>
          <div className="mx-auto flex w-full max-w-[780px] flex-col gap-3.5 p-5">
            {archived ? <Alert tone="info" title={t("archivedTitle")}>{t("archivedHint")}</Alert> : null}
            {!can.member ? <Alert tone="info">{t("readOnly")}</Alert> : null}
            {can.member && !archived && inFlight > 0 && !can.manager ? (
              <Alert tone="warn" title={t("inFlightTitle", {count: inFlight})}>
                {t("managerRestriction")}
              </Alert>
            ) : null}

            <Section title={t("campaign")} subtitle={t("campaignHint")}>
              <Field label={t("name")}>
                {(fieldId) => <Input id={fieldId} value={form.name} maxLength={160} disabled={readOnly} invalid={!form.name.trim()} onChange={(event) => set({ name: event.target.value })} />}
              </Field>
              <Field label={t("description")} hint={t("descriptionHint")}>
                {(fieldId) => <Textarea id={fieldId} rows={2} value={form.description} maxLength={500} disabled={readOnly} onChange={(event) => set({ description: event.target.value })} />}
              </Field>
              <Field label={t("owner")} hint={t("ownerHint")}>
                {(fieldId) => (
                  <Select
                    id={fieldId} value={form.owner_id} onChange={(owner_id) => set({ owner_id })} disabled={readOnly} className="w-[280px]"
                    options={[{ value: NO_OWNER, label: t("noOwner") }, ...data.members.map((member) => ({ value: member.id, label: member.name }))]}
                  />
                )}
              </Field>
            </Section>

            <Section title={t("schedule")} subtitle={t("scheduleHint")}>
              <div className="flex items-center justify-between gap-4 rounded-lg bg-subtle px-3 py-2.5">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-125 font-medium text-ink">
                    {t("status")}
                    <Pill tone={campaign.status === "active" ? "good" : campaign.status === "paused" ? "warn" : "neutral"} dot={campaign.status === "active"}>{t(campaign.status === "active" ? "statusActive" : campaign.status === "paused" ? "statusPaused" : campaign.status === "draft" ? "statusDraft" : campaign.status === "completed" ? "statusCompleted" : "statusArchived")}</Pill>
                  </span>
                  <span className="text-115 leading-[17px] text-ink-2">
                    {campaign.status === "active" ? t("activeHint") : campaign.status === "paused" ? t("pausedHint") : campaign.status === "draft" ? t("draftHint") : t("noneInFlight")}
                  </span>
                </span>
                {campaign.run && can.manager && !archived ? (
                  campaign.run.status === "running"
                    ? <Button icon={Pause} loading={working === "run"} onClick={() => void setRunning("pause")}>{t("pause")}</Button>
                    : <Button variant="primary" icon={Play} loading={working === "run"} onClick={() => void setRunning("resume")}>{t("resume")}</Button>
                ) : campaign.status === "draft" && can.member ? (
                  <Button asChild><Link href={`/campaigns?setup=${id}`}>{t("continueSetup")}</Link></Button>
                ) : null}
              </div>
              <Toggle
                label={t("recipientTimezone")}
                hint={t("recipientTimezoneHint")}
                checked={form.send_in_recipient_tz} onChange={(send_in_recipient_tz) => set({ send_in_recipient_tz })} disabled={sendingLocked}
              />
              <p className="text-115 leading-[17px] text-ink-2">
                {t("senderHours")} <Link href="/linkedin-accounts" className="font-semibold text-brand-strong hover:underline">{t("linkedinAccounts")}</Link> and <Link href="/mailboxes" className="font-semibold text-brand-strong hover:underline">{t("mailboxes")}</Link>.
                {t("builderHint")} <Link href={`/campaigns/${id}/sequence`} className="font-semibold text-brand-strong hover:underline">{t("sequenceBuilder")}</Link>.
              </p>
            </Section>

            <Section title={t("senders")} subtitle={t("sendersHint")}>
              {usesLinkedin ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-125 font-semibold text-ink">{t("linkedinAccounts")}</span>
                    <span className="text-11 text-ink-3">{form.account_ids.length === 0 ? t("noneChosen") : t("chosen", {count: form.account_ids.length})}</span>
                  </div>
                  {accounts.length === 0 ? <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-115 text-ink-2">{t("noLinkedin")} <Link href="/linkedin-accounts" className="font-semibold text-brand-strong hover:underline">{t("connectOne")}</Link>.</p> : null}
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {accounts.map((account) => (
                      <SenderRow
                        key={account.id} name={account.name} disabled={sendingLocked}
                        on={form.account_ids.includes(account.id)} onChange={(on) => toggleIn("account_ids", account.id, on)}
                        detail={t("invites", {limit: account.connections_per_day, remaining: account.connections_left_today})}
                        pill={<Pill size="sm" tone={account.status === "active" ? "good" : account.usable ? "warn" : "bad"}>{account.status === "active" ? t("accountActive") : account.status === "warming_up" ? t("accountWarming") : account.status === "weekly_hold" ? t("accountWeekly") : account.status === "paused" ? t("accountPaused") : account.status === "needs_signin" ? t("accountNeedsLogin") : account.status === "disconnected" ? t("accountDisconnected") : account.status === "never_connected" ? t("accountNotConnected") : account.status}</Pill>}
                      />
                    ))}
                  </div>
                  {form.account_ids.length > 1 ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-subtle px-3 py-2">
                      <span className="flex flex-col gap-0.5">
                        <span className="text-115 font-medium text-ink">{t("shareContacts")}</span>
                        <span className="text-105 text-ink-3">{form.rotation === "capacity" ? t("rotationCapacityHint") : t("rotationRoundHint")}</span>
                      </span>
                      <Segmented size="sm" label={t("rotationLabel")} value={form.rotation} onChange={(rotation) => !sendingLocked && set({ rotation })} options={[{ value: "round_robin", label: t("rotationRound") }, { value: "capacity", label: t("rotationCapacity") }]} />
                    </div>
                  ) : null}
                  <p className="text-11 leading-4 text-ink-3">
                    {settings.run
                      ? t("runUpdated")
                      : t("nextLaunch")}
                  </p>
                </div>
              ) : null}
              {usesLinkedin && usesEmail ? <hr className="border-line" /> : null}
              {usesEmail ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-125 font-semibold text-ink">{t("mailboxes")}</span>
                    <span className="text-11 text-ink-3">{form.email_account_ids.length === 0 ? t("noneChosen") : t("chosen", {count: form.email_account_ids.length})}</span>
                  </div>
                  {mailboxes.length === 0 ? <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-115 text-ink-2">{t("noMailbox")} <Link href="/mailboxes" className="font-semibold text-brand-strong hover:underline">{t("connectOne")}</Link>.</p> : null}
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {mailboxes.map((mailbox) => (
                      <SenderRow
                        key={mailbox.id} name={mailbox.name} disabled={sendingLocked}
                        on={form.email_account_ids.includes(mailbox.id)} onChange={(on) => toggleIn("email_account_ids", mailbox.id, on)}
                        detail={t("mailboxSends", {email: mailbox.email, count: mailbox.emails_per_day})}
                        pill={mailbox.paused ? <Pill size="sm" tone="bad">{t("accountPaused")}</Pill> : !mailbox.verified ? <Pill size="sm" tone="bad">{t("unverified")}</Pill> : mailbox.warming_up ? <Pill size="sm" tone="warn">{t("accountWarming")}</Pill> : <Pill size="sm" tone="good">{t("ready")}</Pill>}
                      />
                    ))}
                  </div>
                  <p className="text-11 leading-4 text-ink-3">
                    {t("mailboxRotationHint")}
                  </p>
                </div>
              ) : null}
              {!usesLinkedin && !usesEmail ? <p className="text-12 text-ink-2">{t("noStepsStart")} <Link href={`/campaigns/${id}/sequence`} className="font-semibold text-brand-strong hover:underline">{t("sequenceBuilder")}</Link>{t("noStepsEnd")}</p> : null}
            </Section>

            <Section title={t("exclusions")} subtitle={t("exclusionsHint")}>
              <Toggle label={t("excludeCustomers")} hint={t("excludeCustomersHint")} checked={form.exclude.customers} onChange={(customers) => set({ exclude: { ...form.exclude, customers } })} disabled={sendingLocked} />
              <Toggle label={t("excludeDeals")} hint={t("excludeDealsHint")} checked={form.exclude.open_deals} onChange={(open_deals) => set({ exclude: { ...form.exclude, open_deals } })} disabled={sendingLocked} />
              <p className="text-11 leading-4 text-ink-3">
                {t("exclusionsBody")}
              </p>
            </Section>

            <Section title={t("spamFilter")} subtitle={t("spamHint")}>
              <Segmented
                size="sm" label={t("spamForCampaign")} value={form.spam_filter}
                onChange={(spam_filter) => !sendingLocked && set({ spam_filter })}
                options={[{ value: "inherit", label: t("workspaceMode", {mode: spamModeLabel(form.spam_filter_default)}) }, ...SPAM_MODES.map((mode) => ({ value: mode, label: spamModeLabel(mode) }))]}
              />
              <p className="text-11 leading-4 text-ink-3">{spamModeHint(form.spam_filter === "inherit" ? form.spam_filter_default : form.spam_filter)}</p>
              <div className="flex flex-col gap-1.5 border-t border-line pt-3">
                <span className="text-105 font-semibold text-ink-2">{t("workspaceDefault")}</span>
                <Segmented
                  size="sm" label={t("workspaceDefault")} value={form.spam_filter_default}
                  onChange={(spam_filter_default: SpamMode) => can.admin && !readOnly && set({ spam_filter_default })}
                  options={SPAM_MODES.map((mode) => ({ value: mode, label: spamModeLabel(mode) }))}
                />
                <p className="text-11 leading-4 text-ink-3">
                  {can.admin ? t("workspaceAdminHint") : t("workspaceReadOnlyHint")}
                  {" "}{t("spamExplainer")}
                </p>
              </div>
            </Section>

            <Section title={t("tracking")} subtitle={t("trackingHint")}>
              {settings.tracking.length === 0 ? (
                <p className="text-12 text-ink-2">{t("noTracking")}</p>
              ) : (
                <div role="table" aria-label={t("trackingTable")} className="flex flex-col rounded-lg border border-line">
                  <div role="row" className="flex h-8 items-center gap-3 border-b border-line bg-subtle px-3 text-10 font-semibold uppercase tracking-label text-ink-3">
                    <span role="columnheader" className="min-w-0 flex-1">{t("emailHeader")}</span>
                    <span role="columnheader" className="w-[76px] shrink-0 text-center">{t("opens")}</span>
                    <span role="columnheader" className="w-[76px] shrink-0 text-center">{t("clicks")}</span>
                  </div>
                  {settings.tracking.map((step) => {
                    const row = form.tracking.find((entry) => entry.step_id === step.step_id) ?? { step_id: step.step_id, opens: step.opens, clicks: step.clicks };
                    const change = (patch: { opens?: boolean; clicks?: boolean }) => set({ tracking: form.tracking.map((entry) => (entry.step_id === step.step_id ? { ...entry, ...patch } : entry)) });
                    return (
                      <div key={step.step_id} role="row" className="flex min-h-11 items-center gap-3 border-b border-line px-3 last:border-b-0">
                        <span role="cell" className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="shrink-0 text-125 font-medium text-ink">{t("emailNumber", {number: step.email_number})}</span>
                          <span className="truncate text-115 text-ink-3">{step.subject || t("writtenAi")}</span>
                        </span>
                        <span role="cell" className="flex w-[76px] shrink-0 justify-center"><Switch checked={row.opens} onChange={(opens) => change({ opens })} label={t("trackOpens", {number: step.email_number})} disabled={sendingLocked} /></span>
                        <span role="cell" className="flex w-[76px] shrink-0 justify-center"><Switch checked={row.clicks} onChange={(clicks) => change({ clicks })} label={t("trackClicks", {number: step.email_number})} disabled={sendingLocked} /></span>
                      </div>
                    );
                  })}
                </div>
              )}
              {settings.tracking.length > 0 ? (
                <p className="text-11 leading-4 text-ink-3">
                  {t("trackingExplanation")}
                </p>
              ) : null}
              <Toggle
                label={t("autoPromote")}
                hint={t("autoPromoteHint")}
                checked={form.ab_auto_promote} onChange={(ab_auto_promote) => set({ ab_auto_promote })} disabled={sendingLocked}
              />
            </Section>

            {settings.signal_rules.length > 0 ? (
              <Section title={t("signals")} subtitle={t("signalsHint")}>
                <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
                  {settings.signal_rules.map((rule) => (
                    <li key={rule.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-125 font-medium text-ink">{rule.name}</span>
                        <span className="truncate text-115 text-ink-2">
                          {t("signalWhen", {type: rule.signal_type.replaceAll("_", " ")})}{rule.min_score > 0 ? t("signalIntent", {score: rule.min_score}) : ""}
                          {rule.auto_start ? t("signalAuto") : ""}
                        </span>
                      </span>
                      <Pill tone={rule.enabled ? "good" : "neutral"} dot={rule.enabled}>{rule.enabled ? t("live") : t("off")}</Pill>
                    </li>
                  ))}
                </ul>
                <p className="text-11 leading-4 text-ink-3">{t("rulesMade")} <Link href="/signals?tab=rules" className="font-semibold text-brand-strong hover:underline">{t("signals")}</Link>.</p>
              </Section>
            ) : null}

            {can.member ? (
              <Section title={t("archiveDelete")} subtitle={t("archiveDeleteHint")}>
                <div className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-125 font-medium text-ink">{archived ? t("bringBackTitle") : t("archiveCampaignTitle")}</span>
                    <span className="text-115 leading-[17px] text-ink-2">
                      {archived ? t("bringBackHint") : campaign.status === "active" ? t("activeCannotArchive") : t("archiveInactiveHint")}
                    </span>
                  </span>
                  <Button icon={archived ? ArchiveRestore : Archive} disabled={!archived && campaign.status === "active"} loading={working === "archive"} onClick={() => void setArchived(!archived)}>{archived ? t("bringBack") : t("archive")}</Button>
                </div>
                <hr className="border-line" />
                <div className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-125 font-medium text-ink">{t("deleteCampaignTitle")}</span>
                    <span className="text-115 leading-[17px] text-ink-2">{mayDelete ? settings.enrolled === 0 ? t("deleteEmpty") : t("deleteWithPeople", {count: settings.enrolled, inFlight: settings.run?.in_flight ?? 0}) : t("deleteRequiresManager")}</span>
                  </span>
                  <Button variant="danger" icon={Trash2} disabled={!mayDelete} loading={working === "delete"} onClick={() => void remove()}>{t("delete")}</Button>
                </div>
              </Section>
            ) : null}
          </div>
        </>
      )}
    </CampaignFrame>
  );
}
