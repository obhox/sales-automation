// "Check replies now": read every mailbox and every LinkedIn inbox in the workspace
// without waiting for their next turn, and say when each was last read.
//
//   GET  /api/conversations/sync   when replies were last looked for, and whether a check is running
//   POST /api/conversations/sync   start a check; answers at once, 202
//
// A mailbox check runs here and can take minutes. A LinkedIn inbox is read by the one loop
// that drives the LinkedIn session, so for those this only asks; the read follows within
// about a minute when that loop is running.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { isoOf } from "@/lib/conversations/rows";
import { getInboxSyncState, startInboxSync, type InboxSyncState } from "@/lib/email/inbox-sync-job";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

export interface InboxSyncStatus {
  /** The latest time any mailbox or LinkedIn inbox was read. Null when none has been. */
  last_checked_at: string | null;
  email: { mailboxes: number; without_imap: number; last_checked_at: string | null; check: InboxSyncState };
  linkedin: { accounts: number; last_read_at: string | null; requested: number };
}

function status(workspaceId: string): InboxSyncStatus {
  const db = getDb();
  const email = db.prepare(`SELECT SUM(CASE WHEN COALESCE(imap_host, '') != '' THEN 1 ELSE 0 END) AS mailboxes,
    SUM(CASE WHEN COALESCE(imap_host, '') = '' THEN 1 ELSE 0 END) AS without_imap, MAX(inbox_synced_at) AS last FROM email_accounts WHERE workspace_id = ?`).get(workspaceId) as { mailboxes: number | null; without_imap: number | null; last: string | null };
  const linkedin = db.prepare(`SELECT COUNT(*) AS accounts, MAX(inbox_synced_at) AS last, SUM(CASE WHEN inbox_sync_requested_at IS NOT NULL THEN 1 ELSE 0 END) AS requested
    FROM accounts WHERE workspace_id = ? AND is_authenticated = 1 AND sync_inbox = 1`).get(workspaceId) as { accounts: number; last: string | null; requested: number | null };
  const emailAt = isoOf(email.last);
  const linkedinAt = isoOf(linkedin.last);
  return {
    last_checked_at: [emailAt, linkedinAt].filter((at): at is string => Boolean(at)).sort().pop() ?? null,
    email: { mailboxes: email.mailboxes ?? 0, without_imap: email.without_imap ?? 0, last_checked_at: emailAt, check: getInboxSyncState(workspaceId) },
    linkedin: { accounts: linkedin.accounts, last_read_at: linkedinAt, requested: linkedin.requested ?? 0 },
  };
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  if (req.method === "GET") return res.json(status(ctx.workspaceId));

  const { started } = startInboxSync(ctx.workspaceId, (result) => {
    recordAudit(ctx, "inbox.synced", "email_reply", undefined, result);
  });
  const asked = getDb().prepare("UPDATE accounts SET inbox_sync_requested_at = datetime('now') WHERE workspace_id = ? AND is_authenticated = 1 AND sync_inbox = 1 AND paused_at IS NULL").run(ctx.workspaceId).changes;
  if (asked > 0) ensureGlobalRunnerStarted();
  return res.status(202).json({ started, ...status(ctx.workspaceId) });
}
