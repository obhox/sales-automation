import type { NextApiRequest, NextApiResponse } from "next";
import { syncWorkspaceEmailInboxes } from "@/lib/email/inbox";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

/**
 * Manual "Check for replies now" — immediately runs an IMAP fetch across the
 * workspace's email accounts (ignoring the background poller's throttle),
 * capturing + classifying any new replies. Returns how many were captured.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;
  try {
    const result = await syncWorkspaceEmailInboxes(ctx.workspaceId);
    recordAudit(ctx, "inbox.synced", "email_reply", undefined, result);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Inbox sync failed" });
  }
}
