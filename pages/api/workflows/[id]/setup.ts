import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { aiContextOf, aiContextProblem, saveAiContext } from "@/lib/campaigns/context";
import { saveSetup, setupOf, setupOptions, setupProblem } from "@/lib/campaigns/setup";
import { campaignSummaries } from "@/lib/campaigns/summary";
import { premium } from "@/lib/premium";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * What a campaign is set up with, before and after it is launched.
 *
 *   GET  the campaign, its setup (list, exclusions, LinkedIn accounts and rotation,
 *        mailboxes, what to do with contacts in another campaign), its AI brief, and the
 *        lists, LinkedIn accounts and mailboxes there are to choose from
 *   PUT  { name?, description?, prompt?, send_in_recipient_tz?, setup?, ai? }
 *        change any of it; what is left out stays as it was
 *
 * Nothing here enrols anyone or sends anything: POST /api/workflows/{id}/launch does that.
 * Changing the setup of a campaign that is already running changes what its next launch
 * would use, not the run in flight.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", ["GET", "PUT"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member"); if (!ctx) return;
  const db = getDb();
  const id = req.query.id as string;
  const exists = () => db.prepare("SELECT id, name, description, prompt, send_in_recipient_tz FROM workflows WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as
    | { id: string; name: string; description: string | null; prompt: string | null; send_in_recipient_tz: number | null } | undefined;
  if (!exists()) return res.status(404).json({ error: "Resource not found" });

  if (req.method === "PUT") {
    const { name, description, prompt, send_in_recipient_tz, setup, ai } = (req.body ?? {}) as Record<string, unknown>;
    if (name !== undefined && (typeof name !== "string" || !name.trim())) return res.status(400).json({ error: "A campaign needs a name" });
    for (const [key, value] of [["description", description], ["prompt", prompt]] as const) {
      if (value != null && typeof value !== "string") return res.status(400).json({ error: `${key} must be text` });
    }
    const problem = setupProblem(db, ctx.workspaceId, setup) ?? aiContextProblem(ai);
    if (problem) return res.status(400).json({ error: problem });
    db.transaction(() => {
      if (name !== undefined) db.prepare("UPDATE workflows SET name = ? WHERE id = ?").run((name as string).trim().slice(0, 160), id);
      if (description !== undefined) db.prepare("UPDATE workflows SET description = ? WHERE id = ?").run(typeof description === "string" && description.trim() ? description.trim().slice(0, 500) : null, id);
      if (prompt !== undefined) db.prepare("UPDATE workflows SET prompt = ? WHERE id = ?").run(typeof prompt === "string" && prompt.trim() ? prompt.trim().slice(0, 8000) : null, id);
      if (send_in_recipient_tz !== undefined) db.prepare("UPDATE workflows SET send_in_recipient_tz = ? WHERE id = ?").run(send_in_recipient_tz ? 1 : 0, id);
      if (setup) saveSetup(db, id, setup as Parameters<typeof saveSetup>[2]);
      if (ai) saveAiContext(db, id, ai as Parameters<typeof saveAiContext>[2]);
    })();
    // The wizard saves as it goes; one audit entry for a rename is enough, the rest is its working state.
    if (name !== undefined) recordAudit(ctx, "workflow.updated", "workflow", id, { name });
  }

  const campaign = exists()!;
  const summary = campaignSummaries(db, ctx.workspaceId).find((candidate) => candidate.id === id);
  const defaultModel = (db.prepare("SELECT default_model FROM workspace_ai_config WHERE workspace_id = ?").get(ctx.workspaceId) as { default_model: string | null } | undefined)?.default_model ?? null;
  return res.json({
    campaign: { id: campaign.id, name: campaign.name, description: campaign.description, prompt: campaign.prompt, send_in_recipient_tz: Boolean(campaign.send_in_recipient_tz), status: summary?.status ?? "draft", enrolled: summary?.enrolled ?? 0, run: summary?.run ?? null },
    setup: setupOf(db, id),
    ai: aiContextOf(db, id),
    ai_available: Boolean(premium.ai),
    default_model: defaultModel,
    options: setupOptions(db, ctx.workspaceId),
  });
}
