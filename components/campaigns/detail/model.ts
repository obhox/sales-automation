// What a campaign's Overview, Prospects and Settings tabs say, apart from how they draw
// it: labels, the sentence under each figure, what an action reports back. No React here.
import type { CampaignOverview, FunnelStage, OverviewChannel, OverviewRange, Rate, VariantRow, VariantTest } from "@/lib/campaigns/overview";
import type { ActionResult, ProspectAction, ProspectRow, ProspectSort, ProspectsPage, ProspectStatus, StepFacet, TrackPlace } from "@/lib/campaigns/prospects";
import type { CampaignSettings, EmailTracking } from "@/lib/campaigns/settings";
import type { ReportShare } from "@/lib/campaigns/share";
import type { PoolChange } from "@/lib/outreach/enroll";
import type { Tone } from "@/components/ui";
import { changeInRate, formatCount, formatPercent, plural, type Change } from "@/lib/client/format";

export type {
  ActionResult, CampaignOverview, CampaignSettings, EmailTracking, FunnelStage, OverviewChannel, OverviewRange, PoolChange, ProspectAction, ProspectRow, ProspectSort,
  ProspectsPage, ProspectStatus, Rate, ReportShare, StepFacet, TrackPlace, VariantRow, VariantTest,
};

// ── Overview ──────────────────────────────────────────────────────────────────

export const RANGE_OPTIONS: Array<{ value: OverviewRange; label: string }> = [
  { value: "7d", label: "7d" }, { value: "14d", label: "14d" }, { value: "30d", label: "30d" }, { value: "all", label: "All" },
];
export const CHANNEL_OPTIONS: Array<{ value: OverviewChannel; label: string }> = [
  { value: "both", label: "Both channels" }, { value: "linkedin", label: "LinkedIn only" }, { value: "email", label: "Email only" },
];
const RANGE_WORDS: Record<OverviewRange, string> = { "7d": "the last 7 days", "14d": "the last 14 days", "30d": "the last 30 days", all: "all time" };
export const isRange = (value: unknown): value is OverviewRange => RANGE_OPTIONS.some((option) => option.value === value);
export const isChannel = (value: unknown): value is OverviewChannel => CHANNEL_OPTIONS.some((option) => option.value === value);

export interface KpiView {
  key: keyof CampaignOverview["kpis"];
  label: string;
  value: string;
  change: Change | null;
  spark: number[];
  tone: Tone;
  /** What the figure is out of, for the tooltip and for a screen reader. */
  basis: string;
}

const KPI_ORDER: Array<{ key: KpiView["key"]; label: string; tone: Tone; basis: (rate: Rate) => string }> = [
  { key: "acceptance", label: "Acceptance rate", tone: "li", basis: (rate) => `${formatCount(rate.part)} of ${formatCount(rate.whole)} people invited in the period accepted` },
  { key: "reply", label: "Reply rate", tone: "mail", basis: (rate) => `${formatCount(rate.part)} of ${formatCount(rate.whole)} people written to in the period replied` },
  { key: "open", label: "Open rate", tone: "li", basis: (rate) => `${formatCount(rate.part)} of ${formatCount(rate.whole)} tracked emails delivered in the period were opened by a person` },
  { key: "click", label: "Click rate", tone: "brand", basis: (rate) => `${formatCount(rate.part)} of ${formatCount(rate.whole)} emails with tracked links delivered in the period were clicked` },
  { key: "completion", label: "Completion", tone: "good", basis: (rate) => `${formatCount(rate.part)} of ${formatCount(rate.whole)} enrolled contacts have finished the sequence` },
];

/** The five figures along the top. A rate with nothing under it reads as a dash, never as 0%. */
export function kpiViews(overview: CampaignOverview): KpiView[] {
  return KPI_ORDER.map(({ key, label, tone, basis }) => {
    const rate = overview.kpis[key];
    return {
      key, label, tone,
      value: rate.value === null ? "—" : formatPercent(rate.value),
      change: changeInRate(rate.value, rate.previous),
      // Bars need a height: a slice nobody was enrolled in draws as the shortest one.
      spark: rate.spark.map((value) => value ?? 0),
      basis: rate.whole === 0 ? "Nothing to measure yet" : basis(rate),
    };
  });
}

