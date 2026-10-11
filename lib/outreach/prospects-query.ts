// Which of a campaign's prospects a request is asking for. The prospects table and its CSV
// export both build their query here, so the file holds the rows that were on screen.
import { PROSPECT_FILTER_COLUMNS, filterClause, parseFilters, type Query } from "@/lib/contacts/filters";

/** A prospect with their track on each channel. Everything below is written against these aliases. */
export const PROSPECTS_FROM = `FROM run_profiles rp
       JOIN runs r ON r.id = rp.run_id
       JOIN targets t ON t.id = rp.target_id
       LEFT JOIN run_profile_tracks rt_li ON rt_li.run_profile_id = rp.id AND rt_li.track = 'linkedin'
       LEFT JOIN run_profile_tracks rt_em ON rt_em.run_profile_id = rp.id AND rt_em.track = 'email'`;

const hasTrackIn = (state: string) => `EXISTS (SELECT 1 FROM run_profile_tracks rt_a WHERE rt_a.run_profile_id = rp.id AND rt_a.state = '${state}')`;

/** Where a prospect stands overall: the most active state among their tracks. */
export const PROSPECT_STATE = `CASE
                WHEN ${hasTrackIn("in_progress")} THEN 'in_progress'
                WHEN ${hasTrackIn("pending")} THEN 'pending'
                WHEN ${hasTrackIn("failed")} THEN 'failed'
                WHEN ${hasTrackIn("skipped")} THEN 'skipped'
                ELSE 'completed'
              END`;

