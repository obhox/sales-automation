import { CalendarDays, Eye, ListMinus, ListPlus, Mail, MailOpen, MailX, MessageSquare, Phone, Reply, Sparkles, StickyNote, UserCheck, UserMinus, UserPlus, UserRound, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Button, Card, EmptyState, ErrorState, Pill, Segmented, Skeleton, Timeline as TimelineList, type TimelineEvent } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { channelOptions, fullMessage, timelineLine, TIMELINE_PAGE, type Timeline, type TimelineChannel, type TimelineIcon, type TimelineItem } from "./model";

const ICONS: Record<TimelineIcon, LucideIcon> = {
  mail: Mail, "mail-open": MailOpen, "mail-x": MailX, eye: Eye, "user-plus": UserPlus, "user-check": UserCheck, "user-minus": UserMinus, message: MessageSquare, reply: Reply,
  note: StickyNote, phone: Phone, calendar: CalendarDays, "list-plus": ListPlus, "list-minus": ListMinus, sparkles: Sparkles, user: UserRound,
};

/** A message's whole text, folded away until asked for. */
function FullMessage({ subject, body }: { subject: string | null; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="mt-1 flex flex-col gap-1">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="self-start text-105 font-semibold text-brand-strong hover:underline">{open ? "Hide full message" : "Show full message"}</button>
      {open ? (
        <span className="flex flex-col gap-1 rounded-md border border-line bg-subtle p-2.5 text-12 text-ink-2">
          {subject ? <span className="font-semibold text-ink">{subject}</span> : null}
          <span className="whitespace-pre-wrap break-words">{body}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Everything that has happened with the contact on either channel, newest first. */
export function TimelineCard({
  timeline, error, channel, canEdit, onChannel, onMore, onRetry, onEditActivity, onDeleteActivity,
}: {
  timeline: Timeline | undefined;
  error: string | null;
  channel: TimelineChannel;
  canEdit: boolean;
  onChannel: (channel: TimelineChannel) => void;
  onMore: () => void;
  onRetry: () => void;
  onEditActivity: (item: TimelineItem) => void;
  onDeleteActivity: (item: TimelineItem) => void;
}) {
  const events: TimelineEvent[] = (timeline?.items ?? []).map((item) => {
    const line = timelineLine(item);
    const editable = canEdit && item.kind === "activity" && item.activity_id;
    const full = fullMessage(item);
    return {
      key: item.id,
      icon: ICONS[line.icon],
      tone: line.tone,
      title: line.title,
      badge: line.badge ? <Pill size="sm" tone={line.badge.tone} className="block max-w-[150px] truncate leading-[17px]">{line.badge.label}</Pill> : undefined,
      time: formatDateTime(item.at),
      detail: line.detail || editable || full ? (
        <>
          {line.detail ? <span className="whitespace-pre-wrap break-words">{line.quoted ? `“${line.detail}”` : line.detail}</span> : null}
          {full ? <FullMessage subject={full.subject} body={full.body} /> : null}
          {editable ? (
            <span className="mt-1 flex gap-2.5">
              <button type="button" onClick={() => onEditActivity(item)} className="text-105 font-semibold text-brand-strong hover:underline">Edit</button>
              <button type="button" onClick={() => onDeleteActivity(item)} className="text-105 font-semibold text-ink-3 hover:text-bad hover:underline">Delete</button>
            </span>
          ) : null}
        </>
      ) : undefined,
    };
  });
  const shown = timeline?.items.length ?? 0;

  return (
    <Card className="flex min-w-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-3.5">
        <h2 className="text-13 font-semibold tracking-snug text-ink">Outreach timeline</h2>
        <Segmented label="Channel" size="sm" value={channel} onChange={onChannel} options={channelOptions(timeline?.counts)} />
      </div>
      <div className="px-3.5 py-3">
        {error && !timeline ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : !timeline ? (
          <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Loading the timeline">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-9 w-full" />)}</div>
        ) : events.length === 0 ? (
          <EmptyState title={channel === "all" ? "Nothing has happened yet" : channel === "email" ? "Nothing by email yet" : "Nothing on LinkedIn yet"}>
            Emails, LinkedIn messages, opens, replies, notes and list changes appear here as they happen.
          </EmptyState>
        ) : (
          <>
            <TimelineList events={events} />
            {timeline.total > shown ? <Button size="sm" className="mt-1" onClick={onMore}>Show {Math.min(TIMELINE_PAGE, timeline.total - shown)} earlier</Button> : null}
          </>
        )}
      </div>
    </Card>
  );
}
