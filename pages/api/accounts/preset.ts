import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { accountSettingsProblem, getLinkedinPreset, saveLinkedinPreset, PRESET_ACCOUNT_FIELDS } from "@/lib/linkedin/account-settings";

/**
 * The limits and schedule a new LinkedIn account in this workspace starts with.
 *   GET                            the preset
 *   PUT  { ...fields }             change it (admin)
 *   POST { account_ids: [...] }    copy the preset's limits and schedule onto those accounts (admin)
 *
 * Applying a preset never starts or stops a warm-up on an account that already exists,
 * and never changes its clean-up switch: those are decisions about one account.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "admin");
  if (!ctx) return;

  if (req.method === "GET") return res.json(getLinkedinPreset(ctx.workspaceId, db));

  if (req.method === "PUT") {
    const saved = saveLinkedinPreset(ctx.workspaceId, (req.body ?? {}) as Record<string, unknown>, db);
    if (typeof saved === "string") return res.status(400).json({ error: saved });
    recordAudit(ctx, "linkedin_preset.updated", "workspace", ctx.workspaceId);
    return res.json(saved);
  }

  if (req.method === "POST") {
    const ids = Array.isArray(req.body?.account_ids) ? (req.body.account_ids as unknown[]).filter((id): id is string => typeof id === "string") : [];
    if (ids.length === 0) return res.status(400).json({ error: "account_ids is required" });
    const preset = getLinkedinPreset(ctx.workspaceId, db);
    const problem = accountSettingsProblem(preset as unknown as Record<string, unknown>);
    if (problem) return res.status(400).json({ error: problem });
    const update = db.prepare(
      `UPDATE accounts SET ${PRESET_ACCOUNT_FIELDS.map((field) => `${field} = ?`).join(", ")} WHERE id = ? AND workspace_id = ?`,
    );
    let applied = 0;
    db.transaction(() => {
      for (const id of ids) applied += update.run(...PRESET_ACCOUNT_FIELDS.map((field) => preset[field]), id, ctx.workspaceId).changes;
    })();
    recordAudit(ctx, "linkedin_preset.applied", "workspace", ctx.workspaceId, { accounts: applied });
    return res.json({ applied });
  }

  res.setHeader("Allow", ["GET", "PUT", "POST"]);
  res.status(405).end();
}
