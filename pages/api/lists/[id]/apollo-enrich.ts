import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { apolloKey, enrichTargetFromApollo } from "@/lib/contacts/apollo-enrich";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx=requireWorkspace(req,res,"member"); if(!ctx)return;

  const db = getDb();
  const listId = req.query.id as string;
  if(!requireWorkspaceEntity(res,ctx,"lists",listId))return;

  const list = db.prepare("SELECT id FROM lists WHERE id = ?").get(listId);
  if (!list) return res.status(404).json({ error: "List not found" });

  const apiKey = apolloKey(db, ctx.workspaceId);
  if (!apiKey) {
    return res.status(400).json({ error: "Apollo integration not configured" });
  }

  // Optional: target_ids in body to enrich specific contacts only
  const { target_ids } = req.body as { target_ids?: string[] };

  let targets: { id: string; linkedin_url: string | null; sales_nav_url: string | null }[];
  if (target_ids && target_ids.length > 0) {
    const placeholders = target_ids.map(() => "?").join(",");
    targets = db.prepare(`
      SELECT t.id, t.linkedin_url, t.sales_nav_url
      FROM targets t
      INNER JOIN list_targets lt ON lt.target_id = t.id
      WHERE lt.list_id = ? AND t.id IN (${placeholders}) AND t.email IS NULL
        AND (t.linkedin_url IS NOT NULL OR t.sales_nav_url IS NOT NULL)
    `).all(listId, ...target_ids) as { id: string; linkedin_url: string | null; sales_nav_url: string | null }[];
  } else {
    targets = db.prepare(`
      SELECT t.id, t.linkedin_url, t.sales_nav_url
      FROM targets t
      INNER JOIN list_targets lt ON lt.target_id = t.id
      WHERE lt.list_id = ? AND t.apollo_enriched_at IS NULL AND t.email IS NULL
        AND (t.linkedin_url IS NOT NULL OR t.sales_nav_url IS NOT NULL)
    `).all(listId) as { id: string; linkedin_url: string | null; sales_nav_url: string | null }[];
  }

  let enriched = 0;
  let notFound = 0;
  let skipped = 0;

  for (const target of targets) {
    const outcome = await enrichTargetFromApollo(db, ctx.workspaceId, target, apiKey);
    if (outcome === "enriched") enriched++;
    else if (outcome === "not_found") notFound++;
    else skipped++;
  }

  return res.json({ enriched, notFound, skipped, total: targets.length });
}

export const config = {
  api: { responseLimit: false },
};
