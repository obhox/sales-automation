import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import type { ConditionGroup } from "@/lib/platform/conditions";

type DB = DatabaseType.Database;

// The one place a campaign's sequence is written: its steps, its gates, and the draft an
// editor works on before publishing.
//
// Why one place. A contact's position in a campaign is an index into the campaign's
// ordered steps, and what a step has sent is counted against the step's id. Saving used to
// hand ids out by position: delete the first step and every later step took its
// predecessor's id, so the statistics followed the slot and every contact mid-sequence
// landed one step further on than they had been. Each route that wrote steps had its own
// copy of that.

export const STEP_TYPES = ["visit", "connect", "message", "sales_inmail", "delay", "email"] as const;
export type StepType = (typeof STEP_TYPES)[number];
export type Track = "linkedin" | "email";

/** At most this many other versions beside a step's own wording (four in all). */
export const MAX_EMAIL_VARIANTS = 3;

export interface VariantInput {
  id?: string | null;
  subject?: string;
  body?: string;
  /** Share of sends against the other versions. Leave every weight out for equal shares. */
  weight?: number | null;
}

export interface StepInput {
  /** The step's id when it already exists. Omit for a new step. */
  id?: string | null;
  /** A name the editor gives a step that has no id yet, so a gate can point at it. */
  key?: string | null;
  track?: Track;
  step_type: StepType;
  template_id?: string | null;
  template_ids?: string[];
  delay_seconds?: number;
  connect_note?: string | null;
  message_body?: string | null;
  message_position?: number;
  email_subject?: string | null;
  email_body?: string | null;
  email_signature?: string | null;
  email_position?: number;
  email_delivery_mode?: "plain" | "enhanced";
  email_track_opens?: boolean | number;
  email_track_clicks?: boolean | number;
  email_in_thread?: boolean | number;
  email_control_weight?: number | null;
  email_variants?: VariantInput[];
  ai_enabled?: boolean | number;
  ai_model?: string | null;
  ai_prompt?: string | null;
  ai_max_words?: number | null;
  ai_language?: string | null;
  /** Hours (0 to 24) the step may run in, inside its sender's own hours. */
  window_start?: number | null;
  window_end?: number | null;
  /** Days the step may run on, "1,2,3" with 1 = Monday. */
  window_days?: string | null;
}

export const trackOf = (step: Pick<StepInput, "track" | "step_type">): Track => (step.track === "email" || step.step_type === "email" ? "email" : "linkedin");

/** Why these steps cannot be saved, or null when they can. */
export function sequenceProblem(steps: unknown): string | null {
  if (!Array.isArray(steps)) return "steps array is required";
  for (const [index, raw] of steps.entries()) {
    const at = `Step ${index + 1}`;
    if (!raw || typeof raw !== "object") return `${at} is not a step`;
    const step = raw as StepInput;
    if (!(STEP_TYPES as readonly string[]).includes(step.step_type)) return `${at}: step_type must be one of ${STEP_TYPES.join(", ")}`;
    if (step.step_type === "email" && step.track === "linkedin") return `${at}: an email step belongs on the email track`;
    if (step.delay_seconds != null && (!Number.isFinite(step.delay_seconds) || step.delay_seconds < 0)) return `${at}: delay_seconds cannot be negative`;
    const hasStart = step.window_start != null;
    const hasEnd = step.window_end != null;
    if (hasStart !== hasEnd) return `${at}: a sending window needs both a start and an end hour`;
    if (hasStart && hasEnd) {
      const { window_start: start, window_end: end } = step as { window_start: number; window_end: number };
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) return `${at}: the sending window must run from an earlier hour to a later one, between 0 and 24`;
    }
    if (step.window_days != null && step.window_days !== "") {
      const days = String(step.window_days).split(",").map((day) => day.trim());
      if (days.some((day) => !/^[1-7]$/.test(day)) || new Set(days).size !== days.length) return `${at}: window_days must be days from 1 (Monday) to 7 (Sunday), such as 1,2,3,4,5`;
    }
    const weights = [step.email_control_weight, ...(Array.isArray(step.email_variants) ? step.email_variants.map((variant) => variant?.weight) : [])];
    if (weights.some((weight) => weight != null && (!Number.isInteger(weight) || weight < 1 || weight > 100))) return `${at}: a version's weight must be a whole number from 1 to 100`;
  }
  return null;
}

export interface PublishResult {
  /** True when steps were matched by id; false when the request carried none and was matched by position, as saving always was. */
  by_id: boolean;
  created: string[];
  updated: string[];
  deleted: string[];
  /** Every step after the save, in order, with the key the request gave it (if any). */
  steps: Array<{ id: string; track: Track; step_order: number; key: string | null }>;
  /** Contacts part-way through a run of this campaign when it was saved. */
  in_flight: number;
  /** Of those, how many had their place carried to the same step at its new position. */
  moved: number;
  version: number;
}

