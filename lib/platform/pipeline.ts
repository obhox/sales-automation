import type DatabaseType from "better-sqlite3";
import { emitDomainEvent } from "@/lib/platform/events";

type DB = DatabaseType.Database;

/**
 * Call after any write that may have moved an opportunity. Keeps its closed date in step
 * with its stage (stamped on reaching a won or lost stage, cleared on going back to an open
 * one) and tells subscribers when the stage changed.
 *
 * `previousStageId` is the stage before the write; leave it out for a new opportunity,
 * which has no earlier stage to have moved from.
 */
export function settleStage(db: DB, workspaceId: string, opportunityId: string, previousStageId?: string | null): void {
  const row = db.prepare(`SELECT o.name, o.stage_id, o.amount, o.currency, o.target_id, o.company_id, o.owner_id, o.closed_at,
      ps.name stage_name, COALESCE(ps.is_won, 0) is_won, COALESCE(ps.is_lost, 0) is_lost
    FROM opportunities o LEFT JOIN pipeline_stages ps ON ps.id = o.stage_id
    WHERE o.id = ? AND o.workspace_id = ?`).get(opportunityId, workspaceId) as {
      name: string; stage_id: string | null; amount: number | null; currency: string; target_id: string | null; company_id: string | null;
      owner_id: string | null; closed_at: string | null; stage_name: string | null; is_won: number; is_lost: number;
    } | undefined;
  if (!row) return;

  const moved = previousStageId !== undefined && (previousStageId ?? null) !== row.stage_id;
  const closed = Boolean(row.is_won || row.is_lost);
  if (!closed && row.closed_at) db.prepare("UPDATE opportunities SET closed_at = NULL WHERE id = ?").run(opportunityId);
  else if (closed && (!row.closed_at || moved)) db.prepare("UPDATE opportunities SET closed_at = datetime('now') WHERE id = ?").run(opportunityId);
  if (!moved) return;

  const from = previousStageId
    ? db.prepare("SELECT name FROM pipeline_stages WHERE id = ? AND workspace_id = ?").get(previousStageId, workspaceId) as { name: string } | undefined
    : undefined;
  emitDomainEvent({
    workspaceId, type: "opportunity.stage_changed", entityType: "opportunity", entityId: opportunityId,
    payload: {
      opportunity_id: opportunityId, name: row.name,
      from_stage_id: previousStageId ?? null, from_stage: from?.name ?? null,
      to_stage_id: row.stage_id, to_stage: row.stage_name,
      is_won: Boolean(row.is_won), is_lost: Boolean(row.is_lost),
      amount: row.amount, currency: row.currency,
      target_id: row.target_id, company_id: row.company_id, owner_id: row.owner_id,
    },
  });
}

/** After a stage's won/lost marking changes: the opportunities sitting in it are now closed, or open again. */
export function settleStageOpportunities(db: DB, workspaceId: string, stageId: string): void {
  const stage = db.prepare("SELECT is_won, is_lost FROM pipeline_stages WHERE id = ? AND workspace_id = ?").get(stageId, workspaceId) as { is_won: number; is_lost: number } | undefined;
  if (!stage) return;
  if (stage.is_won || stage.is_lost) db.prepare("UPDATE opportunities SET closed_at = datetime('now') WHERE stage_id = ? AND workspace_id = ? AND closed_at IS NULL").run(stageId, workspaceId);
  else db.prepare("UPDATE opportunities SET closed_at = NULL WHERE stage_id = ? AND workspace_id = ? AND closed_at IS NOT NULL").run(stageId, workspaceId);
}
