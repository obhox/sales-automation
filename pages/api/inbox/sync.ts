import type { NextApiRequest, NextApiResponse } from "next";
import { getInboxSyncState, startInboxSync } from "@/lib/email/inbox-sync-job";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

/**
 * Manual "Check for replies now" — runs an IMAP fetch across the workspace's email accounts
 * (ignoring the background poller's throttle), capturing + classifying any new replies and
 * recording any bounces.
 *
 * POST starts the sweep and returns immediately; GET reports its state. The sweep is minutes
 * of IMAP work on a busy workspace, which is longer than callers are willing to hold a
 * request open — awaiting it here meant the MCP client timed out at -32001 and the result was
 * lost even though the sweep had finished.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;

  if (req.method === "GET") {
    return res.json({ ok: true, ...getInboxSyncState(ctx.workspaceId) });
  }

  const { started, state } = startInboxSync(ctx.workspaceId, (result) => {
    recordAudit(ctx, "inbox.synced", "email_reply", undefined, result);
  });
  return res.status(202).json({
    ok: true,
    started,
    ...state,
    poll: "GET /api/inbox/sync",
    message: started ? "Inbox sync started" : "An inbox sync is already running",
  });
}
