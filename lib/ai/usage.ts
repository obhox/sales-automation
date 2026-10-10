// What AI requests have cost a workspace, and the monthly budget that pauses AI writing
// when it is used up.
//
// Every request that reaches OpenRouter is recorded in agent_sessions with what it was
// for. The budget is counted from those rows, over a calendar month in UTC.
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { emitDomainEvent } from "@/lib/platform/events";
import { notify } from "@/lib/platform/notifications";

export const PURPOSES = ["email_opener", "email_followup", "linkedin_message", "inmail", "classification", "test", "other"] as const;
/** What a request was for. "other" is a request recorded before purposes were, whose step has since been removed. */
export type Purpose = (typeof PURPOSES)[number];

export interface UsageRecord {
  workspaceId: string | null;
  purpose: Exclude<Purpose, "other">;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** What OpenRouter charged, in US dollars. Null when it did not say. */
  costUsd: number | null;
  usedFallback?: boolean;
  runId?: string | null;
  targetId?: string | null;
  stepId?: string | null;
  prompt?: string | null;
  generatedText?: string | null;
}

/** Record one request. If it took the month's spend to the budget, the workspace is told. */
export function recordAiUsage(record: UsageRecord): void {
  getDb().prepare(
    `INSERT INTO agent_sessions (id, workspace_id, run_id, target_id, step_id, model, input_tokens, output_tokens, cost_usd, prompt, generated_text, purpose, used_fallback)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), record.workspaceId, record.runId ?? null, record.targetId ?? null, record.stepId ?? null, record.model,
    record.inputTokens, record.outputTokens, record.costUsd, record.prompt ?? null, record.generatedText ?? null, record.purpose, record.usedFallback ? 1 : 0,
  );
  if (record.workspaceId) raiseBudgetAlertIfReached(record.workspaceId);
}

// ── The month ─────────────────────────────────────────────────────────────────

const pad = (value: number) => String(value).padStart(2, "0");
/** SQLite's own timestamp format, in UTC, which is how agent_sessions.created_at is stored. */
const sqlTime = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
const firstOfMonth = (date: Date, offset = 0) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));

function spendBetween(workspaceId: string, from: Date, until: Date): { cost: number; count: number } {
  const row = getDb().prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS count FROM agent_sessions WHERE workspace_id = ? AND created_at >= ? AND created_at < ?",
  ).get(workspaceId, sqlTime(from), sqlTime(until)) as { cost: number; count: number };
  return row;
}

// ── The budget ────────────────────────────────────────────────────────────────

export interface BudgetState {
  /** US dollars a month, or null when no budget is set. */
  budget_usd: number | null;
  /** Spent so far this calendar month (UTC). */
  spent_usd: number;
  /** True when a budget is set and this month's spend has reached it: AI writing is paused. */
  reached: boolean;
  /** "2026-10" */
  month: string;
  /** The first day of next month, when the count starts again: "2026-11-01". */
  resets_on: string;
}

export function budgetState(workspaceId: string, now: Date = new Date()): BudgetState {
  const row = getDb().prepare("SELECT monthly_budget_usd FROM workspace_ai_config WHERE workspace_id = ?").get(workspaceId) as { monthly_budget_usd: number | null } | undefined;
  const budget = typeof row?.monthly_budget_usd === "number" && row.monthly_budget_usd > 0 ? row.monthly_budget_usd : null;
  const start = firstOfMonth(now);
  const next = firstOfMonth(now, 1);
  const spent = spendBetween(workspaceId, start, next).cost;
  return {
    budget_usd: budget,
    spent_usd: spent,
    // Costs are fractions of a cent; allow for the rounding of adding many of them.
    reached: budget !== null && spent >= budget - 1e-9,
    month: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}`,
    resets_on: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`,
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dollars = (amount: number) => `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** AI writing was asked for after the month's budget was used up. The step it was for should wait, not fail. */
export class AiBudgetReachedError extends Error {
  readonly budgetUsd: number;
  readonly resetsOn: string;

  constructor(state: BudgetState) {
    super(`This month's AI budget of ${dollars(state.budget_usd ?? 0)} is used up. AI writing is paused until the budget is raised or ${state.resets_on}.`);
    this.name = "AiBudgetReachedError";
    this.budgetUsd = state.budget_usd ?? 0;
    this.resetsOn = state.resets_on;
  }
}

/**
 * Tell the workspace, once, that this month's budget has been reached. Once per month and
 * per budget amount: raising the budget and reaching the new one is told again.
 * Returns whether the budget is reached.
 */
export function raiseBudgetAlertIfReached(workspaceId: string, now: Date = new Date()): boolean {
  const state = budgetState(workspaceId, now);
  if (!state.reached || state.budget_usd === null) return false;
  const month = MONTHS[Number(state.month.slice(5)) - 1];
  const raised = notify({
    workspaceId, kind: "ai.budget_reached", tone: "warn", link: "/ai",
    title: `The AI budget for ${month} is used up`,
    body: `${dollars(state.spent_usd)} of ${dollars(state.budget_usd)} spent. Steps written by AI wait until the budget is raised or ${state.resets_on}. Everything else carries on.`,
    dedupeKey: `ai-budget:${state.month}:${state.budget_usd}`,
  });
  // The event goes out with the notification, so a webhook hears of it once as well.
  if (raised) {
    emitDomainEvent({
      workspaceId, type: "ai.budget_reached", entityType: "workspace", entityId: workspaceId,
      payload: { month: state.month, budget_usd: state.budget_usd, spent_usd: Number(state.spent_usd.toFixed(4)), resets_on: state.resets_on },
    });
  }
  return true;
}

/** Throws AiBudgetReachedError when the workspace has a budget and this month's spend has reached it. */
export function assertWithinBudget(workspaceId: string, now: Date = new Date()): void {
  const state = budgetState(workspaceId, now);
  if (!state.reached) return;
  raiseBudgetAlertIfReached(workspaceId, now);
  throw new AiBudgetReachedError(state);
}

// ── What the screen shows ─────────────────────────────────────────────────────

export interface UsageOverview {
  month: {
    /** "2026-10" */
    key: string;
    spent_usd: number;
    requests: number;
    /** Spend over the same number of days at the start of last month. Null when there was none. */
    previous_usd: number | null;
  };
  /** The last 14 days, oldest first. Days are UTC. */
  daily: Array<{ day: string; cost_usd: number; requests: number }>;
  budget: BudgetState;
  /** This month, largest first. */
  by_purpose: Array<{ purpose: Purpose; cost_usd: number; requests: number }>;
  by_model: Array<{ model: string; cost_usd: number; requests: number }>;
  /** Requests this month that the fallback model answered. */
  fallback_requests: number;
  /** When a request was last made, in SQLite's UTC format. */
  last_used_at: string | null;
}

const DAILY_DAYS = 14;

// Rows from before `purpose` existed are told apart by their step. One with no step was a
// preview; one whose step has since been removed cannot be placed.
const PURPOSE_SQL = `COALESCE(a.purpose, CASE
  WHEN a.step_id IS NULL THEN 'test'
  WHEN s.step_type = 'email' THEN CASE WHEN COALESCE(s.email_position, 1) > 1 THEN 'email_followup' ELSE 'email_opener' END
  WHEN s.step_type = 'message' THEN 'linkedin_message'
  WHEN s.step_type = 'sales_inmail' THEN 'inmail'
  ELSE 'other' END)`;

export function usageOverview(workspaceId: string, now: Date = new Date()): UsageOverview {
  const db = getDb();
  const start = firstOfMonth(now);
  const next = firstOfMonth(now, 1);
  const thisMonth = spendBetween(workspaceId, start, next);
  const elapsedMs = now.getTime() - start.getTime();
  const previousStart = firstOfMonth(now, -1);
  // Never past the end of last month, which may be shorter than this one.
  const previousEnd = new Date(Math.min(previousStart.getTime() + elapsedMs, start.getTime()));
  const previous = spendBetween(workspaceId, previousStart, previousEnd);

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const firstDay = new Date(today.getTime() - (DAILY_DAYS - 1) * 86_400_000);
  const dayRows = db.prepare(
    `SELECT date(created_at) AS day, COALESCE(SUM(cost_usd), 0) AS cost_usd, COUNT(*) AS requests FROM agent_sessions
     WHERE workspace_id = ? AND created_at >= ? GROUP BY date(created_at)`,
  ).all(workspaceId, sqlTime(firstDay)) as Array<{ day: string; cost_usd: number; requests: number }>;
  const byDay = new Map(dayRows.map((row) => [row.day, row]));
  const daily = Array.from({ length: DAILY_DAYS }, (_, index) => {
    const day = new Date(firstDay.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, cost_usd: 0, requests: 0 };
  });

  const window = [workspaceId, sqlTime(start), sqlTime(next)];
  const byPurpose = db.prepare(
    `SELECT ${PURPOSE_SQL} AS purpose, COALESCE(SUM(a.cost_usd), 0) AS cost_usd, COUNT(*) AS requests
     FROM agent_sessions a LEFT JOIN workflow_steps s ON s.id = a.step_id
     WHERE a.workspace_id = ? AND a.created_at >= ? AND a.created_at < ?
     GROUP BY 1 ORDER BY cost_usd DESC, requests DESC`,
  ).all(...window) as UsageOverview["by_purpose"];
  const byModel = db.prepare(
    `SELECT COALESCE(NULLIF(model, ''), 'unknown') AS model, COALESCE(SUM(cost_usd), 0) AS cost_usd, COUNT(*) AS requests
     FROM agent_sessions WHERE workspace_id = ? AND created_at >= ? AND created_at < ?
     GROUP BY 1 ORDER BY cost_usd DESC, requests DESC`,
  ).all(...window) as UsageOverview["by_model"];
  const fallback = db.prepare(
    "SELECT COUNT(*) AS c FROM agent_sessions WHERE workspace_id = ? AND created_at >= ? AND created_at < ? AND used_fallback = 1",
  ).get(...window) as { c: number };
  const last = db.prepare("SELECT MAX(created_at) AS at FROM agent_sessions WHERE workspace_id = ?").get(workspaceId) as { at: string | null };

  return {
    month: { key: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}`, spent_usd: thisMonth.cost, requests: thisMonth.count, previous_usd: previous.cost > 0 ? previous.cost : null },
    daily,
    budget: budgetState(workspaceId, now),
    by_purpose: byPurpose,
    by_model: byModel,
    fallback_requests: fallback.c,
    last_used_at: last.at,
  };
}
