// The dashboard: how the whole workspace's outreach is doing over a period, beside the
// period before; what was sent and answered each day; how far contacts got; what today
// has used of each sender's allowance; and which campaigns are doing best.
//
// A period means what it means on a campaign's Overview: what was sent in it and what came
// of those sends, with a reply counted for the message it answers. Replies, positive
// replies and meetings shown as plain counts are counted on the day they arrived.
import type DatabaseType from "better-sqlite3";
import { campaignReach, type OverviewChannel, type Reached } from "@/lib/campaigns/overview";
import { campaignSummaries, type CampaignSummary } from "@/lib/campaigns/summary";
import { listMailboxes } from "@/lib/email/mailbox-list";
import { linkedinAccountsOverview } from "@/lib/linkedin/account-list";
import { AUTO_REPLY_KINDS, sqlList } from "@/lib/reply-kinds";

type DB = DatabaseType.Database;

export const DASHBOARD_RANGES = ["7d", "30d", "90d"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];
const DAYS: Record<DashboardRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
const DAY_MS = 86_400_000;
const SPARK_BARS = 8;

export const isDashboardRange = (value: unknown): value is DashboardRange => (DASHBOARD_RANGES as readonly unknown[]).includes(value);

export interface DashboardFilters {
  range?: DashboardRange;
  /** One campaign only. */
  workflow_id?: string | null;
  /** Contacts enrolled from one list only. */
  list_id?: string | null;
  /** Campaigns one member owns only. */
  owner_id?: string | null;
  now?: number;
}

export interface Tally {
  value: number;
  /** The same count for the period before. */
  previous: number;
  /** The count in each slice of the period, oldest first. */
  spark: number[];
}

export interface DashboardRate {
  value: number | null;
  part: number;
  whole: number;
  previous: number | null;
  spark: Array<number | null>;
}

export interface DashboardFunnelStage {
  key: "enrolled" | "delivered" | "engaged" | "replied" | "positive" | "meeting";
  count: number;
}

export interface TopCampaign {
  id: string;
  name: string;
  status: CampaignSummary["status"];
  channels: CampaignSummary["channels"];
  enrolled: number;
  contacted: number;
  replied: number;
  reply_rate: number | null;
  invited: number;
  accepted: number;
  acceptance_rate: number | null;
}

