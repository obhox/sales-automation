import { useRouter } from "next/router";
import { useLocale, useTranslations } from "next-intl";
import { Check, CirclePause, CirclePlay, Ellipsis, EllipsisVertical, Globe, Mail, MailWarning, Minus, PlugZap, Plus, RefreshCw, Settings2, ShieldCheck, Signature, Trash2, TriangleAlert, X } from "lucide-react";
import { Card, IconButton, Menu, MenuItem, MenuSeparator, Meter, Pill, Tooltip } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatRelativeByLocale } from "@/lib/client/localize-relative";
import {
  bounceLine, deliverabilityHref, dnsBadges, domainMeta, limitLine, metaLine, rampLine, reputationLabel, reputationSpoken, reputationTone, reputationWhy, statusBadge, warmupBadge, warmupSub, windowLabel,
  type DomainView, type MailboxView,
} from "./model";

export type MailboxAction = "edit" | "signature" | "pause" | "resume" | "test" | "delete";

const DOT: Record<string, string> = { good: "bg-good", warn: "bg-warn", bad: "bg-bad", neutral: "bg-ink-3", brand: "bg-brand-strong", li: "bg-li", mail: "bg-mail" };
const LIMIT_TEXT = { ink: "text-ink", warn: "text-warn", muted: "text-ink-3" } as const;
/** A DNS badge's mark: there, there but weak, missing. A dash when it has not been checked. */
const DNS_ICON: Partial<Record<string, typeof Check>> = { good: Check, warn: TriangleAlert, bad: X };

export interface DomainGroupProps {
  domain: DomainView;
  selected: string | null;
  /** What the signed-in member may do. Everything that changes a mailbox is an admin's. */
  canEdit: boolean;
  /** The mailbox an action is running on. */
  busy: string | null;
  checkingDns: boolean;
  onSelect: (mailbox: MailboxView) => void;
  onAction: (action: MailboxAction, mailbox: MailboxView) => void;
  onConnect: (domain: string) => void;
  onCheckDns: (domain: string) => void;
}

