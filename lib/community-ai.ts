import { getDb } from "@/lib/db";
import { TONE_INSTRUCTION, examplesForPrompt, isTone } from "@/lib/ai/config";
import { OpenRouterError, openrouterUrl, worthTryingAnotherModel } from "@/lib/ai/openrouter";
import { assertWithinBudget, recordAiUsage, type Purpose } from "@/lib/ai/usage";

type Channel = "message" | "email" | "sales_inmail";

export interface CommunityAiParams {
  apiKey: string;
  model: string;
  stepType: Channel;
  stepPrompt?: string;
  maxWords?: number;
  language?: string;
  campaignPrompt?: string;
  contact: Record<string, unknown>;
  company?: Record<string, unknown> | null;
  agentConfig?: Record<string, unknown>;
  previousMessageContext?: { followupNumber: number; previousMessage: string };
  followupContext?: { followupNumber: number; previousSubject: string; previousBody: string };
  replyContext?: string;
  runId?: string;
  targetId?: string;
  stepId?: string;
  /** The workspace to record the request against, when no contact or run says which. */
  workspaceId?: string;
  /** What the request is for. Left out, it is worked out from the step, and anything outside a campaign run is a test. */
  purpose?: Exclude<Purpose, "other">;
}

export interface CommunityAiResult {
  subject?: string;
  body: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  /** The model that wrote it: the one asked for, or the fallback. */
  model: string;
  used_fallback: boolean;
}

interface OpenRouterResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
  error?: { message?: string };
}

function compactRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== null && field !== "" && field !== undefined),
  );
}

export function buildPrompt(params: CommunityAiParams): string {
  const outputShape = params.stepType === "message"
    ? '{"body":"personalized LinkedIn message"}'
    : '{"subject":"concise subject","body":"personalized message body"}';

  const tone = params.agentConfig?.tone;
  const instructions = [
    "Write concise, natural B2B outreach that sounds like a thoughtful human.",
    "Use only facts supplied in the contact and company context; never invent achievements, events, or relationships.",
    "Avoid hype, generic compliments, fake familiarity, and unsupported claims.",
    `Write in ${params.language || "English"}.`,
    params.maxWords ? `Keep the body at or below ${params.maxWords} words.` : "Keep the body brief.",
    // A workspace that has chosen no tone gets the instructions exactly as they always were.
    ...(isTone(tone) ? [TONE_INSTRUCTION[tone]] : []),
    `Return only valid JSON matching ${outputShape}.`,
  ];

  return JSON.stringify({
    task: params.stepType,
    instructions,
    campaign_context: params.campaignPrompt || null,
    step_instruction: params.stepPrompt || null,
    global_system_prompt: params.agentConfig?.system_prompt || null,
    global_user_prompt: params.agentConfig?.user_prompt || null,
    contact: compactRecord(params.contact),
    company: compactRecord(params.company),
    previous_linkedin_message: params.previousMessageContext || null,
    previous_email: params.followupContext || null,
    reply_context: params.replyContext || null,
    examples: {
      email: examplesForPrompt(params.agentConfig?.email_examples),
      linkedin: examplesForPrompt(params.agentConfig?.linkedin_examples),
    },
  }, null, 2);
}

function parseModelJson(content: string, stepType: Channel): { subject?: string; body: string } {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: { subject?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(cleaned) as { subject?: unknown; body?: unknown };
  } catch {
    if (stepType === "message" && cleaned) return { body: cleaned };
    throw new Error("The selected model did not return valid JSON");
  }

  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : undefined;
  if (!body) throw new Error("The selected model returned an empty message");
  if (stepType !== "message" && !subject) throw new Error("The selected model returned no subject");
  return { subject, body };
}

interface Completion {
  parsed: { subject?: string; body: string };
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
}

