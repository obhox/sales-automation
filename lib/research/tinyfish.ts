// TinyFish: the actor. Instead of an address it takes a goal, and its agent decides what to
// click, types into search boxes and walks pagination until it has the answer. For pages
// whose content does not exist until something has been done to them.
//
// Built against the TinyFish Web Agent API as documented on 2026-10-11. Four behaviours
// here are not guesses but defences against documented traps:
//
//   Steps are money. $0.016 each, and the account default ceiling is 150 — so an unbounded
//   goal can spend $2.40 on one contact. MAX_STEPS caps every run this module starts.
//
//   `COMPLETED` does not mean the goal was met; TinyFish says plainly that it means the
//   infrastructure worked. The result is inspected separately, and an empty result on a
//   COMPLETED run is reported as "nothing found", not as success.
//
//   The result is not uniformly shaped: an object lands at `result`, while a bare list or a
//   plain-text answer lands at `result.result`. Every run here sends an output_schema whose
//   top level is an object, which pins it to the first shape, and the reader tolerates both.
//
//   Async over sync. The synchronous endpoint has no documented timeout ceiling and cannot
//   be cancelled; run-async returns a run id (with HTTP 200, not 202) that can be polled and
//   cancelled, which is the only safe way to hold a multi-minute job.
import { ResearchRefused } from "@/lib/research/providers";

export function tinyfishUrl(path: string, env: Record<string, string | undefined> = process.env): string {
  const base = (env.TINYFISH_BASE_URL || "https://agent.tinyfish.ai/v1").replace(/\/$/, "");
  return `${base}${path}`;
}

export function tinyfishFetchUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.TINYFISH_FETCH_URL || "https://api.fetch.tinyfish.ai/").replace(/\/$/, "/");
}

/** Dollars a step, so a cost preview can quote a ceiling rather than a surprise. */
export const USD_PER_STEP = 0.016;
/** The most steps one run may take. Well under TinyFish's own default of 150. */
export const MAX_STEPS = 25;
/** What one capped run can cost at worst, for the cost preview. */
export const MAX_USD_PER_RUN = MAX_STEPS * USD_PER_STEP;
const MAX_RUN_SECONDS = 180;
const REQUEST_TIMEOUT_MS = 30_000;

interface ErrorBody {
  error?: { code?: string; message?: string; category?: string; retry_after?: number } | string;
  request_id?: string;
}

/**
 * A refusal. TinyFish answers "no money" as 402 on wallet accounts and 403 on older credit
 * ones, so both are read the same way rather than 403 being mistaken for a blocked site.
 */
function refusal(status: number, body: ErrorBody | null): ResearchRefused {
  const detail = typeof body?.error === "string" ? body.error : body?.error?.message?.trim();
  const why = status === 0 ? "it could not be reached"
    : status === 401 ? "the API key was not accepted"
      : status === 402 || status === 403 ? "the TinyFish wallet is empty"
        : status === 409 ? "it asked for the request to be retried"
          : status === 429 ? "too many requests at once; try again shortly"
            : status >= 500 ? `it answered ${status}`
              : detail || `it answered ${status}`;
  const retryable = status === 0 || status === 409 || status === 429 || status >= 500;
  return new ResearchRefused("tinyfish", status, `TinyFish could not be asked: ${why}`, retryable);
}

async function ask<T>(url: string, apiKey: string, body: unknown, method: "POST" | "GET" = "POST"): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      // The header name is case-sensitive on TinyFish's side.
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw refusal(0, null);
  }
  const payload = await response.json().catch(() => null) as (T & ErrorBody) | null;
  if (!response.ok) throw refusal(response.status, payload);
  return (payload ?? {}) as T;
}

// ── Reading pages (free tier) ────────────────────────────────────────────────────────────

interface FetchBody {
  results?: Array<{ url?: string; final_url?: string; title?: string | null; text?: string | null }>;
  errors?: Array<{ url?: string; code?: string; message?: string }>;
}

/**
 * Read up to ten pages. TinyFish charges nothing for this, which makes it a free fallback
 * for a page Firecrawl refused or ran out of credits on.
 *
 * Per-URL failures come back in `errors` with the request still a 200, so a partial answer
 * is the normal case: the pages that worked are returned and the rest reported, never
 * silently dropped and never failing the whole batch.
 */
