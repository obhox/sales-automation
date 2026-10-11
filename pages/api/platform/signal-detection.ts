import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { apolloKey } from "@/lib/contacts/apollo-enrich";
import {
  DETECTION_KINDS, INTERVAL_DAYS, MAX_WATCHED, companiesOfList, estimate, readDetectionConfig, recentRuns, runDetection, runProblem, runUnderWay, saveDetectionConfig,
  unwatchCompanies, watchCompanies, watchedAccounts, type DetectionConfig, type DetectionEstimate, type DetectionRun, type WatchedAccount,
} from "@/lib/signals/detection";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

export interface DetectionOverview {
  apollo_connected: boolean;
  config: DetectionConfig;
  /** What detection would cost as it is set now. Worked out without asking Apollo anything. */
  estimate: DetectionEstimate;
  accounts: WatchedAccount[];
  runs: DetectionRun[];
  running: boolean;
  /** Why a run cannot be started now, or null when it can. */
  run_problem: string | null;
  /** When the schedule will next run. Null when detection is off. */
  next_run_at: string | null;
  limits: { max_watched: number; kinds: readonly string[]; interval_days: readonly number[] };
}

function overview(workspaceId: string): DetectionOverview {
  const db = getDb();
  const config = readDetectionConfig(db, workspaceId);
  const runs = recentRuns(db, workspaceId);
  const last = runs[0]?.started_at ?? null;
  const next = !config.enabled ? null : last ? new Date(Date.parse(`${last.replace(" ", "T")}Z`) + config.interval_days * 86_400_000).toISOString() : new Date().toISOString();
  return {
    apollo_connected: Boolean(apolloKey(db, workspaceId)),
    config,
    estimate: estimate(db, workspaceId, config),
    accounts: watchedAccounts(db, workspaceId),
    runs,
    running: runUnderWay(db, workspaceId),
    run_problem: runProblem(db, workspaceId),
    next_run_at: next,
    limits: { max_watched: MAX_WATCHED, kinds: DETECTION_KINDS, interval_days: INTERVAL_DAYS },
  };
}

/**
 * Scheduled detection of changes at watched accounts.
 *
 *   GET   settings, what they would cost, the accounts watched and the latest runs
 *   PUT   { enabled?, kinds?, interval_days?, monthly_credit_cap? }                  admin
 *   POST  { action: "watch", company_ids?: [...], list_id? }                          manager
 *         { action: "unwatch", company_ids: [...] }                                   manager
 *         { action: "run" }  check the accounts now; answers at once, the run goes on  admin
 *
 * Anything that can spend Apollo credits (turning it on, raising the cap, a run) is an
 * admin's. Choosing which accounts are watched is a manager's.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const minRole = req.method === "GET" ? "viewer" : req.method === "POST" && body.action !== "run" ? "manager" : "admin";
  const ctx = requireWorkspace(req, res, minRole);
  if (!ctx) return;
  const db = getDb();

  if (req.method === "GET") return res.json(overview(ctx.workspaceId));

  if (req.method === "PUT") {
    const before = readDetectionConfig(db, ctx.workspaceId);
    const saved = saveDetectionConfig(db, ctx.workspaceId, ctx.userId, body);
    if (!saved.ok) return res.status(400).json({ error: saved.error });
    recordAudit(ctx, before.enabled !== saved.config.enabled ? (saved.config.enabled ? "signal_detection.enabled" : "signal_detection.disabled") : "signal_detection.updated", "signal_detection", ctx.workspaceId, {
      kinds: saved.config.kinds, interval_days: saved.config.interval_days, monthly_credit_cap: saved.config.monthly_credit_cap,
    });
    return res.json(overview(ctx.workspaceId));
  }

  if (req.method === "POST") {
    const ids = Array.isArray(body.company_ids) ? body.company_ids.filter((id): id is string => typeof id === "string") : [];
    if (body.action === "watch") {
      let companies = ids;
      if (typeof body.list_id === "string" && body.list_id) {
        if (!db.prepare("SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?").get(body.list_id, ctx.workspaceId)) return res.status(404).json({ error: "List not found" });
        companies = [...companies, ...companiesOfList(db, ctx.workspaceId, body.list_id)];
      }
      if (companies.length === 0) return res.status(400).json({ error: body.list_id ? "No contact in that list has a company." : "Name the companies to watch, or a list." });
      const result = watchCompanies(db, ctx.workspaceId, ctx.userId, companies);
      if (result.added > 0) recordAudit(ctx, "signal_detection.accounts_added", "signal_detection", ctx.workspaceId, { added: result.added });
      return res.json({ ...result, overview: overview(ctx.workspaceId) });
    }
    if (body.action === "unwatch") {
      if (ids.length === 0) return res.status(400).json({ error: "Name the companies to stop watching." });
      const removed = unwatchCompanies(db, ctx.workspaceId, ids);
      if (removed > 0) recordAudit(ctx, "signal_detection.accounts_removed", "signal_detection", ctx.workspaceId, { removed });
      return res.json({ removed, overview: overview(ctx.workspaceId) });
    }
    if (body.action === "run") {
      const problem = runProblem(db, ctx.workspaceId);
      if (problem) return res.status(409).json({ error: problem });
      recordAudit(ctx, "signal_detection.run_started", "signal_detection", ctx.workspaceId, { credits_at_most: Math.min(estimate(db, ctx.workspaceId, readDetectionConfig(db, ctx.workspaceId)).credits_per_run, estimate(db, ctx.workspaceId, readDetectionConfig(db, ctx.workspaceId)).remaining) });
      // The run writes its own row before its first question to Apollo, and never throws:
      // the answer here says it began, and the screen reads how it goes.
      void runDetection(db, ctx.workspaceId, { trigger: "manual", startedBy: ctx.userId });
      return res.status(202).json({ started: true, overview: overview(ctx.workspaceId) });
    }
    return res.status(400).json({ error: "action must be watch, unwatch or run" });
  }

  res.setHeader("Allow", ["GET", "PUT", "POST"]);
  return res.status(405).end();
}
