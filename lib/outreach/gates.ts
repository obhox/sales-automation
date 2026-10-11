import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { loadTargetCustomValues } from "@/lib/outreach/custom-values";
import { gateOnStep, type Effect, type GateKind, type Outcome, type StoredGate } from "@/lib/outreach/publish";
import { renderOutreachTemplate, type OutreachTemplateTarget } from "@/lib/outreach/render";
import { seededPick, seededUnit } from "@/lib/outreach/seed";
import { createAutomaticTask } from "@/lib/pipeline/auto";

type DB = DatabaseType.Database;

// What the runner does with a gate, apart from moving the contact (which is the runner's
// own business): remembering which side a contact came out on, carrying out an outcome's
// side effects, and starting an email track that was waiting for a hand-over.

/** Where a contact is when a gate is settled. */
export interface GatePlace {
  runId: string;
  workflowId: string;
  targetId: string;
  runProfileId: string;
}

/**
 * Note which side of a gate a contact came out on. The first answer stands: a step that
 * is retried, or a contact who reaches the same gate again, does not move the counts and
 * does not repeat the side effects. Returns true when the answer was recorded.
 *
 * `overrule` is for the one answer that can change: a contact who passed a "no reply yet"
 * gate and then replied. Their "no" replaces the earlier "yes" (once), so the gate's two
 * counts say how things stand, and the reply's side effects still happen.
 */
export function recordGateOutcome(db: DB, place: GatePlace, gate: Pick<StoredGate, "id" | "source_step_id" | "kind">, side: boolean, outcome: Outcome, opts: { overrule?: boolean } = {}): boolean {
  const workspace = db.prepare("SELECT workspace_id FROM runs WHERE id = ?").get(place.runId) as { workspace_id: string | null } | undefined;
  if (!workspace?.workspace_id) return false;
  const onConflict = opts.overrule
    ? "ON CONFLICT(run_id, target_id, step_id, kind) DO UPDATE SET side = excluded.side, outcome = excluded.outcome, created_at = datetime('now') WHERE step_outcomes.side != excluded.side"
    : "ON CONFLICT(run_id, target_id, step_id, kind) DO NOTHING";
  return db.prepare(
    `INSERT INTO step_outcomes (id, workspace_id, workflow_id, run_id, target_id, step_id, branch_id, kind, side, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${onConflict}`,
  ).run(randomUUID(), workspace.workspace_id, place.workflowId, place.runId, place.targetId, gate.source_step_id, gate.id, gate.kind, side ? "true" : "false", outcome.then).changes > 0;
}

/** Carry out an outcome's side effects for one contact. Anything that no longer exists (a deleted list) is passed over. */
export function runEffects(db: DB, targetId: string, effects: Effect[] | undefined): void {
  if (!effects?.length) return;
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(targetId) as (OutreachTemplateTarget & { id: string; workspace_id: string | null }) | undefined;
  if (!target?.workspace_id) return;
  for (const effect of effects) {
    if (effect.type === "add_to_list") {
      if (db.prepare("SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?").get(effect.list_id, target.workspace_id)) {
        db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)").run(effect.list_id, targetId);
      }
    } else if (effect.type === "create_task") {
      // The title may use the same tags a message does ("Call {{first_name}}").
      const values = loadTargetCustomValues(db, target.workspace_id, targetId);
      const title = renderOutreachTemplate(effect.title, target, values, { seed: `task:${targetId}` }).trim() || effect.title;
      const due = effect.due_in_days != null && effect.due_in_days >= 0 ? new Date(Date.now() + effect.due_in_days * 86_400_000).toISOString().slice(0, 10) : null;
      createAutomaticTask(db, { workspaceId: target.workspace_id, targetId, title: title.slice(0, 300), description: effect.description ?? null, dueDate: due });
    }
  }
}

/** Start the email track of a contact who was waiting to be handed over. Returns whether there was one to start. */
export function releaseEmailTrack(db: DB, runProfileId: string): boolean {
  return db.prepare("UPDATE run_profile_tracks SET hold = NULL WHERE run_profile_id = ? AND track = 'email' AND hold = 'handover' AND state = 'pending'").run(runProfileId).changes > 0;
}

