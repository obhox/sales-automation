// What a Gemini call costs, worked out from a table, because Gemini does not say.
//
// OpenRouter returns `usage.cost` in dollars, which recordAiUsage stores and the monthly AI
// budget counts. Gemini returns token counts only. So this table is the difference between
// Gemini spend counting against a workspace's budget and it spending invisibly.
//
// Four things about Gemini's pricing make this more than a lookup, and each one is a way to
// be quietly wrong:
//
//   Prices change on a date. The Flash tier doubles on 2027-01-01 — already announced. A
//   table of single numbers would be correct today and 100% wrong on New Year's Day, with
//   nothing to notice it. So a model's price is a list of periods and the rate is chosen by
//   when the call happened.
//
//   Thinking tokens are billed as output, and they are ADDITIVE to candidatesTokenCount
//   rather than included in it. Every Gemini 3 model thinks by default, so ignoring them
//   under-bills every single call.
//
//   The Pro tier's rate steps at a 200k-token prompt — and the OUTPUT rate steps with it,
//   keyed on the size of the prompt rather than of the answer. A 250k-token prompt bills
//   its output at the higher rate too.
//
//   The service tier changes the rate. Flex and Batch are half of Standard, and the tier
//   that was actually applied comes back on the response, so that is what is keyed on
//   rather than what was asked for.
//
// Taken from https://ai.google.dev/gemini-api/docs/pricing, whose own footer read
// "Last updated 2026-10-09". A model absent from this table costs an honest null rather
// than a plausible wrong number: an under-counted budget is a known gap, while an invented
// figure is a wrong one nobody goes looking for.

/** Dollars per million tokens for one model over one span of time. */
export interface GeminiRate {
  /** First day this rate applies, inclusive. */
  from: string;
  input: number;
  output: number;
  /** The rate above LONG_PROMPT_TOKENS, for the models that step. Absent means flat. */
  long_input?: number;
  long_output?: number;
}

/** Where the Pro tiers' rate steps, measured on the PROMPT. */
export const LONG_PROMPT_TOKENS = 200_000;

/** The date the prices below were read from Google's pricing page. */
export const PRICES_READ_ON = "2026-10-09";

/** Periods are ordered oldest first; the last one that has started wins. */
export const GEMINI_RATES: Record<string, GeminiRate[]> = {
  // Announced increase from 2027-01-01, which is why this table has dates at all.
  "gemini-3.8-flash": [
    { from: "2026-01-01", input: 0.75, output: 3.75 },
    { from: "2027-01-01", input: 1.5, output: 7.5 },
  ],
  "gemini-3.6-flash": [
    { from: "2026-01-01", input: 0.75, output: 3.75 },
    { from: "2027-01-01", input: 1.5, output: 7.5 },
  ],
  "gemini-3.5-flash-lite": [{ from: "2026-01-01", input: 0.3, output: 2.5 }],
  "gemini-3.1-flash-lite": [{ from: "2026-01-01", input: 0.25, output: 1.5 }],
  "gemini-3-flash-preview": [{ from: "2026-01-01", input: 0.5, output: 3.0 }],
  "gemini-3.1-pro-preview": [{ from: "2026-01-01", input: 2.0, output: 12.0, long_input: 4.0, long_output: 18.0 }],
  // Still served, but Google limits these to keys that have used them before, so a new
  // workspace will probably not be able to choose one.
  "gemini-2.5-pro": [{ from: "2026-01-01", input: 1.25, output: 10.0, long_input: 2.5, long_output: 15.0 }],
  "gemini-2.5-flash": [{ from: "2026-01-01", input: 0.3, output: 2.5 }],
  "gemini-2.5-flash-lite": [{ from: "2026-01-01", input: 0.1, output: 0.4 }],
};

/** Flex and Batch are half price. Anything unrecognised is charged as Standard. */
const TIER_MULTIPLIER: Record<string, number> = { standard: 1, flex: 0.5, batch: 0.5, priority: 1 };

export interface GeminiUsage {
  prompt_tokens: number;
  /** The visible answer's tokens. */
  output_tokens: number;
  /** Reasoning tokens, billed as output and not counted inside output_tokens. */
  thinking_tokens?: number;
  /** Tokens served from an explicit cache, billed at the cached rate. */
  cached_tokens?: number;
  /** The tier the response says was applied, not the one requested. */
  service_tier?: string | null;
}

/** The rate for a model at a moment, or null when this model's price is not known here. */
export function rateFor(model: string, at: Date = new Date()): GeminiRate | null {
  const periods = GEMINI_RATES[model];
  if (!periods) return null;
  const day = at.toISOString().slice(0, 10);
  let chosen: GeminiRate | null = null;
  for (const period of periods) if (period.from <= day) chosen = period;
  // A call dated before the earliest period we know about: the oldest rate is the best
  // available answer, and refusing to price it would lose the cost for no gain.
  return chosen ?? periods[0] ?? null;
}

/**
 * What one call cost in dollars, or null when the model's price is not in the table.
 *
 * Cached input is priced at a tenth of fresh input, which is Google's published ratio
 * across every model in the table. The hourly storage charge that explicit caching also
 * incurs is NOT included: it is time-based and cannot be derived from one response's
 * token counts, so a workspace using explicit caching will see a slight under-count here.
 */
export function geminiCost(model: string, usage: GeminiUsage, at: Date = new Date()): number | null {
  const rate = rateFor(model, at);
  if (!rate) return null;

  const long = usage.prompt_tokens > LONG_PROMPT_TOKENS;
  const inputRate = long && rate.long_input !== undefined ? rate.long_input : rate.input;
  const outputRate = long && rate.long_output !== undefined ? rate.long_output : rate.output;
  const multiplier = TIER_MULTIPLIER[(usage.service_tier ?? "standard").toLowerCase()] ?? 1;

  const cached = Math.max(0, usage.cached_tokens ?? 0);
  const fresh = Math.max(0, usage.prompt_tokens - cached);
  // Thinking tokens are output and are not already inside output_tokens.
  const billableOutput = Math.max(0, usage.output_tokens) + Math.max(0, usage.thinking_tokens ?? 0);

  const dollars =
    (fresh / 1_000_000) * inputRate * multiplier +
    (cached / 1_000_000) * (inputRate / 10) * multiplier +
    (billableOutput / 1_000_000) * outputRate * multiplier;
  return Number(dollars.toFixed(6));
}

/** Whether this app knows what a model charges. For telling a workspace before it chooses. */
export function pricedModels(): string[] {
  return Object.keys(GEMINI_RATES).sort();
}
