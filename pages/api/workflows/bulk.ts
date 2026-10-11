import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { campaignStatus } from "@/lib/campaigns/summary";
import { copySequence } from "@/lib/outreach/publish";
import { roleAtLeast } from "@/lib/roles";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

const ACTIONS = ["pause", "resume", "duplicate", "archive", "unarchive"] as const;
type Action = (typeof ACTIONS)[number];
const MAX_AT_ONCE = 100;

/**
 * One action on several campaigns.
 *   POST { ids: [...], action: pause | resume | duplicate | archive | unarchive }
 *   → { results: [{ id, ok, error?, new_id? }], done }
 *
 * Pausing and resuming act on a campaign's run and need a manager, as they do one at a
 * time; the rest need a member. Each campaign is answered for by itself: one that cannot
 * take the action (nothing running to pause, still sending so it cannot be archived) says
 * why and the others go ahead.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;
  const db = getDb();
  const action = req.body?.action as Action;
  const ids = Array.isArray(req.body?.ids) ? [...new Set((req.body.ids as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
  if (!ACTIONS.includes(action)) return res.status(400).json({ error: `action must be one of ${ACTIONS.join(", ")}` });
  if (ids.length === 0) return res.status(400).json({ error: "ids is required" });
  if (ids.length > MAX_AT_ONCE) return res.status(400).json({ error: `At most ${MAX_AT_ONCE} campaigns at a time` });
  if ((action === "pause" || action === "resume") && !roleAtLeast(ctx.role, "manager")) return res.status(403).json({ error: "Pausing and resuming a campaign needs a manager", required_role: "manager" });

  const results: Array<{ id: string; ok: boolean; error?: string; new_id?: string }> = [];
  let started = false;
  for (const id of ids) {
    const campaign = db.prepare("SELECT id, name, description, prompt, send_in_recipient_tz, COALESCE(is_archived, 0) AS archived FROM workflows WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as
      | { id: string; name: string; description: string | null; prompt: string | null; send_in_recipient_tz: number; archived: number }
      | undefined;
    if (!campaign) { results.push({ id, ok: false, error: "Not found" }); continue; }
    const runs = db.prepare("SELECT id, status FROM runs WHERE workflow_id = ? AND workspace_id = ?").all(id, ctx.workspaceId) as Array<{ id: string; status: string }>;
    const status = campaignStatus(Boolean(campaign.archived), runs.map((run) => run.status));

    if (action === "pause") {
      const running = runs.filter((run) => run.status === "running");
      if (running.length === 0) { results.push({ id, ok: false, error: "Nothing is running to pause" }); continue; }
      for (const run of running) db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(run.id);
      recordAudit(ctx, "run.status_changed", "workflow", id, { status: "paused", runs: running.length });
    } else if (action === "resume") {
      const paused = runs.filter((run) => run.status === "paused");
      if (paused.length === 0) { results.push({ id, ok: false, error: "Nothing is paused to resume" }); continue; }
      for (const run of paused) db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(run.id);
      recordAudit(ctx, "run.started", "workflow", id, { runs: paused.length });
      started = true;
    } else if (action === "duplicate") {
      const newId = randomUUID();
      db.transaction(() => {
        db.prepare("INSERT INTO workflows (id, workspace_id, name, description, prompt, send_in_recipient_tz, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(newId, ctx.workspaceId, `${campaign.name} (copy)`, campaign.description, campaign.prompt, campaign.send_in_recipient_tz ?? 0, ctx.userId);
        copySequence(db, ctx.workspaceId, id, newId);
      })();
      recordAudit(ctx, "workflow.duplicated", "workflow", newId, { from: id });
      results.push({ id, ok: true, new_id: newId });
      continue;
    } else if (action === "archive") {
      // An archived campaign is out of sight. One that is still sending must not be.
      if (status === "active") { results.push({ id, ok: false, error: "It is still running. Pause it first" }); continue; }
      db.prepare("UPDATE workflows SET is_archived = 1 WHERE id = ?").run(id);
      recordAudit(ctx, "workflow.archived", "workflow", id, { is_archived: true });
    } else {
      db.prepare("UPDATE workflows SET is_archived = 0 WHERE id = ?").run(id);
      recordAudit(ctx, "workflow.archived", "workflow", id, { is_archived: false });
    }
    results.push({ id, ok: true });
  }
  if (started) ensureGlobalRunnerStarted();
  return res.json({ results, done: results.filter((result) => result.ok).length });
}
