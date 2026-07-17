import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { communityAi, generateCommunityContent } from "@/lib/community-ai";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

const STEP_TYPES = new Set(["message", "email", "sales_inmail"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const ctx=requireWorkspace(req,res,"member"); if(!ctx)return;

  const {
    step_type,
    ai_model,
    ai_prompt,
    ai_max_words,
    ai_language,
    target_id,
    campaign_prompt,
  } = req.body as Record<string, unknown>;

  if (typeof step_type !== "string" || !STEP_TYPES.has(step_type)) {
    return res.status(400).json({ error: "Unsupported AI step type" });
  }
  if (typeof ai_model !== "string" || !ai_model || typeof target_id !== "string" || !target_id) {
    return res.status(400).json({ error: "Model and target are required" });
  }
  if(!requireWorkspaceEntity(res,ctx,"targets",target_id))return;

  const db = getDb();
  const row = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(ctx.workspaceId) as { api_key: string | null } | undefined;
  const apiKey = decryptSecret(row?.api_key ?? null);
  if (!apiKey) return res.status(400).json({ error: "Configure an OpenRouter API key in Settings first" });

  const contactData = communityAi.getContactWithCompany(target_id);
  if (!contactData) return res.status(404).json({ error: "Contact not found" });

  try {
    const result = await generateCommunityContent({
      apiKey,
      model: ai_model,
      stepType: step_type as "message" | "email" | "sales_inmail",
      stepPrompt: typeof ai_prompt === "string" ? ai_prompt : undefined,
      maxWords: typeof ai_max_words === "number" ? ai_max_words : undefined,
      language: typeof ai_language === "string" ? ai_language : undefined,
      campaignPrompt: typeof campaign_prompt === "string" ? campaign_prompt : undefined,
      contact: contactData.contact,
      company: contactData.company,
      agentConfig: communityAi.getAgentConfig(ctx.workspaceId),
      targetId: target_id,
    });
    return res.json(result);
  } catch (error) {
    console.error("[agent-preview]", error);
    return res.status(502).json({ error: error instanceof Error ? error.message : "AI preview failed" });
  }
}
