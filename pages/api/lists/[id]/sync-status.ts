import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

// POST /api/lists/[id]/sync-status  body: { account_id: number }
// Re-fetches the Sales Nav list and updates degree for non-connected targets.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const workspace=requireWorkspace(req,res,"member"); if(!workspace)return;

  const db = getDb();
  const listId = req.query.id as string;
  if(!requireWorkspaceEntity(res,workspace,"lists",listId))return;

  const list = db.prepare("SELECT * FROM lists WHERE id = ?").get(listId) as
    | { sales_nav_url?: string }
    | undefined;
  if (!list) return res.status(404).json({ error: "List not found" });
  if (!list.sales_nav_url) return res.status(400).json({ error: "No Sales Navigator URL saved for this list — run an import first" });

  const { account_id } = req.body as { account_id: string };
  if (!account_id) return res.status(400).json({ error: "account_id required" });

  const account = db.prepare("SELECT * FROM accounts WHERE id = ? AND workspace_id = ?").get(account_id,workspace.workspaceId) as
    | { cookies_json: string | null; is_authenticated: number }
    | undefined;
  if (!account?.is_authenticated) return res.status(400).json({ error: "Account not authenticated" });

  const { getSessionContext } = await import("@/lib/linkedin/session");
  const { scrapeNavigatorList } = await import("@/lib/linkedin/scraper");

  try {
    const ctx = await getSessionContext(account_id);
    const { profiles } = await scrapeNavigatorList(ctx, list.sales_nav_url, { maxPages: 300 });

    const updateDegree = db.prepare("UPDATE targets SET degree = ? WHERE linkedin_url = ? AND workspace_id = ?");
    const markConnected = db.prepare(
      `UPDATE targets SET degree = ?, connected_at = CASE
         WHEN (degree IS NULL OR degree != 1) AND connected_at IS NULL THEN datetime('now')
         ELSE connected_at
       END
       WHERE linkedin_url = ? AND workspace_id = ?`
    );

    let updated = 0;
    db.transaction(() => {
      for (const p of profiles) {
        if (p.degree === 1) {
          markConnected.run(p.degree, p.salesNavUrl, workspace.workspaceId);
        } else {
          updateDegree.run(p.degree, p.salesNavUrl, workspace.workspaceId);
        }
        updated++;
      }
    })();

    return res.json({ updated, total: profiles.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}

export const config = {
  api: { responseLimit: false },
};