const STEP_COLUMNS = [
  "step_order", "track", "step_type", "template_id", "delay_seconds", "connect_note", "message_body", "email_subject", "email_body", "email_signature",
  "email_position", "email_delivery_mode", "email_track_opens", "email_track_clicks", "message_position", "ai_enabled", "ai_model", "ai_prompt",
  "ai_max_words", "ai_language", "email_in_thread", "window_start", "window_end", "window_days", "email_control_weight",
] as const;

function stepValues(step: StepInput, track: Track, order: number): unknown[] {
  const mode = step.email_delivery_mode === "enhanced" ? "enhanced" : "plain";
  return [
    order, track, step.step_type, step.template_id ?? null, step.delay_seconds ?? 0, step.connect_note ?? null,
    step.message_body ?? null, step.email_subject ?? null, step.email_body ?? null, step.email_signature ?? null,
    step.email_position ?? 1, mode, mode === "enhanced" && step.email_track_opens ? 1 : 0, mode === "enhanced" && step.email_track_clicks ? 1 : 0,
    step.message_position ?? 1, step.ai_enabled ? 1 : 0, step.ai_model ?? null, step.ai_prompt ?? null, step.ai_max_words ?? null, step.ai_language ?? "English",
    track === "email" && step.email_in_thread ? 1 : 0,
    step.window_start ?? null, step.window_end ?? null, step.window_days ? String(step.window_days) : null, step.email_control_weight ?? null,
  ];
}

/**
 * Replace a campaign's steps with `incoming`, in the order given within each track.
 *
 * When the request names steps by id, a step keeps its id wherever it moves, so its
 * statistics and its gates stay with it, and every contact part-way through a run is put
 * back on the step they were on. A contact whose step was removed goes on to the next
 * step that is left. Nobody is moved backwards onto something they have done: the runner
 * also refuses to repeat a LinkedIn action it has on record for that contact and step.
 *
 * When no step in the request carries an id of this campaign, ids are matched by
 * position within each track, exactly as saving has always worked, and no contact is
 * moved. That is what the old editor and existing API callers send.
 *
 * `byId` forces matching by id even when no step carries one: that is a sequence being
 * replaced outright, where every incoming step is new and none may inherit an old id.
 *
 * Call sequenceProblem() first. Runs in one transaction.
 */
