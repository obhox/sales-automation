// The Gemini API, called directly rather than through OpenRouter.
//
// Written against the v1beta generateContent surface as documented on 2026-10-11. Google's
// docs now lead with a newer Interactions API, but say plainly that generateContent is what
// to use for stable production, so that is what this calls.
//
// Four of Gemini's behaviours are traps a naive client falls into, and each one is handled
// deliberately rather than discovered later:
//
//   A thought summary arrives as a text part alongside the answer, marked `thought: true`.
//   Joining every part — the obvious thing to do — feeds the model's reasoning into
//   JSON.parse along with the JSON, and every caller here parses the answer.
//
//   A refusal is an HTTP 200. A blocked prompt comes back with no candidates at all and a
//   promptFeedback.blockReason; a refusal mid-answer comes back with a finishReason and
//   possibly no parts. Neither is an HTTP error, so the error handler never sees them, and
//   a client that only checks res.ok reports "returned nothing" for all of them.
//
//   An invalid API key is a 400, not a 401, because 400 also means "your request body is
//   wrong". Telling them apart needs details[].reason, and conflating them makes a missing
//   key look like a bug in this code.
//
//   Thinking tokens are billed as output and are additive to candidatesTokenCount. They are
//   passed to the cost table separately for that reason — see lib/ai/gemini-prices.ts.
import { OpenRouterError, type ModelAnswer } from "@/lib/ai/openrouter";
import { geminiCost } from "@/lib/ai/gemini-prices";

/** Overridable so tests can point at a local stand-in. */
export function geminiUrl(path: string, env: Record<string, string | undefined> = process.env): string {
  const base = (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  return `${base}${path}`;
}

const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Covers thinking AND the visible answer together, so this cannot be tight: a small ceiling
 * spends the budget on reasoning and then truncates the JSON the caller needs.
 */
const MAX_OUTPUT_TOKENS = 8_192;
/**
 * Every Gemini 3 model reasons by default, at a level that costs output tokens. These
 * callers want a sentence or a small object, not deliberation, so it is turned down — but
 * not off: "minimal" is rejected outright by gemini-3.8-flash.
 */
const THINKING_LEVEL = "low";

interface Part { text?: string; thought?: boolean }
interface GeminiBody {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string; finishMessage?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number;
    cachedContentTokenCount?: number; totalTokenCount?: number; serviceTier?: string;
  };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string; details?: Array<{ reason?: string }> };
}

/** The model declined, or stopped before it finished. Not a transport failure. */
export class GeminiDeclined extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "GeminiDeclined";
    this.reason = reason;
  }
}

/** Reasons that mean the content was refused rather than the request mishandled. */
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "LANGUAGE"]);

/**
 * A refusal, mapped onto the error type OpenRouter failures already use.
 *
 * Reusing OpenRouterError is deliberate rather than lazy: worthTryingAnotherModel decides
 * whether a workspace's fallback model is worth trying, and it branches on that type. A
 * Gemini-only error class would make every fallback stop working the moment someone chose
 * a Gemini model — silently, because falling back is invisible when it works.
 */
function refusal(status: number, body: GeminiBody | null): OpenRouterError {
  const said = body?.error?.message?.trim();
  const badKey = body?.error?.details?.some((detail) => detail.reason === "API_KEY_INVALID") ?? false;
  const why = status === 0 ? "it could not be reached"
    : badKey ? "the API key was not accepted"
      : status === 403 ? "the API key is not allowed to use this model"
        : status === 402 ? "the Google account's prepaid balance is used up"
          : status === 429 ? "its rate or spend limit is used up; try again shortly"
            : status >= 500 ? `it answered ${status}`
              : said || `it answered ${status}`;
  return new OpenRouterError(status, `Gemini could not be asked: ${why}`);
}

