// A campaign's Overview tab: five rates with how they have moved, what was sent and
// answered each day, how far contacts got and where they dropped out, how the A/B versions
// of each email are doing, and how many of the opens were a person.
//
// Everything follows contacts, not events: a period means "the contacts enrolled in it",
// whenever their opens and replies came. Counting this week's replies against this week's
// sends would credit the week with answers to mail sent a month ago.
import type DatabaseType from "better-sqlite3";
import { campaignAnalytics } from "@/lib/reporting/campaign-analytics";
import { parseRange, type ReportRange } from "@/lib/reporting/range";
import { confidenceBetween, MIN_SENDS, sendsNeeded } from "@/lib/reporting/stats";
import { AUTO_REPLY_KINDS } from "@/lib/reply-kinds";

type DB = DatabaseType.Database;

export const OVERVIEW_RANGES = ["7d", "14d", "30d", "all"] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
export const OVERVIEW_CHANNELS = ["both", "linkedin", "email"] as const;
export type OverviewChannel = (typeof OVERVIEW_CHANNELS)[number];
const DAYS: Record<Exclude<OverviewRange, "all">, number> = { "7d": 7, "14d": 14, "30d": 30 };
const DAY_MS = 86_400_000;
const SPARK_BARS = 8;

export interface Rate {
  /** 0 to 1, or null when there is nothing to divide by yet. */
  value: number | null;
  part: number;
  whole: number;
  /** The same rate for the contacts enrolled in the period before this one. Null for "all", or with nothing to compare. */
  previous: number | null;
  /** The rate for the contacts enrolled in each eighth of the period, oldest first. Null where nobody was. */
  spark: Array<number | null>;
}

export interface FunnelStage {
  key: "enrolled" | "contacted" | "delivered" | "engaged" | "replied" | "positive" | "meeting";
  count: number;
  /** Why the contacts who did not get this far did not: the number, and the word for them. */
  drop: { count: number; reason: string } | null;
}

export interface VariantRow {
  variant_id: string | null;
  label: string;
  subject: string;
  sent: number;
  open_rate: number | null;
  reply_rate: number | null;
  replies: number;
  positive: number;
  /** "winner" is the one version left running once the others were paused. */
  status: "control" | "leading" | "trailing" | "paused" | "removed" | "waiting" | "winner";
}

export interface VariantTest {
  step_id: string;
  /** "Email 2": which email of the sequence this is. */
  email_number: number;
  /** Whether the versions still running share the sends equally. */
  even_split: boolean;
  rows: VariantRow[];
  /** How sure the gap between the two best versions is, 0 to 1. Null until both have enough sends. */
  confidence: number | null;
  significant: boolean;
  /** Sends each version still needs for a gap like this one to count as real. Null when it already does, or cannot be told. */
  more_sends_needed: number | null;
  /** The version to promote, when one is ahead: by enough to call, or just ahead so far. */
  leader: { variant_id: string | null; label: string } | null;
  /** A winner has been chosen: every other version is paused. */
  decided: boolean;
}

export interface CampaignOverview {
  range: OverviewRange;
  channel: OverviewChannel;
  kpis: { acceptance: Rate; reply: Rate; open: Rate; click: Rate; completion: Rate };
  daily: Array<{ day: string; linkedin: number; email: number; replies: number }>;
  funnel: Record<OverviewChannel, FunnelStage[]>;
  variants: VariantTest[];
  auto_promote: boolean;
  opens: { raw: number; human: number; scanners: number; automation: number; prefetch: number };
  generated_at: string;
}

interface ContactFacts {
  enrolled_at: string;
  done: number;
  first_at: string | null;
  li: number; em: number; invited: number; li_written: number;
  mail_sent: number; mail_bounced: number; opened: number; clicked: number; tracked_open: number; tracked_click: number;
  connected_at: string | null; last_replied_at: string | null; email_replied_at: string | null; reply_kind: string | null;
  verdict: string | null; meeting_at: string | null;
}