export function publishSequence(db: DB, workflowId: string, incoming: StepInput[], opts: { byId?: boolean } = {}): PublishResult {
  const result: PublishResult = { by_id: false, created: [], updated: [], deleted: [], steps: [], in_flight: 0, moved: 0, version: 0 };

  db.transaction(() => {
    const existing = db.prepare("SELECT id, track FROM workflow_steps WHERE workflow_id = ? ORDER BY track, step_order, rowid").all(workflowId) as Array<{ id: string; track: Track }>;
    const before: Record<Track, string[]> = { linkedin: [], email: [] };
    for (const row of existing) before[row.track].push(row.id);
    const trackOfExisting = new Map(existing.map((row) => [row.id, row.track]));

    const rows: Record<Track, StepInput[]> = { linkedin: [], email: [] };
    for (const step of incoming) rows[trackOf(step)].push(step);
    result.by_id = opts.byId ?? incoming.some((step) => step.id && trackOfExisting.has(step.id));

    // Which id each incoming step takes.
    const taken = new Set<string>();
    const plan: Record<Track, Array<{ id: string; isNew: boolean; step: StepInput }>> = { linkedin: [], email: [] };
    for (const track of ["linkedin", "email"] as const) {
      rows[track].forEach((step, index) => {
        // By id: the step's own, if it is this campaign's, on this track and not claimed twice.
        // By position: the id of whatever sat in this slot before.
        const candidate = result.by_id ? (step.id && trackOfExisting.get(step.id) === track ? step.id : null) : before[track][index] ?? null;
        if (candidate && !taken.has(candidate)) {
          taken.add(candidate);
          plan[track].push({ id: candidate, isNew: false, step });
        } else {
          plan[track].push({ id: randomUUID(), isNew: true, step });
        }
      });
    }

    // Where everyone part-way through is standing, by step id, before anything moves. A
    // contact who has not started yet is not standing anywhere: they begin at the first
    // step, whatever that now is.
    type Standing = { id: string; track: Track; current_step: number };
    const standing = result.by_id
      ? db.prepare(
          `SELECT rt.id, rt.track, rt.current_step FROM run_profile_tracks rt
           JOIN run_profiles rp ON rp.id = rt.run_profile_id JOIN runs r ON r.id = rp.run_id
           WHERE r.workflow_id = ? AND rt.state = 'in_progress'`,
        ).all(workflowId) as Standing[]
      : [];
    result.in_flight = (db.prepare(
      `SELECT COUNT(DISTINCT rp.id) AS c FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id JOIN runs r ON r.id = rp.run_id
       WHERE r.workflow_id = ? AND rt.state = 'in_progress' AND r.status IN ('running', 'paused', 'pending')`,
    ).get(workflowId) as { c: number }).c;

    const update = db.prepare(`UPDATE workflow_steps SET ${STEP_COLUMNS.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`);
    const insert = db.prepare(`INSERT INTO workflow_steps (id, workflow_id, ${STEP_COLUMNS.join(", ")}) VALUES (?, ?, ${STEP_COLUMNS.map(() => "?").join(", ")})`);
    const clearLinks = db.prepare("DELETE FROM workflow_step_templates WHERE step_id = ?");
    const addLink = db.prepare("INSERT OR IGNORE INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)");
    // Versions keep their ids across a save. Sends, opens and clicks are counted per version
    // id, so re-creating them on every save scattered one version's results over as many
    // ids as the campaign had been saved.
    const listVariants = db.prepare("SELECT id FROM workflow_step_email_variants WHERE step_id = ?");
    const addVariant = db.prepare("INSERT INTO workflow_step_email_variants (id, step_id, subject, body, position, weight) VALUES (?, ?, ?, ?, ?, ?)");
    const updateVariant = db.prepare("UPDATE workflow_step_email_variants SET subject = ?, body = ?, position = ?, weight = ? WHERE id = ?");
    const deleteVariant = db.prepare("DELETE FROM workflow_step_email_variants WHERE id = ?");
    // The step's own wording may be paused only while another version is sending in its
    // place. If the edit removed that version, the original sends again.
    const resumeControl = db.prepare(`UPDATE workflow_steps SET email_control_disabled = 0 WHERE id = ? AND email_control_disabled = 1
      AND NOT EXISTS (SELECT 1 FROM workflow_step_email_variants WHERE step_id = ? AND disabled_at IS NULL)`);

    for (const track of ["linkedin", "email"] as const) {
      plan[track].forEach(({ id, isNew, step }, index) => {
        const values = stepValues(step, track, index + 1);
        if (isNew) { insert.run(id, workflowId, ...values); result.created.push(id); }
        else { update.run(...values, id); result.updated.push(id); }
        clearLinks.run(id);
        if (Array.isArray(step.template_ids)) for (const templateId of step.template_ids) addLink.run(id, templateId);

        const stored = new Set((listVariants.all(id) as Array<{ id: string }>).map((row) => row.id));
        const kept = new Set<string>();
        (Array.isArray(step.email_variants) ? step.email_variants.slice(0, MAX_EMAIL_VARIANTS) : []).forEach((variant, position) => {
          // Only an id that belongs to this step is kept; anything else is a new version.
          if (variant.id && stored.has(variant.id) && !kept.has(variant.id)) {
            updateVariant.run(variant.subject ?? "", variant.body ?? "", position, variant.weight ?? null, variant.id);
            kept.add(variant.id);
          } else {
            const variantId = randomUUID();
            addVariant.run(variantId, id, variant.subject ?? "", variant.body ?? "", position, variant.weight ?? null);
            kept.add(variantId);
          }
        });
        for (const variantId of stored) if (!kept.has(variantId)) deleteVariant.run(variantId);
        resumeControl.run(id, id);
        result.steps.push({ id, track, step_order: index + 1, key: step.key ?? null });
      });
    }

    // Steps that are gone. Their gates and versions go with them.
    const remove = db.prepare("DELETE FROM workflow_steps WHERE id = ?");
    for (const row of existing) {
      if (!taken.has(row.id)) { remove.run(row.id); result.deleted.push(row.id); }
    }

    // Put everyone back on the step they were on.
    if (result.by_id) {
      const after: Record<Track, string[]> = { linkedin: plan.linkedin.map((entry) => entry.id), email: plan.email.map((entry) => entry.id) };
      const place = db.prepare("UPDATE run_profile_tracks SET current_step = ? WHERE id = ?");
      for (const row of standing) {
        const was = before[row.track];
        const now = after[row.track];
        let index: number;
        if (row.current_step >= was.length) {
          index = now.length; // already past the last step
        } else {
          // Their own step, or failing that the first one after it that is still there.
          const next = was.slice(row.current_step).find((id) => now.includes(id));
          index = next ? now.indexOf(next) : now.length;
        }
        if (index !== row.current_step) { place.run(index, row.id); result.moved += 1; }
      }
    }

    db.prepare("UPDATE workflows SET sequence_version = COALESCE(sequence_version, 0) + 1, published_at = datetime('now') WHERE id = ?").run(workflowId);
    result.version = (db.prepare("SELECT sequence_version FROM workflows WHERE id = ?").get(workflowId) as { sequence_version: number }).sequence_version;
  })();

  return result;
}

/**
 * Remove one step, through the writer: the steps after it close the gap and keep their
 * ids, and everyone part-way through stays on their own step (a contact standing on the
 * removed one goes on to the next). Deleting the row directly left a hole that moved
 * every later contact one step further on than they had been.
 */
