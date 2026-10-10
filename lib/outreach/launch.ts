// Starting a campaign on a list: who in the list can be enrolled, who is left out and why,
// and the run itself. One place decides this, for the API that creates a run and for the
// wizard that shows the numbers before anyone commits to them.
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { assignEmailAccounts, assignLinkedinAccounts, enrollTargets, saveRunAccountPool, workflowTracks, type LinkedinRotation } from "@/lib/outreach/enroll";

type DB = DatabaseType.Database;

export interface Exclusions {
  /** Contacts who have, or whose company has, a deal that was won. */
  customers: boolean;
  /** Contacts who have, or whose company has, a deal still open. */
  open_deals: boolean;
}

/**
 * What to do with a contact who is part-way through another campaign:
 *  - skip       leave them where they are and do not enrol them here (the rule there has always been)
 *  - take_over  enrol them here and hold their steps in the other campaign until they are done here
 */
export type OverlapChoice = "skip" | "take_over";
export const isOverlapChoice = (value: unknown): value is OverlapChoice => value === "skip" || value === "take_over";

export interface AudienceOptions {
  exclude?: Partial<Exclusions>;
  overlap?: OverlapChoice;
  /** Enrol only these contacts of the list. */
  targetIds?: string[];
}

export interface Audience {
  /** Contacts considered: the list's, or the ones asked for. */
  total: number;
  /** Already in this campaign from an earlier run. Never enrolled twice. */
  already_enrolled: number;
  /** How many are customers, and how many have an open deal, whether or not they are being left out. */
  customers: number;
  open_deals: number;
  /** Left out by the exclusions that are switched on. */
  excluded: number;
  /** Part-way through another running or paused campaign, among those not left out above. */
  overlapping: number;
  overlaps: Array<{ workflow_id: string; name: string; contacts: number }>;
  /** Who will be enrolled, given the choice about overlaps. */
  enrol: number;
  /** Of those: how many have an email address, and how many have one that is verified. */
  with_email: number;
  verified_email: number;
}

const chunked = <T,>(items: T[], size = 400): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/**
 * Work out a campaign's audience on a list. Returns the figures, the contacts to enrol, and
 * (for take_over) those among them whose other campaign is to be held.
 */
