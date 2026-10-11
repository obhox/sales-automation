// What the Signals screen says, worked out from what the routes return. No React here,
// so the wording can be tested on its own.
import { formatCount, formatRelative, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS, type SignalType } from "@/lib/platform/signal-types";
import type { DetectionEstimate, DetectionKind, DetectionRun, WatchedAccount } from "@/lib/signals/detection";
import type { SignalFeed, SignalRow } from "@/lib/signals/feed";
import type { DetectionOverview } from "@/pages/api/platform/signal-detection";

export type { DetectionEstimate, DetectionKind, DetectionOverview, DetectionRun, SignalFeed, SignalRow, SignalType, WatchedAccount };
export { SIGNAL_TYPES, SIGNAL_TYPE_LABELS };

export const SIGNALS_PATH = "/api/platform/signals";
export const RULES_PATH = "/api/platform/signal-rules";
export const DETECTION_PATH = "/api/platform/signal-detection";
export const PAGE_SIZE = 50;

export type SignalsTab = "feed" | "rules" | "detection";
export const isTab = (value: unknown): value is SignalsTab => value === "feed" || value === "rules" || value === "detection";

// ── The feed ─────────────────────────────────────────────────────────

export const TYPE_TONE: Record<string, Tone> = { job_change: "li", funding: "good", hiring: "brand", technology: "mail", product_intent: "warn", custom: "neutral" };

export const typeLabel = (type: string): string => SIGNAL_TYPE_LABELS[type as SignalType] ?? type;

const SOURCE_LABELS: Record<string, string> = { manual: "Recorded by hand", apollo: "Apollo detection", api: "API", public_api: "API", mcp: "MCP", import: "Import" };
/** Where a signal came from, in words. A source nobody has named is shown as it is. */
export const sourceLabel = (source: string | null): string => (source ? SOURCE_LABELS[source] ?? source : "Unknown");

/** The kinds to offer in the filter, each with how many signals it has under the other filters. Kinds with none are left out, apart from the one chosen. */
export function typeOptions(feed: Pick<SignalFeed, "by_type">, chosen: string): Array<{ value: string; label: string }> {
  const total = Object.values(feed.by_type).reduce((sum, count) => sum + count, 0);
  return [
    { value: "all", label: `All kinds · ${formatCount(total)}` },
    ...SIGNAL_TYPES.filter((type) => (feed.by_type[type] ?? 0) > 0 || type === chosen).map((type) => ({ value: type, label: `${SIGNAL_TYPE_LABELS[type]} · ${formatCount(feed.by_type[type] ?? 0)}` })),
  ];
}

/** "3 new · 128 in all". */
export function feedSummary(feed: Pick<SignalFeed, "new_count" | "all_count">): string {
  if (feed.all_count === 0) return "No signals yet";
  return `${feed.new_count > 0 ? `${formatCount(feed.new_count)} new · ` : ""}${formatCount(feed.all_count)} in all`;
}

/** Who a signal is about, in the order they are named. */
export function aboutLine(signal: Pick<SignalRow, "contact" | "company">): string {
  if (signal.contact && signal.company) return `${signal.contact.name} · ${signal.company.name}`;
  return signal.contact?.name ?? signal.company?.name ?? "Nobody named";
}

export function pageLine(feed: Pick<SignalFeed, "total">, offset: number, shown: number): string {
  if (feed.total === 0) return "";
  return `${formatCount(offset + 1)} to ${formatCount(offset + shown)} of ${formatCount(feed.total)}`;
}

// ── Recording one by hand ────────────────────────────────────────────

export interface SignalForm {
  type: SignalType;
  title: string;
  description: string;
  score: string;
  about: { kind: "contact" | "company"; id: string; name: string } | null;
}

export const blankSignal = (): SignalForm => ({ type: "job_change", title: "", description: "", score: "50", about: null });

export function signalProblem(form: SignalForm): { field: "title" | "score" | "about"; message: string } | null {
  if (!form.title.trim()) return { field: "title", message: "Say what happened." };
  const score = Number(form.score);
  if (form.score.trim() === "" || !Number.isFinite(score) || score < 0 || score > 100) return { field: "score", message: "A score is a number from 0 to 100." };
  if (!form.about) return { field: "about", message: "Choose the contact or company it is about." };
  return null;
}

export function signalPayload(form: SignalForm): Record<string, unknown> {
  return {
    type: form.type, title: form.title.trim(), description: form.description.trim() || undefined, score: Number(form.score), source: "manual",
    ...(form.about?.kind === "contact" ? { target_id: form.about.id } : form.about ? { company_id: form.about.id } : {}),
  };
}

/** What recording a signal does, for the dialog: rules act on a contact's signals only. */
export function aboutHint(form: Pick<SignalForm, "about">): string {
  if (form.about?.kind === "company") return "It is filed on the company. Rules act on signals about a contact, so none will fire on this one.";
  return "It raises the contact's intent score and sets off any rule it matches.";
}