export interface Dashboard {
  range: DashboardRange;
  filters: { workflow_id: string | null; list_id: string | null; owner_id: string | null };
  kpis: { emails: Tally; linkedin: Tally; reply: DashboardRate; positive: Tally; meetings: Tally };
  /** One bar a day, or one a week for the longest period. `label` is the day, or the Monday the week starts on. */
  activity: { unit: "day" | "week"; points: Array<{ start: string; email: number; linkedin: number; replies: number }> };
  /** The campaigns the funnel adds up, and how far their contacts got on both channels and on each. */
  funnel: { campaigns: number; scope: "campaign" | "in_flight" | "all"; stages: Record<OverviewChannel, DashboardFunnelStage[]> };
  /** Today on each sender's own calendar day, against what the senders in use may do. Always the whole workspace. */
  today: {
    emails: { sent: number; cap: number };
    invites: { sent: number; cap: number };
    visits: { sent: number; cap: number };
    replies: number;
    meetings: number;
  };
  campaigns: TopCampaign[];
  /** How far the workspace has got with setting itself up, for the first-run checklist. */
  setup: { linkedin_accounts: number; mailboxes: number; lists: number; campaigns: number; launched: number };
  options: { campaigns: Array<{ id: string; name: string }>; lists: Array<{ id: string; name: string }>; members: Array<{ id: string; name: string }> };
  generated_at: string;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const time = (value: string | null | undefined) => (value ? Date.parse(/[TZ]/.test(value) ? value : `${value.replace(" ", "T")}Z`) || 0 : 0);
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** Which sends, replies and meetings the filters let through, as SQL over the alias given. */
function scopeSql(filters: DashboardFilters): { sends: string; target: string; bind: Record<string, string | null> } {
  const clauses: string[] = [];
  if (filters.workflow_id) clauses.push("ss.workflow_id = @wf");
  if (filters.list_id) clauses.push("ss.run_id IN (SELECT id FROM runs WHERE list_id = @list AND workspace_id = @ws)");
  if (filters.owner_id) clauses.push("ss.workflow_id IN (SELECT id FROM workflows WHERE owner_id = @owner AND workspace_id = @ws)");
  const sends = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
  return {
    sends,
    // A reply or a meeting is in scope when the scope wrote to that contact.
    target: clauses.length ? ` AND x.target_id IN (SELECT ss.target_id FROM step_sends ss WHERE ss.workspace_id = @ws${sends})` : "",
    bind: { wf: filters.workflow_id ?? null, list: filters.list_id ?? null, owner: filters.owner_id ?? null },
  };
}

interface Send { target_id: string; at: number; channel: "linkedin" | "email"; action: string }

/** The share of people written to between two times who answered a message sent between them. */
function replyRate(sends: Send[], credit: Map<string, { linkedin: number; email: number }>, from: number, to: number): [number, number] {
  const written = new Set<string>();
  for (const send of sends) {
    if (send.at < from || send.at >= to) continue;
    // A profile visit is not something to reply to.
    if (send.channel === "email" || send.action !== "visit") written.add(send.target_id);
  }
  const inPeriod = (at: number) => at >= from && at < to;
  let replied = 0;
  for (const id of written) {
    const answered = credit.get(id);
    if (answered && (inPeriod(answered.linkedin) || inPeriod(answered.email))) replied += 1;
  }
  return [replied, written.size];
}

/** Add a number of days' counts into equal slices, oldest first. */
function slices(daily: number[], bars: number): number[] {
  const count = Math.min(bars, daily.length);
  const out = Array.from({ length: count }, () => 0);
  daily.forEach((value, index) => { out[Math.min(count - 1, Math.floor((index * count) / daily.length))] += value; });
  return out;
}

const STAGES: Array<{ key: DashboardFunnelStage["key"]; from: keyof Reached }> = [
  { key: "enrolled", from: "enrolled" }, { key: "delivered", from: "delivered" }, { key: "engaged", from: "engaged" },
  { key: "replied", from: "replied" }, { key: "positive", from: "positive" }, { key: "meeting", from: "meeting" },
];

export function workspaceDashboard(db: DB, workspaceId: string, filters: DashboardFilters = {}): Dashboard {
  const range = filters.range ?? "7d";
  const now = filters.now ?? Date.now();
  const days = DAYS[range];
  const span = days * DAY_MS;
  const end = now + 1;
  const from = end - span;
  const scope = scopeSql(filters);
  const bind = { ws: workspaceId, ...scope.bind };

  // ── Counts by day, over this period and the one before ──
  const firstDay = dayOf(from - span);
  const dayIndex = new Map<string, number>();
  // Days are UTC calendar days; the period's own edges are exact, so the first and last day may be part days.
  const allDays: string[] = [];
  for (let ms = Date.parse(`${firstDay}T00:00:00Z`); ms < end; ms += DAY_MS) { dayIndex.set(dayOf(ms), allDays.length); allDays.push(dayOf(ms)); }
  const series = { email: allDays.map(() => 0), linkedin: allDays.map(() => 0), replies: allDays.map(() => 0), positive: allDays.map(() => 0), meetings: allDays.map(() => 0) };
  const put = (key: keyof typeof series, day: string, count: number) => { const index = dayIndex.get(day); if (index !== undefined) series[key][index] += count; };
  // Times are stored in more than one format (SQLite's and ISO), which sort apart within a
  // day. Whole days as bounds are right for both; anything finer is cut in code.
  const window = { ...bind, from: firstDay, to: dayOf(end + DAY_MS) };

  for (const row of db.prepare(
    `SELECT date(ss.sent_at) AS day, ss.channel, COUNT(*) AS c FROM step_sends ss
     WHERE ss.workspace_id = @ws AND ss.sent_at >= @from AND ss.sent_at < @to${scope.sends} GROUP BY day, ss.channel`,
  ).all(window) as Array<{ day: string; channel: "email" | "linkedin"; c: number }>) put(row.channel === "email" ? "email" : "linkedin", row.day, row.c);

  const KIND = "COALESCE(CASE WHEN json_valid(x.classification_json) THEN json_extract(x.classification_json, '$.kind') END, '')";
  // A contact who writes three times in a day replied once that day.
  for (const row of db.prepare(
    `SELECT day, COUNT(*) AS replies, SUM(positive) AS positive FROM (
       SELECT date(x.received_at) AS day, x.target_id, MAX(${KIND} = 'positive') AS positive FROM email_replies x
       WHERE x.workspace_id = @ws AND x.target_id IS NOT NULL AND x.received_at >= @from AND x.received_at < @to
         AND ${KIND} NOT IN (${sqlList(AUTO_REPLY_KINDS)})${scope.target}
       GROUP BY day, x.target_id) GROUP BY day`,
  ).all(window) as Array<{ day: string; replies: number; positive: number | null }>) {
    put("replies", row.day, row.replies);
    put("positive", row.day, row.positive ?? 0);
  }

  for (const row of db.prepare(
    `SELECT date(x.created_at) AS day, COUNT(*) AS c FROM meetings x
     WHERE x.workspace_id = @ws AND x.created_at >= @from AND x.created_at < @to AND COALESCE(x.status, '') NOT IN ('cancelled', 'canceled')${scope.target} GROUP BY day`,
  ).all(window) as Array<{ day: string; c: number }>) put("meetings", row.day, row.c);

  // The period is the last `days` calendar days ending today; the one before, the `days` before those.
  const total = allDays.length;
  const current = (key: keyof typeof series) => series[key].slice(total - days);
  const before = (key: keyof typeof series) => series[key].slice(Math.max(0, total - 2 * days), total - days);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const tally = (key: keyof typeof series): Tally => ({ value: sum(current(key)), previous: sum(before(key)), spark: slices(current(key), SPARK_BARS) });

  // ── Reply rate: people written to in the period, and whether they answered a message sent in it ──
  const sends = db.prepare(
    `SELECT ss.target_id, CAST(strftime('%s', ss.sent_at) AS INTEGER) * 1000 AS at, ss.channel, ss.action FROM step_sends ss
     WHERE ss.workspace_id = @ws AND ss.target_id IS NOT NULL AND ss.sent_at >= @from AND ss.sent_at < @to${scope.sends} ORDER BY at, ss.rowid`,
  ).all(window) as Send[];
  const credit = new Map<string, { linkedin: number; email: number }>();
  if (sends.length > 0) {
    const auto = new Set<string>(AUTO_REPLY_KINDS);
    const answered = new Map<string, { linkedin: number; email: number; kind: string | null }>();
    const ids = [...new Set(sends.map((send) => send.target_id))];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      for (const row of db.prepare(
        `SELECT id, last_replied_at, email_replied_at, reply_kind FROM targets WHERE id IN (${chunk.map(() => "?").join(",")}) AND (last_replied_at IS NOT NULL OR email_replied_at IS NOT NULL)`,
      ).all(...chunk) as Array<{ id: string; last_replied_at: string | null; email_replied_at: string | null; reply_kind: string | null }>) {
        answered.set(row.id, { linkedin: time(row.last_replied_at), email: time(row.email_replied_at), kind: row.reply_kind });
      }
    }
    // Sends come oldest first, so the last one at or before the reply is the one it answers.
    for (const send of sends) {
      const reply = answered.get(send.target_id);
      if (!reply || auto.has(reply.kind ?? "")) continue;
      const at = reply[send.channel];
      if (at === 0 || send.at > at || (send.channel === "linkedin" && send.action === "visit")) continue;
      const entry = credit.get(send.target_id) ?? { linkedin: 0, email: 0 };
      entry[send.channel] = send.at;
      credit.set(send.target_id, entry);
    }
  }
  const rate = replyRate(sends, credit, from, end);
  const earlier = replyRate(sends, credit, from - span, from);
  const slice = span / SPARK_BARS;
  const reply: DashboardRate = {
    value: ratio(...rate), part: rate[0], whole: rate[1], previous: ratio(...earlier),
    spark: Array.from({ length: SPARK_BARS }, (_, index) => ratio(...replyRate(sends, credit, from + index * slice, from + (index + 1) * slice))),
  };

