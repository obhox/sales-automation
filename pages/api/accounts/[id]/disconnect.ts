import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";

/**
 * Sign a LinkedIn sender out without removing it.
 *
 * Clears the stored session and drops the live browser context, but keeps the account row,
 * its limits and its campaign history — so the user can reconnect from Settings later
 * without rebuilding anything. This is the reversible counterpart to DELETE, and the right
 * action for "this session is stale" or "stop using this account for now".
 *
 * The runner's active-run query filters on `is_authenticated = 1`, so clearing that flag is
 * what actually stops LinkedIn work for this account on the next tick.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "admin"); if (!ctx) return;

  const db = getDb();
  const id = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "accounts", id)) return;

  const account = db
    .prepare("SELECT id, name FROM accounts WHERE id = ? AND workspace_id = ?")
    .get(id, ctx.workspaceId) as { id: string; name: string } | undefined;
  if (!account) return res.status(404).json({ error: "Account not found" });

  // Tear the live Playwright context down first. markNeedsReauth already clears
  // is_authenticated and calls closeSession; we additionally drop cookies_json so no session
  // material is retained for an account the user has explicitly signed out.
  const { markNeedsReauth } = await import("@/lib/linkedin/session");
  await markNeedsReauth(id);
  db.prepare("UPDATE accounts SET cookies_json = NULL WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);

  recordAudit(ctx, "account.disconnected", "account", id);
  return res.json({ ok: true, name: account.name });
}
