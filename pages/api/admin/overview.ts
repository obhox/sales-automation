import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireSuperadmin } from "@/lib/superadmin";

// Instance-wide operational overview for the superadmin dashboard.
//
// PRIVACY / SECURITY CONTRACT - read before adding a query here:
//  * Aggregates and metadata ONLY. Never select a credential column (LinkedIn
//    cookies_json, proxy_*, email account passwords, integrations.api_key, api_keys.*,
//    oauth_* hashes, webhook_endpoints.secret, users.password_hash, mail_provider_*
//    tokens, external_connections.secret_value).
//  * Never select message content or contact PII (email/LinkedIn bodies, reply text,
//    template bodies, AI prompts/output, target names/emails/phones, suppression values).
//  * Always use an explicit column list. Never SELECT * - the schema grows by appending
//    migrations, so a wildcard will eventually leak a newly added secret.
// Several tables have a nullable or absent workspace_id, so counts use COALESCE or a
// join rather than silently dropping unattributed rows.

type Row = Record<string, unknown>;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const admin = await requireSuperadmin(req, res);
  if (!admin) return;

  const db = getDb();
  // A single malformed/absent table must not blank the whole dashboard.
  const all = (sql: string, ...params: unknown[]): Row[] => {
    try {
      return db.prepare(sql).all(...params) as Row[];
    } catch (error) {
      return [{ error: error instanceof Error ? error.message : String(error) }];
    }
  };
  const one = (sql: string, ...params: unknown[]): Row => {
    try {
      return (db.prepare(sql).get(...params) as Row) ?? {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  const count = (table: string, where = ""): number => {
    try {
      return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get() as { c: number }).c;
    } catch {
      return -1; // -1 signals "unavailable" rather than a misleading 0
    }
  };

  const pageCount = one("PRAGMA page_count") as { page_count?: number };
  const pageSize = one("PRAGMA page_size") as { page_size?: number };

  return res.json({
    generated_at: new Date().toISOString(),
    viewer: admin,

    instance: {
      version: process.env.APP_VERSION ?? "dev",
      node_env: process.env.NODE_ENV ?? "unknown",
      process_uptime_seconds: Math.round(process.uptime()),
      database_bytes: (pageCount.page_count ?? 0) * (pageSize.page_size ?? 0),
    },

    tenancy: {
      workspaces: count("workspaces"),
      users: count("users"),
      members_by_role: all("SELECT role, COUNT(*) AS count FROM workspace_members GROUP BY role ORDER BY count DESC"),
      invitations: one(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted,
          SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
          SUM(CASE WHEN accepted_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now') THEN 1 ELSE 0 END) AS pending
        FROM workspace_invitations`),
      signups_last_30d: all(
        "SELECT date(created_at) AS day, COUNT(*) AS count FROM users WHERE created_at >= datetime('now','-30 days') GROUP BY day ORDER BY day",
      ),
    },

    volume: {
      contacts: count("targets"),
      companies: count("companies"),
      lists: count("lists"),
      workflows: count("workflows"),
      runs: count("runs"),
      linkedin_accounts: count("accounts"),
      email_accounts: count("email_accounts"),
      templates: count("templates"),
      opportunities: count("opportunities"),
      todos: count("todos"),
    },

    email_queue: {
      by_status: all("SELECT status, COUNT(*) AS count FROM email_jobs GROUP BY status ORDER BY count DESC"),
      // `uncertain` means a worker died between provider handoff and local commit.
      // It is the alarm state: it needs a human to reconcile, never an auto-retry.
      uncertain: count("email_jobs", "WHERE status = 'uncertain'"),
      ready_backlog: count("email_jobs", "WHERE status = 'pending' AND available_at <= datetime('now')"),
      stale_leases: count("email_jobs", "WHERE status IN ('leased','sending') AND lease_expires_at < datetime('now')"),
      attempts_exhausted: count("email_jobs", "WHERE attempt >= max_attempts AND status NOT IN ('sent','cancelled')"),
      oldest_pending: one(
        "SELECT MIN(created_at) AS oldest FROM email_jobs WHERE status = 'pending'",
      ),
    },

    deliverability: {
      sent_totals: one(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounced,
          SUM(CASE WHEN complained_at IS NOT NULL THEN 1 ELSE 0 END) AS complained,
          SUM(CASE WHEN deferred_at IS NOT NULL THEN 1 ELSE 0 END) AS deferred
        FROM sent_messages`),
      provider_events: all(
        "SELECT event_type, COUNT(*) AS count FROM sender_events GROUP BY event_type ORDER BY count DESC",
      ),
      senders: one(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN is_verified = 1 THEN 1 ELSE 0 END) AS verified,
          SUM(CASE WHEN paused_at IS NOT NULL THEN 1 ELSE 0 END) AS paused
        FROM email_accounts`),
      suppressions_by_kind: all("SELECT kind, COUNT(*) AS count FROM suppressions GROUP BY kind ORDER BY count DESC"),
    },

    campaigns: {
      runs_by_status: all("SELECT status, COUNT(*) AS count FROM runs GROUP BY status ORDER BY count DESC"),
      tracks_by_state: all(
        "SELECT track, state, COUNT(*) AS count FROM run_profile_tracks GROUP BY track, state ORDER BY track, count DESC",
      ),
      // In-progress work whose next step came due over an hour ago is likely wedged.
      stuck_tracks: count(
        "run_profile_tracks",
        "WHERE state = 'in_progress' AND next_step_at IS NOT NULL AND next_step_at < datetime('now','-1 hour')",
      ),
      run_log_levels: all("SELECT level, COUNT(*) AS count FROM logs GROUP BY level ORDER BY count DESC"),
      imports_by_status: all("SELECT status, COUNT(*) AS count FROM list_imports GROUP BY status ORDER BY count DESC"),
    },

    linkedin: {
      // Session material (cookies_json, proxy_*) is deliberately never selected.
      accounts: one(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN is_authenticated = 1 THEN 1 ELSE 0 END) AS authenticated,
          SUM(CASE WHEN is_authenticated = 1 THEN 0 ELSE 1 END) AS needs_reauth
        FROM accounts`),
    },

    workers: {
      // The operator's own infrastructure; no tenant data involved.
      leases: all(`SELECT name, owner_id, expires_at, heartbeat_at,
          CASE WHEN expires_at > datetime('now') THEN 1 ELSE 0 END AS alive
        FROM worker_leases ORDER BY name`),
    },

    eventing: {
      domain_events: one(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) AS unprocessed,
          MIN(CASE WHEN processed_at IS NULL THEN occurred_at END) AS oldest_unprocessed
        FROM domain_events`),
      events_by_type: all(
        "SELECT type, COUNT(*) AS count FROM domain_events GROUP BY type ORDER BY count DESC LIMIT 20",
      ),
      webhook_deliveries: all(
        "SELECT status, COUNT(*) AS count FROM webhook_deliveries GROUP BY status ORDER BY count DESC",
      ),
      external_sync: all(
        "SELECT status, COUNT(*) AS count FROM external_sync_records GROUP BY status ORDER BY count DESC",
      ),
    },

    governance: {
      // action/entity metadata only - metadata_json and ip_address are denylisted.
      audit_actions: all(
        "SELECT action, COUNT(*) AS count FROM audit_logs GROUP BY action ORDER BY count DESC LIMIT 20",
      ),
      api_keys: one(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
          SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now')) THEN 1 ELSE 0 END) AS active
        FROM api_keys`),
      // request_json is denylisted; only tool name, outcome and latency.
      mcp_tools: all(`SELECT tool_name,
          COUNT(*) AS calls,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS succeeded,
          ROUND(AVG(duration_ms)) AS avg_ms
        FROM mcp_audit_logs GROUP BY tool_name ORDER BY calls DESC LIMIT 20`),
      oauth_clients: count("oauth_clients"),
    },

    ai_spend: {
      // prompt and generated_text are denylisted - cost/token metrics only.
      totals: one(`SELECT
          COUNT(*) AS generations,
          ROUND(SUM(cost_usd), 4) AS cost_usd,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens
        FROM agent_sessions`),
      by_model: all(`SELECT COALESCE(model,'unknown') AS model, COUNT(*) AS generations,
          ROUND(SUM(cost_usd), 4) AS cost_usd
        FROM agent_sessions GROUP BY model ORDER BY cost_usd DESC LIMIT 20`),
      last_14d: all(`SELECT date(created_at) AS day, ROUND(SUM(cost_usd), 4) AS cost_usd,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
        FROM agent_sessions WHERE created_at >= datetime('now','-14 days')
        GROUP BY day ORDER BY day`),
    },

    // A live "what is happening" feed. Type and timing only, never payload_json.
    recent_events: all(`SELECT type, entity_type, COALESCE(workspace_id,'unattributed') AS workspace_id, occurred_at
      FROM domain_events ORDER BY occurred_at DESC LIMIT 50`),
  });
}
