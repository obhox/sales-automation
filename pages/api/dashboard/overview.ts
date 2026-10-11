import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { currentAlerts } from "@/lib/platform/alerts";
import { DASHBOARD_RANGES, isDashboardRange, workspaceDashboard } from "@/lib/reporting/dashboard";
import { readRunnerHealth } from "@/lib/system/health";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

/**
 * GET: the dashboard.
 *   ?range=7d|30d|90d (default 7d)
 *   ?workflow_id=   one campaign     ?list_id=   contacts enrolled from one list     ?owner_id=   one member's campaigns
 *
 * → { dashboard, alerts, health }
 *   dashboard.kpis      emails sent, LinkedIn actions, reply rate, positive replies and meetings booked,
 *                       each beside the period before and as bars across the period
 *   dashboard.activity  sends by channel and replies, a bar a day (a bar a week for 90d)
 *   dashboard.funnel    how far contacts got, added up over the campaigns in flight (or the one picked)
 *   dashboard.today     today's sends against what the senders in use may do; always the whole workspace
 *   dashboard.campaigns the campaigns in scope with their reply and acceptance rates
 *   alerts              what needs attention now (also at GET /api/alerts)
 *
 * The rates are of what was sent in the period, with a reply counted for the message it
 * answers. Counts of replies, positive replies and meetings are of the day they arrived.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer"); if (!ctx) return;
  const db = getDb();
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || null;
  const range = one(req.query.range) ?? "7d";
  if (!isDashboardRange(range)) return res.status(400).json({ error: `range must be one of ${DASHBOARD_RANGES.join(", ")}` });
  const workflowId = one(req.query.workflow_id);
  const listId = one(req.query.list_id);
  const ownerId = one(req.query.owner_id);
  if (workflowId && !requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;
  if (listId && !requireWorkspaceEntity(res, ctx, "lists", listId)) return;
  if (ownerId && !db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ctx.workspaceId, ownerId)) return res.status(404).json({ error: "Resource not found" });

  const health = readRunnerHealth(db);
  return res.json({
    dashboard: workspaceDashboard(db, ctx.workspaceId, { range, workflow_id: workflowId, list_id: listId, owner_id: ownerId }),
    alerts: currentAlerts(db, ctx.workspaceId, ctx.role),
    // Whether sending is live, for the pill beside the title. Which loop is behind is for the developer page.
    health: { status: health.status },
  });
}