const time = (value: string | null | undefined) => (value ? Date.parse(/[TZ]/.test(value) ? value : `${value.replace(" ", "T")}Z`) || 0 : 0);
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** What happened to each contact the campaign enrolled. One row per contact. */
function contactFacts(db: DB, workspaceId: string, workflowId: string): ContactFacts[] {
  return db.prepare(
    `WITH own_runs AS (SELECT id FROM runs WHERE workflow_id = @wf AND workspace_id = @ws),
     enrolled AS (
       SELECT rp.target_id, MIN(rp.created_at) AS enrolled_at,
         MIN(CASE WHEN NOT EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped'))
                   AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id) THEN 1 ELSE 0 END) AS done
       FROM run_profiles rp WHERE rp.run_id IN (SELECT id FROM own_runs) GROUP BY rp.target_id),
     sends AS (
       SELECT ss.target_id, MIN(ss.sent_at) AS first_at, MAX(ss.channel = 'linkedin') AS li, MAX(ss.channel = 'email') AS em,
         MAX(ss.action = 'connect') AS invited, MAX(ss.action IN ('connect', 'message', 'inmail')) AS li_written
       FROM step_sends ss WHERE ss.workflow_id = @wf AND ss.target_id IS NOT NULL GROUP BY ss.target_id),
     mail AS (
       SELECT sm.target_id, COUNT(*) AS mail_sent, SUM(sm.bounced_at IS NOT NULL) AS mail_bounced,
         MAX(EXISTS (SELECT 1 FROM sender_events se WHERE se.sent_message_id = sm.id AND se.event_type = 'opened' AND se.is_bot = 0)) AS opened,
         MAX(EXISTS (SELECT 1 FROM sender_events se WHERE se.sent_message_id = sm.id AND se.event_type = 'clicked' AND se.is_bot = 0)) AS clicked,
         MAX(COALESCE(j.track_opens, 0)) AS tracked_open, MAX(COALESCE(j.track_clicks, 0)) AS tracked_click
       FROM sent_messages sm LEFT JOIN email_jobs j ON j.id = sm.job_id
       WHERE sm.run_id IN (SELECT id FROM own_runs) AND sm.target_id IS NOT NULL GROUP BY sm.target_id)
     SELECT e.enrolled_at, e.done, s.first_at, COALESCE(s.li, 0) AS li, COALESCE(s.em, 0) AS em, COALESCE(s.invited, 0) AS invited, COALESCE(s.li_written, 0) AS li_written,
       COALESCE(m.mail_sent, 0) AS mail_sent, COALESCE(m.mail_bounced, 0) AS mail_bounced, COALESCE(m.opened, 0) AS opened, COALESCE(m.clicked, 0) AS clicked,
       COALESCE(m.tracked_open, 0) AS tracked_open, COALESCE(m.tracked_click, 0) AS tracked_click,
       t.connected_at, t.last_replied_at, t.email_replied_at, t.reply_kind,
       (SELECT c.verdict FROM conversations c WHERE c.target_id = t.id AND c.workspace_id = @ws ORDER BY c.rowid DESC LIMIT 1) AS verdict,
       -- A meeting is this campaign's when this campaign was the last to write to the contact before it was booked.
       (SELECT MIN(mt.created_at) FROM meetings mt WHERE mt.target_id = t.id AND mt.workspace_id = @ws AND COALESCE(mt.status, '') NOT IN ('cancelled', 'canceled')
          AND (SELECT ss.workflow_id FROM step_sends ss WHERE ss.target_id = t.id AND ss.action != 'visit' AND datetime(ss.sent_at) <= datetime(mt.created_at)
               ORDER BY datetime(ss.sent_at) DESC, ss.rowid DESC LIMIT 1) = @wf) AS meeting_at
     FROM enrolled e JOIN targets t ON t.id = e.target_id LEFT JOIN sends s ON s.target_id = e.target_id LEFT JOIN mail m ON m.target_id = e.target_id`,
  ).all({ wf: workflowId, ws: workspaceId }) as ContactFacts[];
}

interface Reached { enrolled: number; contacted: number; skipped: number; delivered: number; bounced: number; engaged: number; replied: number; positive: number; meeting: number }

