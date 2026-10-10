// The one place that knows where OpenRouter is and what its answers look like.

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

/**
 * A full OpenRouter URL for a path such as "/chat/completions". OPENROUTER_BASE_URL
 * points every request somewhere else that speaks the same API: a gateway of your own,
 * or a stand-in on localhost when trying the app without spending anything.
 */
export function openrouterUrl(path: string): string {
  const base = (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** The part of the id before the slash: "anthropic", "openai" … */
  provider: string;
  /** US dollars per million tokens read. Null when OpenRouter gives no price. */
  input_price: number | null;
  /** US dollars per million tokens written. */
  output_price: number | null;
  context_length: number | null;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown } | null;
}

/** OpenRouter prices are strings in dollars per token ("0.000003"). A negative price is its marker for "varies". */
function perMillion(value: unknown): number | null {
  const perToken = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  return Number((perToken * 1_000_000).toFixed(4));
}

/** The models in an OpenRouter listing, by provider then name. Entries without an id or a name are dropped. */
export function modelsFromListing(payload: unknown): ModelInfo[] {
  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : null;
  if (!Array.isArray(data)) return [];
  return (data as RawModel[])
    .filter((model): model is RawModel & { id: string; name: string } => typeof model?.id === "string" && model.id !== "" && typeof model?.name === "string" && model.name !== "")
    .map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.id.split("/")[0] || "other",
      input_price: perMillion(model.pricing?.prompt),
      output_price: perMillion(model.pricing?.completion),
      context_length: typeof model.context_length === "number" && Number.isFinite(model.context_length) ? model.context_length : null,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

/** A request to OpenRouter that did not succeed, with the HTTP status when there was one (0: it never answered). */
export class OpenRouterError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

/**
 * Whether another model might succeed where this request failed: the model is
 * rate-limited (429), gone or has no provider serving it (404), timed out (408), or its
 * provider is failing (5xx), or OpenRouter never answered. A refused key (401), an
 * empty balance (402) or a malformed request (400) would fail the same way again.
 */
export function worthTryingAnotherModel(error: unknown): boolean {
  if (!(error instanceof OpenRouterError)) return false;
  return error.status === 0 || error.status === 404 || error.status === 408 || error.status === 429 || error.status >= 500;
}
