// Ending an A/B test without being asked: for a campaign that has it switched on, once one
// version of an email is ahead on replies by more than chance would explain, the others
// are paused. It is off unless someone turns it on, and it never acts on opens alone.
import type DatabaseType from "better-sqlite3";
import { campaignAnalytics } from "@/lib/reporting/campaign-analytics";
import { parseRange, type ReportRange } from "@/lib/reporting/range";
import { notify } from "@/lib/platform/notifications";

type DB = DatabaseType.Database;

export interface Promotion { workflow_id: string; step_id: string; variant_id: string | null; label: string; confidence: number }

/** Pause every version of a step except the winner. Null names the step's own wording, version A. */
export function promoteVersion(db: DB, stepId: string, winner: string | null): void {
  db.transaction(() => {
    // A version paused earlier keeps the time it was first paused.
    db.prepare("UPDATE workflow_step_email_variants SET disabled_at = CASE WHEN id IS ? THEN NULL ELSE COALESCE(disabled_at, datetime('now')) END WHERE step_id = ?").run(winner, stepId);
    db.prepare("UPDATE workflow_steps SET email_control_disabled = ? WHERE id = ?").run(winner === null ? 0 : 1, stepId);
  })();
}

/**
 * Promote the winners that are clear, in the campaigns that asked for it and are running.
 * Returns what it promoted.
 */
export function autoPromote(db: DB): Promotion[] {
  const campaigns = db.prepare(
    `SELECT w.id, w.workspace_id, w.name FROM workflows w
     WHERE w.ab_auto_promote = 1 AND COALESCE(w.is_archived, 0) = 0 AND EXISTS (SELECT 1 FROM runs r WHERE r.workflow_id = w.id AND r.status = 'running')`,
  ).all() as Array<{ id: string; workspace_id: string; name: string }>;
  const allTime = parseRange({}) as ReportRange;
  const promoted: Promotion[] = [];
  for (const campaign of campaigns) {
    for (const test of campaignAnalytics(db, campaign.id, allTime).emailVariants) {
      const winner = test.likely_winner;
      // Opens are a weaker sign than replies: enough to show a person, not enough to act on alone.
      if (!winner || winner.metric !== "replies") continue;
      const running = test.variants.filter((version) => !version.paused && !version.removed);
      if (running.length < 2) continue;
      const label = test.variants.find((version) => version.variant_id === winner.variant_id)?.label ?? "A";
      promoteVersion(db, test.step_id, winner.variant_id);
      db.prepare("INSERT INTO audit_logs (id, workspace_id, user_id, action, entity_type, entity_id, metadata_json) VALUES (lower(hex(randomblob(16))), ?, NULL, 'workflow.ab_winner_chosen', 'workflow_step', ?, ?)")
        .run(campaign.workspace_id, test.step_id, JSON.stringify({ workflow_id: campaign.id, variant_id: winner.variant_id, automatic: true, confidence: Number(winner.confidence.toFixed(4)) }));
      notify({
        workspaceId: campaign.workspace_id, kind: "campaign.ab_promoted", tone: "good", link: `/campaigns/${campaign.id}`,
        title: `Version ${label} was promoted in ${campaign.name}`,
        body: `It was ahead on replies with ${Math.round(winner.confidence * 100)}% confidence, so the other versions of that email are paused. Reopen the test from the campaign's overview to undo it.`,
        dedupeKey: `ab-promoted:${test.step_id}:${winner.variant_id ?? "control"}`,
      });
      promoted.push({ workflow_id: campaign.id, step_id: test.step_id, variant_id: winner.variant_id, label, confidence: winner.confidence });
    }
  }
  return promoted;
}

let lastChecked = 0;
/** autoPromote, at most once every ten minutes: a test does not turn on one more send, and working it out reads a lot. */
export function autoPromoteWhenDue(db: DB, now = Date.now()): Promotion[] {
  if (now - lastChecked < 10 * 60_000) return [];
  lastChecked = now;
  try {
    return autoPromote(db);
  } catch (error) {
    console.error("[auto-promote] failed", error);
    return [];
  }
}