/** How far each contact got, on one channel or on either. */
function reach(contacts: ContactFacts[], channel: OverviewChannel): Reached {
  const out: Reached = { enrolled: 0, contacted: 0, skipped: 0, delivered: 0, bounced: 0, engaged: 0, replied: 0, positive: 0, meeting: 0 };
  const auto = new Set<string>(AUTO_REPLY_KINDS);
  for (const c of contacts) {
    const li = channel !== "email";
    const em = channel !== "linkedin";
    out.enrolled += 1;
    const contacted = (li && c.li === 1) || (em && c.em === 1);
    if (!contacted) {
      // Finished without anything going out on this channel: left out, not merely waiting.
      if (c.done === 1) out.skipped += 1;
      continue;
    }
    out.contacted += 1;
    const delivered = (li && c.li === 1) || (em && c.mail_sent > c.mail_bounced);
    if (!delivered) { out.bounced += 1; continue; }
    out.delivered += 1;
    const first = time(c.first_at);
    const accepted = li && c.invited === 1 && Boolean(c.connected_at);
    const liReplied = li && c.li_written === 1 && time(c.last_replied_at) >= first && time(c.last_replied_at) > 0;
    const emReplied = em && c.em === 1 && time(c.email_replied_at) >= first && time(c.email_replied_at) > 0;
    const replied = (liReplied || emReplied) && !auto.has(c.reply_kind ?? "");
    // A reply is engagement too, even from someone whose open was never seen.
    if (accepted || (em && c.opened === 1) || replied) out.engaged += 1;
    if (!replied) continue;
    out.replied += 1;
    if (c.reply_kind === "positive" || c.verdict === "positive") {
      out.positive += 1;
      if (time(c.meeting_at) > 0) out.meeting += 1;
    }
  }
  return out;
}

function funnelOf(reached: Reached): FunnelStage[] {
  const waiting = reached.enrolled - reached.contacted - reached.skipped;
  return [
    { key: "enrolled", count: reached.enrolled, drop: null },
    { key: "contacted", count: reached.contacted, drop: reached.enrolled > reached.contacted ? (reached.skipped >= waiting ? { count: reached.skipped, reason: "skipped" } : { count: waiting, reason: "not reached yet" }) : null },
    { key: "delivered", count: reached.delivered, drop: reached.bounced > 0 ? { count: reached.bounced, reason: "bounced" } : null },
    { key: "engaged", count: reached.engaged, drop: reached.delivered > reached.engaged ? { count: reached.delivered - reached.engaged, reason: "no engagement" } : null },
    { key: "replied", count: reached.replied, drop: reached.engaged > reached.replied ? { count: reached.engaged - reached.replied, reason: "silent" } : null },
    { key: "positive", count: reached.positive, drop: null },
    { key: "meeting", count: reached.meeting, drop: null },
  ];
}

interface Rates { acceptance: [number, number]; reply: [number, number]; open: [number, number]; click: [number, number]; completion: [number, number] }

function ratesOf(contacts: ContactFacts[], channel: OverviewChannel): Rates {
  const auto = new Set<string>(AUTO_REPLY_KINDS);
  const li = channel !== "email";
  const em = channel !== "linkedin";
  const rates: Rates = { acceptance: [0, 0], reply: [0, 0], open: [0, 0], click: [0, 0], completion: [0, 0] };
  for (const c of contacts) {
    rates.completion[1] += 1;
    if (c.done === 1) rates.completion[0] += 1;
    if (li && c.invited === 1) { rates.acceptance[1] += 1; if (c.connected_at) rates.acceptance[0] += 1; }
    if (em && c.tracked_open === 1 && c.mail_sent > c.mail_bounced) { rates.open[1] += 1; if (c.opened === 1) rates.open[0] += 1; }
    if (em && c.tracked_click === 1 && c.mail_sent > c.mail_bounced) { rates.click[1] += 1; if (c.clicked === 1) rates.click[0] += 1; }
    // Written to, not merely looked at: a profile visit is not something to reply to.
    const written = (li && c.li_written === 1) || (em && c.em === 1);
    if (!written) continue;
    rates.reply[1] += 1;
    const first = time(c.first_at);
    const replied = ((li && c.li_written === 1 && time(c.last_replied_at) >= first && time(c.last_replied_at) > 0) || (em && c.em === 1 && time(c.email_replied_at) >= first && time(c.email_replied_at) > 0)) && !auto.has(c.reply_kind ?? "");
    if (replied) rates.reply[0] += 1;
  }
  return rates;
}

const within = (contacts: ContactFacts[], from: number, to: number) => contacts.filter((contact) => time(contact.enrolled_at) >= from && time(contact.enrolled_at) < to);

/** Which email of the sequence each email step is, counting from 1. */
function emailNumbers(db: DB, workflowId: string): Map<string, number> {
  const steps = db.prepare("SELECT id FROM workflow_steps WHERE workflow_id = ? AND step_type = 'email' ORDER BY step_order").all(workflowId) as { id: string }[];
  return new Map(steps.map((step, index) => [step.id, index + 1]));
}

/**
 * Each email's A/B test, over every send it has had. A test is not cut to the period the
 * rest of the page shows: how sure a result is should not move with the range picker.
 */
