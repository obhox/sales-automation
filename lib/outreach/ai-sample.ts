// One sample of what an AI step would write for one contact.
//
// A step that AI writes has no fixed text, so the preview and the test send could only say
// "written when it is sent". This writes one for real, with the inputs the runner gives the
// writer at send time: the step's own instruction and limits, the campaign's brief, angle,
// tone and signals, the workspace's writing settings and the model the campaign would use.
// The one thing a sample cannot have is the earlier email a follow-up replies to, unless the
// caller supplies it.
//
// It is a real request: it is recorded and counts towards the month's AI budget.
import type DatabaseType from "better-sqlite3";
import { anyAiConnected } from "@/lib/ai/providers";
import { aiContextOf, campaignContextText, withCampaignTone, withTriggers } from "@/lib/campaigns/context";
import { communityAi, generateCommunityContent, type CommunityAiResult } from "@/lib/community-ai";
import type { StepInput } from "@/lib/outreach/publish";
import { capabilities } from "@/lib/premium";

type DB = DatabaseType.Database;

/** A reason a sample could not be written that the person can act on. `status` is the HTTP status it should be answered with. */
export class AiSampleError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = "AiSampleError";
  }
}

export interface AiSampleInput {
  workspaceId: string;
  workflowId: string;
  targetId: string;
  step: StepInput;
  /** The email this one follows up on, when the caller has it. Without it a follow-up is written as if it were the first. */
  previous?: { subject: string; body: string } | null;
}

export interface AiSample extends CommunityAiResult {
  /** Whether this step is a follow-up that was written without the email before it. */
  without_previous: boolean;
}

/** The email before this one as a caller sent it, cut to a sane size; null when it sent nothing usable. */
export function earlierEmail(value: unknown): { subject: string; body: string } | null {
  if (!value || typeof value !== "object") return null;
  const { subject, body } = value as { subject?: unknown; body?: unknown };
  if (typeof body !== "string" || !body.trim()) return null;
  return { subject: typeof subject === "string" ? subject.slice(0, 300) : "", body: body.slice(0, 20_000) };
}

const WRITES = ["message", "sales_inmail", "email"] as const;

export async function writeAiSample(db: DB, input: AiSampleInput): Promise<AiSample> {
  const { step } = input;
  if (!(WRITES as readonly string[]).includes(step.step_type)) throw new AiSampleError("Only a message, an InMail or an email can be written by AI");
  if (!step.ai_enabled) throw new AiSampleError("This step is not written by AI");
  if (!capabilities.ai) throw new AiSampleError("AI writing is not part of this build");
  if (!anyAiConnected(db, input.workspaceId)) throw new AiSampleError("Add an OpenRouter or Google Gemini key on the AI & models page first");

  const loaded = communityAi.getContactWithCompany(input.targetId);
  if (!loaded) throw new AiSampleError("Contact not found", 404);
  // The same contact the runner would hand the writer, with the campaign's signals when it uses them.
  const data = withTriggers(db, input.workflowId, input.targetId, loaded);
  const agentConfig = withCampaignTone(db, input.workflowId, communityAi.getAgentConfig(input.workspaceId) ?? {});
  const model = (step.ai_model || "").trim() || aiContextOf(db, input.workflowId).model || (typeof agentConfig.default_model === "string" ? agentConfig.default_model : "");
  if (!model) throw new AiSampleError("Choose a model for this step, or a default one under AI & models");

  const followUp = step.step_type === "email" && (step.email_position ?? 1) > 1;
  const previous = followUp && input.previous && (input.previous.subject || input.previous.body) ? input.previous : null;
  const result = await generateCommunityContent({
    model,
    stepType: step.step_type as (typeof WRITES)[number],
    stepPrompt: step.ai_prompt ?? "",
    maxWords: step.ai_max_words ?? undefined,
    language: step.ai_language ?? undefined,
    campaignPrompt: campaignContextText(db, input.workflowId) ?? undefined,
    contact: data.contact,
    company: data.company,
    agentConfig,
    followupContext: previous ? { followupNumber: (step.email_position ?? 2) - 1, previousSubject: previous.subject, previousBody: previous.body } : undefined,
    targetId: input.targetId,
    stepId: typeof step.id === "string" ? step.id : undefined,
    workspaceId: input.workspaceId,
    purpose: "test",
  });
  return { ...result, without_previous: followUp && previous === null };
}
