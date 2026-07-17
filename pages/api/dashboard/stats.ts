import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const ctx=requireWorkspace(req,res); if(!ctx)return;

  try {
    const db = getDb();

    const listId = req.query.list_id as string | undefined;
    const workflowId = req.query.workflow_id as string | undefined;
    const days = Math.min(Math.max(Number(req.query.days) || 7, 7), 90);

    // Fetch lists and workflows for filter dropdowns (always unfiltered)
    const lists = db.prepare("SELECT id, name FROM lists WHERE workspace_id=? ORDER BY name").all(ctx.workspaceId) as { id: string; name: string }[];
    const workflows = db.prepare("SELECT id, name FROM workflows WHERE workspace_id=? ORDER BY name").all(ctx.workspaceId) as { id: string; name: string }[];
    if(listId && !requireWorkspaceEntity(res,ctx,"lists",listId))return;
    if(workflowId && !requireWorkspaceEntity(res,ctx,"workflows",workflowId))return;

    // Today's summary (always global — not scoped to filter)
    const today = db.prepare(`
      SELECT
        COUNT(CASE WHEN message LIKE 'Visited%' THEN 1 END) AS visits_today,
        COUNT(CASE WHEN message LIKE 'Connection request sent%' THEN 1 END) AS connections_today,
        COUNT(CASE WHEN message LIKE 'Message sent%' THEN 1 END) AS messages_today,
        COUNT(CASE WHEN message LIKE 'InMail sent%' THEN 1 END) AS inmails_today
      FROM logs l JOIN runs r ON r.id=l.run_id
      WHERE date(l.created_at) = date('now') AND r.workspace_id=?
    `).get(ctx.workspaceId) as Record<string, number>;

    if (!workflowId && !listId) {
      // ── Unfiltered: use targets fields (fast, global) ──────────────────────
      const ACTIVE = `workspace_id = (SELECT value FROM workspace) AND id IN (SELECT DISTINCT target_id FROM list_targets)`;

      const totals = db.prepare(`
        WITH workspace(value) AS (SELECT ?)
        SELECT
          (SELECT COUNT(*) FROM targets WHERE ${ACTIVE}) AS total_targets,
          (SELECT COUNT(*) FROM targets WHERE ${ACTIVE} AND connection_requested_at IS NOT NULL) AS connections_requested,
          (SELECT COUNT(*) FROM targets WHERE ${ACTIVE} AND connected_at IS NOT NULL) AS connected,
          (SELECT COUNT(*) FROM targets WHERE ${ACTIVE} AND message_sent_at IS NOT NULL) AS messages_sent,
          (SELECT COUNT(*) FROM targets WHERE ${ACTIVE} AND inmail_sent_at IS NOT NULL) AS inmails_sent,
          (SELECT COUNT(*) FROM targets WHERE ${ACTIVE} AND last_replied_at IS NOT NULL) AS replies_received,
          (SELECT COUNT(*) FROM runs WHERE status = 'running' AND workspace_id=(SELECT value FROM workspace)) AS active_runs,
          (SELECT COUNT(*) FROM lists WHERE workspace_id=(SELECT value FROM workspace)) AS total_lists,
          (SELECT COUNT(*) FROM workflows WHERE workspace_id=(SELECT value FROM workspace)) AS total_workflows,
          (SELECT COUNT(*) FROM logs l JOIN runs r ON r.id=l.run_id WHERE l.message LIKE 'Email sent%' AND r.workspace_id=(SELECT value FROM workspace)) AS emails_sent,
          (SELECT COUNT(*) FROM targets WHERE ${ACTIVE} AND email_replied_at IS NOT NULL) AS email_replies
      `).get(ctx.workspaceId) as Record<string, number>;

      const activity = db.prepare(`
        SELECT
          date(l.created_at) AS day,
          COUNT(CASE WHEN l.message LIKE 'Visited%' THEN 1 END) AS visits,
          COUNT(CASE WHEN l.message LIKE 'Connection request sent%' THEN 1 END) AS connections,
          COUNT(CASE WHEN l.message LIKE 'Message sent%' THEN 1 END) AS messages,
          COUNT(CASE WHEN l.message LIKE 'InMail sent%' THEN 1 END) AS inmails,
          COUNT(CASE WHEN l.message LIKE 'Email sent%' THEN 1 END) AS emails
        FROM logs l JOIN runs r ON r.id=l.run_id
        WHERE l.created_at >= datetime('now', '-${days} days') AND r.workspace_id=?
        GROUP BY date(l.created_at)
        ORDER BY day ASC
      `).all(ctx.workspaceId) as { day: string; visits: number; connections: number; messages: number; inmails: number; emails: number }[];

      const filled = fillDays(activity, days);
      return res.json({ totals, today, activity: filled, lists, workflows });
    }

    // ── Filtered by workflow or list: use logs as source of truth ─────────────
    // Build the scoped runs subquery + its single argument
    let runsSubquery: string;
    let runsArg: string;
    if (workflowId) {
      runsSubquery = `SELECT id FROM runs WHERE workflow_id = ? AND status IN ('running','paused','completed')`;
      runsArg = workflowId;
    } else {
      runsSubquery = `SELECT id FROM runs WHERE list_id = ? AND status IN ('running','paused','completed')`;
      runsArg = listId!;
    }

    // Targets in scope = distinct targets that appeared in scoped runs
    const SCOPED_TARGETS = `SELECT DISTINCT target_id FROM run_profiles WHERE run_id IN (${runsSubquery})`;

    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM (${SCOPED_TARGETS})) AS total_targets,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${runsSubquery})
            AND message LIKE 'Connection request sent%') AS connections_requested,

        (SELECT COUNT(DISTINCT l.target_id) FROM logs l
          JOIN targets t ON t.id = l.target_id
          WHERE l.run_id IN (${runsSubquery})
            AND l.message LIKE 'Connection request sent%'
            AND t.connected_at IS NOT NULL) AS connected,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${runsSubquery})
            AND message LIKE 'Message sent%') AS messages_sent,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${runsSubquery})
            AND message LIKE 'InMail sent%') AS inmails_sent,

        (SELECT COUNT(DISTINCT l.target_id) FROM logs l
          JOIN targets t ON t.id = l.target_id
          WHERE l.run_id IN (${runsSubquery})
            AND (l.message LIKE 'Message sent%' OR l.message LIKE 'InMail sent%')
            AND t.last_replied_at IS NOT NULL) AS replies_received,

        (SELECT COUNT(*) FROM runs WHERE status = 'running') AS active_runs,
        (SELECT COUNT(*) FROM lists) AS total_lists,
        (SELECT COUNT(*) FROM workflows) AS total_workflows,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${runsSubquery})
            AND message LIKE 'Email sent%') AS emails_sent,

        (SELECT COUNT(DISTINCT l.target_id) FROM logs l
          JOIN targets t ON t.id = l.target_id
          WHERE l.run_id IN (${runsSubquery})
            AND l.message LIKE 'Email sent%'
            AND t.email_replied_at IS NOT NULL) AS email_replies
    `).get(
      runsArg,  // SCOPED_TARGETS
      runsArg,  // connections_requested
      runsArg,  // connected
      runsArg,  // messages_sent
      runsArg,  // inmails_sent
      runsArg,  // replies_received
      runsArg,  // emails_sent
      runsArg,  // email_replies
    ) as Record<string, number>;
    const workspaceCounts=db.prepare(`SELECT
      (SELECT COUNT(*) FROM runs WHERE status='running' AND workspace_id=?) active_runs,
      (SELECT COUNT(*) FROM lists WHERE workspace_id=?) total_lists,
      (SELECT COUNT(*) FROM workflows WHERE workspace_id=?) total_workflows`).get(ctx.workspaceId,ctx.workspaceId,ctx.workspaceId) as Record<string,number>;
    Object.assign(totals,workspaceCounts);

    const activity = db.prepare(`
      SELECT
        date(created_at) AS day,
        COUNT(CASE WHEN message LIKE 'Visited%' THEN 1 END) AS visits,
        COUNT(CASE WHEN message LIKE 'Connection request sent%' THEN 1 END) AS connections,
        COUNT(CASE WHEN message LIKE 'Message sent%' THEN 1 END) AS messages,
        COUNT(CASE WHEN message LIKE 'InMail sent%' THEN 1 END) AS inmails,
        COUNT(CASE WHEN message LIKE 'Email sent%' THEN 1 END) AS emails
      FROM logs
      WHERE created_at >= datetime('now', '-${days} days')
        AND run_id IN (${runsSubquery})
      GROUP BY date(created_at)
      ORDER BY day ASC
    `).all(runsArg) as { day: string; visits: number; connections: number; messages: number; inmails: number; emails: number }[];

    const filled = fillDays(activity, days);
    return res.json({ totals, today, activity: filled, lists, workflows });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load dashboard stats" });
  }
}

function fillDays(
  activity: { day: string; visits: number; connections: number; messages: number; inmails: number; emails: number }[],
  days: number
) {
  const filled: typeof activity = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const found = activity.find(r => r.day === key);
    filled.push(found ?? { day: key, visits: 0, connections: 0, messages: 0, inmails: 0, emails: 0 });
  }
  return filled;
}