/** One sending domain: its DNS at a glance, and a row for each mailbox on it. */
export function DomainGroup({ domain, selected, canEdit, busy, checkingDns, onSelect, onAction, onConnect, onCheckDns }: DomainGroupProps) {
  const router = useRouter();
  const t = useTranslations("MailboxDomain");
  const locale = useLocale();
  const dnsTitle = (label: string) => {
    if (locale !== "pt-BR") {
      const badge = dnsBadges(domain).find((entry) => entry.label === label);
      return badge?.title ?? label;
    }
    const record = label.toLowerCase() as "spf" | "dkim" | "dmarc";
    const state = domain.dns[record];
    return state === "pass" ? t("dnsPass", {record: label})
      : state === "weak" ? t("dnsWeak", {record: label})
      : state === "fail" ? t("dnsFail", {record: label})
      : t("dnsUnknown", {record: label});
  };
  const sent = domain.mailboxes.reduce((count, mailbox) => count + mailbox.sending.sent_today, 0);
  const limit = domain.mailboxes.filter((mailbox) => !["disconnected", "auto_paused", "paused", "untested"].includes(mailbox.status))
    .reduce((count, mailbox) => count + mailbox.sending.limit_today, 0);
  return (
    <Card className="flex flex-col overflow-hidden" role="group" aria-label={t("domainMailboxes", {domain: domain.domain})}>
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-line bg-subtle px-3.5 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-[9px] gap-y-1">
          <Globe size={14} className="shrink-0 text-ink-2" aria-hidden="true" />
          <h2 className="truncate text-125 font-semibold text-ink">{domain.domain}</h2>
          {dnsBadges(domain).map((badge) => (
            <Tooltip key={badge.label} label={dnsTitle(badge.label)}>
              <span tabIndex={0} role="img" className="inline-flex rounded-full" aria-label={dnsTitle(badge.label)}>
                <Pill tone={badge.tone} icon={DNS_ICON[badge.tone] ?? Minus} className="h-[18px] text-95">{badge.label}</Pill>
              </span>
            </Tooltip>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="hidden text-11 text-ink-2 sm:inline">{locale === "pt-BR" ? t("domainMeta", {count: domain.mailboxes.length, sent, limit}) : domainMeta(domain)}</span>
          <Menu align="end" width={228} trigger={<IconButton icon={Ellipsis} label={t("moreDomain", {domain: domain.domain})} size={24} />}>
            <div className="px-2 pb-1 pt-1.5 text-105 text-ink-3">{locale === "pt-BR" ? domain.dns.checked_at ? t("dnsChecked", {time: formatRelativeByLocale(domain.dns.checked_at, locale)}) : t("dnsNotChecked") : domain.dns.checked_at ? t("dnsChecked", {time: formatRelativeByLocale(domain.dns.checked_at, locale)}) : t("dnsNotChecked")}</div>
            {canEdit ? <MenuItem icon={RefreshCw} disabled={checkingDns} onSelect={() => onCheckDns(domain.domain)}>{t("checkDns")}</MenuItem> : null}
            <MenuItem icon={ShieldCheck} onSelect={() => void router.push(deliverabilityHref(domain.domain))}>{t("deliverability")}</MenuItem>
            {canEdit ? (
              <>
                <MenuSeparator />
                <MenuItem icon={Plus} onSelect={() => onConnect(domain.domain)}>{t("connectDomain")}</MenuItem>
              </>
            ) : null}
          </Menu>
        </div>
      </div>

      <ul className="flex flex-col">
        {domain.mailboxes.map((mailbox) => (
          <MailboxRow key={mailbox.id} mailbox={mailbox} selected={mailbox.id === selected} canEdit={canEdit} busy={busy === mailbox.id} onSelect={onSelect} onAction={onAction} />
        ))}
      </ul>

      {canEdit ? (
        <button type="button" onClick={() => onConnect(domain.domain)} className="flex h-9 w-full items-center gap-2 px-3.5 text-left text-11 font-semibold text-brand-strong transition-colors hover:bg-subtle">
          <Plus size={13} aria-hidden="true" />
          {t("connectAnother", {domain: domain.domain})}
        </button>
      ) : null}
    </Card>
  );
}

function MailboxRow({ mailbox, selected, canEdit, busy, onSelect, onAction }: {
  mailbox: MailboxView; selected: boolean; canEdit: boolean; busy: boolean;
  onSelect: (mailbox: MailboxView) => void; onAction: (action: MailboxAction, mailbox: MailboxView) => void;
}) {
  const t = useTranslations("MailboxDomain");
  const locale = useLocale();
  const status = statusBadge(mailbox);
  const warmup = warmupBadge(mailbox);
  const limit = limitLine(mailbox);
  const meta = locale !== "pt-BR" ? metaLine(mailbox)
    : [mailbox.provider.label, mailbox.provider.method === "App password" ? t("appPassword") : mailbox.provider.method,
        windowLabel(mailbox) === "All day" ? t("allDay") : windowLabel(mailbox), mailbox.schedule.timezone].join(" · ");
  const ramp = rampLine(mailbox);
  const bounce = bounceLine(mailbox);
  const rampText = (() => {
    if (locale !== "pt-BR") return ramp.text;
    const when = formatRelativeByLocale(mailbox.held?.at ?? null, locale);
    if (mailbox.status === "disconnected") return t("rampDisconnected", {when});
    if (mailbox.status === "auto_paused") return t("rampStopped", {when});
    if (mailbox.status === "paused") return t("rampPaused", {when});
    if (mailbox.status === "untested") return t("rampUntested");
    if (!mailbox.ramp) return t("noRamp");
    return t("rampProgress", {status: mailbox.ramp.complete ? t("rampComplete") : t("ramping"), day: mailbox.ramp.day, total: mailbox.ramp.days});
  })();
  const warmupText = (() => {
    if (locale !== "pt-BR") return warmupSub(mailbox);
    if (mailbox.warmup.state === "off") return t("notInPool");
    if (["paused", "stopped"].includes(mailbox.warmup.state)) return t("warmupStopped");
    if (mailbox.warmup.state === "warming" || mailbox.warmup.sent_week > 0) return t("warmupStats", {sent: mailbox.warmup.sent_week, rescued: mailbox.warmup.rescued_week});
    return mailbox.warmup.peers === 0 ? t("noPeers") : t("peers", {count: mailbox.warmup.peers});
  })();
  const statusLabels: Record<string, string> = {
    active: t("active"), disconnected: t("disconnected"), auto_paused: t("autoPaused"),
    paused: t("paused"), untested: t("untested"), at_limit: t("atLimit"),
  };
  const warmupLabels: Record<string, string> = {
    warmed: t("warmed"), warming: t("warming"), paused: t("paused"),
    stopped: t("stopped"), off: t("off"),
  };

  const lost = mailbox.status === "disconnected";
  const paused = mailbox.status === "paused" || mailbox.status === "auto_paused";
  const act = (action: MailboxAction) => () => onAction(action, mailbox);

  return (
    <li className={cn("relative flex min-h-[58px] items-center gap-3 border-b border-line px-3.5 py-2 transition-colors", selected ? "bg-brand-tint" : "hover:bg-subtle/60")}>
      <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md", lost ? "bg-bad-tint text-bad" : "bg-mail-tint text-mail")} aria-hidden="true">
        {lost ? <MailWarning size={14} /> : <Mail size={14} />}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex min-w-0 items-center gap-[7px]">
          {/* The whole row is this button's target; the menu at the end sits above it. */}
          <button
            type="button" onClick={() => onSelect(mailbox)} aria-pressed={selected}
            className="truncate text-left text-12 font-semibold text-ink outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand"
          >
            {mailbox.from_email}
          </button>
          {selected ? <span className="inline-flex h-[17px] shrink-0 items-center rounded-lg bg-surface px-2 text-95 font-semibold text-brand-strong">{t("viewing")}</span> : null}
        </div>
        <p className="truncate text-105 text-ink-3" title={meta}>
          {meta}{mailbox.reads_replies ? "" : t("repliesNotRead")}
        </p>
      </div>

      <div className="hidden w-[130px] shrink-0 flex-col gap-[5px] md:flex">
        <span className={cn("text-115 font-semibold", LIMIT_TEXT[limit.tone])}>{locale === "pt-BR" ? t("todayLimit", {sent: mailbox.sending.sent_today, limit: mailbox.sending.limit_today}) : limit.text}</span>
        <Meter value={mailbox.sending.sent_today} max={mailbox.sending.limit_today} tone={limit.meter} label={t("sentTodayFrom", {email: mailbox.from_email})} />
        <span className={cn("truncate text-10", ramp.bad ? "text-bad" : "text-ink-3")}>{rampText}</span>
      </div>

      <div className="hidden w-[104px] shrink-0 flex-col items-start gap-1 lg:flex">
        <Pill tone={warmup.tone} dot className="h-[19px] text-10">{warmupLabels[mailbox.warmup.state] ?? warmup.label}</Pill>
        <span className="truncate text-10 text-ink-3">{warmupText}</span>
      </div>

      <div className="hidden w-[86px] shrink-0 flex-col gap-1 lg:flex">
        <Tooltip label={reputationWhy(mailbox)}>
          <span className="relative z-10 inline-flex w-fit items-center gap-1.5" tabIndex={0} role="img" aria-label={locale === "pt-BR" ? mailbox.reputation ? t("reputationSpoken", {score: mailbox.reputation.score}) : t("noReputation") : reputationSpoken(mailbox)}>
            <span className={cn("size-1.5 rounded-full", DOT[reputationTone(mailbox)])} aria-hidden="true" />
            <span className="text-115 font-semibold text-ink">{locale === "pt-BR" ? t("reputation", {score: mailbox.reputation?.score ?? "—"}) : reputationLabel(mailbox)}</span>
          </span>
        </Tooltip>
        <span className={cn("text-10", bounce.bad ? "text-bad" : "text-ink-3")}>{locale === "pt-BR" ? t("bounce", {rate: mailbox.health.bounce_rate === null ? "—" : (mailbox.health.bounce_rate * 100).toLocaleString("pt-BR", {maximumFractionDigits: 1}) + "%"}) : bounce.text}</span>
      </div>

      <div className="flex w-[96px] shrink-0 items-center">
        <Pill tone={status.tone} dot className="h-[19px] text-10">{statusLabels[mailbox.status] ?? status.label}</Pill>
      </div>

      {canEdit ? (
        <Menu align="end" width={212} trigger={<IconButton icon={EllipsisVertical} label={t("moreMailbox", {email: mailbox.from_email})} size={24} className="relative z-10" />}>
          <MenuItem icon={Settings2} onSelect={act("edit")}>{t("editSettings")}</MenuItem>
          <MenuItem icon={Signature} onSelect={act("signature")}>{t("editSignature")}</MenuItem>
          <MenuItem icon={PlugZap} disabled={busy} onSelect={act("test")}>{lost ? t("reconnect") : t("testConnection")}</MenuItem>
          <MenuSeparator />
          {paused ? <MenuItem icon={CirclePlay} disabled={busy} onSelect={act("resume")}>{t("resume")}</MenuItem> : lost ? null : <MenuItem icon={CirclePause} disabled={busy} onSelect={act("pause")}>{t("pause")}</MenuItem>}
          <MenuItem icon={Trash2} tone="danger" onSelect={act("delete")}>{t("remove")}</MenuItem>
        </Menu>
      ) : (
        <span className="w-6 shrink-0" aria-hidden="true" />
      )}
    </li>
  );
}