export function removeStep(db: DB, workflowId: string, stepId: string): PublishResult {
  const remaining = loadSequence(db, workflowId).steps.filter((step) => step.id !== stepId);
  return publishSequence(db, workflowId, remaining, { byId: true });
}

/** Move one step to a place within its own track (1 is first), through the writer, so contacts and statistics stay with their steps. */
export function moveStep(db: DB, workflowId: string, stepId: string, position: number): PublishResult {
  const steps = loadSequence(db, workflowId).steps;
  const moving = steps.find((step) => step.id === stepId);
  if (!moving) return publishSequence(db, workflowId, steps, { byId: true });
  const track = trackOf(moving);
  const lane = steps.filter((step) => trackOf(step) === track && step.id !== stepId);
  lane.splice(Math.min(Math.max(0, Math.round(position) - 1), lane.length), 0, moving);
  return publishSequence(db, workflowId, [...steps.filter((step) => trackOf(step) !== track), ...lane], { byId: true });
}

// ── Gates ─────────────────────────────────────────────────────────────────────

/**
 * What a gate asks.
 *  - conditions      a set of conditions on the contact, checked when its step is done (the branch as it always was)
 *  - connected       on a connect step: did the contact accept the invitation?
 *  - no_reply        has the contact not replied by the time its step is done?
 *  - verified_email  on an email step: is there an address that can be sent to?
 */
