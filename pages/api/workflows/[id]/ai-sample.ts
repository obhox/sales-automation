import type { NextApiRequest, NextApiResponse } from "next";
import { OpenRouterError } from "@/lib/ai/openrouter";
import { AiBudgetReachedError } from "@/lib/ai/usage";
import { getDb } from "@/lib/db";
import { AiSampleError, earlierEmail, writeAiSample } from "@/lib/outreach/ai-sample";
import { previewContact, previewSenders, previewWritten, type StepPreview } from "@/lib/outreach/preview";
import type { StepInput } from "@/lib/outreach/publish";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

/**
 * One sample of what an AI step writes, for a contact of your choosing.
 *   POST { step, target_id, email_account_id?, account_id?, previous? }
 *   → { sample: StepPreview, model, used_fallback, without_previous, input_tokens, output_tokens, cost_usd }
 *
 * `step` is the step as the editor holds it, saved or not. `previous` is the subject and
 * body of the email before it, for a follow-up. Nothing is sent. The request is a real one:
 * it is recorded and counts towards the month's AI spend, so a viewer may not make it.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
  const { step, target_id, email_account_id, account_id, previous } = (req.body ?? {}) as {
    step?: StepInput; target_id?: string; email_account_id?: string | null; account_id?: string | null; previous?: unknown;
  };

  if (!step || typeof step !== "object") return res.status(400).json({ error: "step is required" });
  if (typeof target_id !== "string" || !target_id) return res.status(400).json({ error: "Choose a contact to write the sample for" });
  const contact = previewContact(db, ctx.workspaceId, target_id);
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  try {
    const written = await writeAiSample(db, { workspaceId: ctx.workspaceId, workflowId, targetId: target_id, step, previous: earlierEmail(previous) });
    const senders = previewSenders(db, ctx.workspaceId, workflowId, { emailAccountId: email_account_id, accountId: account_id });
    const sample: StepPreview = previewWritten(contact, step, senders, written);
    return res.json({
      sample,
      model: written.model, used_fallback: written.used_fallback, without_previous: written.without_previous,
      input_tokens: written.input_tokens, output_tokens: written.output_tokens, cost_usd: written.cost_usd,
    });
  } catch (error) {
    if (error instanceof AiBudgetReachedError) return res.status(409).json({ error: error.message, code: "budget_reached" });
    if (error instanceof AiSampleError) return res.status(error.status).json({ error: error.message });
    console.error("[ai-sample]", error instanceof Error ? error.message : error);
    return res.status(error instanceof OpenRouterError && error.status === 429 ? 429 : 502).json({ error: error instanceof Error ? error.message : "The sample could not be written" });
  }
}
