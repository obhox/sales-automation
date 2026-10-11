// What the dashboard says, apart from how it draws it: labels, the change beside each
// figure, the sentence under each card. No React here.
import type { Alert } from "@/lib/platform/alerts";
import type { OverviewChannel } from "@/lib/campaigns/overview";
import type { Dashboard, DashboardFunnelStage, DashboardRange, TopCampaign } from "@/lib/reporting/dashboard";
import type { Tone } from "@/components/ui";
import { changeInCount, changeInRate, changeInTally, formatCount, formatPercent, plural, type Change } from "@/lib/client/format";

export type { Alert, Dashboard, DashboardFunnelStage, DashboardRange, OverviewChannel, TopCampaign };

export interface DashboardData {
  dashboard: Dashboard;
  alerts: Alert[];
  health: { status: string };
}

export const RANGE_OPTIONS: Array<{ value: DashboardRange; label: string }> = [
  { value: "7d", label: "Last 7d" }, { value: "30d", label: "Last 30d" }, { value: "90d", label: "Last 90d" },
];
export const isRange = (value: unknown): value is DashboardRange => RANGE_OPTIONS.some((option) => option.value === value);
const PERIOD_WORDS: Record<DashboardRange, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days" };
export const ALL = "all";

/** The pill beside the title: whether sending and reading replies are going on right now. */
export function livePill(status: string): { label: string; tone: Tone; dot: boolean } {
  if (status === "healthy") return { label: "Live", tone: "good", dot: true };
  if (status === "degraded") return { label: "Delayed", tone: "warn", dot: true };
  if (status === "off") return { label: "Background work off", tone: "neutral", dot: false };
  return { label: "Idle", tone: "neutral", dot: false };
}

export interface KpiView {
  key: keyof Dashboard["kpis"];
  label: string;
  value: string;
  change: Change | null;
  spark: number[];
  tone: Tone;
  /** What the figure counts, for a tooltip and for a screen reader. */
  basis: string;
}

/** The five figures along the top. Counts change by a percentage or a plain difference; the rate by points. */
export function kpiViews(dashboard: Dashboard): KpiView[] {
  const { emails, linkedin, reply, positive, meetings } = dashboard.kpis;
  const period = PERIOD_WORDS[dashboard.range];
  // Nothing now and nothing before is not a change worth a pill.
  const moved = <T,>(tally: { value: number; previous: number }, change: T): T | null => (tally.value === 0 && tally.previous === 0 ? null : change);
  return [
    { key: "emails", label: "Emails sent", value: formatCount(emails.value), change: moved(emails, changeInCount(emails.value, emails.previous)), spark: emails.spark, tone: "mail", basis: `Campaign emails sent in the last ${period}; ${formatCount(emails.previous)} in the ${period} before` },
    { key: "linkedin", label: "LinkedIn actions", value: formatCount(linkedin.value), change: moved(linkedin, changeInCount(linkedin.value, linkedin.previous)), spark: linkedin.spark, tone: "li", basis: `Visits, invitations, messages and InMails in the last ${period}; ${formatCount(linkedin.previous)} in the ${period} before` },
    {
      key: "reply", label: "Reply rate", value: reply.value === null ? "—" : formatPercent(reply.value), change: changeInRate(reply.value, reply.previous), spark: reply.spark.map((value) => value ?? 0), tone: "brand",
      basis: reply.whole === 0 ? "Nobody was written to in this period" : `${formatCount(reply.part)} of ${formatCount(reply.whole)} people written to in the last ${period} replied to a message sent in it`,
    },
    { key: "positive", label: "Positive replies", value: formatCount(positive.value), change: moved(positive, changeInTally(positive.value, positive.previous)), spark: positive.spark, tone: "good", basis: `People whose reply read as positive, by the day it arrived; ${formatCount(positive.previous)} in the ${period} before` },
    { key: "meetings", label: "Meetings booked", value: formatCount(meetings.value), change: moved(meetings, changeInTally(meetings.value, meetings.previous)), spark: meetings.spark, tone: "brand", basis: `Meetings put in a connected calendar with a contact, by the day they were booked; ${formatCount(meetings.previous)} in the ${period} before` },
  ];
}

