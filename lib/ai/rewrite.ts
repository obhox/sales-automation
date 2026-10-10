// Rewriting words a person has already written: the same message, said better. Unlike the
// writer that composes a message per contact at send time, this runs once, in the editor,
// and what comes back is still a template: its merge tags are kept exactly.
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { decryptSecret } from "@/lib/crypto";

type DB = DatabaseType.Database;

export const REWRITE_CHANNELS = ["email", "linkedin", "connect_note"] as const;
export type RewriteChannel = (typeof REWRITE_CHANNELS)[number];

export const REWRITE_STYLES = {
  improve: "Tighten it and make it read like one person writing to another. Keep the meaning and the ask.",
  shorter: "Make it clearly shorter. Keep the one ask and drop everything it can do without.",
  friendlier: "Make it warmer and more conversational, without flattery or exclamation marks.",
  more_direct: "Make it plainer and more direct: get to the point in the first sentence.",
} as const;
export type RewriteStyle = keyof typeof REWRITE_STYLES;

export interface RewriteInput {
  channel: RewriteChannel;
  body: string;
  subject?: string | null;
  style?: RewriteStyle;
  /** What the person asked for in their own words, in place of or on top of the style. */
  instruction?: string | null;
  model?: string | null;
  /** What the campaign is about, so the rewrite does not drift from it. */
  campaignContext?: string | null;
}

export interface RewriteResult {
  body: string;
  subject: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  /** Merge tags the model dropped or invented, if any: the text is returned anyway, for the person to judge. */
  tag_changes: { missing: string[]; added: string[] };
}

const LIMITS: Record<RewriteChannel, string> = {
  email: "It is a cold email. Plain text, short paragraphs, no markdown.",
  linkedin: "It is a LinkedIn direct message. Plain text, a few short sentences, no subject line, no markdown.",
  connect_note: "It is the note on a LinkedIn connection request. It must be 300 characters or fewer. Plain text, no markdown.",
};

const TAG = /\{\{[^{}]*\}\}/g;
const tagsOf = (text: string) => [...new Set((text.match(TAG) ?? []).map((tag) => tag.replace(/\s+/g, "").toLowerCase()))];

/** Why this cannot be rewritten, or null. */
export function rewriteProblem(input: Partial<RewriteInput>): string | null {
  if (!(REWRITE_CHANNELS as readonly unknown[]).includes(input.channel)) return `channel must be one of ${REWRITE_CHANNELS.join(", ")}`;
  if (typeof input.body !== "string" || !input.body.trim()) return "There is nothing to rewrite yet: write a first version";
  if (input.body.length > 8000) return "That is too long to rewrite in one go";
  if (input.style !== undefined && !(input.style in REWRITE_STYLES)) return `style must be one of ${Object.keys(REWRITE_STYLES).join(", ")}`;
  if (input.instruction != null && (typeof input.instruction !== "string" || input.instruction.length > 500)) return "instruction must be text of at most 500 characters";
  return null;
}

export function buildRewritePrompt(input: RewriteInput): string {
  return JSON.stringify({
    task: "rewrite",
    what_it_is: LIMITS[input.channel],
    how: [
      REWRITE_STYLES[input.style ?? "improve"],
      ...(input.instruction?.trim() ? [`The author also asks: ${input.instruction.trim()}`] : []),
      "Keep every {{merge_tag}} exactly as written, braces and all, including any {{tag|fallback}}. Do not add tags that are not in the original.",
      "Keep {choice|of|words} groups if there are any, as groups.",
      "Do not invent facts, names, numbers or claims that are not in the original.",
      "Write in the same language as the original.",
      input.channel === "email" && input.subject != null ? 'Return only valid JSON: {"subject":"…","body":"…"}.' : 'Return only valid JSON: {"body":"…"}.',
    ],
    campaign_context: input.campaignContext?.trim() || null,
    original: { ...(input.channel === "email" && input.subject != null ? { subject: input.subject } : {}), body: input.body },
  }, null, 2);
}

/** Read the model's answer. Exported for tests. */
export function parseRewrite(content: string, input: RewriteInput): { body: string; subject: string | null } {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: { subject?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(cleaned) as { subject?: unknown; body?: unknown };
  } catch {
    throw new Error("The model did not answer in the expected form. Try again, or pick another model.");
  }
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!body) throw new Error("The model returned nothing to use. Try again, or pick another model.");
  const subject = input.channel === "email" && input.subject != null ? (typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim() : input.subject) : null;
  return { body, subject };
}

/** Tags the rewrite lost or made up, compared with the original. */
export function tagChanges(before: string, after: string): { missing: string[]; added: string[] } {
  const was = tagsOf(before);
  const is = tagsOf(after);
  return { missing: was.filter((tag) => !is.includes(tag)), added: is.filter((tag) => !was.includes(tag)) };
}

/**
 * Rewrite a message with the workspace's own OpenRouter key and model. Throws a message
 * fit to show when the workspace has no key or model, or the model fails.
 * What it cost is recorded with the workspace's other AI use.
 */
export async function rewriteMessage(db: DB, workspaceId: string, input: RewriteInput): Promise<RewriteResult> {
  const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(workspaceId) as { api_key: string | null } | undefined;
  const apiKey = decryptSecret(integration?.api_key ?? null);
  if (!apiKey) throw new RewriteUnavailable("Add an OpenRouter API key under AI & models to use AI rewrite.");
  const model = input.model?.trim() || (db.prepare("SELECT default_model FROM workspace_ai_config WHERE workspace_id = ?").get(workspaceId) as { default_model: string | null } | undefined)?.default_model;
  if (!model) throw new RewriteUnavailable("Choose a default model under AI & models to use AI rewrite.");

  const prompt = buildRewritePrompt(input);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXTAUTH_URL || "http://localhost:3000",
      "X-OpenRouter-Title": "Linki",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You edit B2B outreach copy. You change wording, never facts. Return valid JSON only." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.5,
    }),
  });
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `The model could not be reached (${response.status})`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("The model returned nothing to use. Try again, or pick another model.");
  const rewritten = parseRewrite(content, input);
  const usage = { input_tokens: payload.usage?.prompt_tokens ?? 0, output_tokens: payload.usage?.completion_tokens ?? 0, cost_usd: typeof payload.usage?.cost === "number" ? payload.usage.cost : null };

  db.prepare("INSERT INTO agent_sessions (id, workspace_id, model, input_tokens, output_tokens, cost_usd, prompt, generated_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), workspaceId, model, usage.input_tokens, usage.output_tokens, usage.cost_usd, prompt, JSON.stringify(rewritten));

  return { ...rewritten, model, ...usage, tag_changes: tagChanges(`${input.subject ?? ""}\n${input.body}`, `${rewritten.subject ?? ""}\n${rewritten.body}`) };
}

/** The workspace has not set AI up. Not a failure of the model: the answer is a 400, with what to do. */
export class RewriteUnavailable extends Error {}
