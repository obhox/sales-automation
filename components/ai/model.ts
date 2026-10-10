// What the AI & models screen knows and how it words it. No React in here, so the
// wording and the sums can be tested.
import type { AiConfigView, AiExample, Tone } from "@/lib/ai/config";
import type { ModelInfo } from "@/lib/ai/openrouter";
import type { AiCampaign, AiStep, WritableStepType } from "@/lib/ai/steps";
import type { BudgetState, Purpose, UsageOverview } from "@/lib/ai/usage";
import type { AiOverview } from "@/pages/api/ai/overview";
import type { AiTestResult } from "@/pages/api/ai/test";
import { parseTime, plural } from "@/lib/client/format";
import type { Tone as PillTone } from "@/components/ui";

export type { AiCampaign, AiConfigView, AiExample, AiOverview, AiStep, AiTestResult, BudgetState, ModelInfo, Purpose, Tone, UsageOverview, WritableStepType };

export const OVERVIEW_PATH = "/api/ai/overview";
export const MODELS_PATH = "/api/openrouter/models";
export const STEPS_PATH = "/api/ai/steps";

// The limits the server enforces, repeated here so a field can say so before it is sent.
export const MAX_PROMPT = 2000;
export const MAX_EXAMPLES = 12;
export const MAX_EXAMPLE_TITLE = 80;
export const MAX_EXAMPLE_BODY = 4000;
export const MAX_STEP_PROMPT = 1000;
export const MAX_STEP_WORDS = 1000;

// ── Money ─────────────────────────────────────────────────────────────────────

/** 38.416 → "$38.42". An amount under a cent that is not nothing reads "<$0.01". */
export function formatUsd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  if (amount > 0 && amount < 0.005) return "<$0.01";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What one request cost: fractions of a cent matter here. 0.0031 → "$0.0031". */
export function formatRequestCost(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "not reported";
  if (amount === 0) return "$0.00";
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

/** A price per million tokens: "$5.00", "$0.075", "free". */
export function formatPrice(price: number | null): string {
  if (price === null) return "varies";
  if (price === 0) return "free";
  return `$${price < 0.1 ? price.toFixed(3) : price.toFixed(2)}`;
}

/** "$5.00 / $25.00 per 1M tokens": what a model costs to read and to write. Null when there is no price to show. */
export function priceLine(model: ModelInfo | undefined): string | null {
  if (!model || (model.input_price === null && model.output_price === null)) return null;
  if (model.input_price === 0 && model.output_price === 0) return "Free";
  return `${formatPrice(model.input_price)} / ${formatPrice(model.output_price)} per 1M tokens`;
}

// ── Models ────────────────────────────────────────────────────────────────────

const PROVIDER_NAME: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", mistralai: "Mistral", mistral: "Mistral", "meta-llama": "Meta", deepseek: "DeepSeek",
  qwen: "Qwen", alibaba: "Alibaba", cohere: "Cohere", "x-ai": "xAI", perplexity: "Perplexity", openrouter: "OpenRouter", amazon: "Amazon", microsoft: "Microsoft", nvidia: "NVIDIA",
};
// The providers most workspaces pick from come first; the rest follow by name.
const PROVIDER_ORDER = ["anthropic", "openai", "google", "mistralai", "meta-llama"];

