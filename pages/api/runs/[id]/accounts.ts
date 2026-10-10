import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { changeRunAccountPool, checkAccountPool, isLinkedinRotation, runAccounts, runRotation, workflowTracks } from "@/lib/outreach/enroll";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";

/**
 * The LinkedIn accounts a campaign run uses.
 *   GET                                              the accounts, with how many contacts each works
 *   PUT { account_ids: [...], linkedin_rotation? }   change them (manager)
 *
 * Changing them never moves a contact whose LinkedIn steps have started: that contact
 * finishes on the account that started with them, even if it is no longer in the list.
 * Contacts who have not started are shared out again over the new list.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", ["GET", "PUT"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager"); if (!ctx) return;
  const db = getDb();
  const runId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "runs", runId)) return;
  const run = db.prepare("SELECT workflow_id, status, linkedin_rotation FROM runs WHERE id = ? AND workspace_id = ?").get(runId, ctx.workspaceId) as
    | { workflow_id: string; status: string; linkedin_rotation: string | null }
    | undefined;
  if (!run) return res.status(404).json({ error: "run_not_found" });

  if (req.method === "GET") return res.json({ accounts: runAccounts(db, runId), rotation: run.linkedin_rotation });

  if (!workflowTracks(db, run.workflow_id).includes("linkedin")) return res.status(400).json({ error: "This campaign has no LinkedIn steps, so it uses no LinkedIn account" });
  if (run.status === "completed" || run.status === "failed") return res.status(400).json({ error: "This campaign run has finished" });
  const pool = checkAccountPool(db, ctx.workspaceId, req.body?.account_ids);
  if (!Array.isArray(pool)) return res.status(400).json({ error: pool.error });
  if (pool.length === 0) return res.status(400).json({ error: "A campaign with LinkedIn steps needs at least one LinkedIn account" });
  if (req.body?.linkedin_rotation != null && !isLinkedinRotation(req.body.linkedin_rotation)) return res.status(400).json({ error: "linkedin_rotation must be round_robin or capacity" });
  const rotation = isLinkedinRotation(req.body?.linkedin_rotation) ? req.body.linkedin_rotation : runRotation(db, runId);

  const change = db.transaction(() => changeRunAccountPool(db, runId, pool, rotation))();
  recordAudit(ctx, "run.linkedin_accounts_changed", "run", runId, { accounts: pool.length, rotation: change.rotation, reassigned: change.reassigned });
  return res.json({ ...change, accounts: runAccounts(db, runId) });
}