function variantTests(db: DB, workflowId: string): VariantTest[] {
  const numbers = emailNumbers(db, workflowId);
  const weights = new Map<string, number>();
  for (const step of db.prepare("SELECT id, email_control_weight AS weight FROM workflow_steps WHERE workflow_id = ? AND step_type = 'email'").all(workflowId) as Array<{ id: string; weight: number | null }>) weights.set(`${step.id}|control`, step.weight ?? 1);
  for (const variant of db.prepare("SELECT v.id, v.step_id, v.weight FROM workflow_step_email_variants v JOIN workflow_steps s ON s.id = v.step_id WHERE s.workflow_id = ?").all(workflowId) as Array<{ id: string; step_id: string; weight: number | null }>) weights.set(`${variant.step_id}|${variant.id}`, variant.weight ?? 1);
  return campaignAnalytics(db, workflowId, parseRange({}) as ReportRange).emailVariants.map((test): VariantTest => {
    const running = test.variants.filter((version) => !version.paused && !version.removed);
    const ranked = [...running].filter((version) => version.sent > 0).sort((a, b) => b.replies / b.sent - a.replies / a.sent || b.opened_sends / b.sent - a.opened_sends / a.sent);
    const [best, second] = ranked;
    const enough = Boolean(best && second && best.sent >= MIN_SENDS && second.sent >= MIN_SENDS);
    const onReplies = Boolean(best && second && best.replies / best.sent !== second.replies / second.sent);
    // Replies decide it. Where the versions have had none between them, opens are all there is to go on.
    const outcome = (version: typeof best) => (onReplies ? version.replies : version.opened_sends);
    const confidence = enough ? confidenceBetween(outcome(best), best.sent, outcome(second), second.sent) : null;
    const significant = Boolean(test.likely_winner) || (confidence !== null && confidence >= 0.95);
    const target = enough && !significant ? sendsNeeded(outcome(best), best.sent, outcome(second), second.sent) : null;
    const decided = running.length === 1 && test.variants.filter((version) => !version.removed).length > 1;
    const ahead = best && second && outcome(best) / best.sent > outcome(second) / second.sent ? best : null;
    return {
      step_id: test.step_id,
      email_number: numbers.get(test.step_id) ?? test.step_order,
      even_split: new Set(running.map((version) => weights.get(`${test.step_id}|${version.variant_id ?? "control"}`) ?? 1)).size <= 1,
      rows: test.variants.map((version) => ({
        variant_id: version.variant_id, label: version.label, subject: version.subject, sent: version.sent,
        open_rate: ratio(version.opened_sends, version.sent), reply_rate: ratio(version.replies, version.sent), replies: version.replies, positive: version.positive,
        status: version.removed ? "removed" : version.paused ? "paused" : decided ? "winner" : version.sent === 0 ? "waiting" : ahead && version === ahead ? "leading" : version.variant_id === null ? "control" : "trailing",
      })),
      confidence, significant,
      more_sends_needed: target === null ? null : Math.max(0, target - Math.min(best.sent, second.sent)),
      leader: decided ? null : ahead ? { variant_id: ahead.variant_id, label: ahead.label } : null,
      decided,
    };
  });
}

export function isOverviewRange(value: unknown): value is OverviewRange {
  return (OVERVIEW_RANGES as readonly unknown[]).includes(value);
}
export function isOverviewChannel(value: unknown): value is OverviewChannel {
  return (OVERVIEW_CHANNELS as readonly unknown[]).includes(value);
}

