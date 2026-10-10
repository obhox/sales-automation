// The inbox screen's words and small decisions, with no React in them: what each verdict,
// status and temperature is called and coloured, how the filters are kept in the address
// bar, and the sentences shown for a reply's summary, a due time and a lock.
import type { Tone } from "@/components/ui";
import type { ConversationDetail } from "@/lib/conversations/detail";
import type { ConversationFacets, ConversationItem } from "@/lib/conversations/list";
import type { ThreadMessage, ThreadReply } from "@/lib/conversations/thread";
import { parseTime } from "@/lib/client/format";

export type { ConversationDetail, ConversationFacets, ConversationItem, ThreadMessage, ThreadReply };
export type { ConversationsResponse } from "@/pages/api/conversations";
export type { InboxMeta } from "@/pages/api/conversations/meta";
export type { InboxSyncStatus } from "@/pages/api/conversations/sync";

export const LIST_PATH = "/api/conversations";
export const META_PATH = "/api/conversations/meta";
export const SYNC_PATH = "/api/conversations/sync";
export const VIEWS_PATH = "/api/platform/saved-views";
export const conversationPath = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
export const attachmentPath = (id: string) => `/api/conversations/attachments/${encodeURIComponent(id)}`;

/** LinkedIn's own limit on a message. */
export const LINKEDIN_MESSAGE_MAX = 8000;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

// ── Verdict, status, temperature ────────────────────────────────────────────────────────

export interface Named { key: string; label: string; tone: Tone; dot: string }

/** In the order the filter rail lists them. A conversation with no verdict yet reads as "Needs review". */
export const VERDICTS: Named[] = [
  { key: "positive", label: "Positive", tone: "good", dot: "bg-good" },
  { key: "human_review", label: "Needs review", tone: "brand", dot: "bg-brand" },
  { key: "out_of_office", label: "Out of office", tone: "warn", dot: "bg-warn" },
  { key: "negative", label: "Negative", tone: "bad", dot: "bg-bad" },
  { key: "unsubscribe", label: "Unsubscribe", tone: "neutral", dot: "bg-ink-3" },
];
export const STATUSES: Named[] = [
  { key: "open", label: "Open", tone: "good", dot: "bg-good" },
  { key: "snoozed", label: "Snoozed", tone: "warn", dot: "bg-warn" },
  { key: "closed", label: "Closed", tone: "neutral", dot: "bg-ink-3" },
];
export const TEMPERATURES: Named[] = [
  { key: "hot", label: "Hot", tone: "good", dot: "bg-good" },
  { key: "warm", label: "Warm", tone: "warn", dot: "bg-warn" },
  { key: "cold", label: "Cold", tone: "neutral", dot: "bg-ink-3" },
];

const find = (list: Named[], key: string | null | undefined, fallback: Named) => list.find((item) => item.key === key) ?? fallback;
export const verdictOf = (key: string | null | undefined) => find(VERDICTS, key, VERDICTS[1]);
export const statusOf = (key: string | null | undefined) => find(STATUSES, key, STATUSES[0]);
export const temperatureOf = (key: string | null | undefined) => (key ? find(TEMPERATURES, key, TEMPERATURES[1]) : null);

// ── Filters, as the address bar keeps them ──────────────────────────────────────────────

/** Each filter with its "no filter" value. Several values in one filter are comma-separated. */
export const FILTER_DEFAULTS = { view: "all", verdict: "", status: "", temperature: "", assignee: "", sla: "", tag: "" };
export type InboxFilters = typeof FILTER_DEFAULTS;
export type FilterKey = keyof InboxFilters;

export const split = (value: string) => value.split(",").map((part) => part.trim()).filter(Boolean);

/** Add a value to a comma-separated filter, or take it out if it is there. */
export function toggled(value: string, item: string): string {
  const parts = split(value);
  return (parts.includes(item) ? parts.filter((part) => part !== item) : [...parts, item]).join(",");
}

/** A saved view keeps what the address bar keeps: the filters, the sort and the search. */
export interface ViewState { filters?: Partial<InboxFilters>; sort?: string; q?: string }
export interface SavedView { id: string; name: string; shared: boolean; editable: boolean; state: ViewState }

export function sameView(state: ViewState, filters: InboxFilters, sort: string, q: string): boolean {
  const kept = { ...FILTER_DEFAULTS, ...(state.filters ?? {}) };
  return (Object.keys(FILTER_DEFAULTS) as FilterKey[]).every((key) => split(kept[key]).sort().join(",") === split(filters[key]).sort().join(",") || kept[key] === filters[key])
    && (state.sort ?? "recent:desc") === sort && (state.q ?? "") === q;
}

export const SORTS = [
  { value: "recent:desc", label: "Newest message first" },
  { value: "recent:asc", label: "Oldest message first" },
  { value: "due:asc", label: "Answer due soonest" },
] as const;

// ── Sentences ───────────────────────────────────────────────────────────────────────────

const span = (minutes: number) => (minutes < 60 ? `${Math.max(1, minutes)}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`);

/** "Due in 3h" or "Overdue 2h", or nothing when no answer is owed. */
export function dueLabel(dueAt: string | null, status: string, now: Date = new Date()): { text: string; overdue: boolean } | null {
  const due = parseTime(dueAt);
  if (!due || status !== "open") return null;
  const minutes = Math.round((due.getTime() - now.getTime()) / 60_000);
  return minutes < 0 ? { text: `Overdue ${span(-minutes)}`, overdue: true } : { text: `Due in ${span(minutes)}`, overdue: false };
}

