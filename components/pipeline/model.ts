// The pipeline screen's wording and the small decisions behind it: what each figure says,
// how a deal, a task, a meeting and a line of activity read. No React here, so it can be
// tested as plain functions.
import type { ActivityGroup, ActivityItem } from "@/lib/pipeline/activity";
import type { CalendarItem, CalendarProvider, MeetingCounts, MeetingItem } from "@/lib/pipeline/meetings";
import type { PipelineSummary } from "@/lib/pipeline/summary";
import type { Priority, TaskCounts, TaskItem } from "@/lib/pipeline/tasks";
import { formatCompact, formatCount, formatDate, formatMoney, formatPercent, formatRelative, parseTime, plural } from "@/lib/client/format";

export type { ActivityGroup, ActivityItem, CalendarItem, CalendarProvider, MeetingCounts, MeetingItem, PipelineSummary, Priority, TaskCounts, TaskItem };

export const PIPELINE_PATH = "/api/platform/pipeline";
export const TASKS_PATH = "/api/pipeline/tasks";
export const MEETINGS_PATH = "/api/pipeline/meetings";
export const ACTIVITY_PATH = "/api/pipeline/activity";
export const CONNECTIONS_PATH = "/api/platform/connections";

export type Tone = "neutral" | "brand" | "good" | "warn" | "bad" | "li" | "mail";

// ── What the board is read from ─────────────────────────────────────────────────────────

export interface Stage {
  id: string; name: string; position: number; probability: number; is_won: number; is_lost: number;
  /** Every opportunity in the stage, whoever owns it: the owner filter does not narrow this. */
  opportunity_count: number;
}

export interface Opportunity {
  id: string;
  name: string;
  amount: number | null;
  currency: string;
  expected_close_date: string | null;
  stage_id: string | null;
  owner_id: string | null;
  target_id: string | null;
  company_id: string | null;
  source: string | null;
  created_at: string;
  closed_at: string | null;
  contact_name: string | null;
  contact_title: string | null;
  company_name: string | null;
  owner_email: string | null;
  owner_name: string | null;
  open_task_count: number;
}

export interface Member { id: string; email: string; name: string | null; role: string }

export interface PipelineData {
  stages: Stage[];
  opportunities: Opportunity[];
  members: Member[];
  summary: PipelineSummary;
  settings: { auto_opportunity_on_reply: boolean };
  sources: string[];
}

export interface TasksData { tasks: TaskItem[]; total: number; counts: TaskCounts; page: number; limit: number }
export interface MeetingsData { meetings: MeetingItem[]; total: number; counts: MeetingCounts; calendars: CalendarItem[]; sign_in: Record<"google_calendar" | "microsoft_calendar", boolean>; page: number; limit: number }
export interface ActivityData { items: ActivityItem[]; total: number; page: number; limit: number }

// ── Views and the owner filter ──────────────────────────────────────────────────────────

export const VIEWS = [
  { value: "board", label: "Board" },
  { value: "tasks", label: "Tasks" },
  { value: "meetings", label: "Meetings" },
  { value: "activity", label: "Activity" },
] as const;
export type View = (typeof VIEWS)[number]["value"];
export const viewOf = (value: unknown): View => (VIEWS.some((view) => view.value === value) ? (value as View) : "board");

export const memberName = (member: { name: string | null; email: string }) => member.name?.trim() || member.email.split("@")[0];

/** The owner filter's choices: everyone, each member, and what nobody owns. */
export function ownerOptions(members: Member[]): Array<{ value: string; label: string; separated?: boolean }> {
  return [
    { value: "all", label: "All owners" },
    ...members.map((member, index) => ({ value: member.id, label: memberName(member), separated: index === 0 })),
    { value: "none", label: "No owner", separated: true },
  ];
}
export const ownerLabel = (owner: string, members: Member[]) => ownerOptions(members).find((option) => option.value === owner)?.label ?? "All owners";

// ── The figures above the board ─────────────────────────────────────────────────────────

export interface Stat { key: string; label: string; value: string; note: string; tone: "good" | "plain" }

