// What the contact profile says about a contact: the words for a timeline line, a
// campaign's state and each of its steps, a reply's verdict, a task's due date. No React
// in here, so the wording can be tested.
import type { CampaignHistory, CampaignStep, ContactProfile, TimelineChannel, TimelineItem } from "@/lib/contacts/profile";
import { formatCount, formatDate, formatDateTime, formatRelative, parseTime, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";
import { LINKEDIN_LABEL } from "../model";

export type { CampaignHistory, CampaignStep, ContactProfile, TimelineChannel, TimelineItem };

export const profilePath = (id: string) => `/api/targets/${id}`;
export const ACTIVITY_PATH = "/api/activity-logs";
export const TASKS_PATH = "/api/todos";
export const BOOKING_PATH = "/api/platform/booking-link";
export const LINKEDIN_THREAD_PATH = "/api/inbox/linkedin-thread";
export const LINKEDIN_SEND_PATH = "/api/inbox/linkedin-reply";
export const MAILBOXES_PATH = "/api/email-accounts";
/** The longest message LinkedIn's outbox takes (lib/linkedin/outbox.ts holds the rule; this mirrors it for the counter). */
export const LINKEDIN_MESSAGE_MAX = 8000;
export const TIMELINE_PAGE = 30;

export interface Timeline {
  items: TimelineItem[];
  total: number;
  counts: Record<TimelineChannel, number>;
}

export interface Neighbours {
  position: number;
  total: number;
  previous: string | null;
  next: string | null;
}

export interface Badge {
  tone: Tone;
  label: string;
}

// ── Verdicts and header pills ─────────────────────────────────────────────────

const VERDICTS: Record<string, Badge> = {
  positive: { tone: "good", label: "Positive" },
  hot: { tone: "good", label: "Hot" },
  warm: { tone: "warn", label: "Warm" },
  neutral: { tone: "neutral", label: "Neutral" },
  cold: { tone: "neutral", label: "Cold" },
  negative: { tone: "bad", label: "Not interested" },
  human_review: { tone: "warn", label: "Needs a person" },
  out_of_office: { tone: "neutral", label: "Out of office" },
  unsubscribe: { tone: "bad", label: "Opt-out" },
};

/** A reply's verdict as a pill. A verdict this screen has not met is shown in its own words. */
export function verdictBadge(verdict: string | null): Badge | null {
  if (!verdict) return null;
  return VERDICTS[verdict] ?? { tone: "neutral", label: sentence(verdict.replace(/_/g, " ")) };
}

const sentence = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** "Replied · Positive", or just "Replied" when nothing has judged the reply. */
export function replyBadge(reply: ContactProfile["contact"]["reply"]): Badge | null {
  if (!reply) return null;
  const verdict = verdictBadge(reply.verdict);
  return verdict ? { tone: verdict.tone === "neutral" ? "good" : verdict.tone, label: `Replied · ${verdict.label}` } : { tone: "good", label: "Replied" };
}

/** The campaign the contact is in now, as the header says it: "In campaign · Step 3". */
export function campaignBadge(campaigns: CampaignHistory[]): Badge | null {
  const live = campaigns.find((campaign) => campaign.state === "active" || campaign.state === "paused");
  if (!live) return null;
  const step = live.next_number ? ` · Step ${live.next_number}` : "";
  return live.state === "paused" ? { tone: "warn", label: `Campaign paused${step}` } : { tone: "brand", label: `In campaign${step}` };
}

export function emailBadge(contact: ContactProfile["contact"]): Badge {
  if (!contact.email) return { tone: "neutral", label: "No email" };
  if (contact.verifying) return { tone: "brand", label: "Email being verified" };
  switch (contact.email_status) {
    case "verified": return { tone: "mail", label: "Email verified" };
    case "checked": return { tone: "mail", label: "Email checked" };
    case "catchall": return { tone: "warn", label: "Email on a catch-all domain" };
    case "invalid": return { tone: "bad", label: "Email invalid" };
    case "unverified": return { tone: "neutral", label: "Email check inconclusive" };
    default: return { tone: "neutral", label: "Email not checked" };
  }
}

/** "Verified Oct 2" beside the email field. Null when the address has not been checked. */
export function emailCheckedLine(contact: ContactProfile["contact"], now: Date = new Date()): Badge | null {
  if (!contact.email || !contact.email_status) return null;
  const when = contact.email_verified_at ? ` ${formatDate(contact.email_verified_at, now)}` : "";
  switch (contact.email_status) {
    case "verified": return { tone: "good", label: `Verified${when}` };
    case "checked": return { tone: "good", label: `Checked${when}` };
    case "catchall": return { tone: "warn", label: `Catch-all${when}` };
    case "invalid": return { tone: "bad", label: `Invalid${when}` };
    default: return { tone: "neutral", label: `Inconclusive${when}` };
  }
}

export function linkedinBadge(contact: ContactProfile["contact"]): Badge {
  if (!contact.linkedin_url) return { tone: "neutral", label: "No LinkedIn profile" };
  if (contact.linkedin_status === "connected") return { tone: "li", label: "LinkedIn · 1st degree" };
  const degree = contact.degree === 2 ? " · 2nd degree" : contact.degree === 3 ? " · 3rd degree" : "";
  return contact.linkedin_status === "not_connected"
    ? { tone: "neutral", label: `LinkedIn${degree || " · not connected"}` }
    : { tone: LINKEDIN_LABEL[contact.linkedin_status].tone, label: `LinkedIn · ${LINKEDIN_LABEL[contact.linkedin_status].label.toLowerCase()}` };
}

/** "/in/marcusoyelaran" from a profile address; the whole address when it is not shaped like one. */
export function linkedinHandle(url: string): string {
  const match = /linkedin\.com(\/(?:in|sales\/lead)\/[^/?#]+)/i.exec(url);
  return match ? decodeURIComponent(match[1]) : url.replace(/^https?:\/\/(www\.)?/, "");
}

/**
 * "CEST, 3:14 PM local" for a contact's time zone. Null when the zone is missing or is not
 * one the browser knows.
 */
export function localTimeLine(timeZone: string | null, now: Date = new Date()): string | null {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(now);
    const zone = parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
    const time = parts.filter((part) => ["hour", "minute", "literal", "dayPeriod"].includes(part.type)).map((part) => part.value).join("").replace(/\u202f/g, " ").trim();
    return `${zone}, ${time} local`;
  } catch {
    return null;
  }
}

// ── Notes ─────────────────────────────────────────────────────────────────────

/** "Saved 1 min ago" under the notes box, from when they were last stored. */
export function notesSavedLine(state: "idle" | "typing" | "saving" | "failed", updatedAt: string | null, now: Date = new Date()): string {
  if (state === "saving") return "Saving…";
  if (state === "typing") return "Not saved yet";
  if (state === "failed") return "Not saved";
  return updatedAt ? `Saved ${formatRelative(updatedAt, now)}` : "";
}

/** "— Jonas Mertens, Oct 10". */
export function notesByLine(by: { name: string } | null, updatedAt: string | null, now: Date = new Date()): string | null {
  if (!by && !updatedAt) return null;
  return `— ${[by?.name, updatedAt ? formatDate(updatedAt, now) : null].filter(Boolean).join(", ")}`;
}

// ── Career ────────────────────────────────────────────────────────────────────

const monthYear = (value: string | null) => {
  const date = parseTime(value);
  return date ? date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : null;
};

/** "Mar 2022 — Present". Empty when neither end is known. */
export function careerDates(position: { start: string | null; end: string | null; current: boolean }): string {
  const start = monthYear(position.start);
  const end = position.current ? "Present" : monthYear(position.end);
  if (start && end) return `${start} — ${end}`;
  return start ?? (position.current ? "Present" : end ?? "");
}

// ── Campaign history ──────────────────────────────────────────────────────────

const STEP_TYPE: Record<string, string> = { email: "Email", connect: "LinkedIn invite", message: "LinkedIn message", visit: "Profile visit", sales_inmail: "InMail", inmail: "InMail" };

/** "Step 2 · Email — Value" */
export function stepLabel(step: CampaignStep): string {
  const kind = STEP_TYPE[step.type] ?? sentence(step.type.replace(/_/g, " "));
  const subject = step.type === "email" && step.subject ? ` — ${step.subject.replace(/^(re|fwd?):\s*/i, "").trim()}` : "";
  return `Step ${step.number} · ${kind}${subject}`;
}

/** The engine's reason for stopping, in the screen's words where it is one it knows. */
export function stopReason(reason: string | null): string | null {
  if (!reason) return null;
  if (/repl(y|ied)/i.test(reason)) return "Reply received";
  if (/unsubscrib|opt.?out/i.test(reason)) return "Unsubscribed";
  if (/suppress|do.not.contact/i.test(reason)) return "On the do-not-contact list";
  if (/bounce/i.test(reason)) return "Email bounced";
  return reason.replace(/\s*-\s*automation stopped$/i, "");
}

/** The quiet line under a step: what became of it. */
export function stepLine(step: CampaignStep, now: Date = new Date()): string {
  switch (step.status) {
    case "sent": {
      if (step.type === "email") {
        if (!step.email) return "Sent";
        const parts = [step.email.bounced ? "Bounced" : step.email.status === "delivered" ? "Delivered" : "Sent"];
        if (step.email.opens) parts.push(`opened ${step.email.opens}×`);
        if (step.email.clicks) parts.push(`${step.email.clicks} ${plural(step.email.clicks, "click", "clicks")}`);
        return parts.join(" · ");
      }
      if (step.type === "connect") return step.accepted_at ? `Accepted ${formatDate(step.accepted_at, now)}` : "Sent · not accepted yet";
      return step.type === "visit" ? "Visited" : "Sent";
    }
    case "next":
      return step.reason ?? (step.at ? `Due ${formatDateTime(step.at, now)}` : "Next");
    case "upcoming":
      return "Not reached yet";
    case "skipped":
      return step.reason ?? "Skipped";
    case "stopped":
      return step.reason ? `Stopped: ${stopReason(step.reason)!.toLowerCase()}` : "Not sent";
    case "failed":
      return step.reason ? `Failed: ${step.reason}` : "Failed";
  }
}

export const stepDate = (step: CampaignStep, now: Date = new Date()) => (step.status === "sent" && step.at ? formatDate(step.at, now) : "—");

/** The pill on a campaign: "Active · Step 3 of 5", "Completed · no reply". */
export function campaignPill(campaign: CampaignHistory): Badge {
  const place = campaign.next_number ? ` · Step ${campaign.next_number} of ${campaign.steps_total}` : "";
  switch (campaign.state) {
    case "active": return { tone: "brand", label: `Active${place}` };
    case "paused": return { tone: "warn", label: `Paused${place}` };
    case "waiting": return { tone: "neutral", label: "Not started" };
    case "failed": return { tone: "bad", label: "Failed" };
    case "stopped": {
      const reason = stopReason(campaign.stop_reason);
      return { tone: reason === "Reply received" ? "good" : "neutral", label: reason ? `Stopped · ${reason.toLowerCase()}` : "Stopped" };
    }
    case "completed": return { tone: "neutral", label: `Completed · ${campaign.replied ? "replied" : "no reply"}` };
  }
}

/** One line for a campaign shown folded: "5 of 5 steps · last touch Apr 18". */
export function campaignSummary(campaign: CampaignHistory, now: Date = new Date()): string {
  const steps = `${campaign.steps_sent} of ${campaign.steps_total} ${plural(campaign.steps_total, "step", "steps")}`;
  return campaign.last_touch_at ? `${steps} · last touch ${formatDate(campaign.last_touch_at, now)}` : `${steps} · nothing sent`;
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export type TimelineIcon = "mail" | "mail-open" | "mail-x" | "eye" | "user-plus" | "user-check" | "user-minus" | "message" | "reply" | "note" | "phone" | "calendar" | "list-plus" | "list-minus" | "sparkles" | "user";

export interface TimelineLine {
  icon: TimelineIcon;
  tone: Tone;
  title: string;
  badge: Badge | null;
  detail: string | null;
  /** Someone's words (a message, a reply), shown in quotation marks. */
  quoted: boolean;
}

const MESSAGE_STATE: Record<string, Badge> = {
  queued: { tone: "warn", label: "Waiting to send" },
  sending: { tone: "warn", label: "Sending" },
  failed: { tone: "bad", label: "Not sent" },
  uncertain: { tone: "warn", label: "Not confirmed" },
};
const ACTIVITY: Record<string, { icon: TimelineIcon; verb: string }> = {
  note: { icon: "note", verb: "Note added" },
  call: { icon: "phone", verb: "Call logged" },
  email: { icon: "mail", verb: "Email logged" },
  meeting: { icon: "calendar", verb: "Meeting logged" },
  other: { icon: "note", verb: "Activity logged" },
};

/** How one timeline item reads. */
export function timelineLine(item: TimelineItem): TimelineLine {
  const step = item.step ? `Step ${item.step} ` : "";
  const campaign: Badge | null = item.campaign ? { tone: "brand", label: item.campaign.name } : null;
  const by = item.actor ? ` by ${item.actor}` : "";
  const line = (icon: TimelineIcon, tone: Tone, title: string, extra: Partial<TimelineLine> = {}): TimelineLine => ({ icon, tone, title, badge: campaign, detail: item.detail, quoted: false, ...extra });
  switch (item.kind) {
    case "email_sent":
      return line("mail", "mail", item.step ? `${step}email sent` : "Email sent");
    case "email_engaged": {
      const parts: string[] = [];
      if (item.opens) parts.push(`opened ${item.opens}×`);
      if (item.clicks) parts.push(`${item.clicks} link ${plural(item.clicks, "click", "clicks")}`);
      return line("mail-open", "mail", `Email ${parts.join(" · ")}`);
    }
    case "email_bounced":
      return line("mail-x", "bad", "Email bounced");
    case "linkedin_visit":
      return line("eye", "li", item.step ? `${step}profile visit` : "Profile visited");
    case "linkedin_invite":
      return line("user-plus", "li", item.step ? `${step}invite sent` : "Invite sent");
    case "linkedin_accepted":
      return line("user-check", "li", "Connection accepted");
    case "linkedin_withdrawn":
      return line("user-minus", "warn", "Invitation withdrawn");
    case "linkedin_message":
      return line("message", "li", item.step ? `${step}message sent` : `LinkedIn message${item.label ? "" : " sent"}${by}`, { badge: (item.label ? MESSAGE_STATE[item.label] : null) ?? campaign, quoted: Boolean(item.detail) });
    case "linkedin_inmail":
      return line("message", "li", item.step ? `${step}InMail sent` : "InMail sent", { quoted: Boolean(item.detail) });
    case "reply":
      return line("reply", item.channel === "linkedin" ? "li" : "mail", item.channel === "linkedin" ? "Replied on LinkedIn" : "Replied by email", { badge: verdictBadge(item.label), quoted: Boolean(item.detail) });
    case "activity": {
      const kind = ACTIVITY[item.label ?? "other"] ?? ACTIVITY.other;
      return line(kind.icon, "neutral", `${kind.verb}${by}`);
    }
    case "meeting":
      return line("calendar", "brand", "Meeting", { badge: item.label ? { tone: "neutral", label: sentence(item.label) } : null });
    case "list_added":
      return line("list-plus", "neutral", `Added to list · ${item.list?.name ?? "a list since deleted"}`);
    case "list_removed":
      return line("list-minus", "neutral", `Removed from list · ${item.list?.name ?? "a list since deleted"}`);
    case "enriched":
      return line("sparkles", "brand", "Enriched from Apollo");
    case "created":
      return line("user", "neutral", "Contact added");
  }
}

/** The tabs over the timeline, with how many lines each holds. */
export function channelOptions(counts: Record<TimelineChannel, number> | undefined): { value: TimelineChannel; label: string; count?: string }[] {
  return [
    { value: "all", label: "All", count: counts ? formatCount(counts.all) : undefined },
    { value: "email", label: "Email", count: counts ? formatCount(counts.email) : undefined },
    { value: "linkedin", label: "LinkedIn", count: counts ? formatCount(counts.linkedin) : undefined },
  ];
}

// ── Tasks and custom fields ───────────────────────────────────────────────────

/** A task's due date as a pill: overdue in red, today in amber, later in grey. */
export function dueBadge(dueDate: string | null, now: Date = new Date()): Badge | null {
  if (!dueDate) return null;
  const day = dueDate.slice(0, 10);
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const label = formatDate(`${day}T12:00:00`, now);
  if (day < today) return { tone: "bad", label: `Overdue · ${label}` };
  if (day === today) return { tone: "warn", label: "Due today" };
  return { tone: "neutral", label };
}

/** A custom field's value as the card shows it. */
export function customValueText(type: string, value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "boolean") return value ? "Yes" : "No";
  if (type === "number") return typeof value === "number" ? value.toLocaleString("en-US") : String(value);
  if (type === "date" && typeof value === "string") {
    const date = parseTime(`${value.slice(0, 10)}T12:00:00`);
    return date ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : value;
  }
  return String(value);
}

export const ACTIVITY_TYPES = [
  { value: "note", label: "Note" }, { value: "call", label: "Call" }, { value: "email", label: "Email" }, { value: "meeting", label: "Meeting" }, { value: "other", label: "Other" },
] as const;

/** The employee count as the company card writes it. */
export const employeesText = (count: number | null) => (count ? formatCount(count) : "—");