/** "Priya Raman is replying · 2m" */
export function lockLabel(lock: { name: string; at: string }, now: Date = new Date()): string {
  const since = parseTime(lock.at);
  return since ? `${lock.name} is replying · ${span(Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000)))}` : `${lock.name} is replying`;
}

/** "Snoozed until Tue 14 Oct, 9:00" or "Snoozed until they write" */
export function snoozeLabel(until: string | null): string {
  const date = parseTime(until);
  if (!date) return "Snoozed until they write";
  return `Snoozed until ${date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" })}, ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

export interface SnoozeChoice { key: string; label: string; hint: string; until: () => string | null }

/** The times a conversation can be snoozed to, worked out from now. */
export function snoozeChoices(now: Date = new Date()): SnoozeChoice[] {
  const at = (days: number, hour: number) => { const date = new Date(now); date.setDate(date.getDate() + days); date.setHours(hour, 0, 0, 0); return date; };
  const later = new Date(now.getTime() + 3 * 3_600_000);
  const monday = at(((8 - now.getDay()) % 7) || 7, 9);
  const hint = (date: Date) => `${date.toLocaleDateString("en-US", { weekday: "short" })} ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  return [
    { key: "later", label: "Later today", hint: hint(later), until: () => later.toISOString() },
    { key: "tomorrow", label: "Tomorrow morning", hint: hint(at(1, 9)), until: () => at(1, 9).toISOString() },
    { key: "monday", label: "Next week", hint: hint(monday), until: () => monday.toISOString() },
    { key: "reply", label: "Until they write", hint: "No end time", until: () => null },
  ];
}

/** The moment this many hours from now, as the API takes a time. */
export const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

export const DUE_CHOICES = [
  { key: "1h", label: "In 1 hour", hours: 1 },
  { key: "4h", label: "In 4 hours", hours: 4 },
  { key: "24h", label: "This time tomorrow", hours: 24 },
];

// What the classifier's short codes for a next step mean, in words. A model writes its own
// sentence instead of a code, and that is shown as it is.
const NEXT_STEPS: Record<string, string> = {
  human_followup: "answer them personally",
  suppress: "nothing; they will not be contacted again",
  reschedule: "wait until they are back",
  unenroll: "nothing; their campaigns are stopped",
  review: "read it and decide",
  manual: "",
};

/** The summary card's two lines for a reply that has a verdict. */
export function summaryOf(reply: ThreadReply): { title: string; detail: string } {
  const verdict = verdictOf(reply.verdict).label.toLowerCase();
  const confidence = typeof reply.confidence === "number" && reply.confidence > 0 && reply.summary !== "Manually reclassified" ? ` · ${Math.round(reply.confidence * 100)}% confidence` : "";
  const manual = reply.summary === "Manually reclassified";
  const step = reply.suggested_action ? NEXT_STEPS[reply.suggested_action] ?? reply.suggested_action : "";
  const summary = manual ? "Set by a person." : reply.summary?.trim() ?? "";
  const detail = [summary && (/[.!?]$/.test(summary) ? summary : `${summary}.`), step && `Suggested next step: ${step.replace(/[.]$/, "")}.`].filter(Boolean).join(" ");
  return { title: `${manual ? "Marked" : "Classified"} ${verdict}${confidence}`, detail };
}

// What was done about a reply when it was read, for the line under the summary.
const DISPATCHES: Record<string, string> = {
  suppressed_and_unenrolled: "They asked not to be contacted: they are on the do-not-contact list and out of every campaign.",
  unenrolled_and_flagged: "Their campaigns were stopped and a task was made to review the reply.",
  unenrolled: "Their campaigns were stopped.",
  unenrolled_and_task_created: "Their campaigns were stopped and a follow-up task was made.",
  rescheduled: "They are away, so their next campaign step was put back.",
  paused_and_task_created: "Their campaigns were stopped and a task was made to review the reply.",
  none: "",
};
export const dispatchLine = (reply: ThreadReply | null): string => (reply?.dispatch && typeof reply.dispatch.action === "string" ? DISPATCHES[reply.dispatch.action] ?? "" : reply?.dispatch?.kind === "cancelled" ? "The follow-up that was put back for them was cancelled." : "");

/** "Q4 Logistics Ops · Step 2 of 5 · Opened 4×" for a message a campaign sent. */
export function campaignLine(message: ThreadMessage): string | null {
  if (!message.campaign) return null;
  const parts = [message.campaign.name];
  if (message.kind === "inmail") parts.push("InMail");
  else if (message.kind === "note") parts.push("Note with the connection request");
  if (message.campaign.step && message.campaign.steps) parts.push(`Step ${message.campaign.step} of ${message.campaign.steps}`);
  if (message.opens) parts.push(`Opened ${message.opens}×`);
  return parts.join(" · ");
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether anything in a conversation is still on its way, which is the only time the thread is asked for again by itself. */
export const hasPending = (detail: ConversationDetail | undefined): boolean => Boolean(detail?.messages.some((message) => message.status === "queued" || message.status === "sending"));

/** Put text where the cursor is (replacing a selection), and say where the cursor goes next. */
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; cursor: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: text.slice(0, from) + insert + text.slice(to), cursor: from + insert.length };
}

/** A saved reply is added on its own line under what is already written. */
export function appendReply(text: string, reply: string): string {
  const base = text.replace(/\s+$/, "");
  return base ? `${base}\n\n${reply}` : reply;
}
