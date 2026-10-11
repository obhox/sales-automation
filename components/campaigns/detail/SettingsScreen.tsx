import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { Archive, ArchiveRestore, Pause, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CampaignFrame } from "@/components/campaigns/CampaignFrame";
import { Alert, Button, Card, CardHeader, Checkbox, ErrorState, Field, Input, Pill, Segmented, Select, Skeleton, Switch, Textarea, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, plural } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import type { SetupOptions } from "@/lib/campaigns/setup";
import { STATUS_LABEL, type BulkResult, type CampaignSummary } from "../model";
import { NO_OWNER, changeFrom, changesSending, deleteWarning, formFrom, formProblem, poolOutcome, type CampaignSettings, type PoolChange, type SettingsForm } from "./model";

interface SettingsData {
  campaign: CampaignSummary;
  settings: CampaignSettings;
  options: SetupOptions;
  members: Array<{ id: string; name: string }>;
  pool: PoolChange | null;
}

const ACCOUNT_WORD: Record<string, string> = { active: "Active", warming_up: "Warming up", weekly_hold: "Weekly limit", paused: "Paused", needs_signin: "Needs sign-in", disconnected: "Disconnected", never_connected: "Not connected" };

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
  return (
    <label className={cn("flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors", disabled ? "cursor-default" : "cursor-pointer", on ? "border-brand bg-brand-tint" : "border-line bg-surface hover:border-line-strong")}>
      <Checkbox checked={on} onChange={onChange} label={`Use ${name}`} disabled={disabled} />
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
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const can = { member: useCan("member"), manager: useCan("manager") };
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
      toast.success("Settings saved");
      if (saved.pool) toast.message(`LinkedIn accounts changed: ${poolOutcome(saved.pool)}`);
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
      if (!outcome?.ok) toast.error(outcome?.error ?? "The campaign could not be changed");
      else toast.success(action === "pause" ? "Campaign paused: nothing more is sent until it is resumed" : "Campaign resumed");
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
        title: `Archive ${campaign.name}?`,
        body: "It leaves the campaigns list. Its prospects, history and figures are kept, and it can be brought back from the Archived tab.",
        confirmLabel: "Archive",
        tone: "danger",
      });
      if (!ok) return;
    }
    setWorking("archive");
    try {
      // The same route the campaigns list uses, so the same rule holds: a campaign that is still sending is not archived.
      const [outcome] = (await api<BulkResult>("/api/workflows/bulk", { method: "POST", body: { action: next ? "archive" : "unarchive", ids: [id] } })).results;
      if (!outcome?.ok) toast.error(outcome?.error ?? "The campaign could not be changed");
      else toast.success(next ? "Campaign archived" : "Campaign brought back");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(null);
      void mutate();
    }
  }

  async function remove() {
    if (!id || !campaign || !settings || working) return;
    const ok = await confirm({ title: `Delete ${campaign.name}?`, body: deleteWarning(settings), confirmLabel: "Delete campaign", tone: "danger" });
    if (!ok) return;
    setWorking("delete");
    try {
      await api(`/api/workflows/${id}`, { method: "DELETE" });
      toast.success(`${campaign.name} was deleted`);
      void router.push("/campaigns");
    } catch (cause) {
      toast.error(errorMessage(cause));
      setWorking(null);
    }
  }

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
      meta={change ? <Pill tone="warn">Unsaved changes</Pill> : null}
      actions={change ? (
        <>
          <Button variant="ghost" disabled={saving} onClick={() => stored && setForm(stored)}>Discard</Button>
          <Button variant="primary" disabled={Boolean(problem)} loading={saving} onClick={() => void save()}>Save changes</Button>
        </>
      ) : null}
      aside={change ? (
        <span role="status" className="text-11 text-ink-2">
          {problem ?? (changesSending(change) && settings?.run ? `${formatCount(inFlight)} ${plural(inFlight, "contact is", "contacts are")} part-way through; the change applies from the next send.` : null)}
        </span>
      ) : null}
      className="!gap-0 !p-0"
    >
      {error && !data ? (
        <div className="p-5"><ErrorState message={error.status === 404 ? "This campaign does not exist, or is in another workspace." : errorMessage(error)} onRetry={error.status === 404 ? undefined : () => void mutate()} /></div>
      ) : !form || !settings || !campaign ? (
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-3.5 p-5">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[150px]" />)}</div>
      ) : (
        <>
          <div className="mx-auto flex w-full max-w-[780px] flex-col gap-3.5 p-5">
            {archived ? <Alert tone="info" title="This campaign is archived">Bring it back to change its settings.</Alert> : null}
            {!can.member ? <Alert tone="info">You can see these settings. Changing them needs a member of the workspace.</Alert> : null}
            {can.member && !archived && inFlight > 0 && !can.manager ? (
              <Alert tone="warn" title={`${formatCount(inFlight)} ${plural(inFlight, "contact is", "contacts are")} part-way through this campaign`}>
                You can rename it or change its owner. Changing how it sends (time zone, senders, exclusions, tracking) needs a manager while it is in flight.
              </Alert>
            ) : null}

            <Section title="Campaign" subtitle="What it is called and who looks after it">
              <Field label="Name">
                {(fieldId) => <Input id={fieldId} value={form.name} maxLength={160} disabled={readOnly} invalid={!form.name.trim()} onChange={(event) => set({ name: event.target.value })} />}
              </Field>
              <Field label="Description" hint="A note for the team. It is never sent to anyone.">
                {(fieldId) => <Textarea id={fieldId} rows={2} value={form.description} maxLength={500} disabled={readOnly} onChange={(event) => set({ description: event.target.value })} />}
              </Field>
              <Field label="Owner" hint="Shown in the campaigns list, and who the dashboard's member filter counts it under.">
                {(fieldId) => (
                  <Select
                    id={fieldId} value={form.owner_id} onChange={(owner_id) => set({ owner_id })} disabled={readOnly} className="w-[280px]"
                    options={[{ value: NO_OWNER, label: "No owner" }, ...data.members.map((member) => ({ value: member.id, label: member.name }))]}
                  />
                )}
              </Field>
            </Section>

            <Section title="Schedule" subtitle="When the campaign is allowed to send">
              <div className="flex items-center justify-between gap-4 rounded-lg bg-subtle px-3 py-2.5">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-125 font-medium text-ink">
                    Status
                    <Pill tone={campaign.status === "active" ? "good" : campaign.status === "paused" ? "warn" : "neutral"} dot={campaign.status === "active"}>{STATUS_LABEL[campaign.status]}</Pill>
                  </span>
                  <span className="text-115 leading-[17px] text-ink-2">
                    {campaign.status === "active" ? "Sending as its steps fall due." : campaign.status === "paused" ? "Paused: every contact waits where they are until it is resumed." : campaign.status === "draft" ? "Not launched yet." : "Nothing is in flight."}
                  </span>
                </span>
                {campaign.run && can.manager && !archived ? (
                  campaign.run.status === "running"
                    ? <Button icon={Pause} loading={working === "run"} onClick={() => void setRunning("pause")}>Pause</Button>
                    : <Button variant="primary" icon={Play} loading={working === "run"} onClick={() => void setRunning("resume")}>Resume</Button>
                ) : campaign.status === "draft" && can.member ? (
                  <Button asChild><Link href={`/campaigns?setup=${id}`}>Continue setup</Link></Button>
                ) : null}
              </div>
              <Toggle
                label="Send in each contact's time zone"
                hint="A step's sending window is read on the contact's clock where their time zone is known, and on the sender's where it is not."
                checked={form.send_in_recipient_tz} onChange={(send_in_recipient_tz) => set({ send_in_recipient_tz })} disabled={sendingLocked}
              />
              <p className="text-115 leading-[17px] text-ink-2">
                Working hours and days belong to each sender: set them on <Link href="/linkedin-accounts" className="font-semibold text-brand-strong hover:underline">LinkedIn accounts</Link> and <Link href="/mailboxes" className="font-semibold text-brand-strong hover:underline">Mailboxes</Link>.
                A single step&rsquo;s own window, and the waits between steps, are set in the <Link href={`/campaigns/${id}/sequence`} className="font-semibold text-brand-strong hover:underline">sequence builder</Link>.
              </p>
            </Section>

            <Section title="Senders" subtitle="The LinkedIn accounts and mailboxes this campaign sends from">
              {usesLinkedin ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-125 font-semibold text-ink">LinkedIn accounts</span>
                    <span className="text-11 text-ink-3">{form.account_ids.length === 0 ? "None chosen" : `${form.account_ids.length} chosen`}</span>
                  </div>
                  {accounts.length === 0 ? <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-115 text-ink-2">No LinkedIn account is connected. <Link href="/linkedin-accounts" className="font-semibold text-brand-strong hover:underline">Connect one</Link>.</p> : null}
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {accounts.map((account) => (
                      <SenderRow
                        key={account.id} name={account.name} disabled={sendingLocked}
                        on={form.account_ids.includes(account.id)} onChange={(on) => toggleIn("account_ids", account.id, on)}
                        detail={`${formatCount(account.connections_per_day)} invites/day · ${formatCount(account.connections_left_today)} left today`}
                        pill={<Pill size="sm" tone={account.status === "active" ? "good" : account.usable ? "warn" : "bad"}>{ACCOUNT_WORD[account.status] ?? account.status}</Pill>}
                      />
                    ))}
                  </div>
                  {form.account_ids.length > 1 ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-subtle px-3 py-2">
                      <span className="flex flex-col gap-0.5">
                        <span className="text-115 font-medium text-ink">Share contacts out</span>
                        <span className="text-105 text-ink-3">{form.rotation === "capacity" ? "In proportion to each account's daily invitation limit." : "In turn, so each account gets the same number."}</span>
                      </span>
                      <Segmented size="sm" label="How contacts are shared between the accounts" value={form.rotation} onChange={(rotation) => !sendingLocked && set({ rotation })} options={[{ value: "round_robin", label: "Round robin" }, { value: "capacity", label: "By capacity" }]} />
                    </div>
                  ) : null}
                  <p className="text-11 leading-4 text-ink-3">
                    {settings.run
                      ? "A change reaches the run in flight when it is saved. A contact whose LinkedIn steps have started stays with the account that started them; the rest are shared out again."
                      : "Used the next time the campaign is launched."}
                  </p>
                </div>
              ) : null}
              {usesLinkedin && usesEmail ? <hr className="border-line" /> : null}
              {usesEmail ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-125 font-semibold text-ink">Mailboxes</span>
                    <span className="text-11 text-ink-3">{form.email_account_ids.length === 0 ? "None chosen" : `${form.email_account_ids.length} chosen`}</span>
                  </div>
                  {mailboxes.length === 0 ? <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-115 text-ink-2">No mailbox is connected. <Link href="/mailboxes" className="font-semibold text-brand-strong hover:underline">Connect one</Link>.</p> : null}
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {mailboxes.map((mailbox) => (
                      <SenderRow
                        key={mailbox.id} name={mailbox.name} disabled={sendingLocked}
                        on={form.email_account_ids.includes(mailbox.id)} onChange={(on) => toggleIn("email_account_ids", mailbox.id, on)}
                        detail={`${mailbox.email} · ${formatCount(mailbox.emails_per_day)} sends/day`}
                        pill={mailbox.paused ? <Pill size="sm" tone="bad">Paused</Pill> : !mailbox.verified ? <Pill size="sm" tone="bad">Unverified</Pill> : mailbox.warming_up ? <Pill size="sm" tone="warn">Warming up</Pill> : <Pill size="sm" tone="good">Ready</Pill>}
                      />
                    ))}
                  </div>
                  <p className="text-11 leading-4 text-ink-3">
                    Contacts enrolled from now on are shared between these mailboxes. A contact already enrolled keeps the mailbox they were given, so that follow-ups arrive in the same thread.
                  </p>
                </div>
              ) : null}
              {!usesLinkedin && !usesEmail ? <p className="text-12 text-ink-2">This campaign has no steps yet. Add some in the <Link href={`/campaigns/${id}/sequence`} className="font-semibold text-brand-strong hover:underline">sequence builder</Link>, and its senders can be chosen here.</p> : null}
            </Section>

            <Section title="Exclusions" subtitle="Contacts this campaign never enrols, whatever list they are in">
              <Toggle label="Leave out customers" hint="Contacts with a won deal of their own, or whose company has one." checked={form.exclude.customers} onChange={(customers) => set({ exclude: { ...form.exclude, customers } })} disabled={sendingLocked} />
              <Toggle label="Leave out open deals" hint="Contacts someone is already in talks with: a deal of theirs or their company's that is neither won nor lost." checked={form.exclude.open_deals} onChange={(open_deals) => set({ exclude: { ...form.exclude, open_deals } })} disabled={sendingLocked} />
              <p className="text-11 leading-4 text-ink-3">
                Applies when contacts are enrolled: at launch, and when prospects are added later. Nobody already enrolled is taken out. The workspace&rsquo;s do-not-contact list always applies, and is not set here.
              </p>
            </Section>

            <Section title="Tracking and testing" subtitle="What is measured on each email, and what is done with an A/B result">
              {settings.tracking.length === 0 ? (
                <p className="text-12 text-ink-2">This campaign has no email steps, so there is nothing to track.</p>
              ) : (
                <div role="table" aria-label="Tracking for each email" className="flex flex-col rounded-lg border border-line">
                  <div role="row" className="flex h-8 items-center gap-3 border-b border-line bg-subtle px-3 text-10 font-semibold uppercase tracking-label text-ink-3">
                    <span role="columnheader" className="min-w-0 flex-1">Email</span>
                    <span role="columnheader" className="w-[76px] shrink-0 text-center">Opens</span>
                    <span role="columnheader" className="w-[76px] shrink-0 text-center">Clicks</span>
                  </div>
                  {settings.tracking.map((step) => {
                    const row = form.tracking.find((entry) => entry.step_id === step.step_id) ?? { step_id: step.step_id, opens: step.opens, clicks: step.clicks };
                    const change = (patch: { opens?: boolean; clicks?: boolean }) => set({ tracking: form.tracking.map((entry) => (entry.step_id === step.step_id ? { ...entry, ...patch } : entry)) });
                    return (
                      <div key={step.step_id} role="row" className="flex min-h-11 items-center gap-3 border-b border-line px-3 last:border-b-0">
                        <span role="cell" className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="shrink-0 text-125 font-medium text-ink">Email {step.email_number}</span>
                          <span className="truncate text-115 text-ink-3">{step.subject || "Written by AI"}</span>
                        </span>
                        <span role="cell" className="flex w-[76px] shrink-0 justify-center"><Switch checked={row.opens} onChange={(opens) => change({ opens })} label={`Track opens of email ${step.email_number}`} disabled={sendingLocked} /></span>
                        <span role="cell" className="flex w-[76px] shrink-0 justify-center"><Switch checked={row.clicks} onChange={(clicks) => change({ clicks })} label={`Track clicks in email ${step.email_number}`} disabled={sendingLocked} /></span>
                      </div>
                    );
                  })}
                </div>
              )}
              {settings.tracking.length > 0 ? (
                <p className="text-11 leading-4 text-ink-3">
                  Tracking needs the email sent as HTML, so switching it on changes a plain-text email to HTML from the next send. Opens fetched by mail scanners are counted apart on the Overview.
                </p>
              ) : null}
              <Toggle
                label="Promote A/B winners automatically"
                hint="When one version of an email is ahead on replies by more than chance would explain, the others are paused and you are told. It never acts on opens alone, and a test can always be reopened."
                checked={form.ab_auto_promote} onChange={(ab_auto_promote) => set({ ab_auto_promote })} disabled={sendingLocked}
              />
            </Section>

            {settings.signal_rules.length > 0 ? (
              <Section title="Signals" subtitle="Rules that enrol contacts in this campaign as signals come in">
                <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
                  {settings.signal_rules.map((rule) => (
                    <li key={rule.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-125 font-medium text-ink">{rule.name}</span>
                        <span className="truncate text-115 text-ink-2">
                          When {rule.signal_type.replaceAll("_", " ")}{rule.min_score > 0 ? ` with intent of ${rule.min_score} or more` : ""}
                          {rule.auto_start ? ", and starts them straight away" : ""}
                        </span>
                      </span>
                      <Pill tone={rule.enabled ? "good" : "neutral"} dot={rule.enabled}>{rule.enabled ? "Live" : "Off"}</Pill>
                    </li>
                  ))}
                </ul>
                <p className="text-11 leading-4 text-ink-3">Rules are made and switched on under <Link href="/signals?tab=rules" className="font-semibold text-brand-strong hover:underline">Signals</Link>.</p>
              </Section>
            ) : null}

            {can.member ? (
              <Section title="Archive or delete" subtitle="Take the campaign out of the way, or remove it for good">
                <div className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-125 font-medium text-ink">{archived ? "Bring this campaign back" : "Archive this campaign"}</span>
                    <span className="text-115 leading-[17px] text-ink-2">
                      {archived ? "It returns to the campaigns list as it was." : campaign.status === "active" ? "A campaign that is sending cannot be archived. Pause it first." : "It leaves the campaigns list. Its prospects, history and figures are kept."}
                    </span>
                  </span>
                  <Button icon={archived ? ArchiveRestore : Archive} disabled={!archived && campaign.status === "active"} loading={working === "archive"} onClick={() => void setArchived(!archived)}>{archived ? "Bring back" : "Archive"}</Button>
                </div>
                <hr className="border-line" />
                <div className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-125 font-medium text-ink">Delete this campaign</span>
                    <span className="text-115 leading-[17px] text-ink-2">{mayDelete ? deleteWarning(settings) : "It has enrolled contacts, so deleting it needs a manager. Archive it instead."}</span>
                  </span>
                  <Button variant="danger" icon={Trash2} disabled={!mayDelete} loading={working === "delete"} onClick={() => void remove()}>Delete</Button>
                </div>
              </Section>
            ) : null}
          </div>
        </>
      )}
    </CampaignFrame>
  );
}