// ── Rules ────────────────────────────────────────────────────────────

export interface Rule {
  id: string;
  name: string;
  signal_type: string;
  min_score: number;
  list_id: string | null;
  workflow_id: string | null;
  account_id: string | null;
  email_account_id: string | null;
  enabled: number;
  auto_start: number;
  list_name: string | null;
  workflow_name: string | null;
  account_name: string | null;
  email_account_name: string | null;
  /** Why the rule would do nothing as it stands. Null when it is fine. */
  problem: string | null;
}

/** "Funding scoring 50 or more", "Any hiring signal". */
export function ruleWhen(rule: Pick<Rule, "signal_type" | "min_score">): string {
  const kind = typeLabel(rule.signal_type).toLowerCase();
  return rule.min_score > 0 ? `A ${kind} signal scoring ${formatCount(rule.min_score)} or more` : `Any ${kind} signal`;
}

/** What the rule does with the contact, in one line. */
export function ruleThen(rule: Pick<Rule, "list_id" | "workflow_id" | "list_name" | "workflow_name" | "account_name" | "email_account_name" | "auto_start">): string {
  const parts: string[] = [];
  if (rule.list_id) parts.push(`Add to ${rule.list_name ?? "a list since deleted"}`);
  if (rule.workflow_id) {
    const from = [rule.account_name, rule.email_account_name].filter(Boolean).join(" and ");
    parts.push(`enrol in ${rule.workflow_name ?? "a campaign since deleted"}${from ? ` from ${from}` : ""}`);
  }
  if (parts.length === 0) return "Nothing";
  const line = parts.join(", then ");
  const first = line.charAt(0).toUpperCase() + line.slice(1);
  return rule.workflow_id ? `${first} · ${rule.auto_start ? "starts by itself" : "waits to be started"}` : first;
}

export function ruleState(rule: Pick<Rule, "enabled" | "problem">): { label: string; tone: Tone } {
  if (!rule.enabled) return { label: "Off", tone: "neutral" };
  return rule.problem ? { label: "Cannot run", tone: "bad" } : { label: "On", tone: "good" };
}

export function rulesSummary(rules: Rule[]): string {
  if (rules.length === 0) return "No rules yet";
  const on = rules.filter((rule) => rule.enabled && !rule.problem).length;
  return `${on} of ${rules.length} ${plural(rules.length, "rule", "rules")} on`;
}

export interface RuleForm {
  name: string;
  signal_type: SignalType;
  min_score: string;
  list_id: string;
  workflow_id: string;
  account_id: string;
  email_account_id: string;
  auto_start: boolean;
}

export const blankRule = (): RuleForm => ({ name: "", signal_type: "funding", min_score: "0", list_id: "", workflow_id: "", account_id: "", email_account_id: "", auto_start: false });
export const ruleFormOf = (rule: Rule): RuleForm => ({
  name: rule.name, signal_type: (SIGNAL_TYPES as readonly string[]).includes(rule.signal_type) ? (rule.signal_type as SignalType) : "custom", min_score: String(rule.min_score ?? 0),
  list_id: rule.list_id ?? "", workflow_id: rule.workflow_id ?? "", account_id: rule.account_id ?? "", email_account_id: rule.email_account_id ?? "", auto_start: Boolean(rule.auto_start),
});

/** What can be told is wrong before the server is asked. The server knows the rest (which senders the campaign needs). */
export function ruleProblem(form: RuleForm): { field: "name" | "min_score" | "list_id"; message: string } | null {
  if (!form.name.trim()) return { field: "name", message: "Give the rule a name." };
  const score = Number(form.min_score);
  if (form.min_score.trim() === "" || !Number.isFinite(score) || score < 0 || score > 100) return { field: "min_score", message: "The least score is a number from 0 to 100." };
  if (!form.list_id && !form.workflow_id) return { field: "list_id", message: "Pick a list, a campaign, or both. A rule with neither does nothing." };
  if (form.workflow_id && !form.list_id) return { field: "list_id", message: "A rule that enrols contacts needs a list as well: the campaign runs on that list." };
  return null;
}

/** What is sent. An empty choice clears the link, which is how a rule stops naming something. */
export function rulePayload(form: RuleForm): Record<string, unknown> {
  return {
    name: form.name.trim(), signal_type: form.signal_type, min_score: Number(form.min_score),
    list_id: form.list_id || null, workflow_id: form.workflow_id || null,
    account_id: form.workflow_id ? form.account_id || null : null, email_account_id: form.workflow_id ? form.email_account_id || null : null,
    auto_start: form.workflow_id ? form.auto_start : false,
  };
}

// ── Detection ────────────────────────────────────────────────────────

export const KIND_LABEL: Record<DetectionKind, { label: string; detail: string }> = {
  funding: { label: "Funding", detail: "A new round since the last check" },
  hiring: { label: "Hiring", detail: "More open roles, or a growing headcount. Costs one more credit an account" },
  technology: { label: "Technology", detail: "Tools the company did not use at the last check" },
};

