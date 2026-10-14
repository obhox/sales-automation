import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { draftShapeProblem, getDraft, loadSequence, type SequenceDraft } from "@/lib/outreach/publish";
import { previewContact, previewSenders, previewSequence } from "@/lib/outreach/preview";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

/**
 * The whole sequence as one contact would receive it.
 *   POST { target_id, steps?, email_account_id?, account_id?, pick? }
 *   → { contact, senders, steps: [{ ref, track, step_type, day, content, subject, body, signature, shown, warnings }] }
 *
 * `steps` is the sequence to preview (an editor's unsaved one). Without it: the stored
 * draft if there is one, else what is published. Nothing is sent and no AI is called; a
 * step that AI writes at send time comes back with content "ai". `pick` shows that version
 * (0 is A) of each step that has several.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
  const { target_id, steps, email_account_id, account_id, pick } = (req.body ?? {}) as { target_id?: string; steps?: SequenceDraft["steps"]; email_account_id?: string | null; account_id?: string | null; pick?: number };
  if (typeof target_id !== "string" || !target_id) return res.status(400).json({ error: "target_id is required" });
  const contact = previewContact(db, ctx.workspaceId, target_id);
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  let draft: Pick<SequenceDraft, "steps">;
  if (steps !== undefined) {
    const problem = draftShapeProblem({ steps });
    if (problem) return res.status(400).json({ error: problem });
    draft = { steps };
  } else {
    draft = getDraft(db, workflowId)?.draft ?? loadSequence(db, workflowId);
  }
  const senders = previewSenders(db, ctx.workspaceId, workflowId, { emailAccountId: email_account_id, accountId: account_id });
  return res.json({
    contact: { id: contact.id, name: contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(" "), title: contact.title ?? null, company: contact.company ?? null, email: contact.email, linkedin_url: contact.linkedin_url },
    senders: { linkedin: senders.linkedin, email: senders.email ? { id: senders.email.id, name: senders.email.name, email: senders.email.email } : null },
    steps: previewSequence(db, ctx.workspaceId, contact, draft, senders, { pick: Number.isInteger(pick) && (pick as number) >= 0 ? pick : undefined }),
  });
}