  // ── The chart: a fortnight of days for the short period, the period's days for the middle one, weeks for the long one ──
  const chartDays = range === "7d" ? 14 : days;
  const chart = allDays.slice(total - chartDays).map((day) => {
    const index = dayIndex.get(day)!;
    return { start: day, email: series.email[index], linkedin: series.linkedin[index], replies: series.replies[index] };
  });
  let activity: Dashboard["activity"] = { unit: "day", points: chart };
  if (range === "90d") {
    const weeks: Dashboard["activity"]["points"] = [];
    // Weeks counted back from today, so the last bar is always the seven days ending now.
    for (let endIndex = chart.length; endIndex > 0; endIndex -= 7) {
      const part = chart.slice(Math.max(0, endIndex - 7), endIndex);
      weeks.unshift({ start: part[0].start, email: sum(part.map((p) => p.email)), linkedin: sum(part.map((p) => p.linkedin)), replies: sum(part.map((p) => p.replies)) });
    }
    activity = { unit: "week", points: weeks };
  }

  // ── Campaigns in scope: the funnel adds them up, and the best of them are listed ──
  const summaries = campaignSummaries(db, workspaceId).filter((campaign) => campaign.status !== "archived");
  let inScope = summaries.filter((campaign) => campaign.status !== "draft");
  if (filters.workflow_id) inScope = inScope.filter((campaign) => campaign.id === filters.workflow_id);
  if (filters.owner_id) inScope = inScope.filter((campaign) => campaign.owner?.id === filters.owner_id);
  if (filters.list_id) {
    const withList = new Set((db.prepare("SELECT DISTINCT workflow_id FROM runs WHERE workspace_id = ? AND list_id = ?").all(workspaceId, filters.list_id) as { workflow_id: string }[]).map((row) => row.workflow_id));
    inScope = inScope.filter((campaign) => withList.has(campaign.id));
  }
  // With no campaign picked, the funnel is of what is in flight; when nothing is, of everything.
  const inFlight = inScope.filter((campaign) => campaign.status === "active" || campaign.status === "paused");
  const funnelScope: Dashboard["funnel"]["scope"] = filters.workflow_id ? "campaign" : inFlight.length > 0 ? "in_flight" : "all";
  const funnelCampaigns = funnelScope === "in_flight" ? inFlight : inScope;
  const totals: Record<OverviewChannel, Record<string, number>> = { both: {}, linkedin: {}, email: {} };
  for (const campaign of funnelCampaigns) {
    const reached = campaignReach(db, workspaceId, campaign.id, filters.list_id ?? null);
    for (const channel of ["both", "linkedin", "email"] as const) for (const stage of STAGES) totals[channel][stage.key] = (totals[channel][stage.key] ?? 0) + reached[channel][stage.from];
  }
  const stagesOf = (channel: OverviewChannel): DashboardFunnelStage[] => STAGES.map((stage) => ({ key: stage.key, count: totals[channel][stage.key] ?? 0 }));