export const INTERVAL_LABEL: Record<number, string> = { 1: "Every day", 7: "Every week", 14: "Every two weeks", 30: "Every month" };

const credits = (count: number) => `${formatCount(count)} ${plural(count, "credit", "credits")}`;

/** What detection would cost as it is set, in sentences. Said before anything is spent. */
export function costLines(estimate: DetectionEstimate, intervalDays: number): string[] {
  if (estimate.accounts === 0) return ["No accounts are watched yet, so a run would ask nothing and cost nothing."];
  const lines: string[] = [];
  const skipped = estimate.accounts - estimate.checkable;
  lines.push(
    `A run looks up ${formatCount(estimate.checkable)} ${plural(estimate.checkable, "account", "accounts")} at ${credits(estimate.credits_per_account)} each: up to ${credits(estimate.credits_per_run)}.` +
    (skipped > 0 ? ` ${formatCount(skipped)} ${plural(skipped, "has", "have")} no website and ${plural(skipped, "is", "are")} skipped.` : ""),
  );
  lines.push(`${INTERVAL_LABEL[intervalDays] ?? `Every ${intervalDays} days`}, that is up to ${credits(estimate.credits_per_month)} a month.`);
  if (estimate.cap <= 0) lines.push("No monthly cap is set. Detection stays off until one is.");
  else if (!estimate.fits) lines.push(`That is more than the cap of ${credits(estimate.cap)}: a run stops when the cap is reached, and the accounts it did not reach are checked first next time.`);
  else lines.push(`That is within the cap of ${credits(estimate.cap)} a month.`);
  return lines;
}

/**
 * The estimate as it would be with settings not yet saved, so the cost on screen follows
 * the form. The same sums as the server's estimate() (a test holds the two together).
 */
export function previewEstimate(base: DetectionEstimate, kinds: readonly DetectionKind[], intervalDays: number, cap: number): DetectionEstimate {
  const perAccount = kinds.length === 0 ? 0 : 1 + (kinds.includes("hiring") ? 1 : 0);
  const perRun = base.checkable * perAccount;
  const runs = Math.max(1, Math.ceil(30 / Math.max(1, intervalDays)));
  return {
    ...base, credits_per_account: perAccount, credits_per_run: perRun, runs_per_month: runs, credits_per_month: perRun * runs,
    cap, remaining: Math.max(0, cap - base.spent_this_month), fits: cap > 0 && perRun * runs <= cap,
  };
}

/** "42 of 300 credits used this month". */
export function spentLine(estimate: Pick<DetectionEstimate, "cap" | "spent_this_month">): string {
  if (estimate.cap <= 0) return estimate.spent_this_month > 0 ? `${credits(estimate.spent_this_month)} used this month` : "Nothing spent this month";
  return `${formatCount(estimate.spent_this_month)} of ${credits(estimate.cap)} used this month`;
}

/** What "Run now" will ask for confirmation of: the most this one run can spend. */
export function runCost(estimate: Pick<DetectionEstimate, "credits_per_run" | "remaining" | "checkable">): { credits: number; partial: boolean } {
  return { credits: Math.min(estimate.credits_per_run, estimate.remaining), partial: estimate.remaining < estimate.credits_per_run };
}

export function detectionState(overview: Pick<DetectionOverview, "config" | "running" | "apollo_connected">): { label: string; tone: Tone } {
  if (overview.running) return { label: "Checking now", tone: "brand" };
  if (!overview.apollo_connected) return { label: "Apollo not connected", tone: "neutral" };
  return overview.config.enabled ? { label: "On", tone: "good" } : { label: "Off", tone: "neutral" };
}

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "brand" },
  done: { label: "Finished", tone: "good" },
  stopped_at_cap: { label: "Stopped at the cap", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
};

/** One line on a run: what it checked, found and spent, or why it failed. */
export function runLine(run: DetectionRun): string {
  if (run.status === "failed") return run.error ?? "It could not be run.";
  const found = run.signals_found === 0 ? "nothing new" : `${formatCount(run.signals_found)} ${plural(run.signals_found, "signal", "signals")}`;
  return `${formatCount(run.accounts_checked)} ${plural(run.accounts_checked, "account", "accounts")} checked · ${found} · ${credits(run.credits_spent)}`;
}

export function accountLine(account: Pick<WatchedAccount, "last_checked_at" | "last_result" | "domain">, now: Date = new Date()): string {
  if (!account.domain) return "No website, so it cannot be looked up";
  if (!account.last_checked_at) return account.last_result ?? "Not checked yet";
  return `${account.last_result ?? "Checked"} · ${formatRelative(account.last_checked_at, now)}`;
}

/** A cap as typed. */
export function readCap(text: string): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { value: null, error: "Enter a whole number of credits." };
  const value = Number(trimmed);
  if (value > 100_000) return { value: null, error: "The most a cap can be is 100,000 credits." };
  return { value, error: null };
}