export function chartSubtitle(overview: Pick<CampaignOverview, "channel" | "daily">): string {
  const what = overview.channel === "linkedin" ? "LinkedIn actions and replies" : overview.channel === "email" ? "Emails and replies" : "LinkedIn actions, emails and replies";
  return `${what} · last ${overview.daily.length} days`;
}

/** Whether anything at all happened in the days charted. */
export const chartIsEmpty = (daily: CampaignOverview["daily"]) => daily.every((day) => day.linkedin + day.email + day.replies === 0);

const STAGE_LABEL: Record<OverviewChannel, Record<FunnelStage["key"], string>> = {
  both: { enrolled: "Enrolled", contacted: "Contacted", delivered: "Delivered / visited", engaged: "Accepted or opened", replied: "Replied", positive: "Positive reply", meeting: "Meeting booked" },
  linkedin: { enrolled: "Enrolled", contacted: "Reached on LinkedIn", delivered: "Visited or invited", engaged: "Accepted", replied: "Replied", positive: "Positive reply", meeting: "Meeting booked" },
  email: { enrolled: "Enrolled", contacted: "Emailed", delivered: "Delivered", engaged: "Opened", replied: "Replied", positive: "Positive reply", meeting: "Meeting booked" },
};
// The colours the design gives each stage: brand while it is about reach, then each channel's own, then green for the outcomes.
const STAGE_FILL: Record<FunnelStage["key"], string> = {
  enrolled: "bg-brand", contacted: "bg-brand", delivered: "bg-brand", engaged: "bg-li", replied: "bg-mail", positive: "bg-good", meeting: "bg-good",
};

export interface FunnelRow { key: FunnelStage["key"]; label: string; count: number; share: number; note: string | null; fill: string }

export function funnelRows(stages: FunnelStage[], channel: OverviewChannel): FunnelRow[] {
  const count = (key: FunnelStage["key"]) => stages.find((stage) => stage.key === key)?.count ?? 0;
  const base = count("enrolled");
  const of = (part: number, whole: number, noun: string) => (whole > 0 ? `${Math.round((part / whole) * 100)}% of ${noun}` : null);
  return stages.map((stage) => ({
    key: stage.key,
    label: STAGE_LABEL[channel][stage.key],
    count: stage.count,
    share: base > 0 ? stage.count / base : 0,
    note: stage.drop ? `−${formatCount(stage.drop.count)} ${stage.drop.reason}`
      : stage.key === "positive" ? of(stage.count, count("replied"), "replies")
      : stage.key === "meeting" ? of(stage.count, count("positive"), "positives")
      : null,
    fill: STAGE_FILL[stage.key],
  }));
}

export const funnelSubtitle = (stages: FunnelStage[], channel: OverviewChannel) =>
  `${formatCount(stages[0]?.count ?? 0)} enrolled · ${channel === "both" ? "both channels" : channel === "linkedin" ? "LinkedIn" : "email"}`;

export const VARIANT_STATUS: Record<VariantRow["status"], { label: string; tone: Tone }> = {
  control: { label: "Control", tone: "neutral" }, leading: { label: "Leading", tone: "good" }, trailing: { label: "Trailing", tone: "neutral" },
  paused: { label: "Paused", tone: "neutral" }, removed: { label: "Removed", tone: "neutral" }, waiting: { label: "No sends yet", tone: "neutral" }, winner: { label: "Winner", tone: "good" },
};

export interface VariantVerdict {
  subtitle: string;
  pill: { text: string; tone: Tone };
  note: string;
  /** What the button does: promote this version, or put every version back to sending. */
  action: { label: string; winner: string | null } | { label: string; reopen: true } | null;
}

