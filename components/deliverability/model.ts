// What the Deliverability screen knows, and how it words it. No React in here, so the
// wording can be tested.
import type { DeliverabilityOverview, DnsRecordView, DomainDeliverability, DomainDnsDetail, DoNotContact, RangeDays } from "@/lib/email/deliverability-overview";
import type { GuardEvent, GuardEventKind } from "@/lib/email/guard-events";
import type { PlacementResult, PlacementRun, PlacementSummary, PlacementTest, Seed } from "@/lib/email/placement";
import { formatCount, formatDate, formatPercent, formatRelative, parseTime, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";
import { ROTATION_LABEL, type MailboxSettings, type MailboxView } from "@/components/mailboxes/model";

export type { DeliverabilityOverview, DnsRecordView, DomainDeliverability, DomainDnsDetail, DoNotContact, GuardEvent, GuardEventKind, PlacementResult, PlacementRun, PlacementSummary, PlacementTest, RangeDays, Seed };

export const OVERVIEW_PATH = "/api/deliverability";

export const RANGE_OPTIONS: Array<{ value: "7" | "30" | "90"; label: string }> = [
  { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" },
];

export type NoteTone = "good" | "warn" | "bad" | "muted";

// ── The four figures ──────────────────────────────────────────────────────────

export interface Figure {
  key: "sent" | "bounce" | "complaints" | "placement";
  label: string;
  value: string;
  note: string;
  tone: NoteTone;
  /** Said on hover, where the note needs a caveat. */
  why?: string;
}

export function figures(domain: DomainDeliverability, range: RangeDays): Figure[] {
  const { sent, capacity_share: share, sent_all: all, bounce_rate: bounce, complaints, complaint_rate: complaint, placement } = domain.figures;
  const placed = placementNote(placement);
  return [
    {
      key: "sent", label: `Emails sent (${range}d)`, value: formatCount(sent), tone: "muted",
      note: share === null ? "No mailbox on this domain can send" : `${Math.round(share * 100)}% of capacity`,
      why: "Campaign emails from this domain's mailboxes. Capacity is every mailbox that can send, at its full daily limit, on every day of the period.",
    },
    {
      key: "bounce", label: "Bounce rate", value: bounce === null ? "—" : formatPercent(bounce, 2),
      note: bounce === null ? "No emails sent in this period" : bounce < 0.02 ? "Healthy · under 2.0%" : bounce < 0.03 ? "Watch · 2.0% or more" : "High · 3.0% or more",
      tone: bounce === null ? "muted" : bounce < 0.02 ? "good" : bounce < 0.03 ? "warn" : "bad",
      why: `Out of the ${formatCount(all)} emails of every kind these mailboxes sent, which is what each mailbox's guard goes by.`,
    },
    {
      key: "complaints", label: "Spam complaints", value: complaint === null ? "—" : formatPercent(complaint, 2),
      note: complaint === null ? "No emails sent in this period" : complaints === 0 ? "None reported" : complaint < 0.001 ? "Healthy · under 0.10%" : "High · 0.10% or more",
      tone: complaint === null || complaints === 0 ? "muted" : complaint < 0.001 ? "good" : "bad",
      why: "Only complaints a provider reports are counted: by webhook, or by feedback mail sent to a mailbox Linki reads. Most providers, Gmail among them, report none, so zero means none were reported.",
    },
    { key: "placement", label: "Inbox placement", value: placement.inbox_rate === null ? "—" : formatPercent(placement.inbox_rate, 0), note: placed.text, tone: placed.tone },
  ];
}

export function placementNote(summary: PlacementSummary): { text: string; tone: NoteTone } {
  if (summary.checked === 0) {
    return { text: summary.waiting > 0 ? `${summary.waiting} ${plural(summary.waiting, "copy", "copies")} still to be found` : "No placement test in this period", tone: "muted" };
  }
  if (summary.spam > 0) return { text: `${summary.spam} of ${summary.checked} seeds in spam`, tone: "warn" };
  if (summary.missing > 0) return { text: `${summary.missing} of ${summary.checked} seeds not found`, tone: "warn" };
  return { text: `${summary.inbox} of ${summary.checked} seeds in the inbox`, tone: summary.inbox === summary.checked ? "good" : "muted" };
}

// ── Mailbox health ────────────────────────────────────────────────────────────

/** "7 mailboxes · 1 auto-paused · rotation in turn, by company". */
export function healthSubtitle(mailboxes: MailboxView[], settings: MailboxSettings): string {
  const count = (status: MailboxView["status"]) => mailboxes.filter((mailbox) => mailbox.status === status).length;
  const parts = [`${mailboxes.length} ${plural(mailboxes.length, "mailbox", "mailboxes")}`];
  if (count("auto_paused")) parts.push(`${count("auto_paused")} auto-paused`);
  if (count("paused")) parts.push(`${count("paused")} paused`);
  if (count("disconnected")) parts.push(`${count("disconnected")} disconnected`);
  parts.push(`rotation ${ROTATION_LABEL[settings.rotation].toLowerCase()}, by company`);
  return parts.join(" · ");
}

/** The warm-up column: where the ramp is, as words and as a share for the bar. */
export function rampCell(mailbox: MailboxView): { text: string; share: number } {
  if (mailbox.status === "disconnected") return { text: "Stopped", share: 0 };
  if (mailbox.status === "paused" || mailbox.status === "auto_paused") return { text: "Paused", share: mailbox.ramp ? mailbox.ramp.day / mailbox.ramp.days : 0 };
  if (!mailbox.ramp) return { text: mailbox.warmup.enabled ? "No ramp" : "Off", share: mailbox.warmup.enabled ? 1 : 0 };
  if (mailbox.ramp.complete) return { text: "Complete", share: 1 };
  return { text: `Day ${mailbox.ramp.day} of ${mailbox.ramp.days}`, share: mailbox.ramp.day / mailbox.ramp.days };
}

export const STATUS_FILTERS: Array<{ value: "all" | MailboxView["status"]; label: string }> = [
  { value: "all", label: "All statuses" }, { value: "active", label: "Active" }, { value: "at_limit", label: "At limit" },
  { value: "auto_paused", label: "Auto-paused" }, { value: "paused", label: "Paused" }, { value: "disconnected", label: "Disconnected" }, { value: "untested", label: "Not tested" },
];

// ── The guard log ─────────────────────────────────────────────────────────────

export const EVENT_TONE: Record<GuardEvent["tone"], Tone> = { bad: "bad", warn: "warn", good: "good", mail: "mail", neutral: "neutral" };

export const EVENT_KIND_LABEL: Record<GuardEventKind, string> = {
  auto_pause: "Auto-pauses", disconnected: "Sign-in lost", reconnected: "Sign-in regained", daily_limit: "Daily limits",
  dns_change: "DNS changes", warmup_cycle: "Warm-up", complaint: "Spam complaints", placement_test: "Placement tests",
};

const clock = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** "14:02" for today, "Oct 9" for another day. In the reader's own time. */
export function eventTime(at: string, now: Date = new Date()): string {
  const date = parseTime(at);
  if (!date) return "—";
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? clock(date) : formatDate(date, now);
}

/** Both, for the full log: "Oct 9 · 14:02". */
export function eventWhen(at: string, now: Date = new Date()): string {
  const date = parseTime(at);
  return date ? `${formatDate(date, now)} · ${clock(date)}` : "—";
}

// ── Domain authentication ─────────────────────────────────────────────────────

export interface RecordRow {
  key: "spf" | "dkim" | "dmarc" | "mx";
  name: string;
  value: string;
  badge: { tone: Tone; label: string };
  note: string | null;
}

const short = (text: string, max = 46) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function badgeFor(record: DnsRecordView): RecordRow["badge"] {
  if (record.lookup_failed) return { tone: "neutral", label: "Not known" };
  return record.status === "pass" ? { tone: "good", label: "Pass" } : record.status === "weak" ? { tone: "warn", label: "Weak" } : { tone: "bad", label: "Missing" };
}

/** The four records as the card lists them. */
export function recordRows(dns: DomainDnsDetail): RecordRow[] {
  if (!dns.records) return [];
  const { spf, dkim, dmarc, mx } = dns.records;
  const none = (record: DnsRecordView, missing: string) => (record.lookup_failed ? "The lookup got no answer" : missing);
  const dkimValue = dkim.status === "fail" ? none(dkim, "No key found") : `${dns.dkim_selector ?? "?"}._domainkey${dns.dkim_bits ? ` · ${dns.dkim_bits}-bit` : ""}`;
  return [
    { key: "spf", name: "SPF", value: spf.value ? short(spf.value) : none(spf, "No record"), badge: badgeFor(spf), note: spf.note },
    { key: "dkim", name: "DKIM", value: dkimValue, badge: badgeFor(dkim), note: dkim.note },
    { key: "dmarc", name: "DMARC", value: dmarc.value ? short(dmarc.value.replace(/^v=DMARC1;\s*/i, "")) : none(dmarc, "No record"), badge: badgeFor(dmarc), note: dmarc.note },
    { key: "mx", name: "MX", value: mx.value ?? none(mx, "No record"), badge: badgeFor(mx), note: mx.note },
  ];
}

/** "DNS last checked 06:00", "DNS last checked Oct 9", "DNS not checked yet". */
export function checkedLine(dns: DomainDnsDetail, now: Date = new Date()): string {
  return dns.checked_at ? `DNS last checked ${eventTime(dns.checked_at, now)}` : "DNS not checked yet";
}

/** The headline and the sentence under it. */
export function scoreSummary(domain: string, dns: DomainDnsDetail): { headline: string; body: string } {
  if (!dns.score) return { headline: "Not checked yet", body: `Nothing is known about ${domain}'s DNS records. Check them to see what receiving servers see.` };
  if (dns.score.fixes.length === 0) return { headline: dns.score.headline, body: `SPF, DKIM, DMARC and MX are in place for ${domain}, and its mail is being accepted.` };
  return { headline: dns.score.headline, body: dns.score.fixes[0].advice };
}

export function scorePill(score: number | null): { tone: Tone; label: string } | null {
  if (score === null) return null;
  return { tone: score >= 80 ? "good" : score >= 60 ? "warn" : "bad", label: `Domain score ${score}` };
}

// ── Warm-up ───────────────────────────────────────────────────────────────────

export function warmupSubtitle(domain: DomainDeliverability): string {
  const total = domain.mailboxes.length;
  return `${domain.warmup.in_pool} of ${total} ${plural(total, "mailbox", "mailboxes")} in the warm-up pool`;
}

/** "team@acme-mail.co is on day 3 of its ramp. Its daily limit rises from 12 to 40 over the next 18 days." */
export function rampNote(ramping: DomainDeliverability["warmup"]["ramping"]): string | null {
  if (!ramping) return null;
  const left = ramping.days - ramping.day;
  return `${ramping.from_email} is on day ${ramping.day} of its ramp. Its daily limit rises from ${ramping.limit} to ${ramping.limit_full} over the next ${left} ${plural(left, "day", "days")}.`;
}

// ── Do not contact ────────────────────────────────────────────────────────────

export type SuppressionKind = "email" | "domain" | "linkedin" | "phone";

export const KIND_LABEL: Record<SuppressionKind, string> = { email: "Email addresses", domain: "Domains", linkedin: "LinkedIn profiles", phone: "Phone numbers" };
export const KIND_SINGULAR: Record<SuppressionKind, string> = { email: "Email address", domain: "Domain", linkedin: "LinkedIn profile", phone: "Phone number" };
export const KINDS: SuppressionKind[] = ["email", "domain", "linkedin", "phone"];

export function blockedLine(dnc: DoNotContact): string {
  return `${formatCount(dnc.blocked_30d)} ${plural(dnc.blocked_30d, "send", "sends")} blocked in the last 30 days`;
}

export interface SuppressionRow {
  id: string;
  kind: SuppressionKind;
  value: string;
  reason: string;
  source: string | null;
  created_at: string;
  /** It came from an unsubscribe, a complaint or a bounce: only an admin may remove it. */
  protected: boolean;
}

const REASON: Record<string, string> = { manual: "Added by hand", imported: "Imported", unsubscribed: "Unsubscribed", unsubscribe: "Unsubscribed", complained: "Marked as spam", bounced: "Bounced", customer: "Customer", competitor: "Competitor" };

/** "Unsubscribed · Oct 4". */
export function suppressionMeta(row: SuppressionRow, now: Date = new Date()): string {
  const reason = REASON[row.reason] ?? (/bounce/i.test(row.reason) ? "Bounced" : row.reason.charAt(0).toUpperCase() + row.reason.slice(1));
  return `${reason} · ${formatDate(row.created_at, now)}`;
}

// ── Placement tests ───────────────────────────────────────────────────────────

export const PLACEMENT_LABEL: Record<PlacementResult, string> = {
  inbox: "Inbox", primary: "Primary tab", promotions: "Promotions tab", social: "Social tab", updates: "Updates tab", forums: "Forums tab",
  spam: "Spam", other: "Another folder", missing: "Not found",
};

/** What someone entering a result by hand can choose. */
export const MANUAL_PLACEMENTS: PlacementResult[] = ["inbox", "promotions", "spam", "missing"];

export function placementBadge(test: PlacementTest): { tone: Tone; label: string } {
  if (test.status === "failed") return { tone: "bad", label: "Not sent" };
  if (test.status === "sent" || !test.placement) return test.readable ? { tone: "brand", label: "Looking" } : { tone: "neutral", label: "Enter result" };
  if (test.placement === "inbox" || test.placement === "primary") return { tone: "good", label: PLACEMENT_LABEL[test.placement] };
  if (test.placement === "spam") return { tone: "bad", label: "Spam" };
  return { tone: "warn", label: test.placement === "other" && test.folder ? test.folder : PLACEMENT_LABEL[test.placement] };
}

/** "from mia@acme.io · 2 h ago · 5 of 6 in the inbox". */
export function runLine(run: PlacementRun, now: Date = new Date()): string {
  const sent = run.tests.filter((test) => test.status !== "failed");
  const done = sent.filter((test) => test.status === "checked");
  const inbox = done.filter((test) => test.placement === "inbox" || test.placement === "primary").length;
  const result = done.length === 0 ? "no results yet" : `${inbox} of ${done.length} in the inbox`;
  return `from ${run.mailbox?.from_email ?? "a removed mailbox"} · ${formatRelative(run.created_at, now)} · ${result}`;
}

/** A run still has copies Linki is looking for. */
export const runIsLooking = (run: PlacementRun) => run.tests.some((test) => test.status === "sent" && test.readable);

/** Mailboxes a test can be sent from. */
export const canSendTest = (mailbox: MailboxView) => mailbox.status === "active" || mailbox.status === "at_limit";
