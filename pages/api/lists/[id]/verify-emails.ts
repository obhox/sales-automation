import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";
import { pendingVerificationCount } from "@/lib/email/verify";

/**
 * Queue every emailable contact in a list (or a selected subset) for background email
 * verification. Returns immediately — the runner works the queue, so the user can leave
 * the page. Definitively-dead addresses are added to the do-not-send list as they're checked.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;

  const db = getDb();
  const listId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "lists", listId)) return;

  const { target_ids } = req.body as { target_ids?: string[] };

  // Queue contacts with an email that we haven't already marked invalid.
  const where = target_ids && target_ids.length > 0
    ? `AND t.id IN (${target_ids.map(() => "?").join(",")})`
    : "";
  const params = target_ids && target_ids.length > 0 ? [listId, ...target_ids] : [listId];
  const queued = db.prepare(
    `UPDATE targets SET email_verify_requested_at = datetime('now')
     WHERE id IN (
       SELECT t.id FROM targets t JOIN list_targets lt ON lt.target_id = t.id
       WHERE lt.list_id = ? ${where} AND t.email IS NOT NULL AND COALESCE(t.email_status,'') != 'invalid'
     )`
  ).run(...params).changes;

  recordAudit(ctx, "list.emails_queued_for_verification", "list", listId, { queued });
  return res.json({ queued, pending: pendingVerificationCount(db, ctx.workspaceId) });
}
