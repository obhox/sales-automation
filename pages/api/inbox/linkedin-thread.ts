// A contact's LinkedIn conversation, as this app has it: what the inbox read stored, and
// what is waiting to be sent or failed to go.
//
//   GET  /api/inbox/linkedin-thread?target_id=…     the conversation, oldest first
//   POST /api/inbox/linkedin-thread { target_id }   ask for the account's inbox to be read now
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { profileVanity } from "@/lib/linkedin/url";
import { requireWorkspace, type WorkspaceContext } from "@/lib/workspace";

type DB = ReturnType<typeof getDb>;

/**
 * The LinkedIn account a reply to this contact goes from: the one the conversation is on,
 * else the one that has written to them, else the one that worked them in their latest
 * campaign (their own account in a campaign with several), else the workspace's only
 * signed-in account. Null when it cannot be told, with every signed-in account offered instead.
 */
export function linkedinAccountFor(db: DB, ctx: WorkspaceContext, targetId: string): { account: { id: string; name: string } | null; choices: Array<{ id: string; name: string }> } {
  const signedIn = db.prepare("SELECT id, name FROM accounts WHERE workspace_id = ? AND is_authenticated = 1 ORDER BY created_at").all(ctx.workspaceId) as Array<{ id: string; name: string }>;
  const pick = (id: string | null | undefined) => signedIn.find((account) => account.id === id) ?? null;
  const spoken = db.prepare("SELECT account_id FROM linkedin_messages WHERE target_id = ? AND workspace_id = ? AND account_id IS NOT NULL ORDER BY sent_at DESC LIMIT 1").get(targetId, ctx.workspaceId) as { account_id: string } | undefined;
  const wrote = db.prepare("SELECT linkedin_account_id AS account_id FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, ctx.workspaceId) as { account_id: string | null } | undefined;
  const campaigned = db.prepare(`SELECT COALESCE(rp.account_id, r.account_id) AS account_id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
    WHERE rp.target_id = ? AND r.workspace_id = ? AND COALESCE(rp.account_id, r.account_id, '') != '' ORDER BY r.created_at DESC LIMIT 1`).get(targetId, ctx.workspaceId) as { account_id: string } | undefined;
  return { account: pick(spoken?.account_id) ?? pick(wrote?.account_id) ?? pick(campaigned?.account_id) ?? (signedIn.length === 1 ? signedIn[0] : null), choices: signedIn };
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();
  const targetId = String((req.method === "GET" ? req.query.target_id : (req.body as { target_id?: unknown } | undefined)?.target_id) ?? "");
  const contact = db.prepare("SELECT id, full_name, linkedin_url FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, ctx.workspaceId) as { id: string; full_name: string | null; linkedin_url: string | null } | undefined;
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  const { account, choices } = linkedinAccountFor(db, ctx, targetId);

  if (req.method === "GET") {
    const messages = db.prepare(`SELECT id, direction, body, sent_at, status, error, created_by IS NOT NULL AS sent_here
      FROM linkedin_messages WHERE target_id = ? AND workspace_id = ? ORDER BY datetime(sent_at), rowid`).all(targetId, ctx.workspaceId);
    const whyNot = !profileVanity(contact.linkedin_url) ? "This contact has no LinkedIn profile address"
      : choices.length === 0 ? "No LinkedIn account is signed in"
      : null;
    const read = account ? db.prepare("SELECT inbox_synced_at, sync_inbox FROM accounts WHERE id = ?").get(account.id) as { inbox_synced_at: string | null; sync_inbox: number } : null;
    return res.json({
      messages, account, accounts: choices, can_reply: whyNot === null, why_not: whyNot,
      // When the account's inbox was last read, so "nothing here" can be told from "not looked yet".
      last_read_at: read?.inbox_synced_at ?? null, reading: Boolean(read?.sync_inbox),
    });
  }

  if (req.method === "POST") {
    if (!account) return res.status(400).json({ error: choices.length ? "Say which LinkedIn account to read" : "No LinkedIn account is signed in" });
    db.prepare("UPDATE accounts SET inbox_sync_requested_at = datetime('now') WHERE id = ? AND workspace_id = ?").run(account.id, ctx.workspaceId);
    ensureGlobalRunnerStarted();
    return res.status(202).json({ ok: true, account_id: account.id });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
}