/** What to say about one email's A/B test: how sure it is, what it still needs, and what can be done. */
export function variantVerdict(test: VariantTest, autoPromote: boolean): VariantVerdict {
  const live = test.rows.filter((row) => row.status !== "removed");
  const subtitle = `Email ${test.email_number} · ${live.length} ${plural(live.length, "variant", "variants")}${test.decided ? "" : test.even_split ? " · even split" : " · weighted split"}`;
  const auto = autoPromote ? "Auto-promote is on." : "Auto-promote is off.";
  const confidence = test.confidence === null ? null : Math.min(99, Math.floor(test.confidence * 100));
  if (test.decided) {
    const winner = test.rows.find((row) => row.status === "winner");
    return {
      subtitle, pill: { text: "Winner chosen", tone: "good" },
      note: `Only version ${winner?.label ?? "?"} is sending. The others are paused and keep their results.`,
      action: { label: "Reopen test", reopen: true },
    };
  }
  const promote = test.leader ? { label: `Promote ${test.leader.label}`, winner: test.leader.variant_id } : null;
  if (test.significant) {
    return {
      subtitle, pill: { text: confidence === null ? "Significant" : `${confidence}% confidence · significant`, tone: "good" },
      note: `Version ${test.leader?.label ?? "?"} is ahead by more than chance would explain. ${autoPromote ? "Auto-promote will pause the others." : auto}`,
      action: promote,
    };
  }
  if (confidence === null) {
    return { subtitle, pill: { text: "Too early to call", tone: "neutral" }, note: `Each version needs 30 sends before a gap between them means anything. ${auto}`, action: promote };
  }
  return {
    subtitle, pill: { text: `${confidence}% confidence · not yet significant`, tone: "warn" },
    note: test.more_sends_needed === null
      ? `The versions are level so far: more sends will not separate them until one pulls ahead. ${auto}`
      : `Needs ~${formatCount(test.more_sends_needed)} more ${plural(test.more_sends_needed, "send", "sends")} per variant to reach 95% confidence. ${auto}`,
    action: promote,
  };
}

export interface OpensRow { key: "human" | "scanners" | "prefetch" | "automation"; label: string; count: number; share: number; fill: string }

/** The opens split by what made them, largest group of machines named as the detector names it. */
export function opensRows(opens: CampaignOverview["opens"]): { rows: OpensRow[]; filtered: number | null } {
  const share = (count: number) => (opens.raw > 0 ? count / opens.raw : 0);
  return {
    rows: [
      { key: "human", label: "Human opens", count: opens.human, share: share(opens.human), fill: "bg-mail" },
      { key: "scanners", label: "Security scanners", count: opens.scanners, share: share(opens.scanners), fill: "bg-warn" },
      { key: "prefetch", label: "Fetched on arrival · Apple Mail privacy and the like", count: opens.prefetch, share: share(opens.prefetch), fill: "bg-ink-3" },
      { key: "automation", label: "Crawlers and scripts", count: opens.automation, share: share(opens.automation), fill: "bg-bad" },
    ],
    filtered: opens.raw > 0 ? 1 - share(opens.human) : null,
  };
}

export const periodWords = (range: OverviewRange) => RANGE_WORDS[range];

/** What the period picker changes, and what it leaves alone. */
export const periodNote = (range: OverviewRange) =>
  `The rates and the chart are for what was sent in ${RANGE_WORDS[range]}, with replies counted for the message they answer. The funnel and the A/B results are for the whole campaign.`;

// ── Report links ──────────────────────────────────────────────────────────────

export function shareLine(share: ReportShare): string {
  const views = share.views === 0 ? "never opened" : `opened ${formatCount(share.views)} ${plural(share.views, "time", "times")}`;
  return `${share.created_by ? `Made by ${share.created_by.name}` : "Made automatically"} · ${views}`;
}

// ── Prospects ─────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<ProspectStatus, string> = { active: "Active", held: "Held", failed: "Failed", replied: "Replied", completed: "Finished", skipped: "Left out" };
export const STATUS_TONE: Record<ProspectStatus, Tone> = { active: "good", held: "warn", failed: "bad", replied: "brand", completed: "neutral", skipped: "neutral" };
export const STATUS_HELP: Record<ProspectStatus, string> = {
  active: "Part-way through the sequence.",
  held: "Another campaign took this contact; their steps here wait until it has finished with them.",
  failed: "A step failed. Retry puts it back in line.",
  replied: "They replied, so the rest of the sequence was called off.",
  completed: "Went through the whole sequence.",
  skipped: "Unenrolled, bounced or otherwise left out before the end.",
};

export type StatusTab = "all" | ProspectStatus;
const TAB_ORDER: StatusTab[] = ["all", "active", "replied", "failed", "held", "completed", "skipped"];

export function prospectTabs(counts: ProspectsPage["counts"] | undefined): Array<{ value: StatusTab; label: string; count: number | undefined }> {
  // "Held" is rare enough to stay out of the way until someone is.
  return TAB_ORDER.filter((tab) => tab !== "held" || (counts?.held ?? 0) > 0).map((tab) => ({ value: tab, label: tab === "all" ? "All" : STATUS_LABEL[tab], count: counts?.[tab] }));
}

