import type { NextApiRequest, NextApiResponse } from "next";
import type { Page } from "playwright";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth, SessionExpiredError } from "@/lib/linkedin/session";
import { scrapeLinkedInStats } from "@/lib/linkedin/li-stats";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";
import { refuseIfPaused } from "@/lib/linkedin/pause";

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
  if (refuseIfPaused(db, accountId, res)) return;

  let page: Page | undefined;
  try {
    page = await getSessionPage(accountId);
    const stats = await scrapeLinkedInStats(page);
    await saveSessionState(accountId);
    // COALESCE: a figure LinkedIn did not show this time keeps its last known value rather
    // than being overwritten with nothing.
    db.prepare(`
      UPDATE accounts SET
        li_connections = COALESCE(?, li_connections),
        li_pending = COALESCE(?, li_pending),
        li_profile_views = COALESCE(?, li_profile_views),
        li_stats_synced_at = datetime('now')
      WHERE id = ?
    `).run(stats.connections, stats.pending, stats.profile_views, accountId);
    const stored = db.prepare("SELECT li_connections AS connections, li_pending AS pending, li_profile_views AS profile_views FROM accounts WHERE id = ?").get(accountId);
    return res.json(stored);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      await markNeedsReauth(accountId).catch(() => {});
      return res.status(409).json({ error: "The LinkedIn session has expired. Sign it in again on the LinkedIn accounts page." });
    }
    console.error("[li-stats]", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Scrape failed" });
  } finally {
    await page?.close().catch(() => {});
  }
}
