import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { classifyAndDispatch } from "@/lib/community-replies";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  const replyId = req.query.replyId as string;
  const reply = getDb().prepare("SELECT id FROM email_replies WHERE id = ? AND workspace_id = ?").get(replyId, ctx.workspaceId);
  if (!reply) return res.status(404).json({ error: "Reply not found" });
  // Optional explicit override so a human can correct a misclassification (instead of just
  // re-running the same model). A non-suppressing override also lifts any stale
  // classifier-created suppression on the address (handled in classifyAndDispatch).
  const VALID_KINDS = ["positive", "negative", "out_of_office", "unsubscribe", "human_review"] as const;
  const overrideKind = (req.body as { override_kind?: string })?.override_kind;
  if (overrideKind !== undefined && !VALID_KINDS.includes(overrideKind as (typeof VALID_KINDS)[number])) {
    return res.status(400).json({ error: `override_kind must be one of: ${VALID_KINDS.join(", ")}` });
  }
  getDb().prepare("UPDATE email_replies SET classified_at = NULL, classification_json = NULL, classification_error = NULL, dispatched_at = NULL, dispatch_result_json = NULL WHERE id = ?").run(replyId);
  await classifyAndDispatch(replyId, overrideKind as (typeof VALID_KINDS)[number] | undefined);
  recordAudit(ctx, "reply.reclassified", "email_reply", replyId, { override_kind: overrideKind ?? null });
  return res.json(getDb().prepare("SELECT * FROM email_replies WHERE id = ?").get(replyId));
}
