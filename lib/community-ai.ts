import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";

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
}

export interface CommunityAiResult {
  subject?: string;
  body: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
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

function buildPrompt(params: CommunityAiParams): string {
  const outputShape = params.stepType === "message"
    ? '{"body":"personalized LinkedIn message"}'
    : '{"subject":"concise subject","body":"personalized message body"}';

  const instructions = [
    "Write concise, natural B2B outreach that sounds like a thoughtful human.",
    "Use only facts supplied in the contact and company context; never invent achievements, events, or relationships.",
    "Avoid hype, generic compliments, fake familiarity, and unsupported claims.",
    `Write in ${params.language || "English"}.`,
    params.maxWords ? `Keep the body at or below ${params.maxWords} words.` : "Keep the body brief.",
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
      email: params.agentConfig?.email_examples || null,
      linkedin: params.agentConfig?.linkedin_examples || null,
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

export async function generateCommunityContent(params: CommunityAiParams): Promise<CommunityAiResult> {
  const prompt = buildPrompt(params);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXTAUTH_URL || "http://localhost:3000",
      "X-OpenRouter-Title": "Linki Community",
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        { role: "system", content: "You are an expert B2B outbound copywriter. Return valid JSON only." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    }),
  });

  const payload = await response.json() as OpenRouterResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message || `OpenRouter request failed (${response.status})`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  const parsed = parseModelJson(content, params.stepType);
  const inputTokens = payload.usage?.prompt_tokens ?? 0;
  const outputTokens = payload.usage?.completion_tokens ?? 0;
  const cost = typeof payload.usage?.cost === "number" ? payload.usage.cost : null;

  if (params.runId || params.targetId || params.stepId) {
    const db = getDb();
    const workspaceId=params.targetId?(db.prepare("SELECT workspace_id FROM targets WHERE id=?").get(params.targetId) as {workspace_id:string}|undefined)?.workspace_id:params.runId?(db.prepare("SELECT workspace_id FROM runs WHERE id=?").get(params.runId) as {workspace_id:string}|undefined)?.workspace_id:null;
    db.prepare(`
      INSERT INTO agent_sessions
        (id, workspace_id, run_id, target_id, step_id, model, input_tokens, output_tokens, cost_usd, prompt, generated_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      workspaceId,
      params.runId ?? null,
      params.targetId ?? null,
      params.stepId ?? null,
      params.model,
      inputTokens,
      outputTokens,
      cost,
      prompt,
      JSON.stringify(parsed),
    );
  }

  return {
    ...parsed,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: cost,
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
