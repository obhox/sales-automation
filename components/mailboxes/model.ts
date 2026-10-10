// What the Mailboxes screen knows about a mailbox, and how it words it. No React in
// here, so the wording can be tested.
import type { DomainView, MailboxQueue, MailboxStatus, MailboxView, MailboxesOverview, QueueItem, WarmupState } from "@/lib/email/mailbox-list";
import type { MailboxRotation, MailboxSettings } from "@/lib/email/mailbox-settings";
import type { RecordStatus } from "@/lib/email/dns";
import type { TestSend } from "@/lib/email/test-send";
import { REPUTATION_LOW } from "@/lib/email/reputation";
import { formatCount, formatDate, formatPercent, formatRelative, parseTime, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";
import { daysSummary, hourLabel } from "@/components/linkedin-accounts/model";

export type { DomainView, MailboxQueue, MailboxRotation, MailboxSettings, MailboxStatus, MailboxView, MailboxesOverview, QueueItem, TestSend, WarmupState };

export const OVERVIEW_PATH = "/api/email-accounts?view=overview";

/** Where a domain's deliverability is shown. The old page, until the Deliverability screen is rebuilt. */
export const DELIVERABILITY_HREF = "/email-health";

export interface Badge {
  tone: Tone;
  label: string;
}

export const allMailboxes = (domains: DomainView[]): MailboxView[] => domains.flatMap((domain) => domain.mailboxes);

/** Held: nothing is sent from it until someone (or the half-hourly check) puts that right. */
export const isHeld = (mailbox: MailboxView) => mailbox.status === "disconnected" || mailbox.status === "auto_paused" || mailbox.status === "paused";

// ── A row ─────────────────────────────────────────────────────────────────────

export function windowLabel(mailbox: MailboxView): string {
  const { start, end } = mailbox.schedule;
  return start === 0 && end === 24 ? "All day" : `${hourLabel(start)}–${hourLabel(end)}`;
}

/** "Gmail · App password · 08:00–18:00 · Europe/Berlin". */
export function metaLine(mailbox: MailboxView): string {
  return [mailbox.provider.label, mailbox.provider.method, windowLabel(mailbox), mailbox.schedule.timezone].join(" · ");
}

export function statusBadge(mailbox: MailboxView): Badge {
  switch (mailbox.status) {
    case "disconnected":
      return { tone: "bad", label: "Disconnected" };
    case "auto_paused":
      return { tone: "bad", label: "Auto-paused" };
    case "paused":
      return { tone: "warn", label: "Paused" };
    case "untested":
      return { tone: "neutral", label: "Not tested" };
    case "at_limit":
      return { tone: "warn", label: "At limit" };
    default:
      return { tone: "good", label: "Active" };
  }
}

/** "52 / 60 today", and the colour it is written in. */
export function limitLine(mailbox: MailboxView): { text: string; tone: "ink" | "warn" | "muted"; meter: Tone } {
  const { sent_today: sent, limit_today: limit } = mailbox.sending;
  const text = `${formatCount(sent)} / ${formatCount(limit)} today`;
  if (isHeld(mailbox) || mailbox.status === "untested") return { text, tone: "muted", meter: "neutral" };
  if (sent >= limit) return { text, tone: "warn", meter: "warn" };
  return { text, tone: "ink", meter: "mail" };
}

/** The line under the meter: where the ramp is, or why nothing is going out. */
export function rampLine(mailbox: MailboxView, now: Date = new Date()): { text: string; bad: boolean } {
  const since = mailbox.held ? formatRelative(mailbox.held.at, now) : "";
  if (mailbox.status === "disconnected") return { text: `Sign-in refused ${since}`, bad: true };
  if (mailbox.status === "auto_paused") return { text: `Sending stopped ${since}`, bad: true };
  if (mailbox.status === "paused") return { text: `Paused ${since}`, bad: false };
  if (mailbox.status === "untested") return { text: "Test the connection to start", bad: false };
  if (!mailbox.ramp) return { text: "No ramp · full limit", bad: false };
  return { text: `${mailbox.ramp.complete ? "Ramp complete" : "Ramping"} · day ${mailbox.ramp.day} of ${mailbox.ramp.days}`, bad: false };
}

export function warmupBadge(mailbox: MailboxView): Badge {
  switch (mailbox.warmup.state) {
    case "warmed":
      return { tone: "good", label: "Warmed" };
    case "warming":
      return { tone: "brand", label: "Warming up" };
    case "paused":
      return { tone: "neutral", label: "Paused" };
    case "stopped":
      return { tone: "bad", label: "Stopped" };
    default:
      return { tone: "neutral", label: "Off" };
  }
}

export function warmupSub(mailbox: MailboxView): string {
  const { state, peers, sent_week: sent, rescued_week: rescued } = mailbox.warmup;
  if (state === "off") return "not in the pool";
  if (state === "paused" || state === "stopped") return "warm-up halted";
  if (state === "warming" || sent > 0) return `${formatCount(sent)} sent · ${formatCount(rescued)} rescued`;
  return peers === 0 ? "no peers yet" : `pool of ${formatCount(peers)} ${plural(peers, "peer", "peers")}`;
}

/** "Rep 96", or "Rep —" for a mailbox there is nothing to judge by. */
export function reputationLabel(mailbox: MailboxView): string {
  return `Rep ${mailbox.reputation ? mailbox.reputation.score : "—"}`;
}

/** The same, as it is read out: "Reputation 96 out of 100". */
export function reputationSpoken(mailbox: MailboxView): string {
  return mailbox.reputation ? `Reputation ${mailbox.reputation.score} out of 100` : "No reputation score yet";
}

export function reputationTone(mailbox: MailboxView): Tone {
  if (!mailbox.reputation) return "neutral";
  return mailbox.reputation.band === "good" ? "good" : mailbox.reputation.band === "fair" ? "warn" : "bad";
}

/** Why the score is what it is, for the tooltip. */
export function reputationWhy(mailbox: MailboxView): string {
  const intro = "Linki's own score out of 100, from 30 days of bounces and spam complaints, warm-up mail found in spam, and the domain's DNS records. It is not a figure from Google or Microsoft.";
  if (!mailbox.reputation) return `${intro} There is nothing to score this mailbox by yet.`;
  if (mailbox.reputation.losses.length === 0) return `${intro} Nothing is counting against this mailbox.`;
  return `${intro} Counting against this mailbox: ${mailbox.reputation.losses.map((loss) => `${loss.detail} (−${loss.points})`).join("; ")}.`;
}

/** "0.8% bounce", and whether it is at or over the mailbox's guard. */
export function bounceLine(mailbox: MailboxView): { text: string; bad: boolean } {
  const rate = mailbox.health.bounce_rate;
  if (rate === null || mailbox.status === "disconnected") return { text: "— bounce", bad: false };
  return { text: `${formatPercent(rate)} bounce`, bad: rate >= mailbox.guard.bounce_threshold };
}

// ── A domain ──────────────────────────────────────────────────────────────────

const DNS_WORD: Record<RecordStatus, string> = { pass: "in place", weak: "in place but weak", fail: "missing" };

/** The three badges on a domain's header. Grey when the domain has never been checked. */
export function dnsBadges(domain: DomainView): Array<Badge & { title: string }> {
  const badge = (label: string, status: RecordStatus | null): Badge & { title: string } => ({
    label,
    tone: status === "pass" ? "good" : status === "weak" ? "warn" : status === "fail" ? "bad" : "neutral",
    title: status ? `${label} is ${DNS_WORD[status]}` : `${label} has not been checked yet`,
  });
  return [badge("SPF", domain.dns.spf), badge("DKIM", domain.dns.dkim), badge("DMARC", domain.dns.dmarc)];
}

/** "4 mailboxes · 150 of 190 sent today". The limit counts the mailboxes that can send. */
export function domainMeta(domain: DomainView): string {
  const count = domain.mailboxes.length;
  const sent = domain.mailboxes.reduce((sum, mailbox) => sum + mailbox.sending.sent_today, 0);
  const limit = domain.mailboxes.filter((mailbox) => !isHeld(mailbox) && mailbox.status !== "untested").reduce((sum, mailbox) => sum + mailbox.sending.limit_today, 0);
  return `${count} ${plural(count, "mailbox", "mailboxes")} · ${formatCount(sent)} of ${formatCount(limit)} sent today`;
}

export function dnsCheckedLine(domain: DomainView, now: Date = new Date()): string {
  return domain.dns.checked_at ? `DNS checked ${formatRelative(domain.dns.checked_at, now)}` : "DNS not checked yet";
}

// ── The four figures across the top ───────────────────────────────────────────

export interface Totals {
  mailboxes: number;
  mailboxesNote: string;
  mailboxesTone: "warn" | "muted";
  /** Emails every sending mailbox may send today, added up. */
  capacity: number;
  capacityNote: string;
  reputation: number | null;
  reputationNote: string;
  reputationTone: "warn" | "muted";
  bounceRate: number | null;
  bounceNote: string;
  bounceTone: "good" | "warn" | "bad" | "muted";
  /** For the pill beside the title. Null when nothing needs anyone. */
  problem: string | null;
}

export function totals(domains: DomainView[]): Totals {
  const mailboxes = allMailboxes(domains);
  const count = (status: MailboxStatus) => mailboxes.filter((mailbox) => mailbox.status === status).length;
  const paused = count("paused") + count("auto_paused");
  const disconnected = count("disconnected");
  const notes = [`${domains.length} ${plural(domains.length, "domain", "domains")}`];
  if (paused) notes.push(`${paused} paused`);
  if (disconnected) notes.push(`${disconnected} disconnected`);
  if (count("untested")) notes.push(`${count("untested")} not tested`);

  const sending = mailboxes.filter((mailbox) => !isHeld(mailbox) && mailbox.status !== "untested");
  const capacity = sending.reduce((sum, mailbox) => sum + mailbox.sending.limit_today, 0);
  const sentToday = mailboxes.reduce((sum, mailbox) => sum + mailbox.sending.sent_today, 0);

  const scored = mailboxes.filter((mailbox) => mailbox.reputation !== null);
  const low = scored.filter((mailbox) => mailbox.reputation!.score < REPUTATION_LOW).length;

  const sent30 = mailboxes.reduce((sum, mailbox) => sum + mailbox.health.sent, 0);
  const bounces30 = mailboxes.reduce((sum, mailbox) => sum + mailbox.health.bounces, 0);
  const bounceRate = sent30 > 0 ? bounces30 / sent30 : null;

  const problems = [count("auto_paused") ? `${count("auto_paused")} auto-paused` : null, disconnected ? `${disconnected} disconnected` : null].filter((part): part is string => part !== null);

  return {
    mailboxes: mailboxes.length,
    mailboxesNote: mailboxes.length === 0 ? "None connected yet" : notes.join(" · "),
    mailboxesTone: paused || disconnected ? "warn" : "muted",
    capacity,
    capacityNote: capacity > 0 ? `${formatCount(sentToday)} sent today · ${Math.round((sentToday / capacity) * 100)}% used` : mailboxes.length ? "No mailbox can send right now" : "Emails a day, across mailboxes",
    reputation: scored.length ? Math.round(scored.reduce((sum, mailbox) => sum + mailbox.reputation!.score, 0) / scored.length) : null,
    reputationNote: scored.length === 0 ? "Nothing to score yet" : low ? `${low} ${plural(low, "mailbox", "mailboxes")} below ${REPUTATION_LOW}` : `All ${REPUTATION_LOW} or above`,
    reputationTone: low ? "warn" : "muted",
    bounceRate,
    bounceNote: bounceRate === null ? "No emails sent in 30 days" : bounceRate < 0.02 ? "healthy · under 2.0%" : bounceRate < 0.03 ? "watch · 2.0% or more" : "high · 3.0% or more",
    bounceTone: bounceRate === null ? "muted" : bounceRate < 0.02 ? "good" : bounceRate < 0.03 ? "warn" : "bad",
    problem: problems.length ? problems.join(" · ") : null,
  };
}

// ── The detail panel ──────────────────────────────────────────────────────────

/** "Gmail · App password · connected Jun 4". */
export function connectedLine(mailbox: MailboxView, now: Date = new Date()): string {
  return [mailbox.provider.label, mailbox.provider.method, `connected ${formatDate(mailbox.created_at, now)}`].join(" · ");
}

export function warmupDetailBadge(mailbox: MailboxView): Badge {
  const badge = warmupBadge(mailbox);
  if (mailbox.ramp && (mailbox.warmup.state === "warmed" || mailbox.warmup.state === "warming")) return { tone: badge.tone, label: `${badge.label} · ${mailbox.ramp.day} of ${mailbox.ramp.days}` };
  return { tone: badge.tone, label: mailbox.warmup.state === "off" ? "Warm-up off" : mailbox.warmup.state === "warmed" || mailbox.warmup.state === "warming" ? badge.label : `Warm-up ${badge.label.toLowerCase()}` };
}

/** "Mon–Fri" under the window, when it is not every day. */
export function daysLabel(mailbox: MailboxView): string {
  return daysSummary(mailbox.schedule.days);
}

/** A signature as the preview shows it: the first line stands out, the rest follow. */
export function signatureLines(signature: string | null): { first: string; rest: string[] } | null {
  const lines = (signature ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? { first: lines[0], rest: lines.slice(1) } : null;
}

const TAB: Record<string, string> = { primary: "Primary", promotions: "Promotions", social: "Social", updates: "Updates", forums: "Forums" };

/** What the receiving server said about SPF, DKIM and DMARC, in a few words. Empty when it said nothing. */
export function authLine(test: TestSend): string {
  if (!test.auth) return "";
  const parts: Array<[string, string | null]> = [["SPF", test.auth.spf], ["DKIM", test.auth.dkim], ["DMARC", test.auth.dmarc]];
  const known = parts.filter(([, result]) => result !== null);
  if (known.length === 0) return "";
  if (known.every(([, result]) => result === "pass")) return `${listOf(known.map(([name]) => name))} passed`;
  return known.map(([name, result]) => `${name} ${result === "pass" ? "passed" : result === "fail" ? "failed" : result}`).join(", ");
}

const listOf = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** The result of the last test send, as the tinted box says it. */
export function testResult(test: TestSend, now: Date = new Date()): { tone: "good" | "warn" | "bad" | "info" | "neutral"; text: string; looking: boolean } {
  const when = formatRelative(test.sent_at, now);
  const auth = authLine(test);
  const tail = auth ? ` · ${auth}` : "";
  if (test.status === "found") {
    if (test.placement === "spam") return { tone: "bad", looking: false, text: `Landed in spam, sent ${when}${tail}` };
    if (test.placement === "inbox") return { tone: "good", looking: false, text: `Delivered to the inbox, sent ${when}${tail}` };
    if (test.placement === "primary") return { tone: "good", looking: false, text: `Delivered to the Primary tab, sent ${when}${tail}` };
    if (test.placement && TAB[test.placement]) return { tone: "warn", looking: false, text: `Landed in the ${TAB[test.placement]} tab, sent ${when}${tail}` };
    return { tone: "warn", looking: false, text: `Filed in the folder ${test.folder ?? "it was moved to"}, sent ${when}${tail}` };
  }
  if (test.status === "not_found") return { tone: "warn", looking: false, text: `Sent ${when} and not found in the inbox or spam of ${test.recipient}. It may have been rejected or held up.` };
  if (test.readable) return { tone: "info", looking: true, text: `Sent ${when}. Looking for it in ${test.recipient}…` };
  return { tone: "neutral", looking: false, text: `Sent to ${test.recipient} ${when} and accepted by the mail server. Linki can say where a test landed only when it goes to one of your connected mailboxes.` };
}

// ── Upcoming sends ────────────────────────────────────────────────────────────

/** "09:41" today; "Tue 09:41" within a week; then a date. In the reader's own time. */
export function queueTime(at: string, now: Date = new Date()): string {
  const date = parseTime(at);
  if (!date) return "—";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return formatDate(date, now);
}

/** "in about 4 min", "in about 2 h", "now". */
export function inAbout(at: string, now: Date = new Date()): string {
  const date = parseTime(at);
  if (!date) return "";
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `next in about ${minutes} min`;
  if (minutes < 60 * 24) return `next in about ${Math.round(minutes / 60)} h`;
  return `next ${formatDate(date, now)}`;
}

/** The line under "Upcoming sends". */
export function queueSub(mailbox: MailboxView, queue: MailboxQueue, now: Date = new Date()): string {
  if (mailbox.status === "disconnected") return "Nothing is sent until this mailbox signs in again";
  if (isHeld(mailbox)) return "Nothing is sent while this mailbox is paused";
  if (queue.due_today === 0 && !queue.next_at) return queue.waiting ? `${formatCount(queue.waiting)} waiting to start · nothing timed yet` : "Nothing scheduled";
  const due = queue.due_today > 0 ? `${formatCount(queue.due_today)} due today` : "None due today";
  const room = queue.due_today > queue.room_today ? ` · room for ${formatCount(queue.room_today)}` : "";
  return `${due}${room}${queue.next_at ? ` · ${inAbout(queue.next_at, now)}` : ""}`;
}

export function queueBadge(item: QueueItem): Badge & { dot: boolean } {
  if (item.status === "sent") return { tone: "good", label: "Sent", dot: false };
  if (item.status === "sending") return { tone: "brand", label: "Sending", dot: true };
  return { tone: "neutral", label: "Due", dot: false };
}

export function queueWho(item: QueueItem): string {
  return item.contact.company ? `${item.contact.name} · ${item.contact.company}` : item.contact.name;
}

export function queueWhat(item: QueueItem): string {
  return item.step ? `${item.campaign.name} — Step ${item.step}` : item.campaign.name;
}

// ── Settings in words ─────────────────────────────────────────────────────────

export const ROTATION_LABEL: Record<MailboxRotation, string> = { round_robin: "In turn", capacity: "By capacity" };

export const ROTATION_HINT: Record<MailboxRotation, string> = {
  round_robin: "Each company in a campaign is given the next mailbox in the list. Every mailbox gets about the same number.",
  capacity: "Each company is given the mailbox furthest behind its share, where a share is what the mailbox may send today. A mailbox still ramping up gets fewer; one that is paused or disconnected gets none.",
};

/** What pausing a mailbox does, for the confirmation. */
export function pauseConsequence(mailbox: MailboxView): string {
  const campaigns = mailbox.active_campaigns;
  const where = campaigns ? `${campaigns} ${plural(campaigns, "campaign has", "campaigns have")} contacts with this mailbox. They` : "Contacts with this mailbox";
  return `Nothing is sent from ${mailbox.from_email} until it is resumed: campaign emails, warm-up mail and tests. ${where} stay where they are in their sequence and carry on when it resumes. Replies are still read.`;
}

/** What resuming does, when the guard would only pause the mailbox again. Null when there is nothing to warn of. */
export function resumeConsequence(mailbox: MailboxView): string | null {
  if (mailbox.status !== "auto_paused" || !mailbox.health.over_guard) return null;
  const why = mailbox.held?.reason?.replace(/^Auto-paused:\s*/, "") ?? "its figures are over its guard";
  return `It was paused because its ${why}. That has not changed, so it will be paused again at the next check unless the guard is raised in its settings. Sending more from a mailbox in this state makes its reputation worse.`;
}
