import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";
import { verifyAndSuppressTargets } from "@/lib/email/verify";

/**
 * Verify every emailable contact in a list (or a selected subset) and add the ones that
 * definitively bounce (bad domain / no such mailbox) to the do-not-send list.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

  // Only contacts with an email that we haven't already marked invalid.
  let rows: { id: string }[];
  if (target_ids && target_ids.length > 0) {
    const ph = target_ids.map(() => "?").join(",");
    rows = db.prepare(
      `SELECT t.id FROM targets t JOIN list_targets lt ON lt.target_id = t.id
       WHERE lt.list_id = ? AND t.id IN (${ph}) AND t.email IS NOT NULL AND COALESCE(t.email_status,'') != 'invalid'`
    ).all(listId, ...target_ids) as { id: string }[];
  } else {
    rows = db.prepare(
      `SELECT t.id FROM targets t JOIN list_targets lt ON lt.target_id = t.id
       WHERE lt.list_id = ? AND t.email IS NOT NULL AND COALESCE(t.email_status,'') != 'invalid'`
    ).all(listId) as { id: string }[];
  }

  // Use a verified sending inbox as the SMTP MAIL FROM so probes aren't rejected outright.
  const sender = db.prepare(
    "SELECT from_email FROM email_accounts WHERE workspace_id = ? AND is_verified = 1 AND from_email IS NOT NULL ORDER BY created_at LIMIT 1"
  ).get(ctx.workspaceId) as { from_email: string } | undefined;

  const result = await verifyAndSuppressTargets(db, ctx.workspaceId, rows.map((r) => r.id), {
    fromEmail: sender?.from_email,
    createdBy: ctx.userId ?? undefined,
  });

  recordAudit(ctx, "list.emails_verified", "list", listId, result);
  return res.json(result);
}

export const config = { api: { responseLimit: false } };