export async function fetchPages(urls: string[], apiKey: string): Promise<{ pages: Array<{ url: string; final_url: string; title: string | null; markdown: string }>; failed: Array<{ url: string; reason: string }> }> {
  if (urls.length === 0) return { pages: [], failed: [] };
  if (urls.length > 10) throw new ResearchRefused("tinyfish", 400, "TinyFish reads at most ten addresses at a time");
  const body = await ask<FetchBody>(tinyfishFetchUrl(), apiKey, { urls, format: "markdown" });
  const pages = (body.results ?? []).flatMap((row) => {
    const markdown = row.text?.trim();
    if (!markdown || !row.url) return [];
    return [{ url: row.url, final_url: row.final_url || row.url, title: row.title?.trim() || null, markdown }];
  });
  const failed = (body.errors ?? []).map((row) => ({ url: row.url ?? "", reason: row.message || row.code || "unknown" }));
  return { pages, failed };
}

// ── Acting on pages (per-step billing) ──────────────────────────────────────────────────

export interface AgentRunStarted { run_id: string }

/**
 * Start an agent run. The output schema's top level must be an object, which is what keeps
 * the result at a predictable place; a list goes in a field of that object rather than
 * being the whole answer.
 */
export async function startAgentRun(
  input: { url: string; goal: string; schema: Record<string, unknown> },
  apiKey: string,
): Promise<AgentRunStarted> {
  const body = await ask<{ run_id?: string }>(tinyfishUrl("/automation/run-async"), apiKey, {
    url: input.url,
    goal: input.goal,
    output_schema: input.schema,
    agent_config: { mode: "default", max_steps: MAX_STEPS, max_duration_seconds: MAX_RUN_SECONDS },
    capture_config: { screenshots: false, html: false },
  });
  if (!body.run_id) throw new ResearchRefused("tinyfish", 0, "TinyFish started a run but did not say which one");
  return { run_id: body.run_id };
}

export type AgentRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface AgentRunState {
  status: AgentRunStatus;
  /** What the agent returned, once it is COMPLETED. Null when it has nothing. */
  result: unknown | null;
  steps: number;
  /** Dollars this run has cost so far, derived from its steps. */
  cost_usd: number;
  /** Why it failed, in a sentence, when it did. */
  error: string | null;
  /** The provider's own fault and worth retrying, as opposed to a bad goal or no money. */
  retryable: boolean;
}

interface RunBody {
  status?: string;
  result?: unknown;
  num_of_steps?: number | null;
  error?: { code?: string; message?: string; category?: string } | null;
}

/**
 * A run-level failure arrives inside a 200 body rather than as an HTTP error, so this reads
 * the body's own status and never assumes a successful request means a successful run.
 *
 * `error.category` is what retry decisions hang on: SYSTEM_FAILURE and UNKNOWN are
 * TinyFish's problem, while AGENT_FAILURE means the goal was wrong and BILLING_FAILURE
 * means the wallet is empty — neither improves on a retry.
 */
export async function agentRunState(runId: string, apiKey: string): Promise<AgentRunState> {
  const body = await ask<RunBody>(tinyfishUrl(`/runs/${encodeURIComponent(runId)}?screenshots=none&html=none`), apiKey, null, "GET");
  const raw = String(body.status ?? "").toLowerCase();
  const status: AgentRunStatus = raw === "completed" || raw === "failed" || raw === "cancelled" || raw === "running" ? raw : "pending";
  const category = body.error?.category ?? null;
  const steps = typeof body.num_of_steps === "number" ? body.num_of_steps : 0;
  return {
    status,
    result: readResult(body.result),
    steps,
    cost_usd: Number((steps * USD_PER_STEP).toFixed(4)),
    error: body.error ? body.error.message || body.error.code || "The run failed" : null,
    retryable: category === "SYSTEM_FAILURE" || category === "UNKNOWN",
  };
}

/**
 * An object answer sits at `result`; a list or a plain-text one is nested at `result.result`.
 * Both are accepted so a schema drifting between shapes cannot turn a good answer into null.
 */
function readResult(result: unknown): unknown | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "object" && !Array.isArray(result) && "result" in (result as Record<string, unknown>)) {
    const inner = (result as Record<string, unknown>).result;
    if (inner !== undefined && inner !== null) return inner;
  }
  return result;
}

/** Stop a run. Idempotent on TinyFish's side, so calling it on a finished run is harmless. */
export async function cancelAgentRun(runId: string, apiKey: string): Promise<void> {
  await ask(tinyfishUrl(`/runs/${encodeURIComponent(runId)}/cancel`), apiKey, {});
}
