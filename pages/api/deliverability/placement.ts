import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { isPlacementResult, listPlacementRuns, lookForPlacementRun, readPlacementRun, setPlacement, startPlacementRun } from "@/lib/email/placement";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * Inbox placement tests.
 *   GET ?domain=                              the latest runs (for a domain, or all)
 *   GET ?run_id=                              one run
 *   POST { email_account_id, seed_ids? }      send a test from that mailbox to the seeds (admin)
 *   PUT { run_id }                            look in the readable seeds' mailboxes now (admin)
 *   PATCH { test_id, placement }              enter by hand where one seed's copy landed (admin)
 *
 * A placement is inbox, primary, promotions, social, updates, forums, spam, other or missing.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin"); if (!ctx) return;
  const db = getDb();

  if (req.method === "GET") {
    if (typeof req.query.run_id === "string") {
      const run = readPlacementRun(db, ctx.workspaceId, req.query.run_id);
      return run ? res.json({ run }) : res.status(404).json({ error: "not found" });
    }
    const domain = typeof req.query.domain === "string" && req.query.domain ? req.query.domain.toLowerCase() : null;
    return res.json({ runs: listPlacementRuns(db, ctx.workspaceId, domain, Math.min(Number(req.query.limit) || 10, 50)) });
  }

  if (req.method === "POST") {
    const { email_account_id: emailAccountId, seed_ids: seedIds } = (req.body ?? {}) as { email_account_id?: unknown; seed_ids?: unknown };
    if (typeof emailAccountId !== "string" || !emailAccountId) return res.status(400).json({ error: "email_account_id is required" });
    if (seedIds !== undefined && !(Array.isArray(seedIds) && seedIds.every((id) => typeof id === "string"))) return res.status(400).json({ error: "seed_ids must be a list of seed ids" });
    const run = await startPlacementRun({ workspaceId: ctx.workspaceId, emailAccountId, seedIds: seedIds as string[] | undefined, userId: ctx.userId }, db);
    if (typeof run === "string") return res.status(400).json({ error: run });
    recordAudit(ctx, "placement_test.sent", "placement_run", run.id, { from: run.mailbox?.from_email, seeds: run.tests.length });
    return res.status(201).json({ run });
  }

  if (req.method === "PUT") {
    const runId = typeof req.body?.run_id === "string" ? req.body.run_id : "";
    const run = await lookForPlacementRun(db, ctx.workspaceId, runId);
    return run ? res.json({ run }) : res.status(404).json({ error: "not found" });
  }

  if (req.method === "PATCH") {
    const { test_id: testId, placement } = (req.body ?? {}) as { test_id?: unknown; placement?: unknown };
    if (typeof testId !== "string" || !isPlacementResult(placement)) return res.status(400).json({ error: "test_id and a placement are required" });
    const test = setPlacement(db, ctx.workspaceId, testId, placement);
    return test ? res.json({ test }) : res.status(404).json({ error: "not found" });
  }

  res.setHeader("Allow", ["GET", "POST", "PUT", "PATCH"]);
  return res.status(405).end();
}
