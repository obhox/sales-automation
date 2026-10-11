// Which service answers a model request, and with whose key.
//
// Every AI feature used to resolve the OpenRouter key itself — fourteen call sites, each
// with its own copy of the same SELECT and the same "add a key" sentence. A second provider
// would have meant fourteen copies of a second branch, so the resolution moves here once
// and the call sites ask for a model rather than for a key.
//
// A model id says which service it belongs to, by prefix:
//
//   google/gemini-2.5-pro    OpenRouter, which namespaces every model by its maker
//   anthropic/claude-...     OpenRouter
//   gemini/gemini-2.5-pro    the Gemini API directly, billed to the workspace's own Google key
//
// A prefix rather than a column, for three reasons: model ids are already plain TEXT in
// workspace_ai_config and workflow_steps, so nothing needs migrating and every id already
// stored keeps working; the model picker already groups by the prefix (modelsFromListing
// splits on "/"), so direct models group themselves; and "google/" versus "gemini/" is
// unambiguous, where a bare `gemini-2.5-pro` would be a guess about which service was meant.
import type DatabaseType from "better-sqlite3";
import { decryptSecret } from "@/lib/crypto";
import { askModel, worthTryingAnotherModel, type ModelAnswer } from "@/lib/ai/openrouter";
import { assertWithinBudget } from "@/lib/ai/usage";

type DB = DatabaseType.Database;

