import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { latestMailboxTest, lookForMailboxTest, sendMailboxTest } from "@/lib/email/test-send";
import { isAddressSuppressed } from "@/lib/platform/suppression";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

/**
 * A test email from a mailbox, and where it landed.
 *   GET                   the latest test sent from this mailbox
 *   POST { to, ... }      send one (admin)
 *   PUT  { test_id? }     look in the receiving mailbox for it now (admin); the latest when no id is given
 *
 * Where it landed can only be read when `to` is one of this workspace's own connected
 * mailboxes. The mailbox's own address is one of those.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!["GET", "POST", "PUT"].includes(req.method ?? "")) {
    res.setHeader("Allow", ["GET", "POST", "PUT"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin"); if (!ctx) return;

  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "email_accounts", id)) return;

  if (req.method === "GET") return res.json({ test: latestMailboxTest(db, ctx.workspaceId, id) });

  if (req.method === "PUT") {
    const testId = typeof req.body?.test_id === "string" ? req.body.test_id : latestMailboxTest(db, ctx.workspaceId, id)?.id;
    if (!testId) return res.status(404).json({ error: "No test has been sent from this mailbox" });
    const test = await lookForMailboxTest(db, ctx.workspaceId, testId);
    if (!test || test.email_account_id !== id) return res.status(404).json({ error: "not found" });
    return res.json({ test });
  }

  const { to, subject, body, delivery_mode, track_opens, track_clicks } = req.body as { to?: string; subject?: string; body?: string; delivery_mode?: "plain" | "enhanced"; track_opens?: boolean; track_clicks?: boolean };
  if (!to || typeof to !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) return res.status(400).json({ error: "to is required" });

  const suppression = isAddressSuppressed(ctx.workspaceId, to);
  if (suppression) return res.status(409).json({ error: "Recipient is suppressed", suppression });

  try {
    const sent = await sendMailboxTest({
      workspaceId: ctx.workspaceId, emailAccountId: id, to, subject, body: body || undefined, userId: ctx.userId,
      deliveryMode: delivery_mode === "enhanced" ? "enhanced" : "plain", trackOpens: Boolean(track_opens), trackClicks: Boolean(track_clicks),
    }, db);
    return res.json({ ok: true, job_id: sent.jobId, message_id: sent.messageId, test: sent.test });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