export function providerName(provider: string): string {
  return PROVIDER_NAME[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** A model's name for a person: its listed name, or the id when the list does not have it. */
export function modelName(id: string | null, models: ModelInfo[]): string {
  if (!id) return "";
  const listed = models.find((model) => model.id === id);
  // OpenRouter names read "Anthropic: Claude Haiku 5.5"; the provider is shown separately.
  return listed ? listed.name.replace(/^[^:]{2,24}:\s+/, "") : id;
}

export interface ModelGroup {
  provider: string;
  name: string;
  models: ModelInfo[];
}

/** The models matching what was typed, grouped by provider. Every word typed must appear in the name or the id. */
export function groupModels(models: ModelInfo[], search: string): ModelGroup[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = words.length === 0 ? models : models.filter((model) => words.every((word) => `${model.name} ${model.id}`.toLowerCase().includes(word)));
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of matching) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  const rank = (provider: string) => (PROVIDER_ORDER.includes(provider) ? PROVIDER_ORDER.indexOf(provider) : PROVIDER_ORDER.length);
  return [...byProvider.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || providerName(a).localeCompare(providerName(b)))
    .map(([provider, list]) => ({ provider, name: providerName(provider), models: list }));
}

// ── The settings being edited ─────────────────────────────────────────────────

/** The settings as the form holds them. The budget is text while it is being typed. */
export interface Draft {
  default_model: string | null;
  fallback_model: string | null;
  tone: Tone | null;
  system_prompt: string;
  user_prompt: string;
  email_examples: AiExample[];
  linkedin_examples: AiExample[];
  budget: string;
}

export function draftFrom(config: AiConfigView): Draft {
  return {
    default_model: config.default_model, fallback_model: config.fallback_model, tone: config.tone,
    system_prompt: config.system_prompt, user_prompt: config.user_prompt,
    email_examples: config.email_examples, linkedin_examples: config.linkedin_examples,
    budget: config.monthly_budget_usd === null ? "" : String(config.monthly_budget_usd),
  };
}

/** The budget typed, as a number. `undefined` when what was typed is not an amount. */
export function parseBudget(text: string): number | null | undefined {
  const clean = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (clean === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return undefined;
  const amount = Number(clean);
  return amount > 0 ? amount : undefined;
}

const sameExamples = (a: AiExample[], b: AiExample[]) => a.length === b.length && a.every((example, index) => example.title === b[index].title && example.body === b[index].body);

/** Only what differs from what is saved, in the shape the settings route takes. */
export function changes(draft: Draft, saved: AiConfigView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (draft.default_model !== saved.default_model) out.default_model = draft.default_model;
  if (draft.fallback_model !== saved.fallback_model) out.fallback_model = draft.fallback_model;
  if (draft.tone !== saved.tone) out.tone = draft.tone;
  if (draft.system_prompt !== saved.system_prompt) out.system_prompt = draft.system_prompt;
  if (draft.user_prompt !== saved.user_prompt) out.user_prompt = draft.user_prompt;
  if (!sameExamples(draft.email_examples, saved.email_examples)) out.email_examples = draft.email_examples;
  if (!sameExamples(draft.linkedin_examples, saved.linkedin_examples)) out.linkedin_examples = draft.linkedin_examples;
  const budget = parseBudget(draft.budget);
  // Something typed that is not an amount is still a change: saving is what reports it.
  if (budget === undefined || budget !== saved.monthly_budget_usd) out.monthly_budget_usd = budget === undefined ? draft.budget : budget;
  return out;
}

/** Why the draft cannot be saved as it stands, or null. The server checks again. */
export function draftProblem(draft: Draft, saved: AiConfigView): string | null {
  if (draft.system_prompt.length > MAX_PROMPT && draft.system_prompt !== saved.system_prompt) return `The writing style can be at most ${MAX_PROMPT.toLocaleString("en-US")} characters.`;
  if (draft.user_prompt.length > MAX_PROMPT && draft.user_prompt !== saved.user_prompt) return `The extra instructions can be at most ${MAX_PROMPT.toLocaleString("en-US")} characters.`;
  if (parseBudget(draft.budget) === undefined) return "The monthly budget must be an amount above zero, such as 100 or 49.50. Leave it empty for no budget.";
  return null;
}

/** What the test route is sent so it writes with the settings on screen, saved or not. */
export function draftForTest(draft: Draft): Record<string, unknown> {
  return {
    fallback_model: draft.fallback_model, tone: draft.tone, system_prompt: draft.system_prompt || null, user_prompt: draft.user_prompt || null,
    email_examples: draft.email_examples, linkedin_examples: draft.linkedin_examples,
  };
}

export const TONE_OPTIONS: Array<{ value: Tone | "neutral"; label: string }> = [
  { value: "neutral", label: "Neutral" },
  { value: "direct", label: "Direct" },
  { value: "warm", label: "Warm" },
  { value: "formal", label: "Formal" },
];

export const TONE_NOTE: Record<Tone | "neutral", string> = {
  neutral: "No tone is asked for: the writer follows the style below and nothing else.",
  direct: "Gets to the point in the first sentence, plain words, one clear ask.",
  warm: "Friendly and unhurried, one person to another, without flattery.",
  formal: "Complete sentences and a professional register, no slang or contractions.",
};

/** Tags a prompt can name. The writer is given the contact's details and fills them in. */
export const PROMPT_TAGS = ["{{first_name}}", "{{company}}", "{{title}}"] as const;

// ── Steps ─────────────────────────────────────────────────────────────────────

/** "Email 1 · opener", "Email 2 · follow-up", "LinkedIn message 1", "InMail". */
export function stepName(step: Pick<AiStep, "step_type" | "number">): string {
  if (step.step_type === "email") return `Email ${step.number} · ${step.number === 1 ? "opener" : "follow-up"}`;
  if (step.step_type === "message") return `LinkedIn message ${step.number}`;
  return step.number === 1 ? "InMail" : `InMail ${step.number}`;
}

export const stepChannel = (step: Pick<AiStep, "step_type">): "email" | "linkedin" => (step.step_type === "email" ? "email" : "linkedin");

export const LANGUAGES = ["English", "German", "French", "Spanish", "Dutch", "Italian", "Portuguese", "Swedish", "Danish", "Norwegian", "Finnish", "Polish"];

// ── Spend ─────────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10" → "October". */
export function monthName(key: string): string {
  return MONTH_NAMES[Number(key.slice(5, 7)) - 1] ?? key;
}

/** "2026-11-01" → "1 November". */
export function dayOfMonth(date: string): string {
  return `${Number(date.slice(8, 10))} ${monthName(date)}`;
}

/** "2026-10-09" → "09 Oct", for the ends of the daily chart. */
export function shortDay(date: string): string {
  return `${date.slice(8, 10)} ${monthName(date).slice(0, 3)}`;
}

export interface SpendChange {
  label: string;
  direction: "up" | "down" | "flat";
}

/** This month so far against the same days of last month. Null when last month had nothing to compare with. */
export function spendChange(month: UsageOverview["month"]): SpendChange | null {
  if (month.previous_usd === null || month.previous_usd <= 0) return null;
  const ratio = (month.spent_usd - month.previous_usd) / month.previous_usd;
  const percent = Math.round(ratio * 100);
  if (percent === 0) return { label: "0%", direction: "flat" };
  return { label: `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`, direction: percent > 0 ? "up" : "down" };
}

export const PURPOSE_LABEL: Record<Purpose, string> = {
  email_opener: "Email openers",
  email_followup: "Email follow-ups",
  linkedin_message: "LinkedIn messages",
  inmail: "InMails",
  classification: "Reply classification",
  rewrite: "Rewrites in the editor",
  test: "Tests and previews",
  other: "Steps since removed",
};

export const PURPOSE_TONE: Record<Purpose, PillTone> = {
  email_opener: "mail", email_followup: "mail", linkedin_message: "li", inmail: "li", classification: "brand", rewrite: "brand", test: "neutral", other: "neutral",
};

/** What is counted under a row of the breakdown: replies for classification, generations for writing. */
export function requestsNote(purpose: Purpose | null, requests: number): string {
  if (purpose === "classification") return `${requests.toLocaleString("en-US")} ${plural(requests, "reply", "replies")}`;
  if (purpose === null) return `${requests.toLocaleString("en-US")} ${plural(requests, "request", "requests")}`;
  return `${requests.toLocaleString("en-US")} ${plural(requests, "generation", "generations")}`;
}

export interface BudgetView {
  tone: PillTone;
  /** 0 to 1, for the meter. */
  share: number;
  note: string;
}

/** How the budget reads under the meter. */
export function budgetView(budget: BudgetState): BudgetView | null {
  if (budget.budget_usd === null) return null;
  const share = Math.min(1, budget.spent_usd / budget.budget_usd);
  const resets = dayOfMonth(budget.resets_on);
  if (budget.reached) return { tone: "bad", share: 1, note: `Used up. Steps written by AI wait until it is raised or ${resets}.` };
  if (share >= 0.8) return { tone: "warn", share, note: `${Math.round(share * 100)}% used. Steps written by AI wait once it is reached. Starts again ${resets}.` };
  return { tone: "brand", share, note: `Steps written by AI wait once it is reached. Starts again ${resets}.` };
}

/** "last used 4 min ago" from SQLite's UTC timestamp. */
export function lastUsed(at: string | null, relative: (value: Date) => string): string {
  const date = parseTime(at);
  return date ? `last used ${relative(date)}` : "not used yet";
}