export function summaryStats(summary: PipelineSummary): Stat[] {
  const money = (amount: number | null) => formatMoney(amount, summary.currency);
  const short = (amount: number) => {
    // "$38.2k": the currency's own sign, a short number.
    const sign = money(0).replace(/[\d.,\s]/g, "");
    return `${sign}${formatCompact(amount)}`;
  };
  return [
    {
      key: "weighted", label: "Weighted pipeline", value: money(summary.weighted_pipeline),
      note: summary.weighted_added_30d > 0 ? `+${short(summary.weighted_added_30d)} added in 30 days` : "nothing added in 30 days",
      tone: summary.weighted_added_30d > 0 ? "good" : "plain",
    },
    {
      key: "open", label: "Open opportunities", value: formatCount(summary.open_count),
      note: summary.open_from_replies > 0 ? `${formatCount(summary.open_from_replies)} created from replies` : "none created from replies",
      tone: "plain",
    },
    {
      key: "won", label: "Won this quarter", value: money(summary.won_quarter),
      note: summary.won_quarter_count > 0 ? `${formatCount(summary.won_quarter_count)} ${plural(summary.won_quarter_count, "deal", "deals")}` : "no deals yet",
      tone: summary.won_quarter_count > 0 ? "good" : "plain",
    },
    {
      key: "size", label: "Average deal size", value: money(summary.average_deal_size),
      note: summary.sales_cycle_days === null ? "no deal won in 12 months" : `sales cycle ${formatCount(summary.sales_cycle_days)} ${plural(summary.sales_cycle_days, "day", "days")}`,
      tone: "plain",
    },
    {
      key: "win", label: "Win rate", value: formatPercent(summary.win_rate),
      note: summary.closed_12m > 0 ? `of ${formatCount(summary.closed_12m)} closed in 12 months` : "nothing closed in 12 months",
      tone: "plain",
    },
  ];
}

/** Said under the figures when some opportunities are in a currency the sums leave out. */
export function currencyNote(summary: PipelineSummary): string | null {
  if (!summary.other_currencies) return null;
  return `Amounts are in ${summary.currency}. ${formatCount(summary.other_currencies)} ${plural(summary.other_currencies, "opportunity", "opportunities")} in another currency ${plural(summary.other_currencies, "is", "are")} counted but not added in.`;
}

// ── The board ───────────────────────────────────────────────────────────────────────────

export interface Column { stage: Stage | null; id: string; name: string; tone: Tone; deals: Opportunity[]; value: number; probability: number | null }

const OPEN_TONES: Tone[] = ["brand", "li", "mail", "warn", "neutral"];

/** The stages as columns, each with its deals. Deals in no stage get a column of their own, only when there are any. */
export function columnsOf(stages: Stage[], opportunities: Opportunity[], currency: string): Column[] {
  let open = 0;
  const columns = [...stages].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)).map((stage): Column => {
    const deals = opportunities.filter((opportunity) => opportunity.stage_id === stage.id);
    return {
      stage, id: stage.id, name: stage.name, deals, probability: stage.probability,
      tone: stage.is_won ? "good" : stage.is_lost ? "bad" : OPEN_TONES[open++ % OPEN_TONES.length],
      value: deals.reduce((sum, deal) => sum + (deal.currency === currency ? deal.amount ?? 0 : 0), 0),
    };
  });
  const known = new Set(stages.map((stage) => stage.id));
  const loose = opportunities.filter((opportunity) => !opportunity.stage_id || !known.has(opportunity.stage_id));
  if (loose.length) columns.push({ stage: null, id: "none", name: "No stage", tone: "neutral", deals: loose, probability: null, value: loose.reduce((sum, deal) => sum + (deal.currency === currency ? deal.amount ?? 0 : 0), 0) });
  return columns;
}

/** A deal's second line: who it is with. The company is left out when it is already the deal's name. */
export function dealSubline(deal: Opportunity): string {
  const company = deal.company_name && deal.company_name.trim().toLowerCase() !== deal.name.trim().toLowerCase() ? deal.company_name : null;
  return [deal.contact_name, company ?? deal.contact_title].filter(Boolean).join(" · ") || company || "No contact";
}