const DAY_OF_MONTH = new Intl.DateTimeFormat("en", { day: "2-digit", timeZone: "UTC" });
const SHORT_DAY = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" });
const FULL_DAY = new Intl.DateTimeFormat("en", { day: "numeric", month: "long", timeZone: "UTC" });

export function activitySubtitle(activity: Dashboard["activity"]): string {
  return `Sends and LinkedIn actions · last ${activity.points.length} ${activity.unit === "week" ? "weeks" : "days"}`;
}

/** The chart's bars: what to print under each, and what to call it. */
export function activityPoints(activity: Dashboard["activity"]): Array<{ label: string; title: string; values: { linkedin: number; email: number; replies: number } }> {
  // Thirty labels would run together: name every third day. Weeks are named by the day they start on.
  const every = activity.unit === "day" && activity.points.length > 16 ? 3 : 1;
  return activity.points.map((point, index) => {
    const date = new Date(`${point.start}T00:00:00Z`);
    const label = activity.unit === "week" ? SHORT_DAY.format(date) : DAY_OF_MONTH.format(date);
    return {
      label: index % every === 0 ? label : "",
      title: activity.unit === "week" ? `Week of ${FULL_DAY.format(date)}` : FULL_DAY.format(date),
      values: { linkedin: point.linkedin, email: point.email, replies: point.replies },
    };
  });
}

export const activityIsEmpty = (activity: Dashboard["activity"]) => activity.points.every((point) => point.email + point.linkedin + point.replies === 0);

const STAGE_LABEL: Record<OverviewChannel, Record<DashboardFunnelStage["key"], string>> = {
  both: { enrolled: "Contacts enrolled", delivered: "Delivered / visited", engaged: "Opened or accepted", replied: "Replied", positive: "Positive", meeting: "Meeting booked" },
  linkedin: { enrolled: "Contacts enrolled", delivered: "Visited or invited", engaged: "Accepted", replied: "Replied", positive: "Positive", meeting: "Meeting booked" },
  email: { enrolled: "Contacts enrolled", delivered: "Delivered", engaged: "Opened", replied: "Replied", positive: "Positive", meeting: "Meeting booked" },
};

export function funnelStages(dashboard: Dashboard, channel: OverviewChannel): Array<{ key: string; label: string; count: number }> {
  return dashboard.funnel.stages[channel].map((stage) => ({ key: stage.key, label: STAGE_LABEL[channel][stage.key], count: stage.count }));
}

/** Which campaigns the funnel is of, and on which channel. */
export function funnelSubtitle(dashboard: Dashboard, channel: OverviewChannel): string {
  const { funnel, filters, options } = dashboard;
  const narrowed = Boolean(filters.list_id || filters.owner_id);
  const which = funnel.scope === "campaign"
    ? options.campaigns.find((campaign) => campaign.id === filters.workflow_id)?.name ?? "One campaign"
    : funnel.campaigns === 0 ? "No campaigns yet"
    : funnel.scope === "in_flight"
      ? narrowed ? `${formatCount(funnel.campaigns)} active ${plural(funnel.campaigns, "campaign", "campaigns")}` : "All active campaigns"
      : narrowed ? `${formatCount(funnel.campaigns)} ${plural(funnel.campaigns, "campaign", "campaigns")}` : "All campaigns";
  return `${which} · ${channel === "both" ? "both channels" : channel === "linkedin" ? "LinkedIn" : "email"}`;
}

export const NEXT_CHANNEL: Record<OverviewChannel, OverviewChannel> = { both: "linkedin", linkedin: "email", email: "both" };
export const channelWord = (channel: OverviewChannel) => (channel === "both" ? "By channel" : channel === "linkedin" ? "LinkedIn" : "Email");

export interface TodayRow { key: "emails" | "invites" | "visits" | "replies" | "meetings"; label: string; count: number; cap: number | null; tone: Tone }

export function todayRows(today: Dashboard["today"]): TodayRow[] {
  return [
    { key: "emails", label: "Emails sent", count: today.emails.sent, cap: today.emails.cap, tone: "mail" },
    { key: "invites", label: "Invites sent", count: today.invites.sent, cap: today.invites.cap, tone: "li" },
    { key: "visits", label: "Profile visits", count: today.visits.sent, cap: today.visits.cap, tone: "li" },
    { key: "replies", label: "Replies received", count: today.replies, cap: null, tone: "brand" },
    { key: "meetings", label: "Meetings booked", count: today.meetings, cap: null, tone: "brand" },
  ];
}

