import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";
import { saveSequenceSettings, sequenceOverview, settingsProblem, type SequenceSettings } from "@/lib/outreach/publish";

/**
 * A campaign's published sequence, with what is happening on it.
 *
 *   GET    steps (each with its versions and template pool), gates, settings, the published
 *          version, how many contacts are standing on each step, each gate's two counts,
 *          and whether a draft is waiting
 *   PATCH  { email_start?, linkedin_track_enabled?, email_track_enabled? }   (manager)
 *          switch a track on or off, or change when email starts, without republishing
 *
 * Switching a track off holds its contacts where they are; nothing is dropped. Changing
 * when email starts applies to contacts enrolled from then on.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "PATCH") {
    res.setHeader("Allow", ["GET", "PATCH"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "manager"); if (!ctx) return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if (!requireWorkspaceEntity(res, ctx, "workflows", workflowId)) return;

  if (req.method === "PATCH") {
    const problem = settingsProblem(req.body);
    if (problem) return res.status(400).json({ error: problem });
    const { email_start, linkedin_track_enabled, email_track_enabled } = (req.body ?? {}) as Partial<SequenceSettings>;
    saveSequenceSettings(db, workflowId, { email_start, linkedin_track_enabled, email_track_enabled });
    recordAudit(ctx, "workflow.sequence_settings_changed", "workflow", workflowId, { email_start, linkedin_track_enabled, email_track_enabled });
  }
  return res.json(sequenceOverview(db, workflowId));
}
