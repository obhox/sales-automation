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

// ── Several LinkedIn accounts on one campaign ─────────────────────────────────

/**
 * How a campaign with several LinkedIn accounts shares its contacts out.
 * round_robin: in turn. capacity: in proportion to each account's daily invitation limit.
 * Either way a company stays with one account, and so does a contact an account in the
 * pool has already written to.
 */
export type LinkedinRotation = "round_robin" | "capacity";
export const LINKEDIN_ROTATIONS: readonly LinkedinRotation[] = ["round_robin", "capacity"];
export const MAX_POOL_ACCOUNTS = 25;

export function isLinkedinRotation(value: unknown): value is LinkedinRotation {
  return typeof value === "string" && (LINKEDIN_ROTATIONS as readonly string[]).includes(value);
}

/** The LinkedIn accounts a run draws on, in the order they were chosen. Empty for a run with one account. */
export function runAccountPool(db: DB, runId: string): string[] {
  return (db.prepare("SELECT account_id FROM run_accounts WHERE run_id = ? ORDER BY position, rowid").all(runId) as Array<{ account_id: string }>).map((row) => row.account_id);
}

export function runRotation(db: DB, runId: string): LinkedinRotation {
  const row = db.prepare("SELECT linkedin_rotation FROM runs WHERE id = ?").get(runId) as { linkedin_rotation: string | null } | undefined;
  return isLinkedinRotation(row?.linkedin_rotation) ? row.linkedin_rotation : "round_robin";
}

/** Replace a run's pool. One account or none is not a pool: the run then has just runs.account_id. */
export function saveRunAccountPool(db: DB, runId: string, pool: string[], rotation: LinkedinRotation): void {
  db.prepare("DELETE FROM run_accounts WHERE run_id = ?").run(runId);
  if (pool.length < 2) {
    db.prepare("UPDATE runs SET linkedin_rotation = NULL WHERE id = ?").run(runId);
    return;
  }
  const insert = db.prepare("INSERT INTO run_accounts (run_id, account_id, position) VALUES (?, ?, ?)");
  pool.forEach((accountId, position) => insert.run(runId, accountId, position));
  db.prepare("UPDATE runs SET linkedin_rotation = ? WHERE id = ?").run(rotation, runId);
}

/**
 * Which LinkedIn account works which contact, for a run with several.
 *
 * A contact goes, in this order, to: the account that has already written to them, if it
 * is in the pool (their connection state is only true for that account); the account
 * their company already has in this run; otherwise the least loaded account, counting
 * what the run has given each one so far. "Least loaded" is by head count for round robin
 * and by head count against the daily invitation limit for capacity. Ties go to the
 * earlier account in the pool, so three accounts starting empty take contacts A, B, C, A…
 *
 * With one account or none there is nothing to decide and the map comes back empty: every
 * contact is worked by the run's own account, as before a campaign could have several.
 */
