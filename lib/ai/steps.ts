// The AI settings of a campaign's steps, as the AI & models screen lists and edits them:
// which steps are written by AI, with which model, what instruction, how long, in what
// language. Only those five columns are written here. A step's place in the sequence,
// its wording and everything else stay with the sequence writer (lib/outreach/publish.ts).
import type DatabaseType from "better-sqlite3";
import { MAX_MODEL_ID } from "@/lib/ai/config";

type DB = DatabaseType.Database;

/** The step types whose text can be written by AI. */
export const WRITABLE_STEP_TYPES = ["email", "message", "sales_inmail"] as const;
export type WritableStepType = (typeof WRITABLE_STEP_TYPES)[number];

export const MAX_STEP_PROMPT = 1000;
export const MAX_STEP_WORDS = 1000;
export const MAX_LANGUAGE = 40;

export interface AiStep {
  id: string;
  track: "linkedin" | "email";
  step_type: WritableStepType;
  /** 1 for the first step of its type in the campaign, 2 for the second … */
  number: number;
  /** Days from the start of its track to this step, from the waits before it. */
  day: number;
  ai_enabled: boolean;
  /** Null: the workspace's default model. */
  ai_model: string | null;
  ai_prompt: string | null;
  ai_max_words: number | null;
  ai_language: string | null;
}

interface StepRow {
  id: string;
  track: string | null;
  step_type: string;
  delay_seconds: number | null;
  ai_enabled: number | null;
  ai_model: string | null;
  ai_prompt: string | null;
  ai_max_words: number | null;
  ai_language: string | null;
}

/** A campaign's writable steps in the order they happen: by day, LinkedIn before email on the same day. */
export function aiSteps(db: DB, workflowId: string): AiStep[] {
  const rows = db.prepare(
    `SELECT id, track, step_type, delay_seconds, ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language
     FROM workflow_steps WHERE workflow_id = ? ORDER BY track DESC, step_order, rowid`,
  ).all(workflowId) as StepRow[];
  const waited: Record<string, number> = {};
  const seen: Record<string, number> = {};
  const steps: AiStep[] = [];
  for (const row of rows) {
    const track = row.track === "email" || row.step_type === "email" ? "email" : "linkedin";
    // A wait is either a step of its own or the delay in front of a step.
    waited[track] = (waited[track] ?? 0) + Math.max(0, row.delay_seconds ?? 0);
    if (!(WRITABLE_STEP_TYPES as readonly string[]).includes(row.step_type)) continue;
    const type = row.step_type as WritableStepType;
    seen[type] = (seen[type] ?? 0) + 1;
    steps.push({
      id: row.id, track, step_type: type, number: seen[type], day: Math.floor(waited[track] / 86_400),
      ai_enabled: Boolean(row.ai_enabled), ai_model: row.ai_model || null, ai_prompt: row.ai_prompt || null,
      ai_max_words: row.ai_max_words ?? null, ai_language: row.ai_language || null,
    });
  }
  // Stable: steps on the same day keep the order above (LinkedIn first, then by position).
  return steps.map((step, index) => ({ step, index })).sort((a, b) => a.step.day - b.step.day || a.index - b.index).map(({ step }) => step);
}

export const AI_STEP_FIELDS = ["ai_enabled", "ai_model", "ai_prompt", "ai_max_words", "ai_language"] as const;
export type AiStepField = (typeof AI_STEP_FIELDS)[number];
export type AiStepPatch = Partial<{ ai_enabled: boolean; ai_model: string | null; ai_prompt: string | null; ai_max_words: number | null; ai_language: string | null }>;

