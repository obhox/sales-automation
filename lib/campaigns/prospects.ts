// The Prospects tab of a campaign: everyone it has enrolled and where each of them stands,
// what can be done to them (retry, unenrol, remove), adding more to a campaign that is
// already running, and the log of what the campaign has done.
import type DatabaseType from "better-sqlite3";
import { setupOf } from "@/lib/campaigns/setup";
import { assignEmailAccounts, assignLinkedinAccounts, enrollTargets, runAccountPool, runRotation, workflowTracks } from "@/lib/outreach/enroll";
import { audienceFor } from "@/lib/outreach/launch";
import { PROSPECT_STATE, PROSPECT_STATUS, PROSPECT_STATUSES, PROSPECTS_FROM, prospectsWhere, type ProspectStatus, type StepPlace } from "@/lib/outreach/prospects-query";
import { loadSequence } from "@/lib/outreach/publish";
import type { Query } from "@/lib/contacts/filters";

type DB = DatabaseType.Database;
type Track = "linkedin" | "email";

export { PROSPECT_STATUSES, type ProspectStatus };

export interface TrackPlace {
  state: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  /** The step the contact is standing on, counting from 1, and how many the track has. */
  position: number;
  of: number;
  step_id: string | null;
  step_type: string | null;
  next_step_at: string | null;
  /** Why the track stopped, when it did. */
  note: string | null;
  /** Waiting on something other than time: the other track's hand-over, or another campaign that took the contact. */
  hold: "handover" | "other_campaign" | null;
}

export interface ProspectRow {
  /** The enrolment's id: what the actions take. */
  id: string;
  run_id: string;
  target_id: string;
  full_name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  linkedin_url: string | null;
  status: ProspectStatus;
  /** The most active state among the tracks, as the export and older callers know it. */
  state: TrackPlace["state"];
  linkedin: TrackPlace | null;
  email_track: TrackPlace | null;
  enrolled_at: string;
  last_sent_at: string | null;
  replied_at: string | null;
  list: string | null;
  linkedin_account: string | null;
  mailbox: string | null;
}

export interface StepFacet {
  id: string;
  track: Track;
  step_type: string;
  delay_seconds: number | null;
  /** Its number among the track's steps, counting from 1. */
  position: number;
  /** Contacts standing on it now. */
  count: number;
}

export const PROSPECT_SORTS = ["status", "name", "enrolled", "next"] as const;
export type ProspectSort = (typeof PROSPECT_SORTS)[number];

export interface ProspectsPage {
  prospects: ProspectRow[];
  total: number;
  page: number;
  limit: number;
  /** Across the whole campaign, whatever is filtered. */
  counts: Record<ProspectStatus | "all", number>;
  steps: StepFacet[];
  /** Each time a list was enrolled. */
  runs: Array<{ id: string; status: string; list: string | null; created_at: string; enrolled: number }>;
}

const SORT_SQL: Record<ProspectSort, string> = {
  // Most in need of a look first: still going, then held, failed, replied, done, left out.
  status: `CASE ${PROSPECT_STATUS} WHEN 'active' THEN 0 WHEN 'held' THEN 1 WHEN 'failed' THEN 2 WHEN 'replied' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END`,
  name: "lower(COALESCE(t.full_name, ''))",
  enrolled: "datetime(rp.created_at)",
  next: "COALESCE(datetime(rt_li.next_step_at), datetime(rt_em.next_step_at), '9999')",
};

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The steps of each track, in order: a contact's place is an index into these. */
function trackSteps(db: DB, workflowId: string): Record<Track, Array<{ id: string; step_type: string; delay_seconds: number | null }>> {
  const order: Record<Track, Array<{ id: string; step_type: string; delay_seconds: number | null }>> = { linkedin: [], email: [] };
  for (const step of loadSequence(db, workflowId).steps) {
    const track: Track = step.track === "email" || (step.track == null && step.step_type === "email") ? "email" : "linkedin";
    order[track].push({ id: String(step.id), step_type: step.step_type, delay_seconds: step.delay_seconds ?? null });
  }
  return order;
}

/** Where on its track a step is, for "everyone standing on this step". Null when the campaign has no such step. */
export function stepPlace(db: DB, workflowId: string, stepId: string): StepPlace | null {
  const order = trackSteps(db, workflowId);
  for (const track of ["linkedin", "email"] as const) {
    const index = order[track].findIndex((step) => step.id === stepId);
    if (index >= 0) return { track, index };
  }
  return null;
}

/** The `ORDER BY` for a request's `sort` (key or key:direction). The table and the file exported from it share it. */
export function prospectsOrder(query: Query): string {
  const [sortKey, sortDirection] = String(one(query.sort) ?? "status:asc").split(":");
  const sort = (PROSPECT_SORTS as readonly string[]).includes(sortKey) ? (sortKey as ProspectSort) : "status";
  return `ORDER BY ${SORT_SQL[sort]} ${sortDirection === "desc" ? "DESC" : "ASC"}, lower(COALESCE(t.full_name, '')), rp.id`;
}