/** The answer's text, with the model's own reasoning left out of it. */
export function answerText(parts: Part[] | undefined): string {
  return (parts ?? [])
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/** One request to one Gemini model, answered in the shape every caller already handles. */
export async function askGemini(
  apiKey: string,
  model: string,
  prompt: { system: string; user: string; temperature?: number },
  now: Date = new Date(),
): Promise<ModelAnswer> {
  let response: Response;
  try {
    response = await fetch(geminiUrl(`/models/${encodeURIComponent(model)}:generateContent`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: {
          temperature: prompt.temperature ?? 0.5,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // Asked for by mime type rather than in words: a model told only in prose will
          // sometimes wrap its JSON in an explanation, and every caller here parses it.
          responseFormat: { text: { mimeType: "application/json" } },
          thinkingConfig: { thinkingLevel: THINKING_LEVEL },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Includes this client's own timeout, which Google sees as a cancelled request and
    // answers with no usage at all, so such a call has no recoverable cost.
    throw refusal(0, null);
  }
  const payload = await response.json().catch(() => null) as GeminiBody | null;
  if (!response.ok) throw refusal(response.status, payload);

  // A blocked prompt: 200, no candidates, a reason on promptFeedback.
  const blockedPrompt = payload?.promptFeedback?.blockReason;
  if (blockedPrompt && !payload?.candidates?.length) {
    throw new GeminiDeclined(blockedPrompt, `Gemini would not answer this prompt (${blockedPrompt}). Rewording it, or another model, may work.`);
  }

  const candidate = payload?.candidates?.[0];
  const content = answerText(candidate?.content?.parts);
  const finish = candidate?.finishReason ?? "";
  if (!content) {
    if (BLOCKED.has(finish)) throw new GeminiDeclined(finish, `Gemini stopped answering (${finish}).${candidate?.finishMessage ? ` ${candidate.finishMessage}` : ""}`);
    // The ceiling was spent on reasoning before any answer was written. Worth another go.
    if (finish === "MAX_TOKENS") throw new GeminiDeclined(finish, "Gemini ran out of room before answering. Try again, or pick another model.");
    throw new GeminiDeclined(finish || "EMPTY", "Gemini returned nothing to use. Try again, or pick another model.");
  }

  const usage = payload?.usageMetadata;
  const outputTokens = usage?.candidatesTokenCount ?? 0;
  const thinkingTokens = usage?.thoughtsTokenCount ?? 0;
  const promptTokens = usage?.promptTokenCount ?? 0;
  // modelVersion is what actually served the call, which is what to price: an alias can
  // resolve to a model on a different rate.
  const priced = payload?.modelVersion?.trim() || model;

  return {
    content,
    input_tokens: promptTokens,
    // Reported as it is billed, so the recorded tokens and the recorded cost agree.
    output_tokens: outputTokens + thinkingTokens,
    cost_usd: geminiCost(priced, {
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      thinking_tokens: thinkingTokens,
      cached_tokens: usage?.cachedContentTokenCount ?? 0,
      service_tier: usage?.serviceTier ?? null,
    }, now),
  };
}

export interface GeminiModel { id: string; name: string; context: number | null }

/**
 * The models this key may use, named as this app routes them (`gemini/…`).
 *
 * Only those that can generate are offered, and the `-latest` aliases are left out: they
 * are hot-swapped with two weeks' notice, and for a feature that prices what it spends a
 * model changing underneath its own name would change the bill without changing the setting.
 */
export async function geminiModels(apiKey: string): Promise<GeminiModel[]> {
  let response: Response;
  try {
    response = await fetch(geminiUrl("/models?pageSize=200"), {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw refusal(0, null);
  }
  const payload = await response.json().catch(() => null) as { models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }> } & GeminiBody | null;
  if (!response.ok) throw refusal(response.status, payload);

  return (payload?.models ?? []).flatMap((row) => {
    const bare = (row.name ?? "").replace(/^models\//, "").trim();
    if (!bare || bare.endsWith("-latest")) return [];
    const methods = row.supportedGenerationMethods ?? [];
    if (methods.length > 0 && !methods.includes("generateContent")) return [];
    return [{ id: `gemini/${bare}`, name: row.displayName?.trim() || bare, context: row.inputTokenLimit ?? null }];
  });
}