/** One request to one model. Throws OpenRouterError when the request itself fails. */
async function requestCompletion(params: CommunityAiParams, model: string, prompt: string): Promise<Completion> {
  let response: Response;
  try {
    response = await fetch(openrouterUrl("/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXTAUTH_URL || "http://localhost:3000",
        "X-OpenRouter-Title": "Linki Community",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are an expert B2B outbound copywriter. Return valid JSON only." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
      }),
    });
  } catch (error) {
    throw new OpenRouterError(0, `OpenRouter could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  const payload = await response.json().catch(() => ({})) as OpenRouterResponse;
  if (!response.ok) {
    throw new OpenRouterError(response.status, payload.error?.message || `OpenRouter request failed (${response.status})`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  return {
    parsed: parseModelJson(content, params.stepType),
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
    cost: typeof payload.usage?.cost === "number" ? payload.usage.cost : null,
  };
}

function workspaceOf(params: CommunityAiParams): string | null {
  if (params.workspaceId) return params.workspaceId;
  const db = getDb();
  if (params.targetId) return (db.prepare("SELECT workspace_id FROM targets WHERE id=?").get(params.targetId) as { workspace_id: string } | undefined)?.workspace_id ?? null;
  if (params.runId) return (db.prepare("SELECT workspace_id FROM runs WHERE id=?").get(params.runId) as { workspace_id: string } | undefined)?.workspace_id ?? null;
  return null;
}

function purposeOf(params: CommunityAiParams): Exclude<Purpose, "other"> {
  if (params.purpose) return params.purpose;
  // Only the runner names a run. Anything else is someone trying the writer out.
  if (!params.runId) return "test";
  if (params.stepType === "email") return params.followupContext ? "email_followup" : "email_opener";
  return params.stepType === "message" ? "linkedin_message" : "inmail";
}

/**
 * Write one message. The workspace's monthly budget is checked first: with the budget
 * used up this throws AiBudgetReachedError and nothing is sent to OpenRouter. If the
 * model asked for is rate-limited or unavailable and the workspace has a fallback model,
 * that is tried once.
 */
export async function generateCommunityContent(params: CommunityAiParams): Promise<CommunityAiResult> {
  const workspaceId = workspaceOf(params);
  if (workspaceId) assertWithinBudget(workspaceId);

  const prompt = buildPrompt(params);
  const fallback = typeof params.agentConfig?.fallback_model === "string" ? params.agentConfig.fallback_model.trim() : "";
  let model = params.model;
  let usedFallback = false;
  let completion: Completion;
  try {
    completion = await requestCompletion(params, model, prompt);
  } catch (error) {
    if (!fallback || fallback === params.model || !worthTryingAnotherModel(error)) throw error;
    model = fallback;
    usedFallback = true;
    completion = await requestCompletion(params, model, prompt);
  }
  const { parsed, inputTokens, outputTokens, cost } = completion;

  if (params.runId || params.targetId || params.stepId || workspaceId) {
    recordAiUsage({
      workspaceId, purpose: purposeOf(params), model, usedFallback,
      runId: params.runId, targetId: params.targetId, stepId: params.stepId,
      inputTokens, outputTokens, costUsd: cost, prompt, generatedText: JSON.stringify(parsed),
    });
  }

  return {
    ...parsed,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: cost,
    model,
    used_fallback: usedFallback,
  };
}

export const communityAi = {
  getAgentConfig(workspaceId?:string) {
    const db = getDb();
    return (workspaceId?db.prepare("SELECT * FROM workspace_ai_config WHERE workspace_id=?").get(workspaceId):undefined as Record<string,unknown>|undefined) as Record<string,unknown>|undefined ?? {
      default_model: null,
      system_prompt: null,
      user_prompt: null,
      email_examples: null,
      linkedin_examples: null,
    };
  },

  getContactWithCompany(targetId: string) {
    const db = getDb();
    const contact = db.prepare("SELECT * FROM targets WHERE id = ?").get(targetId) as Record<string, unknown> | undefined;
    if (!contact) return null;
    const companyId = typeof contact.company_id === "string" ? contact.company_id : null;
    const company = companyId
      ? db.prepare("SELECT * FROM companies WHERE id = ?").get(companyId) as Record<string, unknown> | undefined
      : null;
    return { contact, company: company ?? null };
  },

  async writeEmail(params: CommunityAiParams) {
    const result = await generateCommunityContent({ ...params, stepType: "email" });
    return { subject: result.subject ?? "", body: result.body };
  },

  async writeLinkedInMessage(params: CommunityAiParams) {
    const result = await generateCommunityContent({ ...params, stepType: "message" });
    return { body: result.body };
  },

  async writeSalesInMail(params: CommunityAiParams) {
    const result = await generateCommunityContent({ ...params, stepType: "sales_inmail" });
    return { subject: result.subject ?? "", body: result.body };
  },
};