const STEP_WORD: Record<string, string> = { visit: "Profile visit", connect: "Connection request", message: "LinkedIn message", sales_inmail: "InMail", email: "Email", delay: "Wait" };

function waitWords(seconds: number | null): string {
  if (!seconds) return "Wait";
  const hours = Math.round(seconds / 3600);
  return hours % 24 === 0 ? `Wait ${hours / 24} ${plural(hours / 24, "day", "days")}` : `Wait ${hours} ${plural(hours, "hour", "hours")}`;
}

/** "LinkedIn 2 · Wait 2 days": a step as the filter names it. */
export function stepLabel(step: Pick<StepFacet, "track" | "position" | "step_type" | "delay_seconds">): string {
  return `${step.track === "email" ? "Email" : "LinkedIn"} ${step.position} · ${step.step_type === "delay" ? waitWords(step.delay_seconds) : STEP_WORD[step.step_type] ?? step.step_type}`;
}

/** Where a prospect is on one track, in a few words. */
export function placeLine(place: TrackPlace | null): string {
  if (!place) return "Not on this channel";
  if (place.state === "completed") return "Finished";
  if (place.state === "failed") return place.note ? `Failed · ${place.note}` : "Failed";
  if (place.state === "skipped") return place.note ?? "Skipped";
  const step = place.step_type ? (place.step_type === "delay" ? "waiting" : (STEP_WORD[place.step_type] ?? place.step_type).toLowerCase()) : "next step";
  const where = `Step ${place.position} of ${place.of} · ${step}`;
  if (place.hold === "handover") return "Waits for LinkedIn to hand over";
  if (place.hold === "other_campaign") return `${where} · held`;
  return where;
}

export const PROSPECT_SORT_OPTIONS: Array<{ value: ProspectSort; label: string }> = [
  { value: "status", label: "Needs attention first" }, { value: "name", label: "Name" }, { value: "enrolled", label: "Enrolled" }, { value: "next", label: "Next step due" },
];
export const defaultSortDirection = (sort: ProspectSort): "asc" | "desc" => (sort === "enrolled" ? "desc" : "asc");

/** What a bulk action did, as the toast says it. */
export function actionOutcome(action: ProspectAction, result: ActionResult): { tone: "success" | "info"; message: string } {
  const people = (count: number) => `${formatCount(count)} ${plural(count, "prospect", "prospects")}`;
  const untouched = result.asked - result.changed;
  if (result.changed === 0) {
    return { tone: "info", message: action === "retry" ? "None of those had a failed step to retry." : action === "unenroll" ? "None of those were still in the sequence." : "None of those could be removed." };
  }
  const rest = untouched > 0
    ? ` ${formatCount(untouched)} ${action === "retry" ? "had nothing failed" : action === "unenroll" ? `${plural(untouched, "was", "were")} already out of the sequence` : "could not be removed"}.`
    : "";
  if (action === "retry") return { tone: "success", message: `${people(result.changed)} back in line.${result.waiting ? " The campaign is not running, so they wait until it is." : ""}${rest}` };
  if (action === "unenroll") return { tone: "success", message: `${people(result.changed)} unenrolled.${rest}` };
  return { tone: "success", message: `${people(result.changed)} removed from the campaign.${rest}` };
}

export interface AddResult { run_id: string; asked: number; enrolled: number; already_enrolled: number; excluded: number; in_another_campaign: number }

export function addOutcome(result: AddResult): { tone: "success" | "info"; message: string } {
  const parts: string[] = [];
  if (result.already_enrolled > 0) parts.push(`${formatCount(result.already_enrolled)} already in this campaign`);
  if (result.excluded > 0) parts.push(`${formatCount(result.excluded)} left out as customers or open deals`);
  if (result.in_another_campaign > 0) parts.push(`${formatCount(result.in_another_campaign)} part-way through another campaign`);
  const rest = parts.length > 0 ? ` Not added: ${parts.join("; ")}.` : "";
  if (result.enrolled === 0) return { tone: "info", message: `Nobody was added.${rest}` };
  return { tone: "success", message: `${formatCount(result.enrolled)} ${plural(result.enrolled, "contact", "contacts")} enrolled. They start at the first step.${rest}` };
}

// ── Settings ──────────────────────────────────────────────────────────────────

