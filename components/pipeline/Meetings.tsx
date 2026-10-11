import { useState } from "react";
import Link from "next/link";
import { CalendarDays, CalendarPlus, Link2, RefreshCw, Rss, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Pagination, Pill, Segmented, Skeleton, TONE_SOLID, TextAction, confirm } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, plural } from "@/lib/client/format";
import { recordHref } from "@/lib/client/nav";
import { useTableState } from "@/lib/client/table-state";
import { addCalendarFeed, calendarSignInHref, linkMeeting, readCalendar, removeCalendar } from "./api";
import { RecordSearch, type Picked } from "./RecordSearch";
import {
  CALENDAR_LABEL, MEETINGS_PATH, SIGN_IN_SETUP_HINT, calendarStatus, calendarWhere, meetingDetail, meetingWhen, meetingWho, signInUnavailable,
  type CalendarItem, type MeetingItem, type MeetingsData,
} from "./model";

// ── The next few, on the board view ─────────────────────────────────────────────────────

/** The next meetings with a contact. Sits in the board view's side card, above the recent activity. */
export function UpcomingMeetings({ canAdmin, onCalendars }: { canAdmin: boolean; onCalendars: () => void }) {
  const { data, error, mutate } = useApi<MeetingsData>(MEETINGS_PATH, { limit: 3 });
  return (
    <section className="flex flex-col gap-2.5 p-3.5" aria-label="Upcoming meetings">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Upcoming meetings</h2>
          <p className="text-11 text-ink-3">Matched to contacts automatically</p>
        </div>
        <TextAction className="mt-1 shrink-0" onClick={onCalendars}>Calendars</TextAction>
      </div>
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} className="py-4" />
      ) : !data ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading meetings">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-[68px] rounded-lg" />)}</div>
      ) : data.meetings.length === 0 ? (
        data.calendars.length === 0 ? (
          <EmptyState icon={CalendarPlus} title="No calendar is connected" className="py-5" action={canAdmin ? <Button size="sm" onClick={onCalendars}>Connect a calendar</Button> : undefined}>
            {canAdmin ? "Connect one and meetings with your contacts show here." : "An admin can connect one, and meetings with your contacts will show here."}
          </EmptyState>
        ) : (
          <EmptyState icon={CalendarDays} title="Nothing coming up with a contact" className="py-5" />
        )
      ) : (
        <ul className="flex flex-col gap-2">
          {data.meetings.map((meeting) => {
            const when = meetingWhen(meeting);
            return (
              <li key={meeting.id} className="flex gap-3 rounded-lg bg-subtle p-2.5">
                <div className="flex w-[58px] shrink-0 flex-col gap-0.5">
                  <span className="font-mono text-125 font-semibold text-ink">{when.time}</span>
                  <span className="text-105 text-ink-3">{when.day}</span>
                </div>
                <span className={cn("w-0.5 shrink-0 rounded-full", TONE_SOLID.brand)} aria-hidden="true" />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-125 font-semibold text-ink">{meeting.title}</span>
                  <span className="truncate text-11 text-ink-3">{meetingWho(meeting)}</span>
                  {meeting.calendar ? <span><span className="inline-flex h-[17px] items-center rounded-full border border-line bg-surface px-[7px] text-95 font-semibold text-ink-2">{CALENDAR_LABEL[meeting.calendar.provider]}</span></span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {data && data.counts.upcoming > data.meetings.length ? <TextAction className="self-start" onClick={onCalendars}>View all {formatCount(data.counts.upcoming)} meetings</TextAction> : null}
    </section>
  );
}

// ── The whole list ──────────────────────────────────────────────────────────────────────

const WHEN = [{ value: "upcoming", label: "Upcoming" }, { value: "past", label: "Past" }] as const;

/** Every meeting, the next ones first, beside the calendars they are read from. */
export function MeetingsView({ canEdit, canAdmin, notice, onDismissNotice, onChanged }: {
  canEdit: boolean; canAdmin: boolean; notice: { tone: "good" | "bad"; message: string } | null; onDismissNotice: () => void; onChanged: () => void;
}) {
  const table = useTableState({ pageSize: 25, sort: { key: "starts", direction: "asc" }, filters: { when: "upcoming", match: "matched" } });
  const { data, error, mutate } = useApi<MeetingsData>(table.ready ? MEETINGS_PATH : null, { when: table.filters.when, match: table.filters.match, page: table.page, limit: table.pageSize });
  const [linking, setLinking] = useState<MeetingItem | null>(null);
  const upcoming = table.filters.when !== "past";
  const unmatched = table.filters.match === "unmatched";
  return (
    <div className="flex min-h-0 items-start gap-3.5">
      <Card className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Meetings</h2>
            <p className="text-11 text-ink-3">Read from the connected calendars and matched to contacts by who is invited</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Segmented label="When" size="sm" value={upcoming ? "upcoming" : "past"} onChange={(when) => table.set({ filters: { when } })} options={[...WHEN]} />
            <Segmented
              label="Which meetings" size="sm" value={unmatched ? "unmatched" : "matched"} onChange={(match) => table.set({ filters: { match } })}
              options={[{ value: "matched", label: "With a contact" }, { value: "unmatched", label: "Not matched", count: upcoming && data && data.counts.upcoming_unmatched > 0 ? formatCount(data.counts.upcoming_unmatched) : undefined }]}
            />
          </div>
        </div>
        <div className="border-t border-line">
          {error && !data ? (
            <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
          ) : !data ? (
            <ul className="divide-y divide-line" aria-busy="true" aria-label="Loading meetings">{Array.from({ length: 4 }, (_, index) => <li key={index} className="flex items-center gap-3 px-3.5 py-3"><Skeleton className="h-8 w-14" /><Skeleton className="h-3 flex-1" /></li>)}</ul>
          ) : data.meetings.length === 0 ? (
            <EmptyState icon={CalendarDays} title={unmatched ? "Every meeting has a contact" : data.calendars.length === 0 ? "No calendar is connected" : upcoming ? "Nothing coming up with a contact" : "No past meetings with a contact"}>
              {unmatched ? "Meetings whose guests are not contacts would be listed here, to be linked by hand." : data.calendars.length === 0 ? "Connect a calendar and its meetings are matched to your contacts by the people invited." : "A meeting is matched when one of the people invited is a contact with that email address."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {data.meetings.map((meeting) => {
                const when = meetingWhen(meeting);
                return (
                  <li key={meeting.id} className="flex items-center gap-3.5 px-3.5 py-2.5">
                    <div className="flex w-[76px] shrink-0 flex-col gap-0.5">
                      <span className="font-mono text-125 font-semibold text-ink">{when.time}</span>
                      <span className="text-105 text-ink-3">{when.day}</span>
                    </div>
                    <span className={cn("h-9 w-0.5 shrink-0 rounded-full", meeting.contact ? TONE_SOLID.brand : "bg-line-strong")} aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-125 font-semibold text-ink">{meeting.title}</span>
                        {meeting.cancelled ? <Pill tone="neutral" size="sm">Cancelled</Pill> : null}
                      </span>
                      <span className="truncate text-11 text-ink-3">
                        {meeting.contact ? <Link href={recordHref("contact", meeting.contact.id)} className="font-medium text-ink-2 hover:underline">{meeting.contact.name}</Link> : null}
                        {meeting.contact ? meetingDetail(meeting).map((part) => ` · ${part}`).join("") : meetingWho(meeting)}
                      </span>
                    </div>
                    {meeting.calendar ? <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-line bg-surface px-2 text-105 font-semibold text-ink-2">{CALENDAR_LABEL[meeting.calendar.provider]}</span> : null}
                    {!meeting.contact && canEdit ? <Button size="sm" icon={Link2} onClick={() => setLinking(meeting)}>Link to a contact</Button> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {data && data.total > data.limit ? (
          <div className="flex items-center justify-between gap-3 border-t border-line px-3.5 py-2">
            <span className="text-11 text-ink-3">{formatCount(data.total)} {plural(data.total, "meeting", "meetings")}</span>
            <Pagination page={table.page} pageSize={table.pageSize} total={data.total} onPageChange={(page) => table.set({ page })} />
          </div>
        ) : null}
      </Card>
      <CalendarsPanel data={data} canAdmin={canAdmin} notice={notice} onDismissNotice={onDismissNotice} onChanged={() => { void mutate(); onChanged(); }} />
      {linking ? <LinkMeetingDialog meeting={linking} onClose={() => setLinking(null)} onLinked={() => { void mutate(); onChanged(); }} /> : null}
    </div>
  );
}

function LinkMeetingDialog({ meeting, onClose, onLinked }: { meeting: MeetingItem; onClose: () => void; onLinked: () => void }) {
  const [contact, setContact] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  async function link() {
    if (!contact) return;
    setBusy(true);
    try {
      await linkMeeting(meeting.id, contact.id);
      toast.success(`Linked to ${contact.label}`);
      onLinked();
      onClose();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }
  return (
    <Dialog
      open onOpenChange={(next) => { if (!next) onClose(); }} title="Link to a contact" icon={Link2} size="sm" description={meeting.title}
      footer={<><span /><span className="flex items-center gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!contact} onClick={() => void link()}>Link</Button></span></>}
    >
      <div className="flex flex-col gap-3">
        <p className="text-11 leading-4 text-ink-2">None of the people invited is a contact. Choose who this meeting is with, and it counts as theirs.</p>
        <Field label="Contact">{(id) => <RecordSearch id={id} kind="contact" value={contact} onChange={setContact} />}</Field>
      </div>
    </Dialog>
  );
}

// ── Calendars ───────────────────────────────────────────────────────────────────────────

const SIGN_IN = [{ provider: "google_calendar", button: "Sign in with Google" }, { provider: "microsoft_calendar", button: "Sign in with Microsoft" }] as const;

/** The calendars meetings are read from, and the ways to connect another. Connecting and removing are an admin's. */
function CalendarsPanel({ data, canAdmin, notice, onDismissNotice, onChanged }: {
  data: MeetingsData | undefined; canAdmin: boolean; notice: { tone: "good" | "bad"; message: string } | null; onDismissNotice: () => void; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  async function read(calendar: CalendarItem) {
    setWorking(calendar.id);
    try {
      const result = await readCalendar(calendar.id);
      const found = result.meetings_imported ?? 0;
      toast.success(found > 0 ? `${formatCount(found)} new ${plural(found, "meeting", "meetings")} from ${calendar.name}` : `${calendar.name} is up to date`);
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setWorking(null); onChanged(); }
  }

  async function remove(calendar: CalendarItem) {
    if (!(await confirm({ title: `Remove ${calendar.name}?`, body: "Linki stops reading it. The meetings already read from it are kept.", confirmLabel: "Remove", tone: "danger" }))) return;
    setWorking(calendar.id);
    try {
      await removeCalendar(calendar.id);
      toast.success("Calendar removed");
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setWorking(null); onChanged(); }
  }

  const unavailable = data ? SIGN_IN.filter((item) => !data.sign_in[item.provider]) : [];
  return (
    <Card className="flex w-[360px] shrink-0 flex-col gap-3 p-3.5" id="calendars">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Calendars</h2>
        <p className="text-11 leading-4 text-ink-3">Where meetings are read from. A whole calendar is read; only meetings with a contact are shown to the team.</p>
      </div>
      {notice ? <Alert tone={notice.tone} title={notice.message} onDismiss={onDismissNotice} /> : null}
      {!data ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading calendars"><Skeleton className="h-12 rounded-lg" /><Skeleton className="h-12 rounded-lg" /></div>
      ) : data.calendars.length === 0 ? (
        <p className="rounded-lg bg-subtle p-2.5 text-115 text-ink-2">No calendar is connected yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.calendars.map((calendar) => {
            const status = calendarStatus(calendar);
            return (
              <li key={calendar.id} className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-125 font-semibold text-ink">{calendar.name}</span>
                    <span className="truncate text-11 text-ink-3">{CALENDAR_LABEL[calendar.provider]} · {calendarWhere(calendar)}</span>
                  </div>
                  {canAdmin ? (
                    <span className="flex shrink-0 items-center">
                      <IconButton icon={RefreshCw} label={`Read ${calendar.name} now`} size={24} disabled={working === calendar.id} onClick={() => void read(calendar)} />
                      <IconButton icon={Trash2} label={`Remove ${calendar.name}`} size={24} disabled={working === calendar.id} onClick={() => void remove(calendar)} />
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Pill tone={status.tone} dot>{status.label}</Pill>
                  <span className="text-105 text-ink-3">{formatCount(calendar.meeting_count)} {plural(calendar.meeting_count, "meeting", "meetings")}</span>
                </div>
                {calendar.sync_error ? <p className="break-words text-105 leading-[14px] text-bad">{calendar.sync_error}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-10 font-semibold uppercase tracking-label text-ink-3">Connect a calendar</span>
        {canAdmin ? (
          <>
            {SIGN_IN.map((item) => (
              !data || data.sign_in[item.provider] ? (
                <div key={item.provider} className="flex items-center justify-between gap-2">
                  <span className="text-12 font-medium text-ink">{CALENDAR_LABEL[item.provider]}</span>
                  {data ? <Button size="sm" asChild><a href={calendarSignInHref(item.provider)}>{item.button}</a></Button> : <Skeleton className="h-[26px] w-28" />}
                </div>
              ) : (
                <div key={item.provider} className="flex flex-col gap-0.5">
                  <span className="text-12 font-medium text-ink">{CALENDAR_LABEL[item.provider]}</span>
                  <span className="text-11 leading-4 text-ink-2">{signInUnavailable(item.provider)}</span>
                </div>
              )
            ))}
            <div className="flex items-center justify-between gap-2">
              <span className="text-12 font-medium text-ink">{CALENDAR_LABEL.ical}</span>
              <Button size="sm" icon={Rss} onClick={() => setAdding(true)}>Add a feed</Button>
            </div>
            {unavailable.length > 0 ? <p className="text-105 leading-[14px] text-ink-3">{SIGN_IN_SETUP_HINT}</p> : null}
          </>
        ) : (
          <p className="text-115 leading-[17px] text-ink-2">An admin connects and removes calendars.</p>
        )}
      </div>
      {adding ? <AddFeedDialog onClose={() => setAdding(false)} onAdded={onChanged} /> : null}
    </Card>
  );
}

function AddFeedDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!/^https?:\/\/[^\s/]+/.test(url.trim())) return setError("Paste the feed's address, starting with https://");
    setError(null);
    setBusy(true);
    try {
      const made = await addCalendarFeed(name.trim() || "Calendar feed", url.trim());
      // Read it straight away, so a wrong address is found out now and the meetings are there when the dialog closes.
      try {
        const result = await readCalendar(made.id);
        const found = result.meetings_imported ?? 0;
        toast.success(`Feed added. ${formatCount(found)} ${plural(found, "meeting", "meetings")} read.`);
      } catch (cause) {
        toast.error(`The feed was added, but could not be read: ${errorMessage(cause)}`);
      }
      onAdded();
      onClose();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog
      open onOpenChange={(next) => { if (!next) onClose(); }} title="Add a calendar feed" icon={Rss} size="sm"
      footer={<><span /><span className="flex items-center gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void add()}>Add feed</Button></span></>}
    >
      <form className="flex flex-col gap-3.5" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} placeholder="Jordan's calendar" maxLength={80} />}</Field>
        <Field label="Feed address" error={error ?? undefined} hint="The private address your calendar gives for subscribing; it usually ends in .ics. Anyone who has it can read the calendar, so Linki does not show it again.">
          {(id) => <Input id={id} data-autofocus type="url" value={url} onChange={(event) => { setUrl(event.target.value); setError(null); }} placeholder="https://calendar.example.com/…/basic.ics" invalid={Boolean(error)} />}
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