export const PROSPECT_STATUSES = ["active", "held", "failed", "replied", "completed", "skipped"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

const anyTrack = (condition: string) => `EXISTS (SELECT 1 FROM run_profile_tracks rt_s WHERE rt_s.run_profile_id = rp.id AND ${condition})`;
const LIVE = "rt_s.state IN ('pending', 'in_progress')";

/**
 * What a prospect is to the person looking after the campaign: still going, held because
 * another campaign took them, stopped on a failure that can be retried, stopped because
 * they replied, through the whole sequence, or left out of it.
 */
export const PROSPECT_STATUS = `CASE
                WHEN ${anyTrack(`${LIVE} AND COALESCE(rt_s.hold, '') NOT LIKE 'superseded:%'`)} THEN 'active'
                WHEN ${anyTrack(LIVE)} THEN 'held'
                WHEN ${anyTrack("rt_s.state = 'failed'")} THEN 'failed'
                WHEN ${anyTrack("rt_s.state = 'skipped' AND rt_s.error_message LIKE '%replied%'")} THEN 'replied'
                WHEN ${anyTrack("rt_s.state = 'completed'")} THEN 'completed'
                ELSE 'skipped'
              END`;

/** A step as a place on its track: the contacts standing on it have this index as their current step. */
export interface StepPlace { track: "linkedin" | "email"; index: number }

/**
 * The `WHERE` (without the keyword) and its parameters for `step`, `track`, `state`,
 * `search` and the filter bar, and for what the campaign's Prospects tab asks by:
 * `status` (one or more of PROSPECT_STATUSES), `q` (name, company or email), `run_id`, and
 * a step's place, which the caller works out from `step_id`. `noStep` is a `step_id` that
 * is not one of the campaign's: nobody stands on it.
 */
export function prospectsWhere(query: Query, workflowId: string, extra: { place?: StepPlace | null; noStep?: boolean } = {}): { where: string; params: unknown[] } {
  const stepFilter = query.step !== undefined ? Number(query.step) : null;
  const trackFilter = (query.track as string | undefined) ?? "linkedin";
  const stateFilter = query.state as string | undefined;
  const search = query.search as string | undefined;

  const conditions: string[] = ["r.workflow_id = ?", "r.status IN ('running', 'paused', 'completed')"];
  const params: unknown[] = [workflowId];

  if (stepFilter !== null) {
    const trackAlias = trackFilter === "email" ? "rt_em" : "rt_li";
    // Only show prospects actively at this step (exclude failed/skipped/completed at that step)
    conditions.push(`COALESCE(${trackAlias}.current_step, 0) = ? AND ${trackAlias}.state NOT IN ('completed','skipped','failed')`);
    params.push(stepFilter - 1);
  }
  if (stateFilter) {
    const states = stateFilter.split(",");
    const stateConditions = states.map((s) => {
      if (s === "completed") {
        // No active tracks, at least one completed — matches stats API definition
        return `NOT EXISTS (SELECT 1 FROM run_profile_tracks rt_sf WHERE rt_sf.run_profile_id = rp.id AND rt_sf.state IN ('in_progress','pending'))
                AND EXISTS (SELECT 1 FROM run_profile_tracks rt_sf2 WHERE rt_sf2.run_profile_id = rp.id AND rt_sf2.state = 'completed')`;
      }
      if (s === "in_progress") {
        return "EXISTS (SELECT 1 FROM run_profile_tracks rt_sf WHERE rt_sf.run_profile_id = rp.id AND rt_sf.state = 'in_progress')";
      }
      if (s === "failed") {
        // No active tracks, no completed tracks, has a failed track
        return `NOT EXISTS (SELECT 1 FROM run_profile_tracks rt_sf WHERE rt_sf.run_profile_id = rp.id AND rt_sf.state IN ('in_progress','pending'))
                AND NOT EXISTS (SELECT 1 FROM run_profile_tracks rt_sf2 WHERE rt_sf2.run_profile_id = rp.id AND rt_sf2.state = 'completed')
                AND EXISTS (SELECT 1 FROM run_profile_tracks rt_sf3 WHERE rt_sf3.run_profile_id = rp.id AND rt_sf3.state = 'failed')`;
      }
      if (s === "skipped") {
        // No active tracks, no completed, no failed, has a skipped track
        return `NOT EXISTS (SELECT 1 FROM run_profile_tracks rt_sf WHERE rt_sf.run_profile_id = rp.id AND rt_sf.state IN ('in_progress','pending'))
                AND NOT EXISTS (SELECT 1 FROM run_profile_tracks rt_sf2 WHERE rt_sf2.run_profile_id = rp.id AND rt_sf2.state = 'completed')
                AND NOT EXISTS (SELECT 1 FROM run_profile_tracks rt_sf3 WHERE rt_sf3.run_profile_id = rp.id AND rt_sf3.state = 'failed')
                AND EXISTS (SELECT 1 FROM run_profile_tracks rt_sf4 WHERE rt_sf4.run_profile_id = rp.id AND rt_sf4.state = 'skipped')`;
      }
      return "EXISTS (SELECT 1 FROM run_profile_tracks rt_sf WHERE rt_sf.run_profile_id = rp.id AND rt_sf.state = ?)";
    });
    conditions.push(`(${stateConditions.join(" OR ")})`);
    params.push(...states.filter((s) => !["completed", "in_progress", "failed", "skipped"].includes(s)));
  }
  if (search) {
    conditions.push("(t.full_name LIKE ? OR t.company LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  const text = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || "";
  const statuses = text(query.status).split(",").filter((status): status is ProspectStatus => (PROSPECT_STATUSES as readonly string[]).includes(status));
  if (statuses.length > 0) {
    conditions.push(`${PROSPECT_STATUS} IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  const q = text(query.q);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    conditions.push("(t.full_name LIKE ? ESCAPE '\\' OR t.company LIKE ? ESCAPE '\\' OR t.email LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (text(query.run_id)) {
    conditions.push("rp.run_id = ?");
    params.push(text(query.run_id));
  }
  if (extra.place) {
    const alias = extra.place.track === "email" ? "rt_em" : "rt_li";
    conditions.push(`${alias}.current_step = ? AND ${alias}.state IN ('pending', 'in_progress')`);
    params.push(extra.place.index);
  } else if (extra.noStep) {
    conditions.push("0");
  }

  // Extra filters from FilterBar
  const filters = filterClause(parseFilters(query), PROSPECT_FILTER_COLUMNS);
  if (filters.sql) {
    conditions.push(filters.sql.replace(/^ AND /, ""));
    params.push(...filters.params);
  }
  return { where: conditions.join(" AND "), params };
}