interface RawRow {
  id: string; run_id: string; target_id: string; enrolled_at: string; status: ProspectStatus; state: TrackPlace["state"];
  full_name: string | null; first_name: string | null; last_name: string | null; title: string | null; company: string | null; email: string | null; linkedin_url: string | null;
  last_replied_at: string | null; email_replied_at: string | null;
  li_state: TrackPlace["state"] | null; li_step: number | null; li_next: string | null; li_note: string | null; li_hold: string | null;
  em_state: TrackPlace["state"] | null; em_step: number | null; em_next: string | null; em_note: string | null; em_hold: string | null;
  list: string | null; linkedin_account: string | null; mailbox: string | null; last_sent_at: string | null;
}

/** One page of a campaign's prospects. `query` is the request's: page, limit, sort, q, status, step_id, run_id. */
export function campaignProspects(db: DB, workspaceId: string, workflowId: string, query: Query = {}): ProspectsPage {
  const order = trackSteps(db, workflowId);
  const limit = Math.min(Math.max(Math.trunc(Number(one(query.limit))) || 25, 1), 100);
  const page = Math.max(Math.trunc(Number(one(query.page))) || 1, 1);
  const stepId = one(query.step_id);
  const place = stepId ? stepPlace(db, workflowId, stepId) : null;

  const { where, params } = prospectsWhere(query, workflowId, { place, noStep: Boolean(stepId) && !place });
  const scope = `${where} AND r.workspace_id = ?`;
  const total = (db.prepare(`SELECT COUNT(*) AS c ${PROSPECTS_FROM} WHERE ${scope}`).get(...params, workspaceId) as { c: number }).c;
  const rows = db.prepare(
    `SELECT rp.id, rp.run_id, rp.target_id, rp.created_at AS enrolled_at, ${PROSPECT_STATUS} AS status, ${PROSPECT_STATE} AS state,
       t.full_name, t.first_name, t.last_name, t.title, t.company, t.email, t.linkedin_url, t.last_replied_at, t.email_replied_at,
       rt_li.state AS li_state, rt_li.current_step AS li_step, rt_li.next_step_at AS li_next, rt_li.error_message AS li_note, rt_li.hold AS li_hold,
       rt_em.state AS em_state, rt_em.current_step AS em_step, rt_em.next_step_at AS em_next, rt_em.error_message AS em_note, rt_em.hold AS em_hold,
       (SELECT l.name FROM lists l WHERE l.id = r.list_id) AS list,
       (SELECT a.name FROM accounts a WHERE a.id = COALESCE(rp.account_id, r.account_id)) AS linkedin_account,
       (SELECT ea.from_email FROM email_accounts ea WHERE ea.id = rp.email_account_id) AS mailbox,
       (SELECT MAX(ss.sent_at) FROM step_sends ss WHERE ss.run_id = rp.run_id AND ss.target_id = rp.target_id) AS last_sent_at
     ${PROSPECTS_FROM} WHERE ${scope}
     ${prospectsOrder(query)} LIMIT ? OFFSET ?`,
  ).all(...params, workspaceId, limit, (page - 1) * limit) as RawRow[];

  const placeOf = (track: Track, state: RawRow["li_state"], step: number | null, next: string | null, note: string | null, hold: string | null): TrackPlace | null => {
    if (!state) return null;
    const steps = order[track];
    const at = steps[step ?? 0];
    const live = state === "pending" || state === "in_progress";
    return {
      state, position: Math.min((step ?? 0) + 1, Math.max(steps.length, 1)), of: steps.length,
      step_id: live ? at?.id ?? null : null, step_type: live ? at?.step_type ?? null : null,
      next_step_at: live ? next : null, note: live ? null : note,
      hold: live && hold ? (hold === "handover" ? "handover" : "other_campaign") : null,
    };
  };
  const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

  const counts = Object.fromEntries([["all", 0], ...PROSPECT_STATUSES.map((status) => [status, 0])]) as ProspectsPage["counts"];
  for (const row of db.prepare(
    `SELECT ${PROSPECT_STATUS} AS status, COUNT(*) AS c ${PROSPECTS_FROM} WHERE r.workflow_id = ? AND r.workspace_id = ? AND r.status IN ('running', 'paused', 'completed') GROUP BY 1`,
  ).all(workflowId, workspaceId) as Array<{ status: ProspectStatus; c: number }>) {
    counts[row.status] = row.c;
    counts.all += row.c;
  }

  const standing = new Map<string, number>();
  for (const row of db.prepare(
    `SELECT rt.track, rt.current_step, COUNT(*) AS c FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id JOIN runs r ON r.id = rp.run_id
     WHERE r.workflow_id = ? AND r.workspace_id = ? AND r.status IN ('running', 'paused', 'completed') AND rt.state IN ('pending', 'in_progress') GROUP BY rt.track, rt.current_step`,
  ).all(workflowId, workspaceId) as Array<{ track: Track; current_step: number; c: number }>) {
    const step = order[row.track]?.[row.current_step];
    if (step) standing.set(step.id, (standing.get(step.id) ?? 0) + row.c);
  }

  return {
    prospects: rows.map((row) => ({
      id: row.id, run_id: row.run_id, target_id: row.target_id,
      full_name: row.full_name?.trim() || [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || "Unnamed contact",
      title: row.title, company: row.company, email: row.email, linkedin_url: row.linkedin_url, status: row.status, state: row.state,
      linkedin: placeOf("linkedin", row.li_state, row.li_step, row.li_next, row.li_note, row.li_hold),
      email_track: placeOf("email", row.em_state, row.em_step, row.em_next, row.em_note, row.em_hold),
      enrolled_at: row.enrolled_at, last_sent_at: row.last_sent_at, replied_at: latest(row.last_replied_at, row.email_replied_at),
      list: row.list, linkedin_account: row.linkedin_account, mailbox: row.mailbox,
    })),
    total, page, limit, counts,
    steps: (["linkedin", "email"] as const).flatMap((track) => order[track].map((step, index) => ({ id: step.id, track, step_type: step.step_type, delay_seconds: step.delay_seconds, position: index + 1, count: standing.get(step.id) ?? 0 }))),
    runs: db.prepare(
      `SELECT r.id, r.status, (SELECT l.name FROM lists l WHERE l.id = r.list_id) AS list, r.created_at, (SELECT COUNT(*) FROM run_profiles rp WHERE rp.run_id = r.id) AS enrolled
       FROM runs r WHERE r.workflow_id = ? AND r.workspace_id = ? ORDER BY datetime(r.created_at) DESC, r.rowid DESC`,
    ).all(workflowId, workspaceId) as ProspectsPage["runs"],
  };
}

// ── Acting on prospects ───────────────────────────────────────────────────────

export const PROSPECT_ACTIONS = ["retry", "unenroll", "remove"] as const;
export type ProspectAction = (typeof PROSPECT_ACTIONS)[number];

export interface ActionResult {
  /** Prospects the action changed. Ones it did not apply to (nothing failed to retry, already finished) are not counted. */
  changed: number;
  asked: number;
  /** Retried, but the campaign is paused or finished: they wait until it runs again. */
  waiting: boolean;
}

/**
 * Retry the steps that failed, take prospects out of the sequence, or remove them from
 * the campaign altogether. `ids` are enrolment ids; any that are not this campaign's are
 * ignored.
 */
export function actOnProspects(db: DB, workspaceId: string, workflowId: string, action: ProspectAction, ids: string[]): ActionResult {
  const asked = [...new Set(ids.filter((id) => typeof id === "string" && id))].slice(0, 5000);
  const own: Array<{ id: string; run_status: string }> = [];
  for (let offset = 0; offset < asked.length; offset += 400) {
    const chunk = asked.slice(offset, offset + 400);
    own.push(...(db.prepare(
      `SELECT rp.id, r.status AS run_status FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
       WHERE r.workflow_id = ? AND r.workspace_id = ? AND rp.id IN (${chunk.map(() => "?").join(",")})`,
    ).all(workflowId, workspaceId, ...chunk) as Array<{ id: string; run_status: string }>));
  }
  let changed = 0;
  let waiting = false;
  db.transaction(() => {
    const retry = db.prepare("UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL, next_step_at = NULL, attempts = 0 WHERE run_profile_id = ? AND state = 'failed'");
    const unenroll = db.prepare("UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Manually unenrolled', hold = NULL WHERE run_profile_id = ? AND state IN ('pending', 'in_progress')");
    const remove = db.prepare("DELETE FROM run_profiles WHERE id = ?");
    for (const profile of own) {
      const done = (action === "retry" ? retry : action === "unenroll" ? unenroll : remove).run(profile.id).changes > 0;
      if (!done) continue;
      changed += 1;
      if (action === "retry" && profile.run_status !== "running") waiting = true;
    }
  })();
  return { changed, asked: asked.length, waiting };
}

// ── Adding prospects to a campaign that is running ────────────────────────────

export type AddResult =
  | { ok: true; run_id: string; asked: number; enrolled: number; already_enrolled: number; excluded: number; in_another_campaign: number }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Enrol more contacts in a campaign that is running or paused: a whole list, or the
 * contacts named. They join the run in flight, share its senders out as a launch would,
 * and start at the first step. The campaign's own exclusions apply, and a contact part-way
 * through another campaign is left where they are.
 */
export function addProspects(db: DB, workspaceId: string, workflowId: string, input: { list_id?: unknown; target_ids?: unknown }): AddResult {
  const run = db.prepare(
    "SELECT id FROM runs WHERE workflow_id = ? AND workspace_id = ? AND status IN ('running', 'paused') ORDER BY status = 'running' DESC, datetime(created_at) DESC, rowid DESC LIMIT 1",
  ).get(workflowId, workspaceId) as { id: string } | undefined;
  if (!run) return { ok: false, status: 400, error: "This campaign is not running. Launch it, and its list is enrolled then." };

  let targetIds: string[] | undefined;
  let listId = "";
  if (Array.isArray(input.target_ids) && input.target_ids.length > 0) {
    targetIds = [...new Set(input.target_ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
    if (targetIds.length === 0) return { ok: false, status: 400, error: "target_ids must be a list of contact ids" };
    if (targetIds.length > 5000) return { ok: false, status: 400, error: "At most 5,000 contacts can be added at once. Add a list instead." };
    let found = 0;
    for (let offset = 0; offset < targetIds.length; offset += 400) {
      const chunk = targetIds.slice(offset, offset + 400);
      found += (db.prepare(`SELECT COUNT(*) AS c FROM targets WHERE workspace_id = ? AND id IN (${chunk.map(() => "?").join(",")})`).get(workspaceId, ...chunk) as { c: number }).c;
    }
    if (found !== targetIds.length) return { ok: false, status: 400, error: "One or more contacts are outside this workspace" };
  } else if (typeof input.list_id === "string" && input.list_id) {
    if (!db.prepare("SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?").get(input.list_id, workspaceId)) return { ok: false, status: 404, error: "That list is not in this workspace" };
    listId = input.list_id;
  } else {
    return { ok: false, status: 400, error: "Name a list (list_id) or the contacts (target_ids) to add" };
  }

  const setup = setupOf(db, workflowId);
  const { audience, enrol } = audienceFor(db, workspaceId, workflowId, listId, { targetIds, exclude: setup.exclude, overlap: "skip" });
  if (enrol.length > 0) {
    const tracks = workflowTracks(db, workflowId);
    // The mailboxes the campaign is set up with; one launched before that was kept uses the ones its contacts already have.
    const inUse = (db.prepare("SELECT DISTINCT email_account_id AS id FROM run_profiles WHERE run_id = ? AND email_account_id IS NOT NULL").all(run.id) as { id: string }[]).map((row) => row.id);
    const known = setup.email_account_ids.filter((id) => db.prepare("SELECT 1 FROM email_accounts WHERE id = ? AND workspace_id = ?").get(id, workspaceId));
    const mailboxes = assignEmailAccounts(db, enrol, known.length > 0 ? known : inUse);
    const accounts = tracks.includes("linkedin") ? assignLinkedinAccounts(db, enrol, runAccountPool(db, run.id), runRotation(db, run.id), run.id) : new Map<string, string>();
    db.transaction(() => enrollTargets(db, run.id, tracks, enrol, mailboxes, accounts))();
  }
  return {
    ok: true, run_id: run.id, asked: audience.total, enrolled: enrol.length,
    already_enrolled: audience.already_enrolled, excluded: audience.excluded, in_another_campaign: audience.overlapping,
  };
}

// ── The run log ───────────────────────────────────────────────────────────────

export interface LogEntry { id: string; level: string; message: string; created_at: string; target_id: string | null; contact: string | null }

/** What the campaign has done, newest first. `before` is the id of the last entry already shown. */
export function campaignLog(db: DB, workspaceId: string, workflowId: string, options: { limit?: number; before?: string; level?: string } = {}): { entries: LogEntry[]; more: boolean } {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 200);
  const clauses = ["lg.run_id IN (SELECT id FROM runs WHERE workflow_id = ? AND workspace_id = ?)"];
  const params: unknown[] = [workflowId, workspaceId];
  if (options.level === "error" || options.level === "warn") { clauses.push("lg.level = ?"); params.push(options.level); }
  if (options.before) { clauses.push("lg.rowid < (SELECT rowid FROM logs WHERE id = ?)"); params.push(options.before); }
  const rows = db.prepare(
    `SELECT lg.id, lg.level, lg.message, lg.created_at, lg.target_id, t.full_name AS contact FROM logs lg LEFT JOIN targets t ON t.id = lg.target_id
     WHERE ${clauses.join(" AND ")} ORDER BY lg.rowid DESC LIMIT ?`,
  ).all(...params, limit + 1) as LogEntry[];
  return { entries: rows.slice(0, limit), more: rows.length > limit };
}
