import { useState } from "react";
import {useTranslations} from "next-intl";
import Link from "next/link";
import { CalendarDays, CalendarPlus, Link2, RefreshCw, Rss, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Pagination, Pill, Segmented, Skeleton, TONE_SOLID, TextAction, confirm } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
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
  const t = useTranslations("PipelineMeetings");
  const { data, error, mutate } = useApi<MeetingsData>(MEETINGS_PATH, { limit: 3 });
  return (
    <section className="flex flex-col gap-2.5 p-3.5" aria-label={t("upcoming")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("upcoming")}</h2>
          <p className="text-11 text-ink-3">{t("matchedAutomatic")}</p>
        </div>
        <TextAction className="mt-1 shrink-0" onClick={onCalendars}>{t("calendars")}</TextAction>
      </div>
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} className="py-4" />
      ) : !data ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("loading")}>{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-[68px] rounded-lg" />)}</div>
      ) : data.meetings.length === 0 ? (
        data.calendars.length === 0 ? (
          <EmptyState icon={CalendarPlus} title={t("noCalendar")} className="py-5" action={canAdmin ? <Button size="sm" onClick={onCalendars}>{t("connectCalendar")}</Button> : undefined}>
            {canAdmin ? t("connectAdmin") : t("connectViewer")}
          </EmptyState>
        ) : (
          <EmptyState icon={CalendarDays} title={t("nothingUpcoming")} className="py-5" />
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
      {data && data.counts.upcoming > data.meetings.length ? <TextAction className="self-start" onClick={onCalendars}>{t("viewAll", {count: formatCount(data.counts.upcoming)})}</TextAction> : null}
    </section>
  );
}

// ── The whole list ──────────────────────────────────────────────────────────────────────

const WHEN = [{ value: "upcoming", label: "Upcoming" }, { value: "past", label: "Past" }] as const;