export function assignLinkedinAccounts(db: DB, targetIds: string[], pool: string[], rotation: LinkedinRotation = "round_robin", runId?: string): Map<string, string> {
  const assignment = new Map<string, string>();
  if (pool.length < 2 || targetIds.length === 0) return assignment;
  const inPool = new Set(pool);

  const weights = new Map<string, number>(pool.map((id) => [id, 1]));
  if (rotation === "capacity") {
    const limits = db.prepare(`SELECT id, daily_connection_limit FROM accounts WHERE id IN (${pool.map(() => "?").join(",")})`).all(...pool) as Array<{ id: string; daily_connection_limit: number | null }>;
    for (const row of limits) weights.set(row.id, Math.max(1, row.daily_connection_limit ?? 20));
  }

  // What the run has already handed out, and which account each company has.
  const load = new Map<string, number>(pool.map((id) => [id, 0]));
  const byCompany = new Map<string, string>();
  if (runId) {
    const existing = db.prepare(
      `SELECT rp.account_id, t.company_id FROM run_profiles rp JOIN targets t ON t.id = rp.target_id WHERE rp.run_id = ? AND rp.account_id IS NOT NULL ORDER BY rp.created_at, rp.rowid`,
    ).all(runId) as Array<{ account_id: string; company_id: string | null }>;
    for (const row of existing) {
      if (!inPool.has(row.account_id)) continue;
      load.set(row.account_id, (load.get(row.account_id) ?? 0) + 1);
      if (row.company_id && !byCompany.has(row.company_id)) byCompany.set(row.company_id, row.account_id);
    }
  }
  const leastLoaded = () => pool.reduce((best, id) => ((load.get(id) ?? 0) / weights.get(id)! < (load.get(best) ?? 0) / weights.get(best)! ? id : best), pool[0]);

  const rows = new Map(
    (db.prepare(`SELECT id, company_id, linkedin_account_id FROM targets WHERE id IN (${targetIds.map(() => "?").join(",")})`).all(...targetIds) as Array<{ id: string; company_id: string | null; linkedin_account_id: string | null }>)
      .map((row) => [row.id, row]),
  );
  for (const targetId of targetIds) {
    const row = rows.get(targetId);
    if (!row) continue;
    const account = (row.linkedin_account_id && inPool.has(row.linkedin_account_id) ? row.linkedin_account_id : null)
      ?? (row.company_id ? byCompany.get(row.company_id) : undefined)
      ?? leastLoaded();
    assignment.set(targetId, account);
    load.set(account, (load.get(account) ?? 0) + 1);
    if (row.company_id && !byCompany.has(row.company_id)) byCompany.set(row.company_id, account);
  }
  return assignment;
}

/**
 * Enrol contacts in a run: one profile each and a pending track for every track the
 * campaign has. A contact with no mailbox assigned gets no email track, since there would
 * be nothing to send it from. `linkedinAssignment` names each contact's LinkedIn account in
 * a run with several; a contact not in it is worked by the run's own account. Call inside
 * a transaction when the run is created alongside.
 */
export function enrollTargets(db: DB, runId: string, tracks: string[], targetIds: string[], emailAssignment: Map<string, string | null>, linkedinAssignment: Map<string, string> = new Map()): void {
  const insertProfile = db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id, account_id) VALUES (?, ?, ?, ?, ?)");
  const insertTrack = db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, ?, 'pending', 0)");
  for (const targetId of targetIds) {
    const mailbox = emailAssignment.get(targetId) ?? null;
    const profileId = randomUUID();
    insertProfile.run(profileId, runId, targetId, mailbox, linkedinAssignment.get(targetId) ?? null);
    for (const track of tracks) {
      if (track === "email" && !mailbox) continue;
      insertTrack.run(randomUUID(), profileId, track);
    }
  }
}

// ── Checking and changing a run's pool ────────────────────────────────────────

/**
 * A requested pool, checked: every id a LinkedIn account of this workspace, each once, in
 * the order given. Returns the reason it was refused instead when it cannot be used.
 */
export function checkAccountPool(db: DB, workspaceId: string, ids: unknown): string[] | { error: string } {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) return { error: "account_ids must be a list of LinkedIn account ids" };
  const pool = [...new Set(ids as string[])];
  if (pool.length > MAX_POOL_ACCOUNTS) return { error: `A campaign can use at most ${MAX_POOL_ACCOUNTS} LinkedIn accounts` };
  if (pool.length === 0) return pool;
  const owned = (db.prepare(`SELECT COUNT(*) AS c FROM accounts WHERE workspace_id = ? AND id IN (${pool.map(() => "?").join(",")})`).get(workspaceId, ...pool) as { c: number }).c;
  return owned === pool.length ? pool : { error: "One or more LinkedIn accounts are not in this workspace" };
}

export interface PoolChange {
  pool: string[];
  rotation: LinkedinRotation | null;
  /** Contacts not yet started on LinkedIn, shared out again over the new pool. */
  reassigned: number;
  /** Contacts already started on an account that is no longer in the pool. They finish on it. */
  finishing_elsewhere: number;
}

/**
 * Change which LinkedIn accounts a run uses. A contact whose LinkedIn steps have started
 * stays with the account that started them, even when that account leaves the pool: a
 * conversation cannot move to another member. Contacts not yet started are shared out
 * again over the new pool. Call inside a transaction.
 */
