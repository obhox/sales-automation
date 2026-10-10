import { useRouter } from "next/router";
import { Check, CirclePause, CirclePlay, Ellipsis, EllipsisVertical, Globe, Mail, MailWarning, Minus, PlugZap, Plus, RefreshCw, Settings2, ShieldCheck, Signature, Trash2, TriangleAlert, X } from "lucide-react";
import { Card, IconButton, Menu, MenuItem, MenuSeparator, Meter, Pill, Tooltip } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import {
  DELIVERABILITY_HREF, bounceLine, dnsBadges, dnsCheckedLine, domainMeta, limitLine, metaLine, rampLine, reputationLabel, reputationTone, reputationWhy, statusBadge, warmupBadge, warmupSub,
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
  return (
    <Card className="flex flex-col overflow-hidden" role="group" aria-label={`Mailboxes on ${domain.domain}`}>
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-line bg-subtle px-3.5 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-[9px] gap-y-1">
          <Globe size={14} className="shrink-0 text-ink-2" aria-hidden="true" />
          <h2 className="truncate text-125 font-semibold text-ink">{domain.domain}</h2>
          {dnsBadges(domain).map((badge) => (
            <Tooltip key={badge.label} label={badge.title}>
              <span tabIndex={0} className="inline-flex rounded-full" aria-label={badge.title}>
                <Pill tone={badge.tone} icon={DNS_ICON[badge.tone] ?? Minus} className="h-[18px] text-95">{badge.label}</Pill>
              </span>
            </Tooltip>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="hidden text-11 text-ink-2 sm:inline">{domainMeta(domain)}</span>
          <Menu align="end" width={228} trigger={<IconButton icon={Ellipsis} label={`More for ${domain.domain}`} size={24} />}>
            <div className="px-2 pb-1 pt-1.5 text-105 text-ink-3">{dnsCheckedLine(domain)}</div>
            {canEdit ? <MenuItem icon={RefreshCw} disabled={checkingDns} onSelect={() => onCheckDns(domain.domain)}>Check DNS now</MenuItem> : null}
            <MenuItem icon={ShieldCheck} onSelect={() => void router.push(DELIVERABILITY_HREF)}>Open deliverability</MenuItem>
            {canEdit ? (
              <>
                <MenuSeparator />
                <MenuItem icon={Plus} onSelect={() => onConnect(domain.domain)}>Connect a mailbox on this domain</MenuItem>
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
          Connect another mailbox on {domain.domain}
        </button>
      ) : null}
    </Card>
  );
}

function MailboxRow({ mailbox, selected, canEdit, busy, onSelect, onAction }: {
  mailbox: MailboxView; selected: boolean; canEdit: boolean; busy: boolean;
  onSelect: (mailbox: MailboxView) => void; onAction: (action: MailboxAction, mailbox: MailboxView) => void;
}) {
  const status = statusBadge(mailbox);
  const warmup = warmupBadge(mailbox);
  const limit = limitLine(mailbox);
  const ramp = rampLine(mailbox);
  const bounce = bounceLine(mailbox);
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
          {selected ? <span className="inline-flex h-[17px] shrink-0 items-center rounded-lg bg-surface px-2 text-95 font-semibold text-brand-strong">Viewing</span> : null}
        </div>
        <p className="truncate text-105 text-ink-3" title={metaLine(mailbox)}>
          {metaLine(mailbox)}{mailbox.reads_replies ? "" : " · replies are not read"}
        </p>
      </div>

      <div className="hidden w-[130px] shrink-0 flex-col gap-[5px] md:flex">
        <span className={cn("text-115 font-semibold", LIMIT_TEXT[limit.tone])}>{limit.text}</span>
        <Meter value={mailbox.sending.sent_today} max={mailbox.sending.limit_today} tone={limit.meter} label={`Sent today from ${mailbox.from_email}`} />
        <span className={cn("truncate text-10", ramp.bad ? "text-bad" : "text-ink-3")}>{ramp.text}</span>
      </div>

      <div className="hidden w-[104px] shrink-0 flex-col items-start gap-1 lg:flex">
        <Pill tone={warmup.tone} dot className="h-[19px] text-10">{warmup.label}</Pill>
        <span className="truncate text-10 text-ink-3">{warmupSub(mailbox)}</span>
      </div>

      <div className="hidden w-[86px] shrink-0 flex-col gap-1 lg:flex">
        <Tooltip label={reputationWhy(mailbox)}>
          <span className="relative z-10 inline-flex w-fit items-center gap-1.5" tabIndex={0}>
            <span className={cn("size-1.5 rounded-full", DOT[reputationTone(mailbox)])} aria-hidden="true" />
            <span className="text-115 font-semibold text-ink">{reputationLabel(mailbox)}</span>
          </span>
        </Tooltip>
        <span className={cn("text-10", bounce.bad ? "text-bad" : "text-ink-3")}>{bounce.text}</span>
      </div>

      <div className="flex w-[96px] shrink-0 items-center">
        <Pill tone={status.tone} dot className="h-[19px] text-10">{status.label}</Pill>
      </div>

      {canEdit ? (
        <Menu align="end" width={212} trigger={<IconButton icon={EllipsisVertical} label={`More for ${mailbox.from_email}`} size={24} className="relative z-10" />}>
          <MenuItem icon={Settings2} onSelect={act("edit")}>Edit settings</MenuItem>
          <MenuItem icon={Signature} onSelect={act("signature")}>Edit signature</MenuItem>
          <MenuItem icon={PlugZap} disabled={busy} onSelect={act("test")}>{lost ? "Try to reconnect" : "Test the connection"}</MenuItem>
          <MenuSeparator />
          {paused ? <MenuItem icon={CirclePlay} disabled={busy} onSelect={act("resume")}>Resume sending</MenuItem> : lost ? null : <MenuItem icon={CirclePause} disabled={busy} onSelect={act("pause")}>Pause sending</MenuItem>}
          <MenuItem icon={Trash2} tone="danger" onSelect={act("delete")}>Remove mailbox</MenuItem>
        </Menu>
      ) : (
        <span className="w-6 shrink-0" aria-hidden="true" />
      )}
    </li>
  );
}
