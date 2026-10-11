// What Linki does in the pipeline by itself when a contact replies positively: the task to
// answer them, and (when the workspace has switched it on) an opportunity.
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { recordPipelineEvent, settleStage } from "@/lib/platform/pipeline";
import { pipelineSettings } from "@/lib/pipeline/settings";
import { createTask } from "@/lib/pipeline/tasks";

type DB = DatabaseType.Database;

/** Who a contact's follow-up falls to: whoever has their conversation, else whoever owns the contact. Null when nobody does. */
export function followUpOwner(db: DB, targetId: string): string | null {
  const row = db.prepare(`SELECT (SELECT c.assigned_to FROM conversations c WHERE c.target_id = t.id) AS assignee, t.owner_id AS owner, t.workspace_id AS ws
    FROM targets t WHERE t.id = ?`).get(targetId) as { assignee: string | null; owner: string | null; ws: string | null } | undefined;
  const candidate = row?.assignee ?? row?.owner ?? null;
  // Somebody who has left the workspace is not given work.
  return candidate && db.prepare("SELECT 1 FROM workspace_members WHERE user_id = ? AND workspace_id = ?").get(candidate, row!.ws) ? candidate : null;
}

/**
 * A task Linki makes about a contact by itself (a reply to follow up, a step in a
 * campaign). Due tomorrow unless told otherwise, and given to whoever the contact's
 * follow-up falls to.
 */
export function createAutomaticTask(db: DB, input: { workspaceId: string; targetId: string; title: string; description?: string | null; dueDate?: string | null; priority?: "high" | "medium" | "low"; opportunityId?: string | null }): string {
  return createTask(db, {
    workspaceId: input.workspaceId, target_id: input.targetId, title: input.title, description: input.description ?? null,
    due_date: input.dueDate === undefined ? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) : input.dueDate,
    priority: input.priority ?? "medium", assigned_to: followUpOwner(db, input.targetId), opportunity_id: input.opportunityId ?? null, automatic: true,
  });
}

/**
 * Open an opportunity for a contact who has replied positively, if the workspace has
 * switched that on and the contact has no opportunity open already. It goes in the
 * pipeline's first open stage, named for their company, with nobody having typed anything.
 * Returns its id, or null when none was made.
 */
export function openOpportunityForReply(db: DB, workspaceId: string, targetId: string): string | null {
  if (!pipelineSettings(workspaceId, db).auto_opportunity_on_reply) return null;
  const open = db.prepare(`SELECT 1 FROM opportunities o LEFT JOIN pipeline_stages ps ON ps.id = o.stage_id
    WHERE o.workspace_id = ? AND o.target_id = ? AND COALESCE(ps.is_won, 0) = 0 AND COALESCE(ps.is_lost, 0) = 0 LIMIT 1`).get(workspaceId, targetId);
  if (open) return null;
  const contact = db.prepare("SELECT full_name, email, company, company_id FROM targets WHERE id = ? AND workspace_id = ?").get(targetId, workspaceId) as
    | { full_name: string | null; email: string | null; company: string | null; company_id: string | null } | undefined;
  if (!contact) return null;
  const stage = db.prepare("SELECT id FROM pipeline_stages WHERE workspace_id = ? AND is_won = 0 AND is_lost = 0 ORDER BY position, name LIMIT 1").get(workspaceId) as { id: string } | undefined;
  if (!stage) return null;
  const id = randomUUID();
  const name = (contact.company?.trim() || contact.full_name?.trim() || contact.email || "New opportunity").slice(0, 200);
  db.prepare(`INSERT INTO opportunities (id, workspace_id, target_id, company_id, stage_id, owner_id, name, currency, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT currency FROM opportunities WHERE workspace_id = ? GROUP BY currency ORDER BY COUNT(*) DESC LIMIT 1), 'USD'), 'reply')`)
    .run(id, workspaceId, targetId, contact.company_id, stage.id, followUpOwner(db, targetId), name, workspaceId);
  settleStage(db, workspaceId, id);
  recordPipelineEvent(db, { workspaceId, kind: "opportunity_created", subject: name, targetId, companyId: contact.company_id, opportunityId: id, detail: { source: "reply" } });
  return id;
}