export const GATE_KINDS = ["conditions", "connected", "no_reply", "verified_email"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/**
 * What happens to a contact on one side of a gate.
 *  - continue        carry on with the next step
 *  - jump            go to a later step of the same track
 *  - end_track       stop this track; the other track carries on
 *  - leave           take the contact out of the campaign on every track
 *  - handover_email  stop the LinkedIn track and start the email track for this contact
 */
export const OUTCOME_ACTIONS = ["continue", "jump", "end_track", "leave", "handover_email"] as const;
export type OutcomeAction = (typeof OUTCOME_ACTIONS)[number];

export type Effect =
  | { type: "add_to_list"; list_id: string }
  | { type: "create_task"; title: string; description?: string | null; due_in_days?: number | null };

export interface Outcome {
  then: OutcomeAction;
  /** For `jump`: the step to go to, by id or by the key the request gave a new step. */
  step?: string | null;
  effects?: Effect[];
}

export interface GateInput {
  /** The step the gate sits on, by id or by the key the request gave a new step. */
  source: string;
  kind?: GateKind;
  /** For kind `conditions`. */
  conditions?: ConditionGroup;
  on_true?: Outcome | null;
  on_false?: Outcome | null;
}

/** What each kind does on each side when nothing is chosen: what the engine did before gates had outcomes. */
export const DEFAULT_OUTCOME: Record<GateKind, { true: OutcomeAction; false: OutcomeAction }> = {
  conditions: { true: "continue", false: "continue" },
  connected: { true: "continue", false: "end_track" },
  no_reply: { true: "continue", false: "leave" },
  verified_email: { true: "continue", false: "end_track" },
};

const CONDITION_OPERATORS = ["is", "is_not", "contains", "exists", "not_exists", "gt", "gte", "lt", "lte"];

/** Why a condition group cannot be evaluated, or null when it can. */
export function conditionsProblem(conditions: unknown): string | null {
  if (!conditions || typeof conditions !== "object") return "conditions are required";
  const group = conditions as { mode?: unknown; conditions?: unknown };
  if (group.mode !== undefined && group.mode !== "all" && group.mode !== "any") return "conditions.mode must be 'all' or 'any'";
  if (!Array.isArray(group.conditions) || group.conditions.length === 0) return "conditions.conditions must be a non-empty array";
  for (const condition of group.conditions as Array<Record<string, unknown>>) {
    if (!condition || typeof condition.field !== "string" || !condition.field.trim()) return "each condition needs a non-empty field";
    if (typeof condition.operator !== "string" || !CONDITION_OPERATORS.includes(condition.operator)) return `invalid operator ${JSON.stringify(condition?.operator)} — use one of: ${CONDITION_OPERATORS.join(", ")}`;
    if (condition.operator !== "exists" && condition.operator !== "not_exists" && (condition.value === undefined || condition.value === null || condition.value === "")) return `operator '${condition.operator}' requires a value`;
  }
  return null;
}

function outcomeProblem(outcome: unknown, side: string): string | null {
  if (outcome == null) return null;
  if (typeof outcome !== "object") return `${side} must be an outcome`;
  const { then, effects } = outcome as Outcome;
  if (!(OUTCOME_ACTIONS as readonly string[]).includes(then)) return `${side}.then must be one of ${OUTCOME_ACTIONS.join(", ")}`;
  if (then === "jump" && !(outcome as Outcome).step) return `${side}: a jump needs the step to go to`;
  if (effects != null) {
    if (!Array.isArray(effects) || effects.length > 5) return `${side}.effects must be a list of at most five`;
    for (const effect of effects) {
      if (effect?.type === "add_to_list") { if (typeof effect.list_id !== "string" || !effect.list_id) return `${side}: add_to_list needs a list_id`; }
      else if (effect?.type === "create_task") { if (typeof effect.title !== "string" || !effect.title.trim()) return `${side}: create_task needs a title`; }
      else return `${side}: an effect must be add_to_list or create_task`;
    }
  }
  return null;
}

interface StepRef { id: string; track: Track; step_order: number; step_type: string }

/**
 * Why this gate cannot be saved on this campaign, or null when it can. `resolve` turns a
 * step reference (an id, or a key from the same request) into the step.
 */
export function gateProblem(db: DB, workspaceId: string, gate: GateInput, resolve: (ref: string) => StepRef | undefined): string | null {
  const kind = gate.kind ?? "conditions";
  if (!(GATE_KINDS as readonly string[]).includes(kind)) return `kind must be one of ${GATE_KINDS.join(", ")}`;
  const source = typeof gate.source === "string" ? resolve(gate.source) : undefined;
  if (!source) return "Source step not found";
  if (kind === "conditions") {
    const problem = conditionsProblem(gate.conditions);
    if (problem) return problem;
  }
  if (kind === "connected" && source.step_type !== "connect") return "A \"connection accepted\" gate belongs on a connection request step";
  // A reply always takes the contact out of the campaign. The gate decides what else happens (a task, a list), not that.
  if (kind === "no_reply" && gate.on_false && gate.on_false.then !== "leave") return "A contact who replies always leaves the campaign; a \"no reply yet\" gate can only add effects to that";
  if (kind === "verified_email" && source.step_type !== "email") return "A \"verified email\" gate belongs on an email step";
  for (const [side, outcome] of [["on_true", gate.on_true], ["on_false", gate.on_false]] as const) {
    const problem = outcomeProblem(outcome, side);
    if (problem) return problem;
    if (!outcome) continue;
    if (outcome.then === "jump") {
      const destination = resolve(String(outcome.step));
      if (!destination || destination.track !== source.track || destination.step_order <= source.step_order) return "Branch targets must be later steps in the same workflow";
    }
    if (outcome.then === "handover_email" && source.track !== "linkedin") return "Only the LinkedIn track can hand a contact over to email";
    for (const effect of outcome.effects ?? []) {
      if (effect.type === "add_to_list" && !db.prepare("SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?").get(effect.list_id, workspaceId)) return "The list to add contacts to is not in this workspace";
    }
  }
  return null;
}

/** An outcome as stored: the step a jump goes to lives in its own column, so it cannot dangle. */
const storedOutcome = (outcome: Outcome | null | undefined): string | null =>
  outcome ? JSON.stringify({ then: outcome.then, ...(outcome.effects?.length ? { effects: outcome.effects } : {}) }) : null;

/** Save one gate on its step (a step has at most one). Returns its id and whether it was new. Validate with gateProblem() first. */
export function saveGate(db: DB, workspaceId: string, workflowId: string, gate: GateInput, resolve: (ref: string) => StepRef | undefined): { id: string; created: boolean } {
  const source = resolve(gate.source)!;
  const kind = gate.kind ?? "conditions";
  const jump = (outcome: Outcome | null | undefined) => (outcome?.then === "jump" ? resolve(String(outcome.step))?.id ?? null : null);
  const existing = db.prepare("SELECT id FROM workflow_branches WHERE source_step_id = ? AND workspace_id = ?").get(source.id, workspaceId) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  db.prepare(
    `INSERT INTO workflow_branches (id, workspace_id, workflow_id, source_step_id, kind, conditions_json, true_step_id, false_step_id, true_outcome_json, false_outcome_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_step_id) DO UPDATE SET kind = excluded.kind, conditions_json = excluded.conditions_json, true_step_id = excluded.true_step_id,
       false_step_id = excluded.false_step_id, true_outcome_json = excluded.true_outcome_json, false_outcome_json = excluded.false_outcome_json`,
  ).run(id, workspaceId, workflowId, source.id, kind, JSON.stringify(kind === "conditions" ? gate.conditions : {}), jump(gate.on_true), jump(gate.on_false), storedOutcome(gate.on_true), storedOutcome(gate.on_false));
  return { id, created: !existing };
}

/** The steps of a campaign, for resolving references. */
export function stepRefs(db: DB, workflowId: string): StepRef[] {
  return db.prepare("SELECT id, track, step_order, step_type FROM workflow_steps WHERE workflow_id = ?").all(workflowId) as StepRef[];
}

export interface StoredGate {
  id: string;
  source_step_id: string;
  kind: GateKind;
  conditions: ConditionGroup | null;
  on_true: Outcome;
  on_false: Outcome;
}

function readOutcome(json: string | null, stepId: string | null, fallback: OutcomeAction): Outcome {
  let stored: Partial<Outcome> | null = null;
  try { stored = json ? (JSON.parse(json) as Partial<Outcome>) : null; } catch { stored = null; }
  // A row written before gates had outcomes says only where to jump, if anywhere.
  const then = stored?.then && (OUTCOME_ACTIONS as readonly string[]).includes(stored.then) ? stored.then : stepId ? "jump" : fallback;
  return { then: then === "jump" && !stepId ? "continue" : then, step: then === "jump" ? stepId : null, effects: Array.isArray(stored?.effects) ? stored.effects : [] };
}

/** A stored gate with each side's outcome filled in, defaults included. */
export function readGate(row: { id: string; source_step_id: string; kind: string | null; conditions_json: string; true_step_id: string | null; false_step_id: string | null; true_outcome_json: string | null; false_outcome_json: string | null }): StoredGate {
  const kind = (GATE_KINDS as readonly string[]).includes(row.kind ?? "") ? (row.kind as GateKind) : "conditions";
  let conditions: ConditionGroup | null = null;
  try { conditions = JSON.parse(row.conditions_json) as ConditionGroup; } catch { conditions = null; }
  return {
    id: row.id, source_step_id: row.source_step_id, kind,
    conditions: kind === "conditions" && Array.isArray(conditions?.conditions) && conditions.conditions.length > 0 ? conditions : null,
    on_true: readOutcome(row.true_outcome_json, row.true_step_id, DEFAULT_OUTCOME[kind].true),
    on_false: readOutcome(row.false_outcome_json, row.false_step_id, DEFAULT_OUTCOME[kind].false),
  };
}

const GATE_COLUMNS = "id, source_step_id, kind, conditions_json, true_step_id, false_step_id, true_outcome_json, false_outcome_json";

export function gatesOf(db: DB, workflowId: string): StoredGate[] {
  return (db.prepare(`SELECT ${GATE_COLUMNS} FROM workflow_branches WHERE workflow_id = ? ORDER BY created_at, rowid`).all(workflowId) as Parameters<typeof readGate>[0][]).map(readGate);
}

export function gateOnStep(db: DB, stepId: string): StoredGate | null {
  const row = db.prepare(`SELECT ${GATE_COLUMNS} FROM workflow_branches WHERE source_step_id = ?`).get(stepId) as Parameters<typeof readGate>[0] | undefined;
  return row ? readGate(row) : null;
}

// ── Campaign-wide sequence settings ───────────────────────────────────────────

export interface SequenceSettings {
  /** When the email track starts for a contact: with everything else, or only on a hand-over from LinkedIn. */
  email_start: "enrolment" | "handover";
  linkedin_track_enabled: boolean;
  email_track_enabled: boolean;
}

export function sequenceSettings(db: DB, workflowId: string): SequenceSettings {
  const row = db.prepare("SELECT email_start, linkedin_track_enabled, email_track_enabled FROM workflows WHERE id = ?").get(workflowId) as
    | { email_start: string | null; linkedin_track_enabled: number | null; email_track_enabled: number | null }
    | undefined;
  return { email_start: row?.email_start === "handover" ? "handover" : "enrolment", linkedin_track_enabled: row?.linkedin_track_enabled !== 0, email_track_enabled: row?.email_track_enabled !== 0 };
}

export function settingsProblem(settings: unknown): string | null {
  if (settings == null) return null;
  if (typeof settings !== "object") return "settings must be an object";
  const { email_start, linkedin_track_enabled, email_track_enabled } = settings as Record<string, unknown>;
  if (email_start !== undefined && email_start !== "enrolment" && email_start !== "handover") return "email_start must be enrolment or handover";
  for (const [name, value] of [["linkedin_track_enabled", linkedin_track_enabled], ["email_track_enabled", email_track_enabled]] as const) {
    if (value !== undefined && typeof value !== "boolean") return `${name} must be true or false`;
  }
  return null;
}

export function saveSequenceSettings(db: DB, workflowId: string, settings: Partial<SequenceSettings>): void {
  if (settings.email_start !== undefined) db.prepare("UPDATE workflows SET email_start = ? WHERE id = ?").run(settings.email_start, workflowId);
  if (settings.linkedin_track_enabled !== undefined) db.prepare("UPDATE workflows SET linkedin_track_enabled = ? WHERE id = ?").run(settings.linkedin_track_enabled ? 1 : 0, workflowId);
  if (settings.email_track_enabled !== undefined) db.prepare("UPDATE workflows SET email_track_enabled = ? WHERE id = ?").run(settings.email_track_enabled ? 1 : 0, workflowId);
}

// ── Drafts ────────────────────────────────────────────────────────────────────

/** What an editor is working on: the whole sequence as it would be after publishing. */
export interface SequenceDraft {
  steps: StepInput[];
  gates?: GateInput[];
  settings?: Partial<SequenceSettings>;
}

export interface StoredDraft {
  draft: SequenceDraft;
  /** The published version the draft was started from. */
  base_version: number;
  updated_by: string | null;
  updated_at: string;
}

export function getDraft(db: DB, workflowId: string): StoredDraft | null {
  const row = db.prepare("SELECT draft_json, base_version, updated_by, updated_at FROM workflow_drafts WHERE workflow_id = ?").get(workflowId) as
    | { draft_json: string; base_version: number; updated_by: string | null; updated_at: string }
    | undefined;
  if (!row) return null;
  try {
    return { draft: JSON.parse(row.draft_json) as SequenceDraft, base_version: row.base_version, updated_by: row.updated_by, updated_at: row.updated_at };
  } catch {
    return null;
  }
}

/** Why a draft cannot be kept, or null. A draft may be unfinished, so only its shape is checked here; publishing checks the rest. */
export function draftShapeProblem(draft: unknown): string | null {
  if (!draft || typeof draft !== "object") return "draft must be an object";
  const { steps, gates, settings } = draft as SequenceDraft;
  if (!Array.isArray(steps)) return "draft.steps must be an array";
  if (steps.length > 200) return "A sequence can have at most 200 steps";
  if (gates !== undefined && !Array.isArray(gates)) return "draft.gates must be an array";
  return settingsProblem(settings);
}

/** Keep a draft. The first save notes the published version it starts from; later saves keep that. */
export function saveDraft(db: DB, workspaceId: string, workflowId: string, userId: string | null, draft: SequenceDraft): StoredDraft {
  const version = (db.prepare("SELECT COALESCE(sequence_version, 0) AS v FROM workflows WHERE id = ?").get(workflowId) as { v: number }).v;
  db.prepare(
    `INSERT INTO workflow_drafts (workflow_id, workspace_id, draft_json, base_version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(workflow_id) DO UPDATE SET draft_json = excluded.draft_json, updated_by = excluded.updated_by, updated_at = datetime('now')`,
  ).run(workflowId, workspaceId, JSON.stringify(draft), version, userId);
  return getDraft(db, workflowId)!;
}

export function discardDraft(db: DB, workflowId: string): boolean {
  return db.prepare("DELETE FROM workflow_drafts WHERE workflow_id = ?").run(workflowId).changes > 0;
}

/** Why this sequence cannot be published, or null when it can. Checks the steps, then every gate against them. */
export function draftProblem(db: DB, workspaceId: string, workflowId: string, draft: SequenceDraft): string | null {
  const shape = draftShapeProblem(draft) ?? sequenceProblem(draft.steps);
  if (shape) return shape;
  // Gates are checked against the steps as they will be: existing ids, and keys for new ones.
  const known = new Map(stepRefs(db, workflowId).map((step) => [step.id, step]));
  const order: Record<Track, number> = { linkedin: 0, email: 0 };
  const refs = new Map<string, StepRef>();
  for (const step of draft.steps) {
    const track = trackOf(step);
    const ref: StepRef = { id: step.id && known.get(step.id)?.track === track ? step.id : `new:${step.key ?? randomUUID()}`, track, step_order: ++order[track], step_type: step.step_type };
    if (step.id && known.get(step.id)?.track === track) refs.set(step.id, ref);
    if (step.key) {
      if (refs.has(step.key)) return `Two steps share the key "${step.key}"`;
      refs.set(step.key, ref);
    }
  }
  const sources = new Set<string>();
  for (const gate of draft.gates ?? []) {
    const problem = gateProblem(db, workspaceId, gate, (ref) => refs.get(ref));
    if (problem) return problem;
    const source = refs.get(gate.source)!.id;
    if (sources.has(source)) return "A step can have only one gate";
    sources.add(source);
  }
  return null;
}

export interface PublishedDraft extends PublishResult {
  gates: number;
}

/**
 * Publish a sequence: its steps (by id, so contacts and statistics stay with their step),
 * then its gates, then the campaign-wide settings. Gates not in the draft are removed.
 * Validate with draftProblem() first. One transaction.
 */
export function publishDraft(db: DB, workspaceId: string, workflowId: string, draft: SequenceDraft): PublishedDraft {
  return db.transaction(() => {
    // A draft is always matched by id: a step without one is new, wherever it sits.
    const result = publishSequence(db, workflowId, draft.steps, { byId: true });
    const byRef = new Map<string, StepRef>();
    const all = new Map(stepRefs(db, workflowId).map((step) => [step.id, step]));
    for (const step of result.steps) {
      const ref = all.get(step.id)!;
      byRef.set(step.id, ref);
      if (step.key) byRef.set(step.key, ref);
    }
    const kept = new Set<string>();
    for (const gate of draft.gates ?? []) kept.add(saveGate(db, workspaceId, workflowId, gate, (ref) => byRef.get(ref)).id);
    const stale = (db.prepare("SELECT id FROM workflow_branches WHERE workflow_id = ?").all(workflowId) as Array<{ id: string }>).filter((row) => !kept.has(row.id));
    for (const row of stale) db.prepare("DELETE FROM workflow_branches WHERE id = ?").run(row.id);
    if (draft.settings) saveSequenceSettings(db, workflowId, draft.settings);
    discardDraft(db, workflowId);
    return { ...result, gates: kept.size };
  })();
}

// ── Copying a campaign ────────────────────────────────────────────────────────

/** The sequence as an editor would load it: every step with its versions and template pool, every gate, the settings. */
export function loadSequence(db: DB, workflowId: string): Required<SequenceDraft> {
  const rows = db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY track DESC, step_order, rowid").all(workflowId) as Array<Record<string, unknown>>;
  const templateIds = db.prepare("SELECT template_id FROM workflow_step_templates WHERE step_id = ?");
  const variants = db.prepare("SELECT id, subject, body, weight FROM workflow_step_email_variants WHERE step_id = ? ORDER BY position");
  const steps = rows.map((row) => ({
    ...(row as unknown as StepInput),
    id: String(row.id),
    template_ids: (templateIds.all(row.id) as Array<{ template_id: string }>).map((link) => link.template_id),
    email_variants: variants.all(row.id) as VariantInput[],
  }));
  const gates = gatesOf(db, workflowId).map((gate): GateInput => ({
    source: gate.source_step_id, kind: gate.kind, ...(gate.conditions ? { conditions: gate.conditions } : {}), on_true: gate.on_true, on_false: gate.on_false,
  }));
  return { steps, gates, settings: sequenceSettings(db, workflowId) };
}

/**
 * Copy one campaign's whole sequence onto another, empty one: steps, template pools,
 * A/B versions, gates and settings. Everything gets new ids, and gates are re-pointed at
 * the copies. Statistics and paused versions are not carried: the copy starts clean.
 */
export function copySequence(db: DB, workspaceId: string, fromWorkflowId: string, toWorkflowId: string): PublishedDraft {
  const source = loadSequence(db, fromWorkflowId);
  // The source's ids become keys, so the copy's gates can find the copied steps.
  const steps = source.steps.map((step) => ({ ...step, key: step.id as string, id: null, email_variants: (step.email_variants ?? []).map((variant) => ({ ...variant, id: null })) }));
  return publishDraft(db, workspaceId, toWorkflowId, { steps, gates: source.gates, settings: source.settings });
}

// ── The sequence as it stands ─────────────────────────────────────────────────

export interface SequenceOverview extends Required<SequenceDraft> {
  version: number;
  published_at: string | null;
  /** Contacts part-way through a run of this campaign right now. */
  in_flight: number;
  /** For each step, how many contacts are standing on it now. */
  standing: Record<string, number>;
  /** For each gate's step, how many contacts came out on each side. */
  gate_counts: Record<string, { true: number; false: number }>;
  draft: { updated_at: string; updated_by: string | null; stale: boolean } | null;
}

/** The published sequence with what is happening on it: who is standing where, and each gate's two counts. */
export function sequenceOverview(db: DB, workflowId: string): SequenceOverview {
  const sequence = loadSequence(db, workflowId);
  const row = db.prepare("SELECT COALESCE(sequence_version, 0) AS version, published_at FROM workflows WHERE id = ?").get(workflowId) as { version: number; published_at: string | null };
  const live = "r.workflow_id = ? AND r.status IN ('running', 'paused', 'pending')";

  // A contact's place is an index into its track's steps, in order.
  const order: Record<Track, string[]> = { linkedin: [], email: [] };
  for (const step of sequence.steps) order[trackOf(step)].push(String(step.id));
  const standing: Record<string, number> = {};
  const places = db.prepare(
    `SELECT rt.track, rt.current_step, COUNT(*) AS c FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id JOIN runs r ON r.id = rp.run_id
     WHERE ${live} AND rt.state = 'in_progress' GROUP BY rt.track, rt.current_step`,
  ).all(workflowId) as Array<{ track: Track; current_step: number; c: number }>;
  for (const place of places) {
    const stepId = order[place.track]?.[place.current_step];
    if (stepId) standing[stepId] = (standing[stepId] ?? 0) + place.c;
  }
  const inFlight = (db.prepare(
    `SELECT COUNT(DISTINCT rp.id) AS c FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id JOIN runs r ON r.id = rp.run_id WHERE ${live} AND rt.state = 'in_progress'`,
  ).get(workflowId) as { c: number }).c;

  const gateCounts: SequenceOverview["gate_counts"] = {};
  for (const count of db.prepare("SELECT step_id, side, COUNT(*) AS c FROM step_outcomes WHERE workflow_id = ? GROUP BY step_id, side").all(workflowId) as Array<{ step_id: string; side: "true" | "false"; c: number }>) {
    (gateCounts[count.step_id] ??= { true: 0, false: 0 })[count.side] = count.c;
  }

  const stored = getDraft(db, workflowId);
  return {
    ...sequence, version: row.version, published_at: row.published_at, in_flight: inFlight, standing, gate_counts: gateCounts,
    draft: stored ? { updated_at: stored.updated_at, updated_by: stored.updated_by, stale: stored.base_version !== row.version } : null,
  };
}
