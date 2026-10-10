// A workspace's AI settings: which models write, in what tone, from which instructions
// and examples, and how much may be spent in a month. One reader and one writer, used by
// the settings route, the screen and the MCP tool.
import { getDb } from "@/lib/db";

export const TONES = ["direct", "warm", "formal"] as const;
export type Tone = (typeof TONES)[number];

/** The line each tone adds to the writer's instructions. No tone adds nothing. */
export const TONE_INSTRUCTION: Record<Tone, string> = {
  direct: "Tone: direct. Get to the point in the first sentence, use plain words and short sentences, and make one clear ask.",
  warm: "Tone: warm. Write as one person to another, friendly and unhurried, without flattery or exclamation marks.",
  formal: "Tone: formal. Use complete sentences and a professional register, with no slang, contractions or emoji.",
};

export const isTone = (value: unknown): value is Tone => typeof value === "string" && (TONES as readonly string[]).includes(value);

export interface AiExample {
  title: string;
  body: string;
}

export const MAX_EXAMPLES = 12;
export const MAX_EXAMPLE_TITLE = 80;
export const MAX_EXAMPLE_BODY = 4000;
export const MAX_PROMPT = 2000;
export const MAX_MODEL_ID = 200;
export const MAX_BUDGET_USD = 100_000;

/** The title given to examples saved as one block of text, before examples had titles. */
export const EARLIER_EXAMPLES_TITLE = "Earlier examples";

function storedExamples(raw: string): AiExample[] | null {
  if (!raw.trimStart().startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const examples = parsed.filter((item): item is { title?: unknown; body: string } => !!item && typeof item === "object" && typeof (item as { body?: unknown }).body === "string");
    if (examples.length !== parsed.length) return null;
    return examples.map((item) => ({ title: typeof item.title === "string" ? item.title : "", body: item.body }));
  } catch {
    return null;
  }
}

/**
 * The examples in a stored column. They are kept as a list of titled examples; text saved
 * before that (or through a caller that still sends plain text) reads as one example.
 */
export function parseExamples(raw: string | null | undefined): AiExample[] {
  if (!raw || !raw.trim()) return [];
  return storedExamples(raw) ?? [{ title: EARLIER_EXAMPLES_TITLE, body: raw }];
}

/** The examples as the writer is shown them. Plain text goes through exactly as it was stored. */
export function examplesForPrompt(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const examples = storedExamples(raw);
  if (!examples) return raw;
  if (examples.length === 0) return null;
  return examples.map((example, index) => `Example ${index + 1}${example.title ? `: ${example.title}` : ""}\n${example.body}`).join("\n\n");
}

interface AiConfigRow {
  default_model: string | null;
  fallback_model: string | null;
  tone: string | null;
  system_prompt: string | null;
  user_prompt: string | null;
  email_examples: string | null;
  linkedin_examples: string | null;
  monthly_budget_usd: number | null;
  updated_at: string | null;
}

const EMPTY_ROW: AiConfigRow = {
  default_model: null, fallback_model: null, tone: null, system_prompt: null, user_prompt: null,
  email_examples: null, linkedin_examples: null, monthly_budget_usd: null, updated_at: null,
};

export interface AiConfigView {
  default_model: string | null;
  fallback_model: string | null;
  tone: Tone | null;
  system_prompt: string;
  user_prompt: string;
  email_examples: AiExample[];
  linkedin_examples: AiExample[];
  monthly_budget_usd: number | null;
  updated_at: string | null;
}

function readRow(workspaceId: string): AiConfigRow {
  const row = getDb().prepare(
    "SELECT default_model, fallback_model, tone, system_prompt, user_prompt, email_examples, linkedin_examples, monthly_budget_usd, updated_at FROM workspace_ai_config WHERE workspace_id = ?",
  ).get(workspaceId) as AiConfigRow | undefined;
  return row ?? EMPTY_ROW;
}

/** The settings as the screen edits them: examples as a list, prompts as text. */
export function readAiConfig(workspaceId: string): AiConfigView {
  const row = readRow(workspaceId);
  return {
    default_model: row.default_model || null,
    fallback_model: row.fallback_model || null,
    tone: isTone(row.tone) ? row.tone : null,
    system_prompt: row.system_prompt ?? "",
    user_prompt: row.user_prompt ?? "",
    email_examples: parseExamples(row.email_examples),
    linkedin_examples: parseExamples(row.linkedin_examples),
    monthly_budget_usd: typeof row.monthly_budget_usd === "number" && row.monthly_budget_usd > 0 ? row.monthly_budget_usd : null,
    updated_at: row.updated_at,
  };
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function checkModel(value: unknown, name: string): Checked<string | null> {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${name} must be a model id, such as anthropic/claude-haiku-5.5` };
  const id = value.trim();
  if (id.length > MAX_MODEL_ID || /\s/.test(id)) return { ok: false, error: `${name} must be a model id, such as anthropic/claude-haiku-5.5` };
  return { ok: true, value: id || null };
}

function checkPrompt(value: unknown, name: string, stored: string | null): Checked<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${name} must be text` };
  // A longer prompt saved before there was a limit stays as it is until someone changes it.
  if (value.length > MAX_PROMPT && value !== stored) return { ok: false, error: `${name} can be at most ${MAX_PROMPT.toLocaleString("en-US")} characters` };
  return { ok: true, value: value.trim() ? value : null };
}

