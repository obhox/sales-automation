import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import { communityAi, generateCommunityContent } from "@/lib/community-ai";
import { decryptSecret } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { toPlainText } from "@/lib/email/content";
import { renderOutreachTemplate, type OutreachTemplateTarget } from "@/lib/outreach/render";
import { loadTargetCustomValues } from "@/lib/outreach/custom-values";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

const requestSchema = z.object({
  target_id: z.string().min(1),
  step_type: z.enum(["message", "sales_inmail", "email"]),
  message_body: z.string().optional().default(""),
  email_subject: z.string().optional().default(""),
  email_body: z.string().optional().default(""),
  email_signature: z.string().nullable().optional(),
  email_account_id: z.string().nullable().optional(),
  email_delivery_mode: z.enum(["plain", "enhanced"]).optional().default("plain"),
  email_track_opens: z.boolean().optional().default(false),
  email_track_clicks: z.boolean().optional().default(false),
  template_id: z.string().nullable().optional(),
  ai_enabled: z.boolean().optional().default(false),
  ai_model: z.string().optional().default(""),
  ai_prompt: z.string().optional().default(""),
  ai_max_words: z.number().int().min(1).max(1000).nullable().optional(),
  ai_language: z.string().nullable().optional(),
  campaign_prompt: z.string().nullable().optional(),
});

interface PreviewTarget extends OutreachTemplateTarget {
  id: string;
  email: string | null;
  linkedin_url: string | null;
}

interface PreviewSender {
  id: string;
  name: string;
  from_email: string;
  from_name: string | null;
  signature: string | null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid preview request" });
  }

  const input = parsed.data;
  if (!requireWorkspaceEntity(res, ctx, "targets", input.target_id)) return;
  const db = getDb();
  const target = db.prepare(`
    SELECT id, first_name, last_name, full_name, company, title, location, email, linkedin_url
    FROM targets WHERE id = ? AND workspace_id = ?
  `).get(input.target_id, ctx.workspaceId) as PreviewTarget | undefined;
  if (!target) return res.status(404).json({ error: "Contact not found" });
  const customVals = loadTargetCustomValues(db, ctx.workspaceId, input.target_id);

  let sender: PreviewSender | null = null;
  if (input.email_account_id) {
    sender = db.prepare(`
      SELECT id, name, from_email, from_name, signature
      FROM email_accounts WHERE id = ? AND workspace_id = ?
    `).get(input.email_account_id, ctx.workspaceId) as PreviewSender | undefined ?? null;
    if (!sender) return res.status(404).json({ error: "Email account not found" });
  }

  let subject = "";
  let body = "";
  let templateName: string | null = null;
  let usage: { input_tokens: number; output_tokens: number; cost_usd: number | null } = {
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
  };

  if (input.ai_enabled) {
    if (!input.ai_model) return res.status(400).json({ error: "Select an AI model before previewing" });
    const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?")
      .get(ctx.workspaceId) as { api_key: string | null } | undefined;
    const apiKey = decryptSecret(integration?.api_key ?? null);
    if (!apiKey) return res.status(400).json({ error: "Configure an OpenRouter API key in Settings first" });
    const contactData = communityAi.getContactWithCompany(input.target_id);
    if (!contactData) return res.status(404).json({ error: "Contact data not found" });

    try {
      const generated = await generateCommunityContent({
        apiKey,
        model: input.ai_model,
        stepType: input.step_type,
        stepPrompt: input.ai_prompt || undefined,
        maxWords: input.ai_max_words ?? undefined,
        language: input.ai_language ?? undefined,
        campaignPrompt: input.campaign_prompt ?? undefined,
        contact: contactData.contact,
        company: contactData.company,
        agentConfig: communityAi.getAgentConfig(ctx.workspaceId),
        targetId: input.target_id,
      });
      subject = generated.subject ?? "";
      body = generated.body;
      usage = {
        input_tokens: generated.input_tokens ?? 0,
        output_tokens: generated.output_tokens ?? 0,
        cost_usd: generated.cost_usd ?? null,
      };
    } catch (error) {
      console.error("[workflow-preview] AI generation failed", error);
      return res.status(502).json({ error: error instanceof Error ? error.message : "AI preview failed" });
    }
  } else if (input.step_type === "email") {
    subject = renderOutreachTemplate(input.email_subject, target, customVals);
    body = renderOutreachTemplate(input.email_body, target, customVals);
  } else {
    let source = input.message_body;
    if (input.template_id) {
      const template = db.prepare("SELECT name, body FROM templates WHERE id = ? AND workspace_id = ?")
        .get(input.template_id, ctx.workspaceId) as { name: string; body: string } | undefined;
      if (!template) return res.status(404).json({ error: "Message template not found" });
      source = template.body;
      templateName = template.name;
    }
    body = renderOutreachTemplate(source, target, customVals);
    if (input.step_type === "sales_inmail") {
      subject = renderOutreachTemplate(input.email_subject, target, customVals);
    }
  }

  const signature = input.step_type === "email"
    ? (input.email_signature !== undefined && input.email_signature !== null ? input.email_signature : sender?.signature ?? "").trim()
    : "";
  const removeLinks = input.step_type === "email" && input.email_delivery_mode === "plain";
  if (input.step_type === "email") {
    body = toPlainText(body, removeLinks);
  }

  return res.json({
    step_type: input.step_type,
    subject,
    body,
    signature: signature ? toPlainText(signature, removeLinks) : "",
    template_name: templateName,
    target: {
      id: target.id,
      full_name: target.full_name,
      first_name: target.first_name,
      last_name: target.last_name,
      title: target.title,
      company: target.company,
      email: target.email,
      linkedin_url: target.linkedin_url,
    },
    sender: sender ? {
      id: sender.id,
      name: sender.from_name || sender.name,
      email: sender.from_email,
    } : null,
    delivery: input.step_type === "email" ? {
      mode: input.email_delivery_mode,
      track_opens: input.email_delivery_mode === "enhanced" && input.email_track_opens,
      track_clicks: input.email_delivery_mode === "enhanced" && input.email_track_clicks,
    } : null,
    generated: input.ai_enabled,
    ...usage,
  });
}
