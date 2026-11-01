import { useState } from "react";
import {useTranslations} from "next-intl";
import { CirclePause, Flag, Flame, Gauge, Inbox, PlugZap, ShieldCheck, Unplug } from "lucide-react";
import { Button, Card, CardHeader, Drawer, EmptyState, ErrorState, LoadingState, Select, TONE_TINT, TextAction, type Icon } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
import { EVENT_KIND_LABEL, EVENT_TONE, eventTime, eventWhen, type GuardEvent, type GuardEventKind } from "./model";

const KIND_ICON: Record<GuardEventKind, Icon> = {
  auto_pause: CirclePause, disconnected: Unplug, reconnected: PlugZap, daily_limit: Gauge,
  dns_change: ShieldCheck, warmup_cycle: Flame, complaint: Flag, placement_test: Inbox,
};

function EventRow({ event, full }: { event: GuardEvent; full?: boolean }) {
  const Glyph = KIND_ICON[event.kind] ?? ShieldCheck;
  return (
    <li className="flex gap-[11px]">
      <time dateTime={event.occurred_at} className={cn("shrink-0 pt-1 font-mono text-105 text-ink-3", full ? "w-[104px]" : "w-[38px]")}>{full ? eventWhen(event.occurred_at) : eventTime(event.occurred_at)}</time>
      <span className={cn("inline-flex size-[22px] shrink-0 items-center justify-center rounded-md", TONE_TINT[EVENT_TONE[event.tone] ?? "neutral"])} aria-hidden="true">
        <Glyph size={12} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-12 font-medium text-ink">{event.title}</p>
        {event.detail ? <p className="text-11 leading-[15px] text-ink-2">{event.detail}</p> : null}
      </div>
    </li>
  );
}

/** What the guards did in the last 24 hours, across every mailbox, with the way into the whole log. */
export function GuardLogCard({ events, total }: { events: GuardEvent[]; total: number }) {
  const t = useTranslations("DeliverabilityGuard");
  const [open, setOpen] = useState(false);
  return (
    <Card className="flex flex-1 flex-col gap-[11px] p-3.5">
      <CardHeader title={t("title")} subtitle={t("subtitle")} actions={<TextAction onClick={() => setOpen(true)}>{t("open")}</TextAction>} />
      {events.length === 0 ? (
        <p className="py-3 text-115 leading-[17px] text-ink-3">{t("noneRecent")}</p>
      ) : (
        <ul className="flex flex-col gap-[11px]">
          {events.map((event) => <EventRow key={event.id} event={event} />)}
        </ul>
      )}
      {total > events.length ? <p className="text-105 text-ink-3">{t("moreRecent", {count: formatCount(total - events.length)})}</p> : null}
      <GuardLogDrawer open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

const PAGE = 25;
type KindFilter = "all" | GuardEventKind;
const KIND_OPTIONS: Array<{ value: KindFilter; label: string }> = [{ value: "all", label: "Everything" }, ...(Object.keys(EVENT_KIND_LABEL) as GuardEventKind[]).map((kind) => ({ value: kind, label: EVENT_KIND_LABEL[kind] }))];

function GuardLogDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("DeliverabilityGuard");
  const [kind, setKind] = useState<KindFilter>("all");
  const [offset, setOffset] = useState(0);
  const { data, error, isLoading, mutate } = useApi<{ events: GuardEvent[]; total: number }>(open ? "/api/deliverability/events" : null, { kind: kind === "all" ? undefined : kind, limit: PAGE, offset });
  const total = data?.total ?? 0;

  return (
    <Drawer
      open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("title")} description={t("description")} width={520}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-11 text-ink-3">{total === 0 ? t("noEvents") : t("range", {start: formatCount(offset + 1), end: formatCount(Math.min(offset + PAGE, total)), total: formatCount(total)})}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t("newer")}</Button>
            <Button size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>{t("older")}</Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Select className="self-start" label={t("kind")} value={kind} onChange={(value) => { setKind(value); setOffset(0); }} options={KIND_OPTIONS.map(option => ({...option, label: t(`kinds.${option.value}`)}))} />
        {error && !data ? (
          <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
        ) : isLoading && !data ? (
          <LoadingState label={t("reading")} />
        ) : data && data.events.length > 0 ? (
          <ul className="flex flex-col gap-3.5">
            {data.events.map((event) => <EventRow key={event.id} event={event} full />)}
          </ul>
        ) : (
          <EmptyState icon={ShieldCheck} title={t("nothing")}>
            {kind === "all" ? t("allNone") : t("kindNone")}
          </EmptyState>
        )}
      </div>
    </Drawer>
  );
}
