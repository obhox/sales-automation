import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { communityAi, generateCommunityContent } from "@/lib/community-ai";
import { AI_CONFIG_FIELDS } from "@/lib/ai/config";
import { OpenRouterError } from "@/lib/ai/openrouter";
import { AiBudgetReachedError } from "@/lib/ai/usage";
import { capabilities } from "@/lib/premium";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";
import { anyAiConnected } from "@/lib/ai/providers";

// "Test on a contact": write one sample for a real contact with the settings on the
// screen, saved or not, and show what came back. Nothing is sent to the contact. The
// request is a real one: it is recorded and counts towards the month's spend.

export interface AiTestResult {
  subject: string | null;
  body: string;
  model: string;
  used_fallback: boolean;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

const STEP_TYPES = ["email", "message"] as const;

export interface AiTestContact {
  id: string;
  name: string;
  /** "VP Sales · Northwind" */
  detail: string | null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;

  // A few contacts to offer before anything is typed: the newest with a name.
  if (req.method === "GET") {
    const contacts = getDb().prepare(
      `SELECT id, COALESCE(NULLIF(full_name, ''), email, linkedin_url) AS name,
              NULLIF(TRIM(COALESCE(title, '') || CASE WHEN title IS NOT NULL AND company IS NOT NULL THEN ' · ' ELSE '' END || COALESCE(company, '')), '') AS detail
       FROM targets WHERE workspace_id = ? AND COALESCE(full_name, '') <> '' ORDER BY created_at DESC, rowid DESC LIMIT 6`,
    ).all(ctx.workspaceId) as AiTestContact[];
    return res.json({ contacts });
  }
  if (!capabilities.ai) return res.status(400).json({ error: "AI writing is not part of this build" });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const stepType = STEP_TYPES.find((type) => type === body.step_type);
  if (!stepType) return res.status(400).json({ error: "step_type must be email or message" });
  const targetId = typeof body.target_id === "string" ? body.target_id : "";
  if (!targetId) return res.status(400).json({ error: "Choose a contact to write for" });
  if (!requireWorkspaceEntity(res, ctx, "targets", targetId)) return;

  const db = getDb();
  if (!anyAiConnected(db, ctx.workspaceId)) return res.status(400).json({ error: "Add an OpenRouter or Google Gemini key before testing" });

  // What is saved, with whatever the screen is showing laid over it. The examples go to
  // the writer as stored text, so a list from the screen is turned into that first.
  const saved = communityAi.getAgentConfig(ctx.workspaceId) as Record<string, unknown>;
  const draft = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? (body.config as Record<string, unknown>) : {};
  const agentConfig: Record<string, unknown> = { ...saved };
  for (const field of AI_CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(draft, field)) continue;
    const value = draft[field];
    agentConfig[field] = Array.isArray(value) ? JSON.stringify(value) : value;
  }
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : typeof agentConfig.default_model === "string" ? agentConfig.default_model : "";
  if (!model) return res.status(400).json({ error: "Choose a default model before testing" });

  const contactData = communityAi.getContactWithCompany(targetId);
  if (!contactData) return res.status(404).json({ error: "Contact not found" });

  try {
    const result = await generateCommunityContent({
      model, stepType,
      stepPrompt: typeof body.instruction === "string" && body.instruction.trim() ? body.instruction.trim().slice(0, 1000) : undefined,
      maxWords: typeof body.max_words === "number" && Number.isInteger(body.max_words) && body.max_words > 0 ? Math.min(body.max_words, 1000) : undefined,
      language: typeof body.language === "string" && body.language.trim() ? body.language.trim().slice(0, 40) : undefined,
      contact: contactData.contact, company: contactData.company, agentConfig,
      targetId, workspaceId: ctx.workspaceId, purpose: "test",
    });
    const payload: AiTestResult = {
      subject: result.subject ?? null, body: result.body, model: result.model, used_fallback: result.used_fallback,
      input_tokens: result.input_tokens, output_tokens: result.output_tokens, cost_usd: result.cost_usd,
    };
    return res.json(payload);
  } catch (error) {
    if (error instanceof AiBudgetReachedError) return res.status(409).json({ error: error.message, code: "budget_reached" });
    const status = error instanceof OpenRouterError && error.status === 429 ? 429 : 502;
    console.error("[ai-test]", error instanceof Error ? error.message : error);
    return res.status(status).json({ error: error instanceof Error ? error.message : "The test could not be written" });
  }
}
