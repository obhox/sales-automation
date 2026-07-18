import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx=requireWorkspace(req,res,req.method==="GET"?"viewer":"member"); if(!ctx)return;
  const db = getDb();
  const workflowId = req.query.id as string;
  if(!requireWorkspaceEntity(res,ctx,"workflows",workflowId))return;

  if (req.method === "GET") {
    const steps = db
      .prepare(
        `SELECT ws.*, t.name as template_name
         FROM workflow_steps ws
         LEFT JOIN templates t ON t.id = ws.template_id
         WHERE ws.workflow_id = ?
         ORDER BY ws.track, ws.step_order`
      )
      .all(workflowId);

    // Attach multi-template ids to each step
    const getTemplateIds = db.prepare(
      `SELECT wst.template_id, t.name
       FROM workflow_step_templates wst
       JOIN templates t ON t.id = wst.template_id
       WHERE wst.step_id = ?`
    );
    const stepsWithTemplates = (steps as Array<Record<string, unknown>>).map((s) => ({
      ...s,
      template_ids: (getTemplateIds.all(s.id) as Array<{ template_id: string; name: string }>).map((r) => r.template_id),
      template_names: (getTemplateIds.all(s.id) as Array<{ template_id: string; name: string }>).map((r) => r.name),
    }));

    return res.json(stepsWithTemplates);
  }

  if (req.method === "POST") {
    const { step_type, track: trackIn, template_id, template_ids, delay_seconds, connect_note, message_body, email_subject, email_body, email_signature, email_position, email_delivery_mode, email_track_opens, email_track_clicks, message_position, ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language } = req.body;
    if (!step_type) return res.status(400).json({ error: "step_type required" });

    // Auto-assign track: email step_type always goes on the email track; everything else linkedin
    const track: "linkedin" | "email" = trackIn === "email" || step_type === "email" ? "email" : "linkedin";

    const maxRow = db
      .prepare("SELECT MAX(step_order) as max_order FROM workflow_steps WHERE workflow_id = ? AND track = ?")
      .get(workflowId, track) as { max_order: number | null };
    const nextOrder = (maxRow.max_order ?? 0) + 1;

    const id = randomUUID();
    const deliveryMode = email_delivery_mode === "enhanced" ? "enhanced" : "plain";
    db.prepare(
      "INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, template_id, delay_seconds, connect_note, message_body, email_subject, email_body, email_signature, email_position, email_delivery_mode, email_track_opens, email_track_clicks, message_position, ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, workflowId, nextOrder, track, step_type, template_id ?? null, delay_seconds ?? 0, connect_note ?? null, message_body ?? null, email_subject ?? null, email_body ?? null, email_signature !== undefined ? email_signature : null, email_position ?? 1, deliveryMode, deliveryMode === "enhanced" && email_track_opens ? 1 : 0, deliveryMode === "enhanced" && email_track_clicks ? 1 : 0, message_position ?? 1, ai_enabled ?? 0, ai_model ?? null, ai_prompt ?? null, ai_max_words ?? null, ai_language ?? null);

    // Insert multi-template associations
    if (Array.isArray(template_ids) && template_ids.length > 0) {
      const insertLink = db.prepare(
        "INSERT OR IGNORE INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)"
      );
      for (const tid of template_ids) {
        insertLink.run(id, tid);
      }
    }

    return res.status(201).json({ id });
  }

  // Bulk reconcile the whole step list in ONE call, reusing existing step ids positionally
  // per track. This replaces the old client "delete every step, re-create with new UUIDs"
  // flow — which cascade-deleted every workflow_branch (branches reference step ids). By
  // updating rows in place, branches attached to steps that still exist survive an edit.
  if (req.method === "PUT") {
    const incoming = Array.isArray((req.body as { steps?: unknown })?.steps) ? (req.body as { steps: Array<Record<string, unknown>> }).steps : null;
    if (!incoming) return res.status(400).json({ error: "steps array is required" });

    const byTrack: Record<"linkedin" | "email", Array<Record<string, unknown>>> = { linkedin: [], email: [] };
    for (const s of incoming) {
      const track: "linkedin" | "email" = s.track === "email" || s.step_type === "email" ? "email" : "linkedin";
      byTrack[track].push({ ...s, track });
    }

    const cols = "step_order, track, step_type, template_id, delay_seconds, connect_note, message_body, email_subject, email_body, email_signature, email_position, email_delivery_mode, email_track_opens, email_track_clicks, message_position, ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language";
    const updateStmt = db.prepare(`UPDATE workflow_steps SET ${cols.split(", ").map(c => `${c} = ?`).join(", ")} WHERE id = ?`);
    const insertStmt = db.prepare(`INSERT INTO workflow_steps (id, workflow_id, ${cols}) VALUES (${Array(2 + cols.split(", ").length).fill("?").join(", ")})`);
    const delStmt = db.prepare("DELETE FROM workflow_steps WHERE id = ?");
    const clearLinks = db.prepare("DELETE FROM workflow_step_templates WHERE step_id = ?");
    const addLink = db.prepare("INSERT OR IGNORE INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)");

    const reconcile = db.transaction(() => {
      for (const track of ["linkedin", "email"] as const) {
        const existing = db.prepare("SELECT id FROM workflow_steps WHERE workflow_id = ? AND track = ? ORDER BY step_order").all(workflowId, track) as Array<{ id: string }>;
        const rows = byTrack[track];
        for (let i = 0; i < rows.length; i++) {
          const s = rows[i];
          const mode = s.email_delivery_mode === "enhanced" ? "enhanced" : "plain";
          const vals = [
            i + 1, track, s.step_type, s.template_id ?? null, s.delay_seconds ?? 0, s.connect_note ?? null,
            s.message_body ?? null, s.email_subject ?? null, s.email_body ?? null, s.email_signature ?? null,
            s.email_position ?? 1, mode, mode === "enhanced" && s.email_track_opens ? 1 : 0, mode === "enhanced" && s.email_track_clicks ? 1 : 0,
            s.message_position ?? 1, s.ai_enabled ? 1 : 0, s.ai_model ?? null, s.ai_prompt ?? null, s.ai_max_words ?? null, s.ai_language ?? "English",
          ];
          let stepId: string;
          if (i < existing.length) { stepId = existing[i].id; updateStmt.run(...vals, stepId); }
          else { stepId = randomUUID(); insertStmt.run(stepId, workflowId, ...vals); }
          clearLinks.run(stepId);
          if (Array.isArray(s.template_ids)) for (const tid of s.template_ids as string[]) addLink.run(stepId, tid);
        }
        // Delete steps beyond the new length (their branches cascade — the step is gone).
        for (let i = rows.length; i < existing.length; i++) delStmt.run(existing[i].id);
      }
    });
    reconcile();
    return res.json({ ok: true });
  }

  res.status(405).end();
}
