import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { roleAtLeast } from "@/lib/roles";
import { campaignSettings, mayChange, saveSettings, settingsProblem, type SettingsChange } from "@/lib/campaigns/settings";
import { setupOptions } from "@/lib/campaigns/setup";
import { campaignSummaries } from "@/lib/campaigns/summary";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * A campaign's Settings tab.
 *
 *   GET  → { campaign, settings, options, members }
 *        settings: name, description, owner_id, send_in_recipient_tz, ab_auto_promote, spam_filter (inherit|off|flag|remove), spam_filter_default,
 *        setup (exclusions, LinkedIn accounts and rotation, mailboxes), tracking (opens
 *        and clicks for each email), run (the run in flight and how many are part-way through)
 *   PUT  { name?, description?, owner_id?, send_in_recipient_tz?, ab_auto_promote?, spam_filter?, spam_filter_default? (admin),
 *          setup?: { exclude?, account_ids?, rotation?, email_account_ids?, overlap? },
 *          tracking?: [{ step_id, opens, clicks }] }
 *        → the same, plus `pool` when the LinkedIn accounts of a run in flight changed
 *
 * A member can rename a campaign or change its owner. Changing how it sends (time zone,
 * senders, exclusions, tracking, automatic A/B promotion) while contacts are part-way
 * through needs a manager. New LinkedIn accounts reach the run in flight: contacts who
 * have started stay with the account that started them. Mailboxes and exclusions apply to
 * contacts enrolled from then on. Archiving and deleting are on /api/workflows/{id}.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", ["GET", "PUT"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member"); if (!ctx) return;
  const db = getDb();
  const id = req.query.id as string;
  const current = campaignSettings(db, ctx.workspaceId, id);
  if (!current) return res.status(404).json({ error: "Resource not found" });

  let pool = null;
  if (req.method === "PUT") {
    const change = (req.body ?? {}) as SettingsChange;
    if (!mayChange(ctx.role, change, current.run?.in_flight ?? 0)) return res.status(403).json({ error: "Contacts are part-way through this campaign, so changing how it sends needs a manager" });
    // The default every campaign follows is the workspace's, not this campaign's.
    if (change.spam_filter_default !== undefined && !roleAtLeast(ctx.role, "admin")) return res.status(403).json({ error: "Only an admin changes the workspace's spam filter default", required_role: "admin" });
    const problem = settingsProblem(db, ctx.workspaceId, id, change);
    if (problem) return res.status(400).json({ error: problem });
    pool = saveSettings(db, ctx.workspaceId, id, change).pool;
    recordAudit(ctx, "workflow.settings_changed", "workflow", id, { changed: Object.keys(change).filter((key) => (change as Record<string, unknown>)[key] !== undefined) });
  }

  const members = db.prepare(
    `SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY lower(COALESCE(NULLIF(u.name, ''), u.email))`,
  ).all(ctx.workspaceId) as Array<{ id: string; name: string }>;
  return res.json({
    campaign: campaignSummaries(db, ctx.workspaceId).find((candidate) => candidate.id === id),
    settings: campaignSettings(db, ctx.workspaceId, id),
    options: setupOptions(db, ctx.workspaceId),
    members,
    pool,
  });
}