/**
 * End the email tracks that are still waiting for a hand-over that can no longer come:
 * the contact's LinkedIn track has finished, one way or another, without handing them
 * over. Left alone, such a track would wait for ever and its campaign would never finish.
 */
export function endUnreachableHandovers(db: DB, runIds: string[]): number {
  if (runIds.length === 0) return 0;
  return db.prepare(
    `UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Not handed over to email', hold = NULL
     WHERE track = 'email' AND state = 'pending' AND hold = 'handover'
       AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id IN (${runIds.map(() => "?").join(",")}))
       AND NOT EXISTS (
         SELECT 1 FROM run_profile_tracks li WHERE li.run_profile_id = run_profile_tracks.run_profile_id
           AND li.track = 'linkedin' AND li.state IN ('pending', 'in_progress'))`,
  ).run(...runIds).changes;
}

/**
 * The gate of one kind that speaks for a contact standing at `index`: the nearest one on
 * a step at or before that position, or failing that (when `orAfter`) the first one after.
 */
export function nearestGate(db: DB, steps: ReadonlyArray<{ id: string }>, index: number, kind: GateKind, orAfter = false): StoredGate | null {
  for (let i = Math.min(index, steps.length - 1); i >= 0; i--) {
    const gate = gateOnStep(db, steps[i].id);
    if (gate?.kind === kind) return gate;
  }
  if (orAfter) {
    for (let i = Math.max(0, index + 1); i < steps.length; i++) {
      const gate = gateOnStep(db, steps[i].id);
      if (gate?.kind === kind) return gate;
    }
  }
  return null;
}

// ── A step's own window ───────────────────────────────────────────────────────

export interface Schedule {
  active_hours_start: number;
  active_hours_end: number;
  timezone: string;
  working_days: string;
}

export interface StepWindow {
  window_start?: number | null;
  window_end?: number | null;
  window_days?: string | null;
}

/**
 * The hours and days a step may run in: its own window, inside its sender's schedule.
 * Returns the sender's schedule unchanged when the step has no window. Returns null when
 * the two never overlap, so the caller can say so rather than hold the contact for ever.
 */
export function withStepWindow<T extends Schedule>(schedule: T, step: StepWindow): T | null {
  const hasHours = step.window_start != null && step.window_end != null;
  const hasDays = Boolean(step.window_days);
  if (!hasHours && !hasDays) return schedule;
  const start = hasHours ? Math.max(schedule.active_hours_start ?? 9, step.window_start as number) : schedule.active_hours_start;
  const end = hasHours ? Math.min(schedule.active_hours_end ?? 18, step.window_end as number) : schedule.active_hours_end;
  const senderDays = (schedule.working_days || "1,2,3,4,5").split(",").map((day) => day.trim());
  const days = hasDays ? senderDays.filter((day) => String(step.window_days).split(",").map((own) => own.trim()).includes(day)) : senderDays;
  if (start >= end || days.length === 0) return null;
  return { ...schedule, active_hours_start: start, active_hours_end: end, working_days: days.join(",") };
}

// ── Choosing between versions ─────────────────────────────────────────────────

/**
 * One of `items`, always the same one for the same seed, in proportion to `weights`.
 *
 * When every version has the same weight, or none has one, this is exactly seededPick:
 * a campaign that never set a weight keeps sending each contact the version it always
 * would have. A version with no weight among versions that have one takes the average
 * of the weights that were given.
 */
export function seededWeightedPick<T>(seed: string, items: readonly T[], weights: ReadonlyArray<number | null | undefined>): T {
  const given = weights.filter((weight): weight is number => typeof weight === "number" && weight > 0);
  if (given.length === 0 || (given.length === items.length && given.every((weight) => weight === given[0]))) return seededPick(seed, items);
  const average = given.reduce((sum, weight) => sum + weight, 0) / given.length;
  const filled = items.map((_, index) => (typeof weights[index] === "number" && (weights[index] as number) > 0 ? (weights[index] as number) : average));
  const total = filled.reduce((sum, weight) => sum + weight, 0);
  let mark = seededUnit(seed) * total;
  for (let index = 0; index < items.length; index++) {
    mark -= filled[index];
    if (mark < 0) return items[index];
  }
  return items[items.length - 1];
}