/** What changing a run's LinkedIn accounts did to the contacts in it. */
export function poolOutcome(pool: PoolChange): string {
  const parts = [`${formatCount(pool.reassigned)} ${plural(pool.reassigned, "contact", "contacts")} not yet started ${plural(pool.reassigned, "was", "were")} shared out again`];
  if (pool.finishing_elsewhere > 0) parts.push(`${formatCount(pool.finishing_elsewhere)} already started ${plural(pool.finishing_elsewhere, "finishes", "finish")} on the account that started them`);
  return `${parts.join("; ")}.`;
}

/** The sentence under the delete button: what would go with the campaign. */
export function deleteWarning(settings: Pick<CampaignSettings, "enrolled" | "run">): string {
  if (settings.enrolled === 0) return "This campaign has enrolled nobody. Deleting it removes its sequence and settings.";
  const running = settings.run ? ` ${formatCount(settings.run.in_flight)} ${plural(settings.run.in_flight, "is", "are")} part-way through and would stop.` : "";
  return `Deleting it removes its sequence, its settings and the record of ${formatCount(settings.enrolled)} ${plural(settings.enrolled, "enrolment", "enrolments")}.${running} Messages already sent stay in each contact's history. This cannot be undone.`;
}

/** The fields of the settings form that are sent back, to tell what has been changed. */
export interface SettingsForm {
  name: string;
  description: string;
  owner_id: string;
  send_in_recipient_tz: boolean;
  ab_auto_promote: boolean;
  exclude: { customers: boolean; open_deals: boolean };
  account_ids: string[];
  rotation: "round_robin" | "capacity";
  email_account_ids: string[];
  tracking: Array<{ step_id: string; opens: boolean; clicks: boolean }>;
}

export const NO_OWNER = "none";

export function formFrom(settings: CampaignSettings): SettingsForm {
  return {
    name: settings.name, description: settings.description ?? "", owner_id: settings.owner_id ?? NO_OWNER,
    send_in_recipient_tz: settings.send_in_recipient_tz, ab_auto_promote: settings.ab_auto_promote,
    exclude: { ...settings.setup.exclude }, account_ids: [...settings.setup.account_ids], rotation: settings.setup.rotation, email_account_ids: [...settings.setup.email_account_ids],
    tracking: settings.tracking.map((step) => ({ step_id: step.step_id, opens: step.opens, clicks: step.clicks })),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only what differs from what is stored, in the shape the route takes. Null when nothing does. */
export function changeFrom(form: SettingsForm, stored: SettingsForm): Record<string, unknown> | null {
  const change: Record<string, unknown> = {};
  if (form.name.trim() !== stored.name) change.name = form.name.trim();
  if (form.description.trim() !== stored.description) change.description = form.description.trim();
  if (form.owner_id !== stored.owner_id) change.owner_id = form.owner_id === NO_OWNER ? null : form.owner_id;
  if (form.send_in_recipient_tz !== stored.send_in_recipient_tz) change.send_in_recipient_tz = form.send_in_recipient_tz;
  if (form.ab_auto_promote !== stored.ab_auto_promote) change.ab_auto_promote = form.ab_auto_promote;
  const setup: Record<string, unknown> = {};
  if (!same(form.exclude, stored.exclude)) setup.exclude = form.exclude;
  if (!same(form.account_ids, stored.account_ids)) setup.account_ids = form.account_ids;
  if (form.rotation !== stored.rotation) setup.rotation = form.rotation;
  if (!same(form.email_account_ids, stored.email_account_ids)) setup.email_account_ids = form.email_account_ids;
  if (Object.keys(setup).length > 0) change.setup = setup;
  const tracking = form.tracking.filter((step) => !same(step, stored.tracking.find((other) => other.step_id === step.step_id)));
  if (tracking.length > 0) change.tracking = tracking;
  return Object.keys(change).length > 0 ? change : null;
}

/** Whether a change alters how the campaign sends, which a member may not do while contacts are part-way through. */
export const changesSending = (change: Record<string, unknown> | null) => Boolean(change && ["send_in_recipient_tz", "ab_auto_promote", "setup", "tracking"].some((key) => key in change));

/** Why the form cannot be saved as it stands, or null. */
export function formProblem(form: SettingsForm, settings: Pick<CampaignSettings, "channels" | "run">): string | null {
  if (!form.name.trim()) return "A campaign needs a name.";
  if (settings.run && settings.channels.includes("linkedin") && form.account_ids.length === 0) return "A running campaign with LinkedIn steps needs at least one LinkedIn account.";
  return null;
}
