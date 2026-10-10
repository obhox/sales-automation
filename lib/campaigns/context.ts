// What the AI writer is told about a campaign, beyond the campaign's own free-text brief:
// the angle to take, the tone, which kinds of signal about a contact it may open with, and
// which model writes it. A campaign with none of this set is written exactly as before.
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

export const TRIGGER_TYPES = ["job_change", "funding", "hiring", "technology", "product_intent", "custom"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const TRIGGER_LABEL: Record<TriggerType, string> = {
  job_change: "Job changes", funding: "Funding", hiring: "Hiring", technology: "Technology", product_intent: "Product intent", custom: "Custom signals",
};

export interface AiContext {
  /** The one idea the outreach turns on ("hiring-driven capacity gap"). */
  angle: string;
  tone: string;
  /** Kinds of signal the writer may use as its reason for writing, when a contact has one. */
  triggers: TriggerType[];
  /** The model for this campaign's AI steps. A step's own model still wins; null falls back to the workspace's. */
  model: string | null;
}

export const EMPTY_AI_CONTEXT: AiContext = { angle: "", tone: "", triggers: [], model: null };
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** Why this cannot be saved as a campaign's AI context, or null. */
export function aiContextProblem(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== "object") return "ai must be an object";
  const { angle, tone, triggers, model } = input as Record<string, unknown>;
  for (const [key, value] of [["angle", angle], ["tone", tone], ["model", model]] as const) {
    if (value != null && typeof value !== "string") return `ai.${key} must be text`;
  }
  if (triggers != null && (!Array.isArray(triggers) || triggers.some((trigger) => !(TRIGGER_TYPES as readonly unknown[]).includes(trigger)))) {
    return `ai.triggers must be a list from: ${TRIGGER_TYPES.join(", ")}`;
  }
  return null;
}

export function readAiContext(json: string | null | undefined): AiContext {
  try {
    const stored = JSON.parse(json ?? "null") as Partial<AiContext> | null;
    if (!stored || typeof stored !== "object") return { ...EMPTY_AI_CONTEXT };
    return {
      angle: text(stored.angle, 300), tone: text(stored.tone, 120),
      triggers: Array.isArray(stored.triggers) ? TRIGGER_TYPES.filter((type) => stored.triggers!.includes(type)) : [],
      model: text(stored.model, 120) || null,
    };
  } catch {
    return { ...EMPTY_AI_CONTEXT };
  }
}

export function aiContextOf(db: DB, workflowId: string): AiContext {
  return readAiContext((db.prepare("SELECT ai_context_json FROM workflows WHERE id = ?").get(workflowId) as { ai_context_json: string | null } | undefined)?.ai_context_json);
}

/** Validate with aiContextProblem() first. Fields left out keep what they had. */
export function saveAiContext(db: DB, workflowId: string, change: Partial<AiContext>): AiContext {
  const next = readAiContext(JSON.stringify({ ...aiContextOf(db, workflowId), ...change }));
  db.prepare("UPDATE workflows SET ai_context_json = ? WHERE id = ?").run(JSON.stringify(next), workflowId);
  return next;
}

/**
 * The campaign's brief as the writer is given it: the free text someone wrote, then the
 * angle, the tone and the triggers as lines of their own. With nothing structured set this
 * is exactly the free text, as it always was.
 */
export function campaignContextText(db: DB, workflowId: string): string | null {
  const row = db.prepare("SELECT prompt, ai_context_json FROM workflows WHERE id = ?").get(workflowId) as { prompt: string | null; ai_context_json: string | null } | undefined;
  if (!row) return null;
  const context = readAiContext(row.ai_context_json);
  const lines = [
    context.angle ? `Angle: ${context.angle}` : "",
    context.tone ? `Tone: ${context.tone}` : "",
    context.triggers.length ? `If the contact has a recent signal of one of these kinds, open with it as the reason for writing: ${context.triggers.map((type) => TRIGGER_LABEL[type].toLowerCase()).join(", ")}. Their recent signals are listed with the contact. Never invent one.` : "",
  ].filter(Boolean);
  if (lines.length === 0) return row.prompt ?? null;
  return [row.prompt?.trim() ?? "", ...lines].filter(Boolean).join("\n");
}

export interface ContactTrigger { type: TriggerType; title: string; description: string | null; occurred_at: string }

/** A contact's own and their company's recent signals of the kinds the campaign may open with: newest first, the last six months, five at most. */
export function contactTriggers(db: DB, targetId: string, types: readonly TriggerType[]): ContactTrigger[] {
  if (types.length === 0) return [];
  return db.prepare(
    `SELECT s.type, s.title, s.description, s.occurred_at FROM signals s
     WHERE (s.target_id = @target OR (s.company_id IS NOT NULL AND s.company_id = (SELECT company_id FROM targets WHERE id = @target)))
       AND s.type IN (${types.map((_, index) => `@type${index}`).join(", ")})
       AND datetime(s.occurred_at) >= datetime('now', '-180 days')
     ORDER BY datetime(s.occurred_at) DESC LIMIT 5`,
  ).all({ target: targetId, ...Object.fromEntries(types.map((type, index) => [`type${index}`, type])) }) as ContactTrigger[];
}

/**
 * The contact as the writer is given it, with the campaign's triggers added when it has
 * any. Without triggers the contact is passed through untouched.
 */
export function withTriggers<T extends { contact: Record<string, unknown> }>(db: DB, workflowId: string, targetId: string, data: T): T {
  const { triggers } = aiContextOf(db, workflowId);
  if (triggers.length === 0) return data;
  const recent = contactTriggers(db, targetId, triggers);
  return recent.length === 0 ? data : { ...data, contact: { ...data.contact, recent_signals: recent } };
}
