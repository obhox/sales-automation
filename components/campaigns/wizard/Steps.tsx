import { useState, type ReactNode } from "react";
import Link from "next/link";
import {useTranslations} from "next-intl";
import { ListChecks, Mail } from "lucide-react";
import { Checkbox, Eyebrow, Field, Input, LinkedinIcon, Pill, SearchInput, Segmented, Switch, Textarea } from "@/components/ui";
import { TRIGGER_TYPES } from "@/lib/campaigns/context";
import { cn } from "@/lib/client/cn";
import { formatCount, formatPercent, rate } from "@/lib/client/format";
import { TONE_IDEAS, type Draft, type SequenceFacts, type SetupOptions } from "./model";

type Change = (change: Partial<Draft>) => void;


function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-12 font-medium text-ink">{label}</span>
        {hint ? <span className="text-11 leading-4 text-ink-2">{hint}</span> : null}
      </div>
      <div className="mt-0.5 shrink-0">{children}</div>
    </div>
  );
}

/** Step 1: the campaign's name, the list it runs on, and who in that list to leave out. */
export function ListStep({ draft, options, onChange }: { draft: Draft; options: SetupOptions | undefined; onChange: Change }) {
  const t = useTranslations("CampaignListStep");
  const [search, setSearch] = useState("");
  const lists = options?.lists ?? [];
  const shown = lists.filter((list) => list.name.toLowerCase().includes(search.trim().toLowerCase()));
  const setExclude = (key: "customers" | "open_deals", on: boolean) => onChange({ setup: { ...draft.setup, exclude: { ...draft.setup.exclude, [key]: on } } });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Field label={t("campaignName")}>
        {(id) => <Input id={id} value={draft.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="Q4 Enterprise, VP Sales" maxLength={160} autoComplete="off" data-autofocus />}
      </Field>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Eyebrow>{t("list")}</Eyebrow>
          {lists.length > 6 ? <SearchInput value={search} onChange={setSearch} placeholder={t("findList")} frameClassName="h-7 w-[200px]" /> : null}
        </div>
        {options && lists.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-115 leading-[18px] text-ink-2">
            {t("noLists")} <Link href="/lists" className="font-semibold text-brand-strong hover:underline">{t("createList")}</Link>, {t("noListsSuffix")}
          </p>
        ) : (
          <div role="radiogroup" aria-label={t("listAria")} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
            {shown.map((list) => {
              const chosen = draft.setup.list_id === list.id;
              return (
                <button
                  key={list.id} type="button" role="radio" aria-checked={chosen} onClick={() => onChange({ setup: { ...draft.setup, list_id: list.id } })}
                  className={cn("flex items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-tint", chosen ? "border-brand bg-brand-tint" : "border-line bg-surface hover:border-line-strong")}
                >
                  <span className={cn("inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border", chosen ? "border-brand" : "border-line-strong")}>{chosen ? <span className="size-2 rounded-full bg-brand" /> : null}</span>
                  <span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-md bg-control text-ink-2"><ListChecks size={13} aria-hidden="true" /></span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-125 font-semibold text-ink">{list.name}</span>
                    <span className="text-105 text-ink-3">{t("listContacts", {count: formatCount(list.contacts)})} · {t("withEmail", {count: formatCount(list.with_email)})}</span>
                  </span>
                  <span className="shrink-0 text-right text-105 text-ink-3">{list.with_email > 0 ? t("verified", {percent: formatPercent(rate(list.verified_email, list.with_email), 0)}) : t("noEmails")}</span>
                </button>
              );
            })}
            {shown.length === 0 && lists.length > 0 ? <p className="py-4 text-center text-115 text-ink-3">{t("noListMatch")}</p> : null}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2.5 rounded-lg bg-subtle p-3">
        <Eyebrow>{t("exclude")}</Eyebrow>
        <Row label={t("customers")} hint={t("customersHint")}>
          <Switch checked={draft.setup.exclude.customers} onChange={(on) => setExclude("customers", on)} label={t("excludeCustomers")} />
        </Row>
        <Row label={t("openDeals")} hint={t("openDealsHint")}>
          <Switch checked={draft.setup.exclude.open_deals} onChange={(on) => setExclude("open_deals", on)} label={t("excludeDeals")} />
        </Row>
      </div>
    </div>
  );
}

/** Step 2: what the AI writer is told about this campaign. All of it is optional. */
export function ContextStep({ draft, aiAvailable, defaultModel, onChange }: { draft: Draft; aiAvailable: boolean; defaultModel: string | null; onChange: Change }) {
  const t = useTranslations("CampaignContextStep");
  const setAi = (change: Partial<Draft["ai"]>) => onChange({ ai: { ...draft.ai, ...change } });
  const toggle = (type: (typeof TRIGGER_TYPES)[number]) => setAi({ triggers: draft.ai.triggers.includes(type) ? draft.ai.triggers.filter((other) => other !== type) : [...draft.ai.triggers, type] });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-0.5">
      {!aiAvailable ? <p className="rounded-md bg-warn-tint px-3 py-2 text-11 leading-4 text-warn">{t("aiUnavailable")}</p> : null}
      <Field label={t("offer")} hint={t("offerHint")}>
        {(id) => <Textarea id={id} rows={5} value={draft.prompt} onChange={(event) => onChange({ prompt: event.target.value })} maxLength={8000} placeholder={t("offerPlaceholder")} />}
      </Field>
      <Field label={t("angle")} hint={t("angleHint")}>
        {(id) => <Input id={id} value={draft.ai.angle} onChange={(event) => setAi({ angle: event.target.value })} maxLength={300} placeholder={t("anglePlaceholder")} />}
      </Field>
      <Field label={t("tone")}>
        {(id) => (
          <div className="flex flex-col gap-1.5">
            <Input id={id} value={draft.ai.tone} onChange={(event) => setAi({ tone: event.target.value })} maxLength={120} placeholder={t("tonePlaceholder")} />
            <div className="flex flex-wrap gap-1.5">
              {TONE_IDEAS.map((idea) => (
                <button key={idea} type="button" onClick={() => setAi({ tone: idea })} className={cn("inline-flex h-6 items-center rounded-md px-2 text-11 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand", draft.ai.tone === idea ? "bg-brand-tint text-brand-strong" : "bg-control text-ink-2 hover:bg-brand-tint hover:text-brand-strong")}>{idea === TONE_IDEAS[0] ? t("toneOptions.direct") : idea === TONE_IDEAS[1] ? t("toneOptions.warm") : idea === TONE_IDEAS[2] ? t("toneOptions.brief") : t("toneOptions.formal")}</button>
              ))}
            </div>
          </div>
        )}
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-105 font-semibold text-ink-2">{t("triggers")}</span>
        <div role="group" aria-label={t("triggers")} className="flex flex-wrap gap-1.5">
          {TRIGGER_TYPES.map((type) => {
            const on = draft.ai.triggers.includes(type);
            return (
              <button key={type} type="button" aria-pressed={on} onClick={() => toggle(type)} className={cn("inline-flex h-7 items-center rounded-md border px-2.5 text-115 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-tint", on ? "border-brand bg-brand-tint text-brand-strong" : "border-line-strong bg-surface text-ink-2 hover:bg-subtle")}>{t(`triggerOptions.${type}`)}</button>
            );
          })}
        </div>
        <p className="text-105 leading-[14px] text-ink-3">{t("triggerHint")}</p>
      </div>
      <Field label={t("model")} hint={defaultModel ? t("modelDefault", {model: defaultModel}) : t("modelDefaultUnset")}>
        {(id) => <Input id={id} value={draft.ai.model ?? ""} onChange={(event) => setAi({ model: event.target.value.trim() || null })} maxLength={120} placeholder={defaultModel ?? "provider/model"} autoComplete="off" />}
      </Field>
    </div>
  );
}

