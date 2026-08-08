import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx=requireWorkspace(req,res); if(!ctx)return;
  if (req.method !== "GET") return res.status(405).end();

  try {
    const db = getDb();
  const workflowId = req.query.id as string;
  if(!requireWorkspaceEntity(res,ctx,"workflows",workflowId))return;
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);

    const RUNS = `SELECT id FROM runs WHERE workflow_id = ? AND status IN ('running','paused','completed')`;

    // ── Audience: enrolled vs. addressable ──────────────────────────────────────
    // The funnel's `total` counts everyone enrolled, but that overstates runway when most
    // contacts have no deliverable email. `eligible` = enrolled AND has a non-bounced email.
    // `verified` = the strict subset with a verified email. `email_real_replies` excludes
    // auto-responders (OOO / substitute / call_task are automated) so the reply signal is honest.
    const audience = db.prepare(`
      WITH enrolled AS (
        SELECT DISTINCT rp.target_id
        FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
        WHERE r.workflow_id = ? AND r.status IN ('running','paused','completed')
      )
      SELECT
        (SELECT COUNT(*) FROM enrolled) AS enrolled,
        (SELECT COUNT(*) FROM enrolled e JOIN targets t ON t.id = e.target_id
          WHERE t.email IS NOT NULL AND t.email != ''
            AND (t.email_status IS NULL OR t.email_status NOT IN ('invalid','unavailable'))) AS eligible,
        (SELECT COUNT(*) FROM enrolled e JOIN targets t ON t.id = e.target_id
          WHERE t.email_status = 'verified') AS verified,
        (SELECT COUNT(DISTINCT t.id) FROM enrolled e JOIN targets t ON t.id = e.target_id
          WHERE t.reply_kind IN ('human_reply','not_interested')) AS email_real_replies,
        (SELECT COUNT(DISTINCT t.id) FROM enrolled e JOIN targets t ON t.id = e.target_id
          WHERE t.reply_kind IN ('ooo_followup','substitute','call_task')) AS email_auto_replies
    `).get(workflowId) as {
      enrolled: number; eligible: number; verified: number;
      email_real_replies: number; email_auto_replies: number;
    };

    // Eligible contacts we've actually emailed at least once (Email sent log).
    const contactedRow = db.prepare(`
      SELECT COUNT(DISTINCT l.target_id) AS contacted
      FROM logs l JOIN targets t ON t.id = l.target_id
      WHERE l.run_id IN (${RUNS}) AND l.message LIKE 'Email sent%'
        AND t.email IS NOT NULL AND t.email != ''
        AND (t.email_status IS NULL OR t.email_status NOT IN ('invalid','unavailable'))
    `).get(workflowId) as { contacted: number };

    const audienceOut = {
      enrolled: audience.enrolled,
      eligible: audience.eligible,        // has a deliverable email — the real addressable count
      verified: audience.verified,        // strict subset with a verified email
      contacted: contactedRow.contacted,  // eligible contacts emailed at least once
      replied: audience.email_real_replies,       // genuine human replies (auto-responders excluded)
      auto_replied: audience.email_auto_replies,  // OOO / substitute / call_task (informational)
      remaining: Math.max(audience.eligible - contactedRow.contacted, 0), // eligible not yet emailed
    };

    // ── Funnel ────────────────────────────────────────────────────────────────
    const funnel = db.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT rp.target_id)
          FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
          WHERE r.workflow_id = ? AND r.status IN ('running','paused','completed')) AS total,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${RUNS}) AND message LIKE 'Connection request sent%') AS connections_sent,

        (SELECT COUNT(DISTINCT l.target_id) FROM logs l
          JOIN targets t ON t.id = l.target_id
          WHERE l.run_id IN (${RUNS})
            AND l.message LIKE 'Connection request sent%'
            AND t.connected_at IS NOT NULL) AS connected,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${RUNS}) AND message LIKE 'Message sent%') AS messages_sent,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${RUNS}) AND message LIKE 'InMail sent%') AS inmails_sent,

        (SELECT COUNT(DISTINCT l.target_id) FROM logs l
          JOIN targets t ON t.id = l.target_id
          WHERE l.run_id IN (${RUNS})
            AND (l.message LIKE 'Message sent%' OR l.message LIKE 'InMail sent%')
            AND t.last_replied_at IS NOT NULL) AS li_replies,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${RUNS}) AND message LIKE 'Email sent%') AS emails_sent,

        (SELECT COUNT(DISTINCT l.target_id) FROM logs l
          JOIN targets t ON t.id = l.target_id
          WHERE l.run_id IN (${RUNS})
            AND l.message LIKE 'Email sent%'
            AND t.email_replied_at IS NOT NULL) AS email_replies,

        (SELECT COUNT(DISTINCT rp.target_id)
          FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
          WHERE r.workflow_id = ? AND r.status IN ('running','paused','completed')
            AND NOT EXISTS (
              SELECT 1 FROM run_profile_tracks rt
              WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped')
            )
            AND EXISTS (
              SELECT 1 FROM run_profile_tracks rt
              WHERE rt.run_profile_id = rp.id AND rt.state = 'completed'
            )) AS completed
    `).get(
      workflowId, workflowId, workflowId, workflowId,
      workflowId, workflowId, workflowId, workflowId, workflowId,
    ) as {
      total: number; connections_sent: number; connected: number;
      messages_sent: number; inmails_sent: number; li_replies: number;
      emails_sent: number; email_replies: number; completed: number;
    };

    // ── Daily activity ────────────────────────────────────────────────────────
    const activity = db.prepare(`
      SELECT
        date(l.created_at) AS day,
        COUNT(CASE WHEN l.message LIKE 'Visited%' THEN 1 END) AS visits,
        COUNT(CASE WHEN l.message LIKE 'Connection request sent%' THEN 1 END) AS connections,
        COUNT(CASE WHEN l.message LIKE 'Message sent%' THEN 1 END) AS messages,
        COUNT(CASE WHEN l.message LIKE 'InMail sent%' THEN 1 END) AS inmails,
        COUNT(CASE WHEN l.message LIKE 'Email sent%' THEN 1 END) AS emails
      FROM logs l
      WHERE l.run_id IN (${RUNS})
        AND l.created_at >= datetime('now', '-${days} days')
      GROUP BY date(l.created_at)
      ORDER BY day ASC
    `).all(workflowId) as { day: string; visits: number; connections: number; messages: number; inmails: number; emails: number }[];

    const filled: typeof activity = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = activity.find(r => r.day === key);
      filled.push(found ?? { day: key, visits: 0, connections: 0, messages: 0, inmails: 0, emails: 0 });
    }

    // ── AI cost — daily time-series scoped to this workflow's runs ────────────
    const aiDaily = db.prepare(`
      SELECT
        date(a.created_at) AS day,
        SUM(a.cost_usd) AS cost_usd,
        SUM(a.input_tokens) AS input_tokens,
        SUM(a.output_tokens) AS output_tokens
      FROM agent_sessions a
      WHERE a.run_id IN (${RUNS})
        AND a.created_at >= datetime('now', '-${days} days')
      GROUP BY date(a.created_at)
      ORDER BY day ASC
    `).all(workflowId) as { day: string; cost_usd: number; input_tokens: number; output_tokens: number }[];

    const aiDailyFilled: typeof aiDaily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = aiDaily.find(r => r.day === key);
      aiDailyFilled.push(found ?? { day: key, cost_usd: 0, input_tokens: 0, output_tokens: 0 });
    }

    // ── AI cost — breakdown per step (step_type + step_order from workflow_steps) ─
    const aiByStep = db.prepare(`
      SELECT
        ws.step_order,
        ws.step_type,
        COUNT(a.id) AS call_count,
        SUM(a.input_tokens) AS input_tokens,
        SUM(a.output_tokens) AS output_tokens,
        SUM(a.cost_usd) AS cost_usd,
        GROUP_CONCAT(DISTINCT a.model) AS models
      FROM agent_sessions a
      JOIN workflow_steps ws ON ws.id = a.step_id
      WHERE a.run_id IN (${RUNS})
      GROUP BY a.step_id
      ORDER BY ws.step_order
    `).all(workflowId) as {
      step_order: number; step_type: string; call_count: number;
      input_tokens: number; output_tokens: number; cost_usd: number; models: string;
    }[];

    // ── Email A/B test results — per-variant sent/opens/clicks for steps that have variants ──
    const emailStepsWithVariants = db.prepare(`
      SELECT ws.id AS step_id, ws.step_order
      FROM workflow_steps ws
      WHERE ws.workflow_id = ? AND ws.track = 'email'
        AND EXISTS (SELECT 1 FROM workflow_step_email_variants v WHERE v.step_id = ws.id)
      ORDER BY ws.step_order
    `).all(workflowId) as { step_id: string; step_order: number }[];

    const variantStmt = db.prepare(`
      SELECT
        ej.variant_id,
        COALESCE(wsev.position, -1) AS position,
        MIN(ej.subject) AS subject,
        COUNT(DISTINCT sm.id) AS sent,
        COUNT(DISTINCT CASE WHEN se.event_type = 'opened' THEN se.id END) AS opens,
        COUNT(DISTINCT CASE WHEN se.event_type = 'clicked' THEN se.id END) AS clicks
      FROM email_jobs ej
      JOIN sent_messages sm ON sm.job_id = ej.id
      LEFT JOIN workflow_step_email_variants wsev ON wsev.id = ej.variant_id
      LEFT JOIN sender_events se ON se.sent_message_id = sm.id AND se.event_type IN ('opened','clicked')
      WHERE ej.step_id = ?
      GROUP BY ej.variant_id
      ORDER BY position
    `);

    const emailVariants = emailStepsWithVariants.map((step) => ({
      step_id: step.step_id,
      step_order: step.step_order,
      variants: (variantStmt.all(step.step_id) as {
        variant_id: string | null; subject: string; sent: number; opens: number; clicks: number;
      }[]).map((r) => ({
        variant_id: r.variant_id,
        subject: r.subject,
        sent: r.sent,
        opens: r.opens,
        clicks: r.clicks,
      })),
    }));

    res.json({ funnel, audience: audienceOut, activity: filled, aiDaily: aiDailyFilled, aiByStep, emailVariants });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load analytics" });
  }
}
