import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { ArrowUpRight, Ellipsis, Inbox, ListFilter, Plus } from "lucide-react";
import { Button, Card, CardHeader, IconButton, Menu, MenuItem, Meter, Pill, Select } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatCount, formatPercent } from "@/lib/client/format";
import { isHeld, statusBadge, type MailboxSettings, type MailboxView } from "@/components/mailboxes/model";
import { STATUS_FILTERS, canSendTest, healthSubtitle, rampCell } from "./model";

type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

/** The mailboxes on one sending domain: what each has sent today, its bounce rate, its ramp and its state. */
export function MailboxHealthCard({ domain, mailboxes, settings, canEdit, onPlacementTest }: { domain: string; mailboxes: MailboxView[]; settings: MailboxSettings; canEdit: boolean; onPlacementTest: (mailbox: MailboxView) => void }) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const shown = filter === "all" ? mailboxes : mailboxes.filter((mailbox) => mailbox.status === filter);

  return (
    <Card className="flex flex-col overflow-hidden">
      <CardHeader
        className="px-3.5 py-3" title="Mailbox health" subtitle={healthSubtitle(mailboxes, settings)}
        actions={
          <>
            <Select size="sm" icon={ListFilter} label="Show mailboxes by status" value={filter} onChange={setFilter} options={STATUS_FILTERS} />
            {canEdit ? (
              <Button size="sm" asChild className="h-7 gap-1.5 px-3">
                <Link href={`/mailboxes?connect=${encodeURIComponent(domain)}`}><Plus size={12} className="text-ink-2" aria-hidden="true" />Add mailbox</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <div role="table" aria-label={`Mailboxes on ${domain}`} className="flex flex-col">
        <div role="row" className="flex h-[31px] items-center gap-3 border-y border-line bg-subtle px-3.5 text-10 font-semibold uppercase tracking-label text-ink-3">
          <span role="columnheader" className="min-w-0 flex-1">Mailbox</span>
          <span role="columnheader" className="w-[150px] shrink-0">Sent today</span>
          <span role="columnheader" className="w-[70px] shrink-0">Bounce</span>
          <span role="columnheader" className="hidden w-24 shrink-0 sm:block">Warm-up</span>
          <span role="columnheader" className="w-[100px] shrink-0">Status</span>
          <span role="columnheader" className="w-6 shrink-0"><span className="sr-only">More</span></span>
        </div>
        {shown.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-115 text-ink-3">No mailbox on {domain} is {STATUS_FILTERS.find((item) => item.value === filter)?.label.toLowerCase()}.</p>
        ) : shown.map((mailbox) => <HealthRow key={mailbox.id} mailbox={mailbox} canEdit={canEdit} onPlacementTest={onPlacementTest} />)}
      </div>
    </Card>
  );
}

function HealthRow({ mailbox, canEdit, onPlacementTest }: { mailbox: MailboxView; canEdit: boolean; onPlacementTest: (mailbox: MailboxView) => void }) {
  const router = useRouter();
  const href = `/mailboxes?mailbox=${encodeURIComponent(mailbox.id)}`;
  const status = statusBadge(mailbox);
  const ramp = rampCell(mailbox);
  const held = isHeld(mailbox) || mailbox.status === "untested";
  const { sent_today: sent, limit_today: limit } = mailbox.sending;
  const rate = mailbox.health.bounce_rate;
  const bounceTone = rate === null || mailbox.status === "disconnected" ? "text-ink-3" : rate >= mailbox.guard.bounce_threshold ? "text-bad" : rate >= 0.02 ? "text-warn" : "text-good";

  return (
    <div role="row" className="relative flex min-h-[54px] items-center gap-3 border-b border-line px-3.5 py-2 transition-colors last:border-b-0 hover:bg-subtle/60">
      <div role="cell" className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link href={href} className="truncate text-12 font-medium text-ink outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand">
          {mailbox.from_email}
        </Link>
        <span className="truncate text-105 text-ink-3">{mailbox.provider.label}</span>
      </div>
      <div role="cell" className="flex w-[150px] shrink-0 flex-col gap-[5px]">
        <span className="flex items-baseline gap-[3px]">
          <span className={cn("font-mono text-115 font-medium", held ? "text-ink-3" : "text-ink")}>{formatCount(sent)}</span>
          <span className="font-mono text-105 text-ink-3">/ {formatCount(limit)} daily</span>
        </span>
        <Meter value={sent} max={limit} height={3} tone={held ? "neutral" : sent >= limit ? "warn" : "mail"} label={`Sent today from ${mailbox.from_email}`} className="h-1" />
      </div>
      <span role="cell" className={cn("w-[70px] shrink-0 font-mono text-115 font-medium", bounceTone)}>{rate === null || mailbox.status === "disconnected" ? "—" : formatPercent(rate)}</span>
      <div role="cell" className="hidden w-24 shrink-0 flex-col gap-[5px] sm:flex">
        <span className="truncate text-11 text-ink-2">{ramp.text}</span>
        <Meter value={ramp.share} max={1} height={3} tone="brand" label={`Ramp of ${mailbox.from_email}`} className="h-1" />
      </div>
      <div role="cell" className="flex w-[100px] shrink-0 items-center">
        <Pill tone={status.tone} dot className="text-105">{status.label}</Pill>
      </div>
      <div role="cell" className="relative z-10 flex w-6 shrink-0 justify-end">
        <Menu align="end" width={236} trigger={<IconButton icon={Ellipsis} label={`More for ${mailbox.from_email}`} size={24} />}>
          <MenuItem icon={ArrowUpRight} onSelect={() => void router.push(href)}>Open in Mailboxes</MenuItem>
          {canEdit ? <MenuItem icon={Inbox} disabled={!canSendTest(mailbox)} onSelect={() => onPlacementTest(mailbox)}>Run a placement test from it</MenuItem> : null}
        </Menu>
      </div>
    </div>
  );
}
