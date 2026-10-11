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

  const { target_ids, unchecked_only } = (req.body ?? {}) as { target_ids?: string[]; unchecked_only?: boolean };

  // Queue contacts with an email that we haven't already marked invalid. With `unchecked_only`
  // an address that already has a result, or is already waiting for one, is left alone: the
  // list screens count "addresses to check" that way, and a check can cost money.
  const where = (target_ids && target_ids.length > 0
    ? `AND t.id IN (${target_ids.map(() => "?").join(",")})`
    : "") + (unchecked_only === true ? " AND t.email != '' AND COALESCE(t.email_status,'') = '' AND t.email_verify_requested_at IS NULL" : "");
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
