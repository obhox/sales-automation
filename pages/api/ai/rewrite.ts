import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";
import { RewriteUnavailable, rewriteMessage, rewriteProblem, type RewriteInput } from "@/lib/ai/rewrite";

/**
 * Rewrite a message someone has already written.
 *   POST { channel: email | linkedin | connect_note, body, subject?, style?, instruction?, model?, workflow_id? }
 *   → { body, subject, model, input_tokens, output_tokens, cost_usd, tag_changes: { missing, added } }
 *
 * Merge tags are kept as written; `tag_changes` says so when the model did not. Nothing is
 * saved: the caller decides whether to keep the result. `workflow_id` lends the campaign's
 * own context to the rewrite.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;
  const body = (req.body ?? {}) as Partial<RewriteInput> & { workflow_id?: string };
  const problem = rewriteProblem(body);
  if (problem) return res.status(400).json({ error: problem });
  const db = getDb();
  let campaignContext: string | null = null;
  if (body.workflow_id) {
    if (!requireWorkspaceEntity(res, ctx, "workflows", body.workflow_id)) return;
    campaignContext = (db.prepare("SELECT prompt FROM workflows WHERE id = ?").get(body.workflow_id) as { prompt: string | null } | undefined)?.prompt ?? null;
  }
  try {
    const result = await rewriteMessage(db, ctx.workspaceId, {
      channel: body.channel!, body: body.body!, subject: body.subject ?? null, style: body.style, instruction: body.instruction ?? null, model: body.model ?? null, campaignContext,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof RewriteUnavailable) return res.status(400).json({ error: error.message, outcome: "not_set_up" });
    console.error("[ai-rewrite] failed", error);
    return res.status(502).json({ error: error instanceof Error ? error.message : "The rewrite failed" });
  }
}
