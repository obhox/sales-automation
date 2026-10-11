import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { mailboxQueue } from "@/lib/email/mailbox-list";
import { requireWorkspace } from "@/lib/workspace";

/**
 * GET: what a mailbox has sent today and what it is expected to send next. The times of
 * what comes next are estimates, read from each contact's next step.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const queue = mailboxQueue(getDb(), ctx.workspaceId, req.query.id as string);
  if (!queue) return res.status(404).json({ error: "not found" });
  return res.json(queue);
}
