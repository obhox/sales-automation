import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { testMailboxConnection } from "@/lib/email/connection";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

/**
 * Sign in to a mailbox's SMTP server, and its IMAP server if it has one (admin).
 *
 * Both working marks the mailbox verified and connected. A refused sign-in marks it
 * disconnected, which holds its sending. A server that could not be reached changes nothing.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "admin"); if (!ctx) return;

  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "email_accounts", id)) return;

  const test = await testMailboxConnection(id, db);
  if (!test) return res.status(404).json({ error: "not found" });
  const state = db.prepare("SELECT disconnected_at FROM email_accounts WHERE id = ?").get(id) as { disconnected_at: string | null };

  return res.status(test.ok ? 200 : 400).json({
    ok: test.ok,
    smtp: test.smtp.error ? { ok: false, error: test.smtp.error } : { ok: true },
    imap: test.imap ? (test.imap.error ? { ok: false, error: test.imap.error } : { ok: true }) : null,
    disconnected: Boolean(state.disconnected_at),
  });
}