/** Step 5: the LinkedIn accounts and mailboxes the campaign runs from. */
export function SendersStep({ draft, options, facts, onChange }: { draft: Draft; options: SetupOptions | undefined; facts: SequenceFacts | null; onChange: Change }) {
  const t = useTranslations("CampaignSendersStep");
  const STATUS_LABELS = {active: t("status.active"), warming_up: t("status.warming_up"), weekly_hold: t("status.weekly_hold"), paused: t("status.paused"), needs_signin: t("status.needs_signin"), disconnected: t("status.disconnected"), never_connected: t("status.never_connected")};
  const needsLinkedin = (facts?.linkedin.length ?? 0) > 0;
  const needsEmail = (facts?.email.length ?? 0) > 0;
  const toggle = (key: "account_ids" | "email_account_ids", id: string, on: boolean) =>
    onChange({ setup: { ...draft.setup, [key]: on ? [...draft.setup[key], id] : draft.setup[key].filter((other) => other !== id) } });
  const accounts = options?.linkedin_accounts ?? [];
  const mailboxes = options?.mailboxes ?? [];
  const chosenAccounts = accounts.filter((account) => draft.setup.account_ids.includes(account.id));
  const chosenMailboxes = mailboxes.filter((mailbox) => draft.setup.email_account_ids.includes(mailbox.id));

  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
      <section className={cn("flex min-h-0 flex-col gap-2", !needsLinkedin && facts && "opacity-60")}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-125 font-semibold text-ink"><LinkedinIcon size={14} className="text-li" aria-hidden="true" />{t("linkedinAccounts")}</span>
          <span className="text-11 text-ink-3">{chosenAccounts.length > 0 ? t("selectedLinkedin", {count: chosenAccounts.length, capacity: formatCount(chosenAccounts.reduce((sum, account) => sum + account.connections_per_day, 0))}) : t("noneChosen")}</span>
        </div>
        {facts && !needsLinkedin ? <p className="text-11 leading-4 text-ink-2">{t("noLinkedinNeeded")}</p> : null}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
          {accounts.length === 0 && options ? <p className="rounded-lg border border-dashed border-line-strong px-3 py-5 text-center text-115 leading-[18px] text-ink-2">{t("noLinkedin")} <Link href="/linkedin-accounts" className="font-semibold text-brand-strong hover:underline">{t("connectLinkedin")}</Link>.</p> : null}
          {accounts.map((account) => {
            const on = draft.setup.account_ids.includes(account.id);
            return (
              <label key={account.id} className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors", on ? "border-brand bg-brand-tint" : "border-line bg-surface hover:border-line-strong")}>
                <Checkbox checked={on} onChange={(next) => toggle("account_ids", account.id, next)} label={t("useAccount", {name: account.name})} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-125 font-semibold text-ink">{account.name}</span>
                  <span className="text-105 text-ink-3">{t("linkedinCapacity", {capacity: formatCount(account.connections_per_day), remaining: formatCount(account.connections_left_today)})}</span>
                </span>
                <Pill tone={account.status === "active" ? "good" : account.usable ? "warn" : "bad"} size="sm">{account.status in STATUS_LABELS ? STATUS_LABELS[account.status as keyof typeof STATUS_LABELS] : account.status}</Pill>
              </label>
            );
          })}
        </div>
        {chosenAccounts.length > 1 ? (
          <div className="flex flex-col gap-1.5 rounded-lg bg-subtle p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-115 font-medium text-ink">{t("shareContacts")}</span>
              <Segmented size="sm" label={t("shareLabel")} value={draft.setup.rotation} onChange={(rotation) => onChange({ setup: { ...draft.setup, rotation } })} options={[{ value: "round_robin", label: t("roundRobin") }, { value: "capacity", label: t("byCapacity") }]} />
            </div>
            <p className="text-105 leading-[14px] text-ink-3">{draft.setup.rotation === "capacity" ? t("capacityInfo") : t("roundRobinInfo")} {t("stickyInfo")}</p>
          </div>
        ) : null}
      </section>

      <section className={cn("flex min-h-0 flex-col gap-2", !needsEmail && facts && "opacity-60")}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-125 font-semibold text-ink"><Mail size={14} className="text-mail" aria-hidden="true" />{t("mailboxes")}</span>
          <span className="text-11 text-ink-3">{chosenMailboxes.length > 0 ? t("selectedMailboxes", {count: chosenMailboxes.length, capacity: formatCount(chosenMailboxes.reduce((sum, mailbox) => sum + mailbox.emails_per_day, 0))}) : t("noneChosen")}</span>
        </div>
        {facts && !needsEmail ? <p className="text-11 leading-4 text-ink-2">{t("noMailboxNeeded")}</p> : null}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
          {mailboxes.length === 0 && options ? <p className="rounded-lg border border-dashed border-line-strong px-3 py-5 text-center text-115 leading-[18px] text-ink-2">{t("noMailboxes")}</p> : null}
          {mailboxes.map((mailbox) => {
            const on = draft.setup.email_account_ids.includes(mailbox.id);
            return (
              <label key={mailbox.id} className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors", on ? "border-brand bg-brand-tint" : "border-line bg-surface hover:border-line-strong")}>
                <Checkbox checked={on} onChange={(next) => toggle("email_account_ids", mailbox.id, next)} label={t("useMailbox", {email: mailbox.email})} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-125 font-semibold text-ink">{mailbox.name}</span>
                  <span className="truncate text-105 text-ink-3">{mailbox.email} · {t("mailboxCapacity", {count: formatCount(mailbox.emails_per_day)})}</span>
                </span>
                {mailbox.paused ? <Pill tone="bad" size="sm">{t("status.paused")}</Pill> : !mailbox.verified ? <Pill tone="bad" size="sm">{t("status.unverified")}</Pill> : mailbox.warming_up ? <Pill tone="warn" size="sm">{t("status.warming_up")}</Pill> : mailbox.domain_checked && !mailbox.domain_ok ? <Pill tone="warn" size="sm">{t("status.checkDns")}</Pill> : <Pill tone="good" size="sm">{t("status.ready")}</Pill>}
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
}
