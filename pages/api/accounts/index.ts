import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  // Excludes cookies_json — the frontend never uses the raw session blob, only
  // is_authenticated, so there's no reason to ship it (even encrypted) to the client.
  const ACCOUNT_COLUMNS = `id, name, email, is_authenticated, daily_connection_limit, daily_message_limit, daily_inmail_limit,
    active_hours_start, active_hours_end, timezone, working_days, created_at,
    inbox_synced_at, accepted_sync_at, li_connections, li_pending, li_profile_views,
    li_stats_synced_at, connections_synced_through_ms`;

  if (req.method === "GET") {
    const accounts = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE workspace_id = ? ORDER BY created_at DESC`).all(ctx.workspaceId);
    return res.json(accounts);
  }

  if (req.method === "POST") {
    const { name, email, daily_connection_limit = 20, daily_message_limit = 50, daily_inmail_limit = 15 } = req.body;
    if (!name || !email) return res.status(400).json({ error: "name and email required" });
    try {
      const id = randomUUID();
      db
        .prepare(
          "INSERT INTO accounts (id, workspace_id, name, email, daily_connection_limit, daily_message_limit, daily_inmail_limit) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(id, ctx.workspaceId, name, email, daily_connection_limit, daily_message_limit, daily_inmail_limit);
      const account = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ? AND workspace_id = ?`).get(id, ctx.workspaceId);
      recordAudit(ctx, "account.created", "account", id);
      return res.status(201).json(account);
    } catch {
      return res.status(409).json({ error: "Email already exists" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}