export function audienceFor(db: DB, workspaceId: string, workflowId: string, listId: string, options: AudienceOptions = {}): { audience: Audience; enrol: string[]; takeOver: string[] } {
  const candidates: string[] = Array.isArray(options.targetIds) && options.targetIds.length > 0
    ? [...new Set(options.targetIds)]
    : (db.prepare("SELECT lt.target_id FROM list_targets lt JOIN targets t ON t.id = lt.target_id WHERE lt.list_id = ? AND t.workspace_id = ?").all(listId, workspaceId) as { target_id: string }[]).map((row) => row.target_id);
  const candidateSet = new Set(candidates);

  // Already enrolled in any run of this campaign.
  const alreadyEnrolled = new Set((db.prepare(
    "SELECT DISTINCT rp.target_id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE r.workflow_id = ? AND r.workspace_id = ?",
  ).all(workflowId, workspaceId) as { target_id: string }[]).map((row) => row.target_id));

  // Part-way through any running or paused campaign in the workspace, and which one.
  const active = db.prepare(
    `SELECT DISTINCT rp.target_id, r.workflow_id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
     WHERE r.status IN ('running', 'paused') AND r.workspace_id = ?
       AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped'))`,
  ).all(workspaceId) as { target_id: string; workflow_id: string }[];
  const activeElsewhere = new Map<string, string>();
  for (const row of active) if (candidateSet.has(row.target_id) && !activeElsewhere.has(row.target_id)) activeElsewhere.set(row.target_id, row.workflow_id);

  // Customers and open deals: by the contact's own deals, or their company's.
  const customers = new Set<string>();
  const openDeals = new Set<string>();
  for (const ids of chunked(candidates)) {
    const rows = db.prepare(
      `SELECT t.id,
         MAX(CASE WHEN ps.is_won = 1 THEN 1 ELSE 0 END) AS won,
         MAX(CASE WHEN COALESCE(ps.is_won, 0) = 0 AND COALESCE(ps.is_lost, 0) = 0 AND o.closed_at IS NULL THEN 1 ELSE 0 END) AS open
       FROM targets t
       JOIN opportunities o ON o.workspace_id = t.workspace_id AND (o.target_id = t.id OR (o.company_id IS NOT NULL AND o.company_id = t.company_id))
       LEFT JOIN pipeline_stages ps ON ps.id = o.stage_id
       WHERE t.workspace_id = ? AND t.id IN (${ids.map(() => "?").join(",")})
       GROUP BY t.id`,
    ).all(workspaceId, ...ids) as Array<{ id: string; won: number; open: number }>;
    for (const row of rows) {
      if (row.won) customers.add(row.id);
      if (row.open) openDeals.add(row.id);
    }
  }
  const leftOut = (id: string) => (options.exclude?.customers === true && customers.has(id)) || (options.exclude?.open_deals === true && openDeals.has(id));

  const fresh = candidates.filter((id) => !alreadyEnrolled.has(id));
  const kept = fresh.filter((id) => !leftOut(id));
  const overlapping = kept.filter((id) => activeElsewhere.has(id));
  const enrol = options.overlap === "take_over" ? kept : kept.filter((id) => !activeElsewhere.has(id));

  const overlapCounts = new Map<string, number>();
  for (const id of overlapping) overlapCounts.set(activeElsewhere.get(id)!, (overlapCounts.get(activeElsewhere.get(id)!) ?? 0) + 1);
  const names = new Map((db.prepare("SELECT id, name FROM workflows WHERE workspace_id = ?").all(workspaceId) as { id: string; name: string }[]).map((row) => [row.id, row.name]));

  let withEmail = 0;
  let verified = 0;
  for (const ids of chunked(enrol)) {
    const row = db.prepare(
      `SELECT SUM(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) AS with_email,
              SUM(CASE WHEN email IS NOT NULL AND email != '' AND email_status = 'verified' THEN 1 ELSE 0 END) AS verified
       FROM targets WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).get(...ids) as { with_email: number | null; verified: number | null };
    withEmail += row.with_email ?? 0;
    verified += row.verified ?? 0;
  }

  return {
    audience: {
      total: candidates.length,
      already_enrolled: candidates.length - fresh.length,
      customers: fresh.filter((id) => customers.has(id)).length,
      open_deals: fresh.filter((id) => openDeals.has(id)).length,
      excluded: fresh.length - kept.length,
      overlapping: overlapping.length,
      overlaps: [...overlapCounts.entries()].map(([workflow_id, contacts]) => ({ workflow_id, name: names.get(workflow_id) ?? "A campaign since removed", contacts })).sort((a, b) => b.contacts - a.contacts),
      enrol: enrol.length,
      with_email: withEmail,
      verified_email: verified,
    },
    enrol,
    takeOver: options.overlap === "take_over" ? overlapping : [],
  };
}

/** The contacts of a list who are part-way through another campaign, with which one. For reviewing them before a launch. */
export function overlappingContacts(db: DB, workspaceId: string, workflowId: string, listId: string, limit = 500): Array<{ id: string; name: string; company: string | null; workflow_id: string; campaign: string }> {
  return db.prepare(
    `SELECT t.id, COALESCE(NULLIF(t.full_name, ''), t.email, t.linkedin_url) AS name, t.company, w.id AS workflow_id, w.name AS campaign
     FROM list_targets lt JOIN targets t ON t.id = lt.target_id
     JOIN run_profiles rp ON rp.target_id = t.id JOIN runs r ON r.id = rp.run_id AND r.status IN ('running', 'paused') AND r.workspace_id = @ws
     JOIN workflows w ON w.id = r.workflow_id
     WHERE lt.list_id = @list AND t.workspace_id = @ws AND r.workflow_id != @wf
       AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped'))
     GROUP BY t.id ORDER BY w.name COLLATE NOCASE, name COLLATE NOCASE LIMIT @limit`,
  ).all({ ws: workspaceId, list: listId, wf: workflowId, limit }) as Array<{ id: string; name: string; company: string | null; workflow_id: string; campaign: string }>;
}

export interface RunInput {
  workflowId: string;
  listId: string;
  /** The LinkedIn accounts to run from: one, or several as a pool. Empty for a campaign that only sends email. */
  linkedinPool: string[];
  /** The single account, when the caller named one rather than a pool. */
  linkedinAccountId?: string | null;
  rotation: LinkedinRotation;
  emailAccountIds: string[];
  targetIds?: string[];
  exclude?: Partial<Exclusions>;
  overlap?: OverlapChoice;
}

export type RunRefusal = { ok: false; status: 400 | 404; error: string; message?: string };
export interface RunCreated {
  ok: true;
  id: string;
  enrolled: number;
  audience: Audience;
  /** How the contacts were shared out, when the campaign has several LinkedIn accounts. */
  linkedin_accounts?: Record<string, number>;
  email_verification: Record<string, number>;
  /** Enrolled, but with an address that will not be sent to. */
  email_will_not_send: number;
  /** Contacts whose steps in another campaign are now held. */
  taken_over: number;
  linkedin_pool: string[];
}

/** The mark on a track held because its contact was taken into another campaign. Names the run that took them. */
export const supersededBy = (runId: string) => `superseded:${runId}`;

/**
 * Create a run of a campaign on a list and enrol everyone who can be. Nothing is created
 * when nobody can be enrolled, or when anything fails part-way.
 */
export function createRun(db: DB, workspaceId: string, input: RunInput): RunCreated | RunRefusal {
  const accountId: string | undefined = input.linkedinPool[0] ?? input.linkedinAccountId ?? undefined;
  const owned = db.prepare(`SELECT
      EXISTS(SELECT 1 FROM workflows WHERE id = ? AND workspace_id = ?) AS workflow_ok,
      EXISTS(SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?) AS list_ok,
      EXISTS(SELECT 1 FROM accounts WHERE id = ? AND workspace_id = ?) AS account_ok`,
  ).get(input.workflowId, workspaceId, input.listId, workspaceId, accountId ?? null, workspaceId) as { workflow_ok: number; list_ok: number; account_ok: number };
  if (!owned.workflow_ok || !owned.list_ok || (accountId && !owned.account_ok)) return { ok: false, status: 404, error: "Workflow, list, or sender not found in this workspace" };

  const mailboxes = input.emailAccountIds;
  if (mailboxes.length > 0) {
    const ownedMailboxes = (db.prepare(`SELECT COUNT(*) c FROM email_accounts WHERE workspace_id = ? AND id IN (${mailboxes.map(() => "?").join(",")})`).get(workspaceId, ...mailboxes) as { c: number }).c;
    if (ownedMailboxes !== new Set(mailboxes).size) return { ok: false, status: 404, error: "Workflow, list, or sender not found in this workspace" };
  }

  // A campaign needs a sender for each channel it has steps on, and only for those: one
  // with no LinkedIn steps runs without a LinkedIn account.
  const tracks = workflowTracks(db, input.workflowId);
  if (tracks.includes("linkedin") && !accountId) {
    return { ok: false, status: 400, error: "linkedin_account_required", message: "This campaign has LinkedIn steps. Choose a LinkedIn account to run them from." };
  }
  if (!tracks.includes("linkedin") && mailboxes.length === 0) {
    return { ok: false, status: 400, error: "email_account_required", message: "This campaign only sends email. Choose at least one mailbox to send from." };
  }

  // Only one active run per campaign.
  const activeRun = db.prepare("SELECT id FROM runs WHERE workflow_id = ? AND workspace_id = ? AND status IN ('running', 'paused') LIMIT 1").get(input.workflowId, workspaceId);
  if (activeRun) return { ok: false, status: 400, error: "workflow_already_active", message: "This workflow is already running. Stop or pause it before enrolling a new list." };

  // Who can actually be enrolled is worked out BEFORE anything is created, so a no-op (or a
  // failure part-way) never leaves an orphaned run or a stranded enrolment.
  const { audience, enrol, takeOver } = audienceFor(db, workspaceId, input.workflowId, input.listId, { exclude: input.exclude, overlap: input.overlap, targetIds: input.targetIds });
  if (enrol.length === 0) {
    return { ok: false, status: 400, error: "all_already_enrolled", message: "All selected contacts are already enrolled in this workflow." };
  }

  const runId = randomUUID();
  // Company-grouped round-robin over the mailbox pool, then the run and every enrolment in
  // ONE transaction: any failure rolls back the run AND its enrolments together.
  const emailAssignment = assignEmailAccounts(db, enrol, mailboxes);
  // Empty unless the campaign has LinkedIn steps and more than one account to run them from.
  const linkedinAssignment = tracks.includes("linkedin") ? assignLinkedinAccounts(db, enrol, input.linkedinPool, input.rotation) : new Map<string, string>();
  let takenOver = 0;
  db.transaction(() => {
    db.prepare("INSERT INTO runs (id, workspace_id, workflow_id, list_id, account_id, email_account_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, workspaceId, input.workflowId, input.listId, accountId ?? null, mailboxes[0] ?? null);
    if (tracks.includes("linkedin")) saveRunAccountPool(db, runId, input.linkedinPool, input.rotation);
    enrollTargets(db, runId, tracks, enrol, emailAssignment, linkedinAssignment);
    // Hold what these contacts were doing elsewhere. It is given back when they are done here.
    const hold = db.prepare(
      `UPDATE run_profile_tracks SET hold = ? WHERE hold IS NULL AND state IN ('pending', 'in_progress') AND run_profile_id IN (
         SELECT rp.id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
         WHERE rp.target_id = ? AND r.id != ? AND r.workspace_id = ? AND r.status IN ('running', 'paused'))`,
    );
    for (const targetId of takeOver) if (hold.run(supersededBy(runId), targetId, runId, workspaceId).changes > 0) takenOver += 1;
  })();

  // The verification mix of everyone just enrolled on the email track. Nothing is blocked
  // here: the runner probes each address before its send and skips the dead ones. But
  // enrolling is the moment someone can still act on it.
  const emailMix = tracks.includes("email")
    ? (db.prepare(
        `SELECT COALESCE(NULLIF(t.email_status, ''), 'unverified') AS status, COUNT(*) AS count
         FROM run_profiles rp JOIN targets t ON t.id = rp.target_id
         WHERE rp.run_id = ? AND t.email IS NOT NULL AND t.email != '' GROUP BY status`,
      ).all(runId) as { status: string; count: number }[])
    : [];
  const emailVerification = Object.fromEntries(emailMix.map((row) => [row.status, row.count]));

  return {
    ok: true, id: runId, enrolled: enrol.length, audience,
    ...(linkedinAssignment.size > 0 ? { linkedin_accounts: Object.fromEntries(input.linkedinPool.map((id) => [id, [...linkedinAssignment.values()].filter((assigned) => assigned === id).length])) } : {}),
    email_verification: emailVerification,
    email_will_not_send: (emailVerification.invalid ?? 0) + (emailVerification.catchall ?? 0),
    taken_over: takenOver,
    linkedin_pool: input.linkedinPool,
  };
}

/**
 * Give back the tracks that were held while their contact was in another campaign, once
 * the contact has nothing left to do there (or that run is over, or gone). They carry on
 * from where they stood. Returns how many tracks were released.
 */
export function releaseSuperseded(db: DB): number {
  // The held tracks are named in their own query: inside one statement that both reads and
  // writes this table, an unqualified column would be read from the wrong copy of it.
  return db.prepare(
    `UPDATE run_profile_tracks SET hold = NULL WHERE id IN (
       SELECT held.id FROM run_profile_tracks held JOIN run_profiles own ON own.id = held.run_profile_id
       WHERE held.hold LIKE 'superseded:%'
         AND NOT EXISTS (
           SELECT 1 FROM runs nr JOIN run_profiles nrp ON nrp.run_id = nr.id JOIN run_profile_tracks nrt ON nrt.run_profile_id = nrp.id
           WHERE nr.id = substr(held.hold, 12) AND nr.status IN ('running', 'paused', 'pending')
             AND nrp.target_id = own.target_id AND nrt.state IN ('pending', 'in_progress')))`,
  ).run().changes;
}