/** The Overview tab of one campaign. `now` is for tests. */
export function campaignOverview(db: DB, workspaceId: string, workflowId: string, options: { range?: OverviewRange; channel?: OverviewChannel; now?: number } = {}): CampaignOverview {
  const range = options.range ?? "14d";
  const channel = options.channel ?? "both";
  const now = options.now ?? Date.now();
  const everyone = contactFacts(db, workspaceId, workflowId);

  // The contacts enrolled in the period, and in the one of the same length before it.
  const span = range === "all" ? null : DAYS[range] * DAY_MS;
  const current = span === null ? everyone : within(everyone, now - span, now + 1);
  const before = span === null ? null : within(everyone, now - 2 * span, now - span);
  const rates = ratesOf(current, channel);
  const earlier = before ? ratesOf(before, channel) : null;
  // Eight slices of the period, for the small bars under each figure. "All" runs from the first enrolment.
  const sparkFrom = span === null ? Math.min(now - DAY_MS, ...current.map((contact) => time(contact.enrolled_at) || now)) : now - span;
  const slice = (now + 1 - sparkFrom) / SPARK_BARS;
  const slices = Array.from({ length: SPARK_BARS }, (_, index) => ratesOf(within(current, sparkFrom + index * slice, sparkFrom + (index + 1) * slice), channel));
  const rate = (key: keyof Rates): Rate => ({
    value: ratio(...rates[key]), part: rates[key][0], whole: rates[key][1],
    previous: earlier ? ratio(...earlier[key]) : null,
    spark: slices.map((part) => ratio(...part[key])),
  });

  // What went out and came back each day: the last fortnight, or the whole period when it is longer.
  const chartDays = range === "30d" ? 30 : range === "all" ? 30 : 14;
  const since = new Date(now - (chartDays - 1) * DAY_MS).toISOString().slice(0, 10);
  const sent = db.prepare(
    "SELECT date(sent_at) AS day, SUM(channel = 'linkedin') AS linkedin, SUM(channel = 'email') AS email FROM step_sends WHERE workflow_id = ? AND date(sent_at) >= ? GROUP BY day",
  ).all(workflowId, since) as Array<{ day: string; linkedin: number; email: number }>;
  const replies = db.prepare(
    `SELECT day, COUNT(*) AS replies FROM (
       SELECT date(er.received_at) AS day FROM email_replies er
       WHERE er.workspace_id = @ws AND er.channel = 'email' AND er.target_id IN (SELECT DISTINCT target_id FROM step_sends WHERE workflow_id = @wf AND channel = 'email')
         AND COALESCE(CASE WHEN json_valid(er.classification_json) THEN json_extract(er.classification_json, '$.kind') END, '') NOT IN (${AUTO_REPLY_KINDS.map((kind) => `'${kind}'`).join(", ")})
       UNION ALL
       SELECT date(t.last_replied_at) FROM targets t
       WHERE t.last_replied_at IS NOT NULL AND t.id IN (SELECT DISTINCT target_id FROM step_sends WHERE workflow_id = @wf AND channel = 'linkedin' AND action != 'visit')
     ) WHERE day >= @since GROUP BY day`,
  ).all({ ws: workspaceId, wf: workflowId, since }) as Array<{ day: string; replies: number }>;
  const daily = Array.from({ length: chartDays }, (_, index) => {
    const day = new Date(now - (chartDays - 1 - index) * DAY_MS).toISOString().slice(0, 10);
    const out = sent.find((row) => row.day === day);
    return { day, linkedin: channel === "email" ? 0 : out?.linkedin ?? 0, email: channel === "linkedin" ? 0 : out?.email ?? 0, replies: replies.find((row) => row.day === day)?.replies ?? 0 };
  });

  // Every open event on the campaign's emails, split by what made it.
  const opens = db.prepare(
    `SELECT COUNT(*) AS raw, COALESCE(SUM(se.is_bot = 0), 0) AS human,
       COALESCE(SUM(se.is_bot = 1 AND se.bot_reason IN ('scanner_user_agent', 'known_bot_ip')), 0) AS scanners,
       COALESCE(SUM(se.is_bot = 1 AND se.bot_reason = 'automation_user_agent'), 0) AS automation,
       COALESCE(SUM(se.is_bot = 1 AND (se.bot_reason = 'prefetch' OR se.bot_reason IS NULL OR se.bot_reason NOT IN ('scanner_user_agent', 'known_bot_ip', 'automation_user_agent'))), 0) AS prefetch
     FROM sender_events se JOIN sent_messages sm ON sm.id = se.sent_message_id
     WHERE se.event_type = 'opened' AND sm.run_id IN (SELECT id FROM runs WHERE workflow_id = ? AND workspace_id = ?)`,
  ).get(workflowId, workspaceId) as CampaignOverview["opens"];

  const autoPromote = (db.prepare("SELECT ab_auto_promote FROM workflows WHERE id = ?").get(workflowId) as { ab_auto_promote: number | null } | undefined)?.ab_auto_promote === 1;

  return {
    range, channel,
    kpis: { acceptance: rate("acceptance"), reply: rate("reply"), open: rate("open"), click: rate("click"), completion: rate("completion") },
    daily,
    funnel: { both: funnelOf(reach(current, "both")), linkedin: funnelOf(reach(current, "linkedin")), email: funnelOf(reach(current, "email")) },
    variants: channel === "linkedin" ? [] : variantTests(db, workflowId),
    auto_promote: autoPromote,
    opens,
    generated_at: new Date(now).toISOString(),
  };
}
