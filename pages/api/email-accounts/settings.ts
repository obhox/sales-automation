import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getMailboxSettings, saveMailboxSettings } from "@/lib/email/mailbox-settings";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * What a workspace has chosen for its mailboxes as a group.
 *   GET                                          the settings
 *   PUT { rotation?, failover?, shared_pool? }   change them (admin)
 *
 * rotation: how a campaign with several mailboxes shares its contacts out (round_robin or capacity).
 * failover: whether a guard-paused mailbox's not-yet-emailed contacts move to the campaign's other mailboxes.
 * shared_pool: whether warm-up mail is exchanged with other workspaces on this instance.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;
  const db = getDb();

  if (req.method === "GET") return res.json(getMailboxSettings(ctx.workspaceId, db));

  if (req.method === "PUT") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!["rotation", "failover", "shared_pool"].some((key) => body[key] !== undefined)) return res.status(400).json({ error: "No settings given" });
    const saved = saveMailboxSettings(ctx.workspaceId, body, db);
    if (typeof saved === "string") return res.status(400).json({ error: saved });
    recordAudit(ctx, "mailbox_settings.updated", "workspace", ctx.workspaceId, { rotation: body.rotation, failover: body.failover, shared_pool: body.shared_pool });
    return res.json(saved);
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end();
}
