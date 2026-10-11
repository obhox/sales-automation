// The hook line: one specific, true sentence about a contact's company, written from that
// company's own website, for a campaign to open with.
//
// This is the thing a careful operator does by hand and cannot do at volume — the Tier 1
// campaign in this workspace has forty founders each with a researched {{hook_line}},
// which is why it stopped at forty. Reading the page is Firecrawl's job; turning it into a
// sentence is the model's; keeping it honest is this module's.
//
// It writes to a custom field, not a new column, because the renderer already resolves
// {{hook_line}} against custom fields. So a hook written here is usable in every email,
// connect note, message and InMail with no change to the renderer or the campaign.
import type DatabaseType from "better-sqlite3";
import { askModel, worthTryingAnotherModel } from "@/lib/ai/openrouter";
import { assertWithinBudget, recordAiUsage } from "@/lib/ai/usage";
import { decryptSecret } from "@/lib/crypto";
import { ensureTextCustomField, writeTargetCustomText } from "@/lib/outreach/custom-values";
import { CREDITS_PER_PAGE, readPage, readableUrl } from "@/lib/research/firecrawl";
import { fetchPages } from "@/lib/research/tinyfish";
import { ResearchRefused, researchKey } from "@/lib/research/providers";

type DB = DatabaseType.Database;

/** The field a hook line is written to. Created on first use if the workspace has no such field. */
export const HOOK_FIELD_KEY = "hook_line";
export const HOOK_FIELD_NAME = "Hook line";
/** Contacts researched in one request. Each one reads a page and asks a model, so the request is slow. */
export const HOOK_BATCH = 5;
/** The most contacts one run will take on. */
export const MAX_HOOK_RUN = 500;
/** How much of a page the model is shown. Enough for the pitch, not the whole site. */
const PAGE_BUDGET = 6_000;

export type HookOutcome = "written" | "no_website" | "unreadable" | "no_hook";

/** A contact worth researching, and the address its hook would come from. */
export interface HookCandidate {
  id: string;
  full_name: string | null;
  company: string | null;
  website: string | null;
}

/**
 * Who among these contacts could gain a hook line, and from where.
 *
 * A contact is eligible when their company has a readable address. Their own LinkedIn
 * profile is deliberately not used: it is not a page a reader is allowed to fetch, and
 * asking anyway spends a credit to be refused.
 */