/** Read the AI fields a request wants to change. Fields it does not name are left out of the patch. */
export function aiStepPatch(body: unknown): { ok: true; patch: AiStepPatch } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send the settings to change as an object" };
  const input = body as Record<string, unknown>;
  const has = (field: AiStepField) => Object.prototype.hasOwnProperty.call(input, field);
  const patch: AiStepPatch = {};

  if (has("ai_enabled")) {
    if (typeof input.ai_enabled !== "boolean") return { ok: false, error: "ai_enabled must be true or false" };
    patch.ai_enabled = input.ai_enabled;
  }
  if (has("ai_model")) {
    const value = input.ai_model;
    if (value === null || value === "") patch.ai_model = null;
    else if (typeof value !== "string" || value.trim().length > MAX_MODEL_ID || /\s/.test(value.trim())) return { ok: false, error: "ai_model must be a model id, or empty for the workspace default" };
    else patch.ai_model = value.trim() || null;
  }
  if (has("ai_prompt")) {
    const value = input.ai_prompt;
    if (value === null) patch.ai_prompt = null;
    else if (typeof value !== "string") return { ok: false, error: "The instruction must be text" };
    else if (value.length > MAX_STEP_PROMPT) return { ok: false, error: `The instruction can be at most ${MAX_STEP_PROMPT.toLocaleString("en-US")} characters` };
    else patch.ai_prompt = value.trim() ? value.trim() : null;
  }
  if (has("ai_max_words")) {
    const value = input.ai_max_words;
    if (value === null || value === "") patch.ai_max_words = null;
    else if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_STEP_WORDS) return { ok: false, error: `The word limit must be a whole number from 1 to ${MAX_STEP_WORDS.toLocaleString("en-US")}, or empty for none` };
    else patch.ai_max_words = value;
  }
  if (has("ai_language")) {
    const value = input.ai_language;
    if (value === null || value === "") patch.ai_language = null;
    else if (typeof value !== "string" || value.trim().length > MAX_LANGUAGE) return { ok: false, error: "The language must be a name such as English or German" };
    else patch.ai_language = value.trim() || null;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: `Send at least one of ${AI_STEP_FIELDS.join(", ")}` };
  return { ok: true, patch };
}

/**
 * Change a published step's AI settings. If someone has an unpublished draft of this
 * campaign's sequence open, the same change is made to that step in the draft, so
 * publishing the draft later does not put the old settings back.
 */
export function saveAiStep(db: DB, workflowId: string, stepId: string, patch: AiStepPatch): void {
  const fields = Object.keys(patch) as AiStepField[];
  if (fields.length === 0) return;
  const stored = (field: AiStepField) => (field === "ai_enabled" ? (patch.ai_enabled ? 1 : 0) : patch[field] ?? null);
  db.transaction(() => {
    db.prepare(`UPDATE workflow_steps SET ${fields.map((field) => `${field} = ?`).join(", ")} WHERE id = ? AND workflow_id = ?`).run(...fields.map(stored), stepId, workflowId);

    const draftRow = db.prepare("SELECT draft_json FROM workflow_drafts WHERE workflow_id = ?").get(workflowId) as { draft_json: string } | undefined;
    if (!draftRow) return;
    try {
      const draft = JSON.parse(draftRow.draft_json) as { steps?: Array<Record<string, unknown>> };
      const step = Array.isArray(draft.steps) ? draft.steps.find((candidate) => candidate && candidate.id === stepId) : undefined;
      if (!step) return;
      for (const field of fields) step[field] = patch[field] ?? null;
      // Only the JSON changes: who last edited the draft, and when, is still true.
      db.prepare("UPDATE workflow_drafts SET draft_json = ? WHERE workflow_id = ?").run(JSON.stringify(draft), workflowId);
    } catch {
      // A draft that cannot be read is not this route's to repair.
    }
  })();
}

export interface AiCampaign {
  id: string;
  name: string;
  archived: boolean;
  /** Steps whose text could be written by AI, and how many of them are. */
  writable_steps: number;
  ai_steps: number;
}

/** Every campaign with at least one step AI could write, those using AI first, then newest first. */
export function aiCampaigns(db: DB, workspaceId: string): AiCampaign[] {
  const rows = db.prepare(
    `SELECT w.id, w.name, COALESCE(w.is_archived, 0) AS archived, COUNT(s.id) AS writable_steps, COALESCE(SUM(CASE WHEN s.ai_enabled = 1 THEN 1 ELSE 0 END), 0) AS ai_steps
     FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id AND s.step_type IN ('email', 'message', 'sales_inmail')
     WHERE w.workspace_id = ?
     GROUP BY w.id
     ORDER BY archived, (ai_steps > 0) DESC, w.created_at DESC, w.name`,
  ).all(workspaceId) as Array<{ id: string; name: string; archived: number; writable_steps: number; ai_steps: number }>;
  return rows.map((row) => ({ ...row, archived: Boolean(row.archived) }));
}