function checkExamples(value: unknown, name: string): Checked<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  // Plain text, as the old screen and the MCP tool send it.
  if (typeof value === "string") return { ok: true, value: value.trim() ? value : null };
  if (!Array.isArray(value)) return { ok: false, error: `${name} must be a list of examples` };
  if (value.length > MAX_EXAMPLES) return { ok: false, error: `${name} can hold at most ${MAX_EXAMPLES} examples` };
  const examples: AiExample[] = [];
  for (const [index, item] of value.entries()) {
    const at = `${name}, example ${index + 1}`;
    if (!item || typeof item !== "object") return { ok: false, error: `${at} is not an example` };
    const { title, body } = item as { title?: unknown; body?: unknown };
    if (typeof body !== "string" || !body.trim()) return { ok: false, error: `${at} has no text` };
    if (body.length > MAX_EXAMPLE_BODY) return { ok: false, error: `${at} can be at most ${MAX_EXAMPLE_BODY.toLocaleString("en-US")} characters` };
    if (title !== undefined && title !== null && typeof title !== "string") return { ok: false, error: `${at} has a title that is not text` };
    const cleanTitle = (typeof title === "string" ? title : "").trim();
    if (cleanTitle.length > MAX_EXAMPLE_TITLE) return { ok: false, error: `${at} has a title longer than ${MAX_EXAMPLE_TITLE} characters` };
    examples.push({ title: cleanTitle, body: body.trim() });
  }
  return { ok: true, value: examples.length ? JSON.stringify(examples) : null };
}

function checkBudget(value: unknown): Checked<number | null> {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return { ok: false, error: "The monthly budget must be an amount above zero. Leave it empty for no budget." };
  if (value > MAX_BUDGET_USD) return { ok: false, error: `The monthly budget can be at most $${MAX_BUDGET_USD.toLocaleString("en-US")}` };
  return { ok: true, value: Math.round(value * 100) / 100 };
}

export const AI_CONFIG_FIELDS = ["default_model", "fallback_model", "tone", "system_prompt", "user_prompt", "email_examples", "linkedin_examples", "monthly_budget_usd"] as const;
export type AiConfigField = (typeof AI_CONFIG_FIELDS)[number];

/**
 * Save the settings named in `body` and leave the rest as they are. A field sent as null
 * (or an empty string) is cleared. Returns the fields that were sent, or why they could
 * not be saved.
 */
export function saveAiConfig(workspaceId: string, body: unknown): { ok: true; changed: AiConfigField[] } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send the settings to change as an object" };
  const input = body as Record<string, unknown>;
  const sent = AI_CONFIG_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(input, field));
  const current = readRow(workspaceId);
  const next: AiConfigRow = { ...current };

  for (const field of sent) {
    const value = input[field];
    let checked: Checked<string | number | null>;
    switch (field) {
      case "default_model":
        checked = checkModel(value, "The default model");
        break;
      case "fallback_model":
        checked = checkModel(value, "The fallback model");
        break;
      case "tone":
        checked = value === null || value === undefined || value === "" || value === "neutral"
          ? { ok: true, value: null }
          : isTone(value) ? { ok: true, value } : { ok: false, error: `The tone must be one of ${TONES.join(", ")}, or empty for none` };
        break;
      case "system_prompt":
        checked = checkPrompt(value, "The writing style", current.system_prompt);
        break;
      case "user_prompt":
        checked = checkPrompt(value, "The extra instructions", current.user_prompt);
        break;
      case "email_examples":
        checked = checkExamples(value, "Example emails");
        break;
      case "linkedin_examples":
        checked = checkExamples(value, "Example LinkedIn messages");
        break;
      case "monthly_budget_usd":
        checked = checkBudget(value);
        break;
    }
    if (!checked.ok) return checked;
    (next as unknown as Record<string, string | number | null>)[field] = checked.value;
  }

  getDb().prepare(
    `INSERT INTO workspace_ai_config (workspace_id, default_model, fallback_model, tone, system_prompt, user_prompt, email_examples, linkedin_examples, monthly_budget_usd, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(workspace_id) DO UPDATE SET default_model = excluded.default_model, fallback_model = excluded.fallback_model, tone = excluded.tone,
       system_prompt = excluded.system_prompt, user_prompt = excluded.user_prompt, email_examples = excluded.email_examples,
       linkedin_examples = excluded.linkedin_examples, monthly_budget_usd = excluded.monthly_budget_usd, updated_at = datetime('now')`,
  ).run(workspaceId, next.default_model, next.fallback_model, next.tone, next.system_prompt, next.user_prompt, next.email_examples, next.linkedin_examples, next.monthly_budget_usd);
  return { ok: true, changed: sent };
}
