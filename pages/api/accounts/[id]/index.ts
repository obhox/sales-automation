import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { LINKEDIN_ACCOUNT_COLUMNS, linkedinAccountView } from "@/lib/linkedin/account-list";
import { ACCOUNT_NUMBER_FIELDS, CLEARABLE_NUMBER_FIELDS, accountSettingsProblem } from "@/lib/linkedin/account-settings";
import { normaliseProxyUrl } from "@/lib/linkedin/session-context";

/** A switch sent as true / 1 is on; anything else sent is off. */
const asFlag = (value: unknown) => (value === true || value === 1 ? 1 : 0);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;

  if (req.method === "GET") {
    // ?view=overview is what the LinkedIn accounts screen reads; the bare row is what the
    // API and the MCP tool have always been given.
    if (req.query.view === "overview") {
      const account = linkedinAccountView(db, ctx.workspaceId, id);
      return account ? res.json(account) : res.status(404).json({ error: "Not found" });
    }
    const account = db.prepare(`SELECT ${LINKEDIN_ACCOUNT_COLUMNS} FROM accounts WHERE id = ? AND workspace_id = ?`).get(id, ctx.workspaceId);
    if (!account) return res.status(404).json({ error: "Not found" });
    return res.json(account);
  }

  if (req.method === "PUT") {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    const current = db.prepare("SELECT active_hours_start, active_hours_end, proxy_url, daily_connection_limit FROM accounts WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as
      | { active_hours_start: number; active_hours_end: number; proxy_url: string | null; daily_connection_limit: number | null }
      | undefined;
    if (!current) return res.status(404).json({ error: "Not found" });

    // Hard ceiling regardless of client input: unbounded profile visiting reads as scraping
    // to LinkedIn's abuse detection, so a larger number is lowered, not refused.
    if (typeof body.daily_visit_limit === "number" && body.daily_visit_limit > 150) body.daily_visit_limit = 150;
    const problem = accountSettingsProblem(body, current);
    if (problem) return res.status(400).json({ error: problem });
    const fullLimit = (body.daily_connection_limit as number | null | undefined) ?? current.daily_connection_limit ?? 20;
    if (typeof body.ramp_start_limit === "number" && body.ramp_start_limit > fullLimit) return res.status(400).json({ error: "Warm-up cannot start above the daily invitation limit" });

    const sets: string[] = [];
    const values: unknown[] = [];
    const changed: string[] = [];
    const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); changed.push(column); };

    for (const field of ["name", "email", "timezone", "working_days"]) {
      if (body[field] != null && String(body[field]).trim()) set(field, String(body[field]).trim());
    }
    for (const field of [...ACCOUNT_NUMBER_FIELDS, "active_hours_start", "active_hours_end"]) {
      if (body[field] === undefined) continue;
      if (body[field] === null) {
        if (CLEARABLE_NUMBER_FIELDS.includes(field)) set(field, null);
        continue;
      }
      set(field, body[field]);
    }
    if (body.ramp_start_date !== undefined) set("ramp_start_date", body.ramp_start_date ? String(body.ramp_start_date) : null);
    for (const field of ["plan", "proxy_label"]) {
      if (body[field] !== undefined) set(field, body[field] == null || !String(body[field]).trim() ? null : String(body[field]).trim());
    }
    // The stale-invitation clean-up is on only when someone says so; reading replies from
    // the account's LinkedIn inbox is on unless switched off.
    if (body.withdraw_stale_invites != null) set("withdraw_stale_invites", asFlag(body.withdraw_stale_invites));
    if (body.sync_inbox != null) set("sync_inbox", asFlag(body.sync_inbox));

    if (body.owner_id !== undefined) {
      const ownerId = body.owner_id ? String(body.owner_id) : null;
      if (ownerId && !db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ctx.workspaceId, ownerId)) {
        return res.status(400).json({ error: "The owner must be a member of this workspace" });
      }
      set("owner_id", ownerId);
    }

    // The proxy. An empty address removes it along with its sign-in. A password is only
    // ever written, never read back: leaving it out keeps the one that is stored.
    if (body.proxy_url !== undefined) {
      const url = typeof body.proxy_url === "string" ? body.proxy_url.trim() : "";
      if (!url) {
        set("proxy_url", null); set("proxy_username", null); set("proxy_password", null);
      } else {
        set("proxy_url", normaliseProxyUrl(url));
      }
    }
    const proxyStays = body.proxy_url === undefined ? Boolean(current.proxy_url) : Boolean(typeof body.proxy_url === "string" && body.proxy_url.trim());
    if (proxyStays) {
      if (body.proxy_username !== undefined) set("proxy_username", body.proxy_username ? String(body.proxy_username).trim() : null);
      if (body.proxy_password !== undefined) set("proxy_password", body.proxy_password ? encryptSecret(String(body.proxy_password)) : null);
    }

    if (sets.length > 0) {
      try {
        db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`).run(...values, id, ctx.workspaceId);
      } catch {
        return res.status(409).json({ error: "Another LinkedIn account already uses this email" });
      }
    }
    // Which settings changed, and the two switches' new values. Never a secret.
    const switches = { ...(body.withdraw_stale_invites != null ? { withdraw_stale_invites: asFlag(body.withdraw_stale_invites) } : {}), ...(body.sync_inbox != null ? { sync_inbox: asFlag(body.sync_inbox) } : {}) };
    recordAudit(ctx, "account.updated", "account", id, changed.length > 0 ? { ...switches, fields: changed } : undefined);
    return res.json(db.prepare(`SELECT ${LINKEDIN_ACCOUNT_COLUMNS} FROM accounts WHERE id = ? AND workspace_id = ?`).get(id, ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    const account = db
      .prepare("SELECT id FROM accounts WHERE id = ? AND workspace_id = ?")
      .get(id, ctx.workspaceId) as { id: string } | undefined;
    if (!account) return res.status(404).json({ error: "Not found" });

    // Refuse while campaigns are live. Deleting the account takes its runs with it, and
    // silently ending someone's outreach is not a side effect a delete button should have —
    // the user pauses them first, deliberately.
    const blocking = db
      .prepare(
        `SELECT r.id, w.name FROM runs r
         LEFT JOIN workflows w ON w.id = r.workflow_id
         WHERE r.account_id = ? AND r.status IN ('running', 'pending')`
      )
      .all(id) as Array<{ id: string; name: string | null }>;
    if (blocking.length > 0) {
      return res.status(409).json({
        error: "Account is in use by active campaigns",
        message: `Pause or stop ${blocking.length} active campaign${blocking.length === 1 ? "" : "s"} before deleting this account.`,
        campaigns: blocking.map((r) => ({ run_id: r.id, name: r.name ?? "Untitled campaign" })),
      });
    }

    // Drop the live browser context before the row goes away, so a cached session can't
    // outlive the account it belongs to.
    const { closeSession } = await import("@/lib/linkedin/session");
    try { await closeSession(id); } catch { /* best effort — the row is going regardless */ }

    // runs.account_id is a plain REFERENCES with no ON DELETE action and foreign_keys is ON,
    // so the account cannot be removed while any run still points at it — this used to fail
    // outright for every account that had ever run a campaign. Historical runs are deleted
    // rather than detached: the runner reaches runs through `JOIN accounts`, so a detached
    // run would be invisible forever instead of merely finished. Everything below a run
    // (run_profiles -> run_profile_tracks, logs) cascades; email_replies, email_jobs and
    // sent_messages null their run_id and keep their own history.
    db.transaction(() => {
      db.prepare("DELETE FROM runs WHERE account_id = ?").run(id);
      db.prepare("DELETE FROM accounts WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    })();

    recordAudit(ctx, "account.deleted", "account", id);
    return res.status(204).end();
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end();
}