  // ── Today, against what the senders in use may do ──
  const mailboxes = listMailboxes(db, workspaceId, new Date(now)).filter((mailbox) => mailbox.status === "active" || mailbox.status === "at_limit");
  const accounts = linkedinAccountsOverview(db, workspaceId, new Date(now)).accounts.filter((account) => account.session.signed_in && account.status !== "paused");
  const repliesToday = (db.prepare(
    `SELECT COUNT(DISTINCT x.target_id) AS c FROM email_replies x WHERE x.workspace_id = ? AND x.target_id IS NOT NULL AND x.received_at >= ? AND ${KIND} NOT IN (${sqlList(AUTO_REPLY_KINDS)})`,
  ).get(workspaceId, dayOf(now)) as { c: number }).c;
  const meetingsToday = (db.prepare("SELECT COUNT(*) AS c FROM meetings WHERE workspace_id = ? AND created_at >= ? AND COALESCE(status, '') NOT IN ('cancelled', 'canceled')").get(workspaceId, dayOf(now)) as { c: number }).c;

  const name = (row: { name: string | null; email: string }) => row.name?.trim() || row.email;
  return {
    range,
    filters: { workflow_id: filters.workflow_id ?? null, list_id: filters.list_id ?? null, owner_id: filters.owner_id ?? null },
    kpis: { emails: tally("email"), linkedin: tally("linkedin"), reply, positive: tally("positive"), meetings: tally("meetings") },
    activity,
    funnel: { campaigns: funnelCampaigns.length, scope: funnelScope, stages: { both: stagesOf("both"), linkedin: stagesOf("linkedin"), email: stagesOf("email") } },
    today: {
      emails: { sent: sum(mailboxes.map((mailbox) => mailbox.sending.sent_today)), cap: sum(mailboxes.map((mailbox) => mailbox.sending.limit_today)) },
      invites: { sent: sum(accounts.map((account) => account.usage.connects)), cap: sum(accounts.map((account) => account.limits.connections)) },
      visits: { sent: sum(accounts.map((account) => account.usage.visits)), cap: sum(accounts.map((account) => account.limits.visits)) },
      replies: repliesToday,
      meetings: meetingsToday,
    },
    campaigns: inScope.filter((campaign) => campaign.enrolled > 0).map((campaign) => ({
      id: campaign.id, name: campaign.name, status: campaign.status, channels: campaign.channels, enrolled: campaign.enrolled, contacted: campaign.contacted, replied: campaign.replied,
      reply_rate: campaign.reply_rate, invited: campaign.invited, accepted: campaign.accepted, acceptance_rate: campaign.acceptance_rate,
    })),
    setup: {
      linkedin_accounts: (db.prepare("SELECT COUNT(*) AS c FROM accounts WHERE workspace_id = ? AND is_authenticated = 1").get(workspaceId) as { c: number }).c,
      mailboxes: (db.prepare("SELECT COUNT(*) AS c FROM email_accounts WHERE workspace_id = ? AND is_verified = 1 AND disconnected_at IS NULL").get(workspaceId) as { c: number }).c,
      lists: (db.prepare("SELECT COUNT(*) AS c FROM lists WHERE workspace_id = ?").get(workspaceId) as { c: number }).c,
      campaigns: summaries.length,
      launched: summaries.filter((campaign) => campaign.status !== "draft").length,
    },
    options: {
      campaigns: summaries.map((campaign) => ({ id: campaign.id, name: campaign.name })).sort((a, b) => a.name.localeCompare(b.name)),
      lists: db.prepare("SELECT id, name FROM lists WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(workspaceId) as Array<{ id: string; name: string }>,
      members: (db.prepare(
        "SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY lower(COALESCE(NULLIF(u.name, ''), u.email))",
      ).all(workspaceId) as Array<{ id: string; name: string | null; email: string }>).map((row) => ({ id: row.id, name: name(row) })),
    },
    generated_at: new Date(now).toISOString(),
  };
}
