import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, requireWorkspaceEntity, recordAudit } from "@/lib/workspace";
import { copySequence } from "@/lib/outreach/publish";

/**
 * Copy a campaign: its name, description, writing prompt and send-time setting, and its
 * whole sequence (steps, template pools, A/B versions, gates, track settings). The copy
 * has no contacts, no runs and no statistics.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const ctx=requireWorkspace(req,res,"member"); if(!ctx)return;

  const db = getDb();
  const sourceId = req.query.id as string;
  if(!requireWorkspaceEntity(res,ctx,"workflows",sourceId))return;

  const source = db.prepare("SELECT name, description, prompt, send_in_recipient_tz FROM workflows WHERE id = ? AND workspace_id = ?").get(sourceId, ctx.workspaceId) as
    | { name: string; description: string | null; prompt: string | null; send_in_recipient_tz: number }
    | undefined;
  if (!source) return res.status(404).json({ error: "Workflow not found" });

  const newId = randomUUID();
  const copied = db.transaction(() => {
    // The copy belongs to whoever made it.
    db.prepare("INSERT INTO workflows (id, workspace_id, name, description, prompt, send_in_recipient_tz, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(newId, ctx.workspaceId, `${source.name} (copy)`, source.description ?? null, source.prompt ?? null, source.send_in_recipient_tz ?? 0, ctx.userId);
    return copySequence(db, ctx.workspaceId, sourceId, newId);
  })();

  recordAudit(ctx, "workflow.duplicated", "workflow", newId, { from: sourceId, steps: copied.steps.length, gates: copied.gates });
  return res.status(201).json({ id: newId, steps: copied.steps.length, gates: copied.gates });
}