/** "2026-11-14" as a day where the reader is, not as midnight UTC (which is the day before, west of Greenwich). */
export function localDay(value: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** When a deal is expected to close, and whether that day has gone by while it is still open. */
export function dealDate(deal: Opportunity, stage: Stage | null, now: Date = new Date()): { label: string; late: boolean } | null {
  const day = localDay(deal.expected_close_date);
  if (!day) return null;
  const closed = Boolean(stage?.is_won || stage?.is_lost);
  return { label: formatDate(day, now), late: !closed && dayDistance(day, now) > 0 };
}

const SOURCE_LABEL: Record<string, string> = {
  manual: "Added by hand", reply: "From a reply", campaign: "From a campaign", inbound: "Inbound", referral: "Referral", event: "Event", import: "Imported", other: "Other",
};
export const sourceLabel = (source: string | null) => (source ? SOURCE_LABEL[source] ?? source.replace(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase()) : "Not recorded");

// ── The CRM the board is copied to ──────────────────────────────────────────────────────

export interface ConnectionRow { id: string; provider: string; name: string; enabled: number; last_synced_at: string | null; sync_error: string | null }
const CRM_LABEL: Record<string, string> = { hubspot: "HubSpot", salesforce: "Salesforce" };

/** "HubSpot synced 6 min ago", for a workspace that has a CRM connected. Null when it has none. */
export function crmSyncNote(connections: ConnectionRow[], now: Date = new Date()): { label: string; failed: boolean } | null {
  const crm = connections.filter((row) => row.provider in CRM_LABEL && row.enabled);
  if (crm.length === 0) return null;
  const failed = crm.find((row) => row.sync_error);
  if (failed) return { label: `${CRM_LABEL[failed.provider]} sync failed`, failed: true };
  const latest = crm.filter((row) => row.last_synced_at).sort((a, b) => (parseTime(b.last_synced_at)?.getTime() ?? 0) - (parseTime(a.last_synced_at)?.getTime() ?? 0))[0];
  return latest ? { label: `${CRM_LABEL[latest.provider]} synced ${formatRelative(latest.last_synced_at, now)}`, failed: false } : { label: `${CRM_LABEL[crm[0].provider]} not synced yet`, failed: false };
}

// ── Days and times ──────────────────────────────────────────────────────────────────────

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
/** Whole calendar days from `date` to `now` where the reader is: 0 today, 1 yesterday, -1 tomorrow. */
const dayDistance = (date: Date, now: Date) => Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
const clock = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

function dayName(date: Date, now: Date): string {
  const distance = dayDistance(date, now);
  return distance === 0 ? "Today" : distance === 1 ? "Yesterday" : distance === -1 ? "Tomorrow" : formatDate(date, now);
}

/** What the task list is told about today where the reader is: the date, for "overdue", and when it began, for "completed today". */
export function todayQuery(now: Date = new Date()): { today: string; day_start: string } {
  return { today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`, day_start: new Date(startOfDay(now)).toISOString() };
}

// ── Tasks ───────────────────────────────────────────────────────────────────────────────

export const PRIORITY_LABEL: Record<Priority, string> = { high: "High", medium: "Medium", low: "Low" };
export const PRIORITY_TONE: Record<Priority, Tone> = { high: "bad", medium: "warn", low: "neutral" };

/** "Yesterday 17:00", "Today", "Nov 14 09:00". Null when the task has no date. */
export function dueLabel(task: Pick<TaskItem, "due_at" | "due_date">, now: Date = new Date()): string | null {
  const moment = parseTime(task.due_at);
  if (moment) return `${dayName(moment, now)} ${clock(moment)}`;
  const day = localDay(task.due_date);
  return day ? dayName(day, now) : null;
}

/** The quiet line under a task: what it is about, then why it is there or when it was finished. */
export function taskSubline(task: TaskItem, now: Date = new Date()): string {
  const subject = task.company?.name ?? task.contact?.name ?? task.opportunity?.name ?? null;
  // A note that already begins with the company is not given the company again in front of it.
  const about = subject && task.status !== "done" && task.description?.trim().toLowerCase().startsWith(subject.toLowerCase()) ? null : subject;
  const finished = task.status === "done" ? parseTime(task.completed_at) : null;
  const detail = task.status === "done"
    ? finished ? `completed ${dayDistance(finished, now) === 0 ? clock(finished) : formatDate(finished, now)}` : "completed"
    : task.description?.split(/\r?\n/)[0].trim() || (task.opportunity && task.opportunity.name !== subject ? task.opportunity.name : task.company && task.contact ? task.contact.name : null);
  return [about, detail].filter(Boolean).join(" · ");
}

export const taskCountsLine = (counts: TaskCounts) => `${formatCount(counts.open)} open · ${formatCount(counts.completed_today)} completed today`;

export const TASK_SCOPES = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "overdue", label: "Overdue" },
] as const;
export type TaskScope = (typeof TASK_SCOPES)[number]["value"];

/** The day and time fields of the task form, from a stored task. */
export function dueFields(task: Pick<TaskItem, "due_at" | "due_date"> | null): { day: string; time: string } {
  const moment = parseTime(task?.due_at);
  if (moment) return { day: `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, "0")}-${String(moment.getDate()).padStart(2, "0")}`, time: clock(moment) };
  return { day: task?.due_date?.slice(0, 10) ?? "", time: "" };
}

/** What to send for a day and an optional time typed where the reader is. */
export function dueFromFields(day: string, time: string): { due_date: string | null; due_at: string | null } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { due_date: null, due_at: null };
  if (!/^\d{2}:\d{2}$/.test(time)) return { due_date: day, due_at: null };
  const moment = new Date(`${day}T${time}:00`);
  return { due_date: day, due_at: Number.isNaN(moment.getTime()) ? null : moment.toISOString() };
}

// ── Meetings and calendars ──────────────────────────────────────────────────────────────

export const CALENDAR_LABEL: Record<CalendarProvider, string> = { google_calendar: "Google Calendar", microsoft_calendar: "Microsoft Calendar", ical: "iCal feed" };

/** The time and the day a meeting starts, the way the list shows them ("15:00" over "Today"). */
export function meetingWhen(meeting: Pick<MeetingItem, "starts_at" | "all_day">, now: Date = new Date()): { time: string; day: string } {
  const start = meeting.all_day ? localDay(meeting.starts_at) : parseTime(meeting.starts_at);
  if (!start) return { time: "—", day: "" };
  return { time: meeting.all_day ? "All day" : clock(start), day: dayName(start, now) };
}

/** "Sofia Ahlberg · 45 min", "Nina Kowalski +2 · 60 min". */
export function meetingWho(meeting: MeetingItem): string {
  const others = meeting.contact ? Math.max(0, meeting.attendee_count - 1) : meeting.attendee_count;
  const who = meeting.contact ? `${meeting.contact.name}${others > 0 ? ` +${others}` : ""}` : others > 0 ? `${others} ${plural(others, "person", "people")} invited` : "Nobody invited";
  return [who, meeting.duration_minutes ? `${meeting.duration_minutes} min` : null].filter(Boolean).join(" · ");
}

/** What follows the contact's name on a matched meeting: their company, how long it is, and the deal when that is not just the company again. */
export function meetingDetail(meeting: MeetingItem): string[] {
  const company = meeting.company?.name ?? null;
  const deal = meeting.opportunity && meeting.opportunity.name.trim().toLowerCase() !== company?.trim().toLowerCase() ? meeting.opportunity.name : null;
  return [company, meeting.duration_minutes ? `${meeting.duration_minutes} min` : null, deal].filter((part): part is string => Boolean(part));
}

export function calendarStatus(calendar: CalendarItem, now: Date = new Date()): { tone: Tone; label: string } {
  if (calendar.sync_error) return { tone: "bad", label: needsSignIn(calendar) ? "Needs signing in to again" : "Could not be read" };
  if (!calendar.enabled) return { tone: "neutral", label: "Paused" };
  const read = parseTime(calendar.last_synced_at);
  if (!read) return { tone: "neutral", label: "Not read yet" };
  const minutes = Math.max(0, Math.round((now.getTime() - read.getTime()) / 60_000));
  return { tone: "good", label: minutes < 1 ? "Read just now" : minutes < 60 ? `Read ${minutes} min ago` : minutes < 60 * 24 ? `Read ${Math.round(minutes / 60)} h ago` : `Read ${formatDate(read, now)}` };
}
const needsSignIn = (calendar: CalendarItem) => calendar.signed_in && /sign(ing)? in|sign-in|401|invalid_grant/i.test(calendar.sync_error ?? "");

/** What a calendar is, in a line: the account that was signed in to, or where a feed is read from. */
export const calendarWhere = (calendar: CalendarItem) => calendar.account_email ?? (calendar.provider === "ical" ? calendar.host ?? "A calendar feed" : "Connected with a pasted token");

/** Said in place of a sign-in button when the server has no app registered with the provider. */
export const signInUnavailable = (provider: "google_calendar" | "microsoft_calendar") => `${CALENDAR_LABEL[provider]} sign-in is not set up on this server.`;
export const SIGN_IN_SETUP_HINT = "Whoever runs this server has to register an app with the provider and add its client id and secret. A calendar feed works without that.";

/** What to say when the member comes back from signing in to a calendar, read from the address they were sent back to. */
export function calendarReturnNotice(query: Record<string, string | string[] | undefined>): { tone: "good" | "bad"; message: string } | null {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const provider = first(query.provider);
  const name = provider === "google_calendar" || provider === "microsoft_calendar" ? CALENDAR_LABEL[provider] : "The calendar";
  if (first(query.calendar) === "connected") return { tone: "good", message: `${name} is connected. Its meetings are being read now.` };
  switch (first(query.calendar_error)) {
    case undefined: return null;
    case "not_set_up": return { tone: "bad", message: `${name} sign-in is not set up on this server.` };
    case "declined": return { tone: "bad", message: `${name} was not connected: access was not given.` };
    case "expired": return { tone: "bad", message: "That sign-in took too long or was started by someone else. Start it again from here." };
    default: return { tone: "bad", message: `${name} did not accept the sign-in. Nothing was connected.` };
  }
}

// ── Activity ────────────────────────────────────────────────────────────────────────────

export const ACTIVITY_GROUPS: Array<{ value: "all" | ActivityGroup; label: string }> = [
  { value: "all", label: "All" },
  { value: "deals", label: "Deals" },
  { value: "tasks", label: "Tasks" },
  { value: "meetings", label: "Meetings" },
  { value: "notes", label: "Notes and calls" },
];

export const LOG_TYPES = [
  { value: "note", label: "Note" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "meeting", label: "Meeting" },
] as const;
export type LogType = (typeof LOG_TYPES)[number]["value"];

export type ActivityIcon = "call" | "note" | "email" | "meeting" | "deal" | "moved" | "won" | "lost" | "deleted" | "task" | "done";

/** One line of activity as a sentence, with the text that goes under it and who did it. */
export function activityLine(item: ActivityItem): { icon: ActivityIcon; tone: Tone; text: string; detail: string | null; by: string } {
  const who = item.contact?.name ?? item.company?.name ?? "a contact";
  const detail = item.detail ?? {};
  // Nobody's name means Linki did it by itself, unless it came in through the API with a key.
  const by = item.actor?.name ?? (detail.via === "api" ? "The API" : "Linki");
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const amount = typeof detail.amount === "number" && detail.amount > 0 ? formatMoney(detail.amount, text(detail.currency) ?? "USD") : null;
  const line = (icon: ActivityIcon, tone: Tone, sentence: string, under: string | null = null) => ({ icon, tone, text: sentence, detail: under, by });
  switch (item.kind) {
    case "log_call": return line("call", "good", `Call logged with ${who}`, item.body);
    case "log_email": return line("email", "mail", `Email logged with ${who}`, item.body);
    case "log_meeting": return line("meeting", "brand", `Meeting logged with ${who}`, item.body);
    case "log_note": return line("note", "neutral", `Note on ${who}`, item.body);
    case "opportunity_created":
      return line("deal", "brand", detail.source === "reply" ? `${item.subject} opened from a positive reply` : `${item.subject} added to the pipeline`, amount);
    case "opportunity_moved": return line("moved", "brand", `${item.subject} moved to ${text(detail.to_stage) ?? "another stage"}`, text(detail.from_stage) ? `from ${text(detail.from_stage)}` : null);
    case "opportunity_won": return line("won", "good", `${item.subject} moved to ${text(detail.to_stage) ?? "won"}`, amount);
    case "opportunity_lost": return line("lost", "bad", `${item.subject} moved to ${text(detail.to_stage) ?? "lost"}`, amount);
    case "opportunity_deleted": return line("deleted", "neutral", `${item.subject} deleted`);
    // The contact is named beside every line already, so these say only what that does not: the company.
    case "task_created": return line("task", "brand", item.actor ? `Task added: ${item.subject}` : `Task created automatically: ${item.subject}`, item.company?.name ?? null);
    case "task_completed": return line("done", "good", `Task done: ${item.subject}`, item.company?.name ?? null);
    case "meeting_booked": return line("meeting", "brand", `Meeting booked: ${item.subject}`, item.company?.name ?? null);
    default: return line("note", "neutral", item.subject || `Activity logged on ${who}`, item.body);
  }
}

// ── The stage editor ────────────────────────────────────────────────────────────────────

export type StageKind = "open" | "won" | "lost";
export const STAGE_KINDS: Array<{ value: StageKind; label: string }> = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];
export const stageKind = (stage: Pick<Stage, "is_won" | "is_lost">): StageKind => (stage.is_won ? "won" : stage.is_lost ? "lost" : "open");

/** A whole number from 0 to 100, or null for anything else typed into the chance field. */
export function probabilityFrom(value: string): number | null {
  const number = Number(value.trim());
  return value.trim() !== "" && Number.isInteger(number) && number >= 0 && number <= 100 ? number : null;
}

/** The amount field: empty is "no amount", which is not zero. `undefined` means it cannot be read. */
export function amountFrom(value: string): number | null | undefined {
  const text = value.replace(/[,\s]/g, "");
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