export const AI_PROVIDERS = ["openrouter", "gemini"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** The `integrations.key` each provider's secret is stored under. */
const KEY_NAME: Record<AiProvider, string> = { openrouter: "openrouter", gemini: "gemini" };

/** What a workspace is told to do when a provider it asked for is not set up. */
const MISSING: Record<AiProvider, string> = {
  openrouter: "Add an OpenRouter API key under AI & models.",
  gemini: "Add a Google Gemini API key under AI & models, or choose a model that runs through OpenRouter.",
};

/** The prefix that means "call this service directly rather than through OpenRouter". */
const DIRECT_PREFIX: Partial<Record<string, AiProvider>> = { gemini: "gemini" };

/** Which service a model id names. Anything unprefixed or namespaced by its maker is OpenRouter's. */
export function providerOf(modelId: string): AiProvider {
  const prefix = modelId.trim().toLowerCase().split("/")[0];
  return DIRECT_PREFIX[prefix] ?? "openrouter";
}

/**
 * The model name the chosen service's own API expects.
 *
 * OpenRouter wants the id whole, prefix included, because the prefix is part of the name it
 * knows. A direct service wants its own name without the prefix this app added to route it.
 */
export function providerModel(modelId: string): string {
  const id = modelId.trim();
  return providerOf(id) === "openrouter" ? id : id.slice(id.indexOf("/") + 1);
}

/** The workspace has not set up the provider the chosen model needs. A 400 with what to do. */
export class AiUnavailable extends Error {
  readonly provider: AiProvider;
  constructor(provider: AiProvider, message = MISSING[provider]) {
    super(message);
    this.name = "AiUnavailable";
    this.provider = provider;
  }
}

/** One provider's key for this workspace, or null when it is not connected. */
export function aiKey(db: DB, workspaceId: string, provider: AiProvider): string | null {
  const row = db.prepare("SELECT api_key FROM integrations WHERE key = ? AND workspace_id = ?")
    .get(KEY_NAME[provider], workspaceId) as { api_key: string | null } | undefined;
  return row?.api_key ? decryptSecret(row.api_key) : null;
}

/** Which AI providers this workspace has connected. For the screens that offer a model. */
export function aiConnected(db: DB, workspaceId: string): Record<AiProvider, boolean> {
  return { openrouter: aiKey(db, workspaceId, "openrouter") !== null, gemini: aiKey(db, workspaceId, "gemini") !== null };
}

/** Any provider at all, which is what "can this workspace use AI" means. */
export function anyAiConnected(db: DB, workspaceId: string): boolean {
  const connected = aiConnected(db, workspaceId);
  return connected.openrouter || connected.gemini;
}

export interface ResolvedModel {
  provider: AiProvider;
  /** The key for that provider. */
  apiKey: string;
  /** The name to send, with this app's routing prefix removed. */
  model: string;
  /** The id as stored, for recording what was used. */
  id: string;
}

/** Work out who to ask and with what, or say what is missing. Throws AiUnavailable. */
export function resolveModel(db: DB, workspaceId: string, modelId: string): ResolvedModel {
  const id = modelId.trim();
  if (!id) throw new AiUnavailable("openrouter", "Choose a default model under AI & models.");
  const provider = providerOf(id);
  const apiKey = aiKey(db, workspaceId, provider);
  if (!apiKey) throw new AiUnavailable(provider);
  return { provider, apiKey, model: providerModel(id), id };
}

export type AiPrompt = { system: string; user: string; temperature?: number };

/**
 * One request to whichever service the model belongs to, answered in one shape.
 *
 * The answer carries a dollar cost when the service reports one. OpenRouter does; the
 * Gemini API returns token counts only, so its cost is worked out from a price table and
 * marked as estimated — see lib/ai/gemini.ts. Callers hand that straight to recordAiUsage,
 * which is what the monthly budget counts, so a provider whose cost cannot be known would
 * otherwise spend invisibly.
 */
export async function askAi(db: DB, workspaceId: string, modelId: string, prompt: AiPrompt): Promise<ModelAnswer> {
  const resolved = resolveModel(db, workspaceId, modelId);
  if (resolved.provider === "openrouter") return askModel(resolved.apiKey, resolved.model, prompt);
  const { askGemini } = await import("@/lib/ai/gemini");
  return askGemini(resolved.apiKey, resolved.model, prompt);
}

export interface AskResult extends ModelAnswer {
  /** The model that answered, which is the fallback when the first choice was unavailable. */
  model: string;
  usedFallback: boolean;
}

/**
 * Ask the workspace's chosen model, trying its fallback if the first one will not answer.
 *
 * Every AI feature used to carry its own copy of this: read the key, read the config,
 * check the budget, ask, catch, maybe ask the fallback. Six copies meant six places for a
 * second provider to be forgotten, and the symptom of forgetting one is the worst kind —
 * a workspace that picked a Gemini model being told to add an OpenRouter key.
 *
 * The budget is checked here rather than in each caller, so no path can reach a provider
 * without having been counted. Recording what it cost stays with the caller, because the
 * purpose and the text worth storing differ by feature.
 */
export async function askWorkspaceModel(
  db: DB,
  workspaceId: string,
  options: { model?: string | null; system: string; user: string; temperature?: number; feature?: string },
): Promise<AskResult> {
  // A key before a model, in that order, because the model picker is populated from
  // whichever provider is connected: told to choose a model first, someone with no key at
  // all opens an empty list and learns nothing about why.
  const forFeature = options.feature ? ` to use ${options.feature}` : "";
  if (!anyAiConnected(db, workspaceId)) {
    throw new AiUnavailable("openrouter", `Add an OpenRouter or Google Gemini API key under AI & models${forFeature}.`);
  }
  const config = db.prepare("SELECT default_model, fallback_model FROM workspace_ai_config WHERE workspace_id = ?")
    .get(workspaceId) as { default_model: string | null; fallback_model: string | null } | undefined;
  const asked = options.model?.trim() || config?.default_model?.trim() || "";
  if (!asked) throw new AiUnavailable("openrouter", `Choose a default model under AI & models${forFeature}.`);
  assertWithinBudget(workspaceId);

  const prompt = { system: options.system, user: options.user, temperature: options.temperature };
  const fallback = config?.fallback_model?.trim() ?? "";
  try {
    return { ...(await askAi(db, workspaceId, asked, prompt)), model: asked, usedFallback: false };
  } catch (error) {
    // A fallback is for a model that would not answer. It is not a way around a provider
    // the workspace has not connected, or a budget it has used up — re-asking cannot fix
    // either, and quietly spending on a different provider is not a fallback, it is a
    // surprise on the bill.
    if (error instanceof AiUnavailable) throw error;
    if (!fallback || fallback === asked || !worthTryingAnotherModel(error)) throw error;
    return { ...(await askAi(db, workspaceId, fallback, prompt)), model: fallback, usedFallback: true };
  }
}