export function hookCandidates(db: DB, workspaceId: string, targetIds: string[]): HookCandidate[] {
  if (targetIds.length === 0) return [];
  const placeholders = targetIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT t.id AS id, t.full_name AS full_name,
           COALESCE(NULLIF(c.name, ''), t.company) AS company,
           COALESCE(NULLIF(c.website, ''), NULLIF(c.domain, '')) AS website
    FROM targets t LEFT JOIN companies c ON c.id = t.company_id
    WHERE t.workspace_id = ? AND t.id IN (${placeholders})
  `).all(workspaceId, ...targetIds) as HookCandidate[];
  return rows.map((row) => ({ ...row, website: readableUrl(row.website) }));
}

/** What a hook run would cost, before anything is spent. */
export interface HookCost {
  selected: number;
  eligible: number;
  eligible_ids: string[];
  no_website: number;
  /** Firecrawl credits: one page read a contact. */
  credits: number;
  batch: number;
}

export function hookCost(candidates: HookCandidate[], selected: number): HookCost {
  const eligible = candidates.filter((row) => row.website !== null);
  return {
    selected,
    eligible: eligible.length,
    eligible_ids: eligible.map((row) => row.id),
    no_website: candidates.length - eligible.length,
    credits: eligible.length * CREDITS_PER_PAGE,
    batch: HOOK_BATCH,
  };
}

const SYSTEM = [
  "You write one opening line for a cold B2B email, from a company's own website.",
  "The line must be specific to this company and true of the page you were given.",
  "Never invent a fact, a number, a customer or a product the page does not state.",
  "No flattery, no 'I came across your website', no exclamation marks, no em dashes.",
  "Return valid JSON only.",
].join(" ");

interface HookAnswer { hook: string | null; grounded_in: string | null }

/**
 * Ask the model for a hook line about one company.
 *
 * It is told it may decline: a page that says nothing specific should produce no hook
 * rather than a generic one, because a generic opener is worse than none — it reads as
 * automated to the one person it was meant to impress. `hook: null` is a valid answer and
 * is recorded as "no_hook", not as a failure.
 */
function buildPrompt(candidate: HookCandidate, markdown: string): string {
  return [
    `Company: ${candidate.company ?? "unknown"}`,
    `Contact: ${candidate.full_name ?? "unknown"}`,
    "",
    "Their website says:",
    markdown.slice(0, PAGE_BUDGET),
    "",
    'Answer with {"hook": "...", "grounded_in": "..."} where hook is one sentence of at most 20 words that could open an email to this person, and grounded_in quotes the words on the page it came from.',
    'If the page says nothing specific enough to earn a sentence, answer {"hook": null, "grounded_in": null}.',
  ].join("\n");
}

function parseHook(content: string): HookAnswer {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return { hook: null, grounded_in: null }; }
  if (!parsed || typeof parsed !== "object") return { hook: null, grounded_in: null };
  const row = parsed as Record<string, unknown>;
  const hook = typeof row.hook === "string" ? row.hook.trim() : "";
  return { hook: hook || null, grounded_in: typeof row.grounded_in === "string" ? row.grounded_in.trim() || null : null };
}

/** The workspace has not set up what a hook run needs. A 400 with what to do, not a failure. */
export class HookUnavailable extends Error {}

/**
 * Write a hook line for one contact.
 *
 * Firecrawl reads the page; if it refuses for lack of credits and TinyFish is connected,
 * TinyFish's free reader stands in rather than failing the contact. A refusal for any other
 * reason is thrown, because it will apply to every remaining contact too.
 */
export async function writeHookLine(
  db: DB,
  workspaceId: string,
  candidate: HookCandidate,
  context: { firecrawlKey: string | null; tinyfishKey: string | null; aiKey: string; model: string; fallbackModel: string | null; fieldId: string },
): Promise<HookOutcome> {
  if (!candidate.website) return "no_website";

  let page: { markdown: string } | null = null;
  try {
    page = context.firecrawlKey ? await readPage(candidate.website, context.firecrawlKey) : null;
  } catch (error) {
    const outOfCredits = error instanceof ResearchRefused && error.status === 402;
    if (!outOfCredits || !context.tinyfishKey) throw error;
    // Firecrawl is out of credits and TinyFish reads pages for nothing, so the run carries
    // on rather than stopping with contacts left unresearched.
    const read = await fetchPages([candidate.website], context.tinyfishKey);
    page = read.pages[0] ?? null;
  }
  if (!page && !context.firecrawlKey && context.tinyfishKey) {
    const read = await fetchPages([candidate.website], context.tinyfishKey);
    page = read.pages[0] ?? null;
  }
  if (!page?.markdown) return "unreadable";

  assertWithinBudget(workspaceId);
  const prompt = buildPrompt(candidate, page.markdown);
  let model = context.model;
  let answer;
  try {
    answer = await askModel(context.aiKey, model, { system: SYSTEM, user: prompt, temperature: 0.4 });
  } catch (error) {
    if (!context.fallbackModel || context.fallbackModel === model || !worthTryingAnotherModel(error)) throw error;
    model = context.fallbackModel;
    answer = await askModel(context.aiKey, model, { system: SYSTEM, user: prompt, temperature: 0.4 });
  }
  const hook = parseHook(answer.content);
  recordAiUsage({
    workspaceId, purpose: "research", model, targetId: candidate.id,
    inputTokens: answer.input_tokens, outputTokens: answer.output_tokens, costUsd: answer.cost_usd,
    usedFallback: model !== context.model, prompt, generatedText: JSON.stringify(hook),
  });

  // A page with nothing specific on it earns no sentence. A generic opener reads as
  // automated to the one person it was meant to land with, so none is written.
  if (!hook.hook) return "no_hook";
  writeTargetCustomText(db, workspaceId, candidate.id, context.fieldId, hook.hook);
  return "written";
}

/** Everything a run needs, read once, with a sentence saying what is missing when something is. */
export function hookContext(db: DB, workspaceId: string): {
  firecrawlKey: string | null; tinyfishKey: string | null; aiKey: string; model: string; fallbackModel: string | null; fieldId: string;
} {
  const firecrawlKey = researchKey(db, workspaceId, "firecrawl");
  const tinyfishKey = researchKey(db, workspaceId, "tinyfish");
  if (!firecrawlKey && !tinyfishKey) throw new HookUnavailable("Connect Firecrawl under Integrations to research contacts.");

  const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(workspaceId) as { api_key: string | null } | undefined;
  const aiKey = decryptSecret(integration?.api_key ?? null);
  if (!aiKey) throw new HookUnavailable("Add an OpenRouter API key under AI and models: a hook line is written by a model.");

  const config = db.prepare("SELECT default_model, fallback_model FROM workspace_ai_config WHERE workspace_id = ?").get(workspaceId) as { default_model: string | null; fallback_model: string | null } | undefined;
  const model = config?.default_model?.trim();
  if (!model) throw new HookUnavailable("Choose a default model under AI and models: a hook line is written by a model.");

  return {
    firecrawlKey, tinyfishKey, aiKey, model,
    fallbackModel: config?.fallback_model?.trim() || null,
    fieldId: ensureTextCustomField(db, workspaceId, { key: HOOK_FIELD_KEY, name: HOOK_FIELD_NAME }),
  };
}
