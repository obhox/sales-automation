import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { syncAcceptedConnections } from "@/lib/linkedin/sync-accepted";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";

/**
 * Reconcile this account's contacts against its real LinkedIn connections list, now.
 *
 * Runs the same authoritative sync the runner does, as a FULL pass: every connection is
 * read from LinkedIn's connections API, contacts found there are marked connected with
 * LinkedIn's own acceptance date, and — only when the whole list was read and matches
 * LinkedIn's total — contacts marked connected that are NOT in it are un-marked.
 *
 * This endpoint used to do the opposite of that: it scrolled the sent-invitations page and
 * marked every contact whose invitation it did not see there as "accepted". That page
 * loads lazily and held 500+ invitations, so on 2026-08-09 one press marked 116 contacts
 * connected in a single minute. LinkedIn's list showed 15 of them actually were.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;

  const accountId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "accounts", accountId)) return;
  const db = getDb();

  const account = db.prepare("SELECT id, is_authenticated FROM accounts WHERE id = ? AND workspace_id = ?").get(accountId, ctx.workspaceId) as
    | { id: string; is_authenticated: number }
    | undefined;

  if (!account) return res.status(404).json({ error: "Account not found" });
  if (!account.is_authenticated) return res.status(400).json({ error: "Account not authenticated" });

  try {
    // A person asked for this and is waiting, so it may take as long as a large network needs.
    const sync = await syncAcceptedConnections(accountId, { mode: "full", budgetMs: 8 * 60_000 });
    if (sync.signedOut) {
      return res.status(409).json({ error: "The LinkedIn session has expired. Re-authenticate the account in Settings and try again." });
    }
    recordAudit(ctx, "account.connections_synced", "account", accountId, { stamped: sync.stamped, unmarked: sync.unmarked, verified: sync.verifiedComplete });
    return res.json({
      newly_accepted: sync.stamped,
      unmarked_not_connected: sync.unmarked,
      connections_read: sync.pulled,
      connections_on_linkedin: sync.declaredTotal,
      // False means the list could not be read end to end, so nothing was un-marked.
      verified_complete: sync.verifiedComplete,
    });
  } catch (err) {
    console.error("[sync-accepted]", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Sync failed" });
  }
}
