import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireSuperadmin } from "@/lib/superadmin";

// Per-tenant rollup for the superadmin dashboard.
//
// Same contract as overview.ts: counts and status metadata only. Tenant *identity*
// (workspace name/slug) and platform *account* identity (user email) are included
// because instance administration is impossible without them - but no lead/contact PII,
// no message content, and no credential column is ever selected.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const admin = await requireSuperadmin(req, res);
  if (!admin) return;

  const db = getDb();

  const workspaces = db.prepare(`SELECT
      w.id, w.name, w.slug, w.created_at,
      (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
      (SELECT COUNT(*) FROM targets t         WHERE t.workspace_id  = w.id) AS contacts,
      (SELECT COUNT(*) FROM companies c       WHERE c.workspace_id  = w.id) AS companies,
      (SELECT COUNT(*) FROM lists l           WHERE l.workspace_id  = w.id) AS lists,
      (SELECT COUNT(*) FROM workflows f       WHERE f.workspace_id  = w.id) AS workflows,
      (SELECT COUNT(*) FROM runs r            WHERE r.workspace_id  = w.id) AS runs,
      (SELECT COUNT(*) FROM runs r            WHERE r.workspace_id  = w.id AND r.status = 'running') AS active_runs,
      (SELECT COUNT(*) FROM accounts a        WHERE a.workspace_id  = w.id) AS linkedin_accounts,
      (SELECT COUNT(*) FROM accounts a        WHERE a.workspace_id  = w.id AND a.is_authenticated = 1) AS linkedin_authenticated,
      (SELECT COUNT(*) FROM email_accounts e  WHERE e.workspace_id  = w.id) AS email_accounts,
      (SELECT COUNT(*) FROM email_jobs j      WHERE j.workspace_id  = w.id AND j.status = 'uncertain') AS uncertain_jobs,
      (SELECT COUNT(*) FROM email_jobs j      WHERE j.workspace_id  = w.id AND j.status = 'failed')    AS failed_jobs,
      (SELECT COUNT(*) FROM suppressions s    WHERE s.workspace_id  = w.id) AS suppressions,
      (SELECT ROUND(SUM(g.cost_usd), 4) FROM agent_sessions g WHERE g.workspace_id = w.id) AS ai_cost_usd,
      (SELECT MAX(d.occurred_at) FROM domain_events d WHERE d.workspace_id = w.id) AS last_event_at
    FROM workspaces w
    ORDER BY w.created_at DESC`).all();

  // Platform account directory. These are the instance's own users, not leads.
  // password_hash is never selected.
  const users = db.prepare(`SELECT
      u.id, u.email, u.created_at,
      (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id) AS workspaces
    FROM users u
    ORDER BY u.created_at DESC
    LIMIT 500`).all();

  // Rows whose workspace_id was never backfilled would otherwise vanish from totals.
  const unattributed = db.prepare(`SELECT
      (SELECT COUNT(*) FROM agent_sessions WHERE workspace_id IS NULL)  AS agent_sessions,
      (SELECT COUNT(*) FROM mcp_audit_logs WHERE workspace_id IS NULL)  AS mcp_audit_logs,
      (SELECT COUNT(*) FROM oauth_tokens   WHERE workspace_id IS NULL)  AS oauth_tokens`).get();

  return res.json({ generated_at: new Date().toISOString(), workspaces, users, unattributed });
}