export function changeRunAccountPool(db: DB, runId: string, pool: string[], rotation: LinkedinRotation): PoolChange {
  const run = db.prepare("SELECT account_id FROM runs WHERE id = ?").get(runId) as { account_id: string | null };
  const started = `EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = run_profiles.id AND rt.track = 'linkedin' AND rt.state != 'pending')`;
  const waiting = `EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = run_profiles.id AND rt.track = 'linkedin' AND rt.state = 'pending')`;

  // Pin every started contact to the account it is on today, before "the run's account"
  // can come to mean a different one.
  if (run.account_id) db.prepare(`UPDATE run_profiles SET account_id = ? WHERE run_id = ? AND account_id IS NULL AND ${started}`).run(run.account_id, runId);

  const primary = run.account_id && pool.includes(run.account_id) ? run.account_id : pool[0];
  db.prepare("UPDATE runs SET account_id = ? WHERE id = ?").run(primary, runId);
  saveRunAccountPool(db, runId, pool, rotation);

  // Share out again everyone who has not started.
  db.prepare(`UPDATE run_profiles SET account_id = NULL WHERE run_id = ? AND ${waiting}`).run(runId);
  const waitingIds = (db.prepare(`SELECT target_id FROM run_profiles WHERE run_id = ? AND ${waiting} ORDER BY created_at, rowid`).all(runId) as Array<{ target_id: string }>).map((row) => row.target_id);
  const assignment = assignLinkedinAccounts(db, waitingIds, pool, rotation, runId);
  const assign = db.prepare("UPDATE run_profiles SET account_id = ? WHERE run_id = ? AND target_id = ?");
  for (const [targetId, accountId] of assignment) assign.run(accountId, runId, targetId);

  const elsewhere = (db.prepare(
    `SELECT COUNT(*) AS c FROM run_profiles WHERE run_id = ? AND account_id IS NOT NULL AND account_id NOT IN (${pool.map(() => "?").join(",")})
       AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = run_profiles.id AND rt.track = 'linkedin' AND rt.state = 'in_progress')`,
  ).get(runId, ...pool) as { c: number }).c;
  return { pool, rotation: pool.length >= 2 ? rotation : null, reassigned: waitingIds.length, finishing_elsewhere: elsewhere };
}

export interface RunAccount {
  id: string;
  name: string;
  signed_in: boolean;
  paused: boolean;
  in_pool: boolean;
  /** Contacts of this run worked by the account. */
  contacts: number;
}

/** The LinkedIn accounts a run uses: its pool, plus any account still finishing contacts it started. */
export function runAccounts(db: DB, runId: string): RunAccount[] {
  const pool = runAccountPool(db, runId);
  const run = db.prepare("SELECT account_id FROM runs WHERE id = ?").get(runId) as { account_id: string | null } | undefined;
  if (!run) return [];
  const counts = db.prepare(
    `SELECT COALESCE(rp.account_id, r.account_id) AS account_id, COUNT(*) AS c FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
     WHERE rp.run_id = ? AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.track = 'linkedin') GROUP BY 1`,
  ).all(runId) as Array<{ account_id: string | null; c: number }>;
  const contacts = new Map(counts.filter((row) => row.account_id).map((row) => [row.account_id as string, row.c]));
  const inPool = new Set(pool.length > 0 ? pool : run.account_id ? [run.account_id] : []);
  const ids = [...new Set([...(pool.length > 0 ? pool : run.account_id ? [run.account_id] : []), ...contacts.keys()])];
  if (ids.length === 0) return [];
  const rows = new Map(
    (db.prepare(`SELECT id, name, is_authenticated, paused_at FROM accounts WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; name: string; is_authenticated: number | null; paused_at: string | null }>)
      .map((row) => [row.id, row]),
  );
  return ids.filter((id) => rows.has(id)).map((id) => {
    const row = rows.get(id)!;
    return { id, name: row.name, signed_in: Boolean(row.is_authenticated), paused: Boolean(row.paused_at), in_pool: inPool.has(id), contacts: contacts.get(id) ?? 0 };
  });
}