export const TOP_SORTS = [
  { value: "reply_rate", label: "By reply rate" }, { value: "replies", label: "By replies" }, { value: "acceptance", label: "By acceptance" },
] as const;
export type TopSort = (typeof TOP_SORTS)[number]["value"];
export const isTopSort = (value: unknown): value is TopSort => TOP_SORTS.some((option) => option.value === value);

export interface TopRow { id: string; name: string; channels: TopCampaign["channels"]; figure: string; share: number; basis: string }

/** A rate needs this many people under it before a campaign is ranked on it: one reply out of one is not 100%. */
export const MIN_FOR_RANK = 5;

/** The best campaigns by the measure chosen, with a bar relative to the best of them. */
export function topCampaigns(campaigns: TopCampaign[], sort: TopSort, limit = 5): TopRow[] {
  const measured = campaigns.flatMap((campaign) => {
    if (sort === "replies") return campaign.replied > 0 ? [{ campaign, value: campaign.replied, figure: formatCount(campaign.replied), basis: `${formatCount(campaign.replied)} of ${formatCount(campaign.contacted)} people written to replied` }] : [];
    const [rate, whole, part, noun] = sort === "reply_rate"
      ? [campaign.reply_rate, campaign.contacted, campaign.replied, "people written to replied"] as const
      : [campaign.acceptance_rate, campaign.invited, campaign.accepted, "invitations were accepted"] as const;
    return rate !== null && whole >= MIN_FOR_RANK ? [{ campaign, value: rate, figure: formatPercent(rate), basis: `${formatCount(part)} of ${formatCount(whole)} ${noun}` }] : [];
  });
  const ranked = measured.sort((a, b) => b.value - a.value || a.campaign.name.localeCompare(b.campaign.name)).slice(0, limit);
  const best = ranked[0]?.value ?? 0;
  return ranked.map(({ campaign, value, figure, basis }) => ({ id: campaign.id, name: campaign.name, channels: campaign.channels, figure, share: best > 0 ? value / best : 0, basis }));
}

export interface SetupStep { key: "sender" | "list" | "campaign" | "launch"; title: string; detail: string; done: boolean; action: { label: string; href: string } }

/** The first things to do in a new workspace, and which of them are done. Null once a campaign has been launched. */
export function setupSteps(setup: Dashboard["setup"]): SetupStep[] | null {
  if (setup.launched > 0) return null;
  const senders = setup.linkedin_accounts + setup.mailboxes;
  return [
    {
      key: "sender", done: senders > 0, title: "Connect something to send from",
      detail: senders > 0 ? `${[setup.linkedin_accounts > 0 ? `${setup.linkedin_accounts} LinkedIn ${plural(setup.linkedin_accounts, "account", "accounts")}` : "", setup.mailboxes > 0 ? `${setup.mailboxes} ${plural(setup.mailboxes, "mailbox", "mailboxes")}` : ""].filter(Boolean).join(" and ")} ready.` : "A LinkedIn account, a mailbox, or both.",
      action: setup.linkedin_accounts > 0 ? { label: "Add a mailbox", href: "/mailboxes" } : { label: "Connect LinkedIn", href: "/linkedin-accounts" },
    },
    { key: "list", done: setup.lists > 0, title: "Bring in the people to contact", detail: setup.lists > 0 ? `${formatCount(setup.lists)} ${plural(setup.lists, "list", "lists")} so far.` : "Import a CSV file or a Sales Navigator search into a list.", action: { label: "Open lists", href: "/lists" } },
    { key: "campaign", done: setup.campaigns > 0, title: "Build a campaign", detail: setup.campaigns > 0 ? "A draft is waiting to be finished." : "Choose the list, write the steps, pick the senders.", action: { label: setup.campaigns > 0 ? "Open campaigns" : "New campaign", href: setup.campaigns > 0 ? "/campaigns" : "/campaigns?new=1" } },
    { key: "launch", done: false, title: "Launch it", detail: "The figures on this page start moving with the first send.", action: { label: "Open campaigns", href: "/campaigns" } },
  ];
}

/** How many alerts the card shows before "View all". */
export const ALERTS_SHOWN = 3;
