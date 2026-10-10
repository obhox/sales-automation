import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { linkedinAccountsOverview, listLinkedinAccounts, listedLinkedinAccount } from "@/lib/linkedin/account-list";
import { accountSettingsProblem, getLinkedinPreset, PRESET_ACCOUNT_FIELDS } from "@/lib/linkedin/account-settings";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    // ?view=overview is what the LinkedIn accounts screen reads. The bare list is the shape
    // the API, the MCP tool and the old settings page have always been given.
    if (req.query.view === "overview") {
      const members = db.prepare(
        `SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at ASC`,
      ).all(ctx.workspaceId) as Array<{ id: string; name: string | null; email: string }>;
      return res.json({
        ...linkedinAccountsOverview(db, ctx.workspaceId),
        preset: getLinkedinPreset(ctx.workspaceId, db),
        // Who an account can be given to. Names only: a viewer sees this too.
        members: members.map((member) => ({ id: member.id, name: member.name?.trim() || member.email.split("@")[0] })),
      });
    }
    return res.json(listLinkedinAccounts(db, ctx.workspaceId));
  }

  if (req.method === "POST") {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!name || !email) return res.status(400).json({ error: "name and email required" });

    // A new account starts from the workspace's preset; anything sent with it wins.
    const preset = getLinkedinPreset(ctx.workspaceId, db);
    const settings: Record<string, unknown> = {};
    for (const field of PRESET_ACCOUNT_FIELDS) settings[field] = body[field] ?? preset[field];
    if (typeof settings.daily_visit_limit === "number" && settings.daily_visit_limit > 150) settings.daily_visit_limit = 150;
    const timezone = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : null;
    const problem = accountSettingsProblem({ ...settings, timezone, plan: body.plan });
    if (problem) return res.status(400).json({ error: problem });

    try {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO accounts (id, workspace_id, name, email, owner_id, plan, timezone,
           daily_connection_limit, daily_message_limit, daily_inmail_limit, daily_visit_limit, weekly_connection_limit,
           daily_withdraw_limit, invite_max_wait_days, active_hours_start, active_hours_end, working_days,
           withdraw_stale_invites, ramp_days, ramp_start_limit)
         VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'UTC'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, ctx.workspaceId, name, email, ctx.userId, typeof body.plan === "string" && body.plan.trim() ? body.plan.trim() : null, timezone,
        settings.daily_connection_limit, settings.daily_message_limit, settings.daily_inmail_limit, settings.daily_visit_limit, settings.weekly_connection_limit,
        settings.daily_withdraw_limit, settings.invite_max_wait_days, settings.active_hours_start, settings.active_hours_end, settings.working_days,
        preset.withdraw_stale_invites ? 1 : 0,
        // A warm-up from the preset starts on the day the account first signs in.
        preset.ramp_days, preset.ramp_days ? Math.min(preset.ramp_start_limit ?? 5, settings.daily_connection_limit as number) : null,
      );
      const account = listedLinkedinAccount(db, ctx.workspaceId, id);
      recordAudit(ctx, "account.created", "account", id);
      return res.status(201).json(account);
    } catch {
      return res.status(409).json({ error: "Email already exists" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}
