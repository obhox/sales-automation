import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

// Putting contacts into a campaign run. Starting a run, adding contacts to a running one
// and a signal rule firing all do it, and used to each carry their own copy of the same
// steps. The signal rule's copy had drifted: it never gave anyone an email track.

/** The tracks a campaign has steps on. One with no steps yet counts as LinkedIn-only, as it always has. */
export function workflowTracks(db: DB, workflowId: string): string[] {
  const tracks = (db.prepare("SELECT DISTINCT track FROM workflow_steps WHERE workflow_id = ?").all(workflowId) as Array<{ track: string }>).map((row) => row.track);
  return tracks.length ? tracks : ["linkedin"];
}

/**
 * Which mailbox writes to which contact. Everyone at one company hears from the same
 * mailbox; companies (and contacts with no company) take the mailboxes in turn. With an
 * empty pool nobody gets one.
 */
export function assignEmailAccounts(db: DB, targetIds: string[], pool: string[]): Map<string, string | null> {
  const assignment = new Map<string, string | null>();
  if (pool.length === 0 || targetIds.length === 0) return assignment;
  const rows = db.prepare(`SELECT id, company_id FROM targets WHERE id IN (${targetIds.map(() => "?").join(",")})`).all(...targetIds) as Array<{ id: string; company_id: string | null }>;
  const byCompany = new Map<string, string>();
  let cursor = 0;
  for (const row of rows) {
    if (row.company_id) {
      if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, pool[cursor++ % pool.length]);
      assignment.set(row.id, byCompany.get(row.company_id)!);
    } else {
      assignment.set(row.id, pool[cursor++ % pool.length]);
    }
  }
  return assignment;
}

/**
 * Enrol contacts in a run: one profile each and a pending track for every track the
 * campaign has. A contact with no mailbox assigned gets no email track, since there would
 * be nothing to send it from. Call inside a transaction when the run is created alongside.
 */
export function enrollTargets(db: DB, runId: string, tracks: string[], targetIds: string[], emailAssignment: Map<string, string | null>): void {
  const insertProfile = db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)");
  const insertTrack = db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, ?, 'pending', 0)");
  for (const targetId of targetIds) {
    const mailbox = emailAssignment.get(targetId) ?? null;
    const profileId = randomUUID();
    insertProfile.run(profileId, runId, targetId, mailbox);
    for (const track of tracks) {
      if (track === "email" && !mailbox) continue;
      insertTrack.run(randomUUID(), profileId, track);
    }
  }
}