/** Every meeting, the next ones first, beside the calendars they are read from. */
export function MeetingsView({ canEdit, canAdmin, notice, onDismissNotice, onChanged }: {
  canEdit: boolean; canAdmin: boolean; notice: { tone: "good" | "bad"; message: string } | null; onDismissNotice: () => void; onChanged: () => void;
}) {
  const t = useTranslations("PipelineMeetings");
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
            <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("title")}</h2>
            <p className="text-11 text-ink-3">{t("subtitle")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Segmented label={t("when")} size="sm" value={upcoming ? "upcoming" : "past"} onChange={(when) => table.set({ filters: { when } })} options={WHEN.map(option => ({...option, label: t(`timeOptions.${option.value}`)}))} />
            <Segmented
              label={t("which")} size="sm" value={unmatched ? "unmatched" : "matched"} onChange={(match) => table.set({ filters: { match } })}
              options={[{ value: "matched", label: t("matched") }, { value: "unmatched", label: t("unmatched"), count: upcoming && data && data.counts.upcoming_unmatched > 0 ? formatCount(data.counts.upcoming_unmatched) : undefined }]}
            />
          </div>
        </div>
        <div className="border-t border-line">
          {error && !data ? (
            <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
          ) : !data ? (
            <ul className="divide-y divide-line" aria-busy="true" aria-label={t("loading")}>{Array.from({ length: 4 }, (_, index) => <li key={index} className="flex items-center gap-3 px-3.5 py-3"><Skeleton className="h-8 w-14" /><Skeleton className="h-3 flex-1" /></li>)}</ul>
          ) : data.meetings.length === 0 ? (
            <EmptyState icon={CalendarDays} title={unmatched ? t("allMatched") : data.calendars.length === 0 ? t("noCalendar") : upcoming ? t("nothingUpcoming") : t("nonePast")}>
              {unmatched ? t("unmatchedHelp") : data.calendars.length === 0 ? t("noCalendarHelp") : t("matchingHelp")}
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
                        {meeting.cancelled ? <Pill tone="neutral" size="sm">{t("cancelled")}</Pill> : null}
                      </span>
                      <span className="truncate text-11 text-ink-3">
                        {meeting.contact ? <Link href={recordHref("contact", meeting.contact.id)} className="font-medium text-ink-2 hover:underline">{meeting.contact.name}</Link> : null}
                        {meeting.contact ? meetingDetail(meeting).map((part) => ` · ${part}`).join("") : meetingWho(meeting)}
                      </span>
                    </div>
                    {meeting.calendar ? <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-line bg-surface px-2 text-105 font-semibold text-ink-2">{CALENDAR_LABEL[meeting.calendar.provider]}</span> : null}
                    {!meeting.contact && canEdit ? <Button size="sm" icon={Link2} onClick={() => setLinking(meeting)}>{t("linkTo")}</Button> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {data && data.total > data.limit ? (
          <div className="flex items-center justify-between gap-3 border-t border-line px-3.5 py-2">
            <span className="text-11 text-ink-3">{t("count", {count: formatCount(data.total)})}</span>
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
  const t = useTranslations("PipelineMeetings");
  const [contact, setContact] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  async function link() {
    if (!contact) return;
    setBusy(true);
    try {
      await linkMeeting(meeting.id, contact.id);
      toast.success(t("linked", {name: contact.label}));
      onLinked();
      onClose();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }
  return (
    <Dialog
      open onOpenChange={(next) => { if (!next) onClose(); }} title={t("linkTo")} icon={Link2} size="sm" description={meeting.title}
      footer={<><span /><span className="flex items-center gap-2"><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} disabled={!contact} onClick={() => void link()}>{t("link")}</Button></span></>}
    >
      <div className="flex flex-col gap-3">
        <p className="text-11 leading-4 text-ink-2">{t("linkHelp")}</p>
        <Field label={t("contact")}>{(id) => <RecordSearch id={id} kind="contact" value={contact} onChange={setContact} />}</Field>
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
  const t = useTranslations("PipelineMeetings");
  const [adding, setAdding] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  async function read(calendar: CalendarItem) {
    setWorking(calendar.id);
    try {
      const result = await readCalendar(calendar.id);
      const found = result.meetings_imported ?? 0;
      toast.success(found > 0 ? t("readFound", {count: formatCount(found), name: calendar.name}) : t("upToDate", {name: calendar.name}));
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setWorking(null); onChanged(); }
  }

  async function remove(calendar: CalendarItem) {
    if (!(await confirm({ title: t("removeTitle", {name: calendar.name}), body: t("removeWarning"), confirmLabel: t("remove"), tone: "danger" }))) return;
    setWorking(calendar.id);
    try {
      await removeCalendar(calendar.id);
      toast.success(t("removed"));
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setWorking(null); onChanged(); }
  }

  const unavailable = data ? SIGN_IN.filter((item) => !data.sign_in[item.provider]) : [];
  return (
    <Card className="flex w-[360px] shrink-0 flex-col gap-3 p-3.5" id="calendars">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("calendars")}</h2>
        <p className="text-11 leading-4 text-ink-3">{t("calendarSubtitle")}</p>
      </div>
      {notice ? <Alert tone={notice.tone} title={notice.message} onDismiss={onDismissNotice} /> : null}
      {!data ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("loadingCalendars")}><Skeleton className="h-12 rounded-lg" /><Skeleton className="h-12 rounded-lg" /></div>
      ) : data.calendars.length === 0 ? (
        <p className="rounded-lg bg-subtle p-2.5 text-115 text-ink-2">{t("noCalendars")}</p>
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
                      <IconButton icon={RefreshCw} label={t("readNow", {name: calendar.name})} size={24} disabled={working === calendar.id} onClick={() => void read(calendar)} />
                      <IconButton icon={Trash2} label={t("removeAria", {name: calendar.name})} size={24} disabled={working === calendar.id} onClick={() => void remove(calendar)} />
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Pill tone={status.tone} dot>{status.label}</Pill>
                  <span className="text-105 text-ink-3">{t("count", {count: formatCount(calendar.meeting_count)})}</span>
                </div>
                {calendar.sync_error ? <p className="break-words text-105 leading-[14px] text-bad">{calendar.sync_error}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-10 font-semibold uppercase tracking-label text-ink-3">{t("connect")}</span>
        {canAdmin ? (
          <>
            {SIGN_IN.map((item) => (
              !data || data.sign_in[item.provider] ? (
                <div key={item.provider} className="flex items-center justify-between gap-2">
                  <span className="text-12 font-medium text-ink">{CALENDAR_LABEL[item.provider]}</span>
                  {data ? <Button size="sm" asChild><a href={calendarSignInHref(item.provider)}>{t(item.provider === "google_calendar" ? "google" : "microsoft")}</a></Button> : <Skeleton className="h-[26px] w-28" />}
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
              <Button size="sm" icon={Rss} onClick={() => setAdding(true)}>{t("addFeed")}</Button>
            </div>
            {unavailable.length > 0 ? <p className="text-105 leading-[14px] text-ink-3">{SIGN_IN_SETUP_HINT}</p> : null}
          </>
        ) : (
          <p className="text-115 leading-[17px] text-ink-2">{t("adminHint")}</p>
        )}
      </div>
      {adding ? <AddFeedDialog onClose={() => setAdding(false)} onAdded={onChanged} /> : null}
    </Card>
  );
}

function AddFeedDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const t = useTranslations("PipelineMeetings");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!/^https?:\/\/[^\s/]+/.test(url.trim())) return setError(t("feedUrlError"));
    setError(null);
    setBusy(true);
    try {
      const made = await addCalendarFeed(name.trim() || t("feedDefault"), url.trim());
      // Read it straight away, so a wrong address is found out now and the meetings are there when the dialog closes.
      try {
        const result = await readCalendar(made.id);
        const found = result.meetings_imported ?? 0;
        toast.success(t("feedAdded", {count: formatCount(found)}));
      } catch (cause) {
        toast.error(t("feedReadError", {error: errorMessage(cause)}));
      }
      onAdded();
      onClose();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog
      open onOpenChange={(next) => { if (!next) onClose(); }} title={t("feedTitle")} icon={Rss} size="sm"
      footer={<><span /><span className="flex items-center gap-2"><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void add()}>{t("addFeed")}</Button></span></>}
    >
      <form className="flex flex-col gap-3.5" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <Field label={t("feedName")}>{(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} placeholder="Jordan's calendar" maxLength={80} />}</Field>
        <Field label={t("feedAddress")} error={error ?? undefined} hint={t("feedHelp")}>
          {(id) => <Input id={id} data-autofocus type="url" value={url} onChange={(event) => { setUrl(event.target.value); setError(null); }} placeholder="https://calendar.example.com/…/basic.ics" invalid={Boolean(error)} />}
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
