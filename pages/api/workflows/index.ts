import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { parsePaging } from "@/lib/api/paging";
import { CAMPAIGN_SORTS, campaignList, type CampaignSort } from "@/lib/campaigns/summary";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    // ?view=list is what the campaigns screen reads: each campaign with its status and
    // figures, filtered, sorted and paged. The bare list is what the API and the MCP tool
    // have always been given.
    if (req.query.view === "list") {
      const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
      const paging = parsePaging(req.query, { defaultLimit: 25, maxLimit: 100 });
      const [sortKey, sortDirection] = (one(req.query.sort) ?? "").split(":");
      return res.json(campaignList(db, ctx.workspaceId, {
        status: one(req.query.status), q: one(req.query.q), channel: one(req.query.channel), owner: one(req.query.owner),
        sort: (CAMPAIGN_SORTS as readonly string[]).includes(sortKey) ? { key: sortKey as CampaignSort, direction: sortDirection === "asc" ? "asc" : "desc" } : undefined,
        page: paging.page, limit: paging.limit,
      }));
    }
    const workflows = db
      .prepare(
        `SELECT w.*, COUNT(ws.id) as step_count
         FROM workflows w
         LEFT JOIN workflow_steps ws ON ws.workflow_id = w.id
         WHERE w.workspace_id = ?
         GROUP BY w.id
         ORDER BY w.created_at DESC`
      )
      .all(ctx.workspaceId);
    return res.json(workflows);
  }

  if (req.method === "POST") {
    const { name, description, prompt } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const id = randomUUID();
    // Whoever creates a campaign owns it, until someone says otherwise.
    db.prepare("INSERT INTO workflows (id, workspace_id, name, description, prompt, owner_id) VALUES (?, ?, ?, ?, ?, ?)").run(id, ctx.workspaceId, name, description ?? null, prompt ?? null, ctx.userId);
    recordAudit(ctx, "workflow.created", "workflow", id);
    return res.status(201).json(db.prepare("SELECT * FROM workflows WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  res.status(405).end();
}
