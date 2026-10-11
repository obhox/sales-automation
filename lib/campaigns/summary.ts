// A workspace's campaigns as the campaigns list shows them: what state each is in, who it
// is going to, how far along it is and what has come of it.
//
// One definition of a campaign's status lives here. The old list worked it out in the
// page and looked only for a running run, which is why a paused campaign had no run to
// resume and its Resume button never appeared.
import type DatabaseType from "better-sqlite3";
import { AUTO_REPLY_KINDS, sqlList } from "@/lib/reply-kinds";

type DB = DatabaseType.Database;

export const CAMPAIGN_STATUSES = ["active", "paused", "draft", "completed", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type Channel = "linkedin" | "email";

/**
 * Where a campaign stands, from its own flag and the states of its runs:
 * archived wins; then active if anything is running; then paused; then draft if it has
 * never been started (no run, or only one prepared and not started); otherwise completed.
 */
export function campaignStatus(archived: boolean, runStatuses: readonly string[]): CampaignStatus {
  if (archived) return "archived";
  if (runStatuses.includes("running")) return "active";
  if (runStatuses.includes("paused")) return "paused";
  if (runStatuses.some((status) => status === "completed" || status === "failed")) return "completed";
  return "draft";
}

export interface CampaignSummary {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  created_at: string;
  channels: Channel[];
  steps: number;
  gates: number;
  /** The list its latest run was started on, with how many contacts the list holds now. */
  list: { id: string; name: string; contacts: number } | null;
  /** Contacts enrolled across its runs, and how many of them have finished. */
  enrolled: number;
  done: number;
  /** Contacts it has written to, and how many of those replied after it first did. Automatic answers are not counted. */
  contacted: number;
  replied: number;
  reply_rate: number | null;
  /** Contacts it has invited on LinkedIn, and how many of those are now connections. */
  invited: number;
  accepted: number;
  acceptance_rate: number | null;
  owner: { id: string; name: string } | null;
  /** When it last sent anything, or failing that when it was last started, or created. */
  last_activity_at: string;
  /** The run that pausing or resuming acts on: the one running, else the one paused. */
  run: { id: string; status: string } | null;
}

const nameFromEmail = (email: string) => (email.split("@")[0] ?? "").split(/[._\-+]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") || email;

/** Every campaign of a workspace, newest first. */
export function campaignSummaries(db: DB, workspaceId: string): CampaignSummary[] {
  const campaigns = db.prepare(
    `SELECT w.id, w.name, w.description, COALESCE(w.is_archived, 0) AS archived, w.created_at, w.owner_id, u.name AS owner_name, u.email AS owner_email
     FROM workflows w LEFT JOIN users u ON u.id = w.owner_id WHERE w.workspace_id = ? ORDER BY w.created_at DESC, w.rowid DESC`,
  ).all(workspaceId) as Array<{ id: string; name: string; description: string | null; archived: number; created_at: string; owner_id: string | null; owner_name: string | null; owner_email: string | null }>;
  if (campaigns.length === 0) return [];

  const by = <T extends { workflow_id: string }>(rows: T[]) => new Map(rows.map((row) => [row.workflow_id, row]));
  const steps = by(db.prepare(
    `SELECT ws.workflow_id, COUNT(*) AS steps, MAX(ws.track = 'linkedin') AS linkedin, MAX(ws.track = 'email') AS email
     FROM workflow_steps ws JOIN workflows w ON w.id = ws.workflow_id WHERE w.workspace_id = ? GROUP BY ws.workflow_id`,
  ).all(workspaceId) as Array<{ workflow_id: string; steps: number; linkedin: number; email: number }>);
  const gates = by(db.prepare("SELECT workflow_id, COUNT(*) AS gates FROM workflow_branches WHERE workspace_id = ? GROUP BY workflow_id").all(workspaceId) as Array<{ workflow_id: string; gates: number }>);

  const runs = db.prepare("SELECT id, workflow_id, status, list_id, started_at, created_at FROM runs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC").all(workspaceId) as
    Array<{ id: string; workflow_id: string; status: string; list_id: string | null; started_at: string | null; created_at: string }>;
  const runsOf = new Map<string, typeof runs>();
  for (const run of runs) runsOf.set(run.workflow_id, [...(runsOf.get(run.workflow_id) ?? []), run]);

  const enrolment = by(db.prepare(
    `SELECT r.workflow_id, COUNT(DISTINCT rp.target_id) AS enrolled,
       COUNT(DISTINCT CASE WHEN NOT EXISTS (
           SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped'))
         AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id) THEN rp.target_id END) AS done
     FROM runs r JOIN run_profiles rp ON rp.run_id = r.id WHERE r.workspace_id = ? GROUP BY r.workflow_id`,
  ).all(workspaceId) as Array<{ workflow_id: string; enrolled: number; done: number }>);

  // What came of its sends, per contact. A reply counts for a campaign only if it came
  // after that campaign first wrote to the contact.
  const outcomes = by(db.prepare(
    `WITH touched AS (
       SELECT ss.workflow_id, ss.target_id, MIN(ss.sent_at) AS first_at, MAX(ss.action = 'connect') AS invited
       FROM step_sends ss WHERE ss.workspace_id = ? AND ss.workflow_id IS NOT NULL AND ss.target_id IS NOT NULL AND ss.action != 'visit'
       GROUP BY ss.workflow_id, ss.target_id)
     SELECT x.workflow_id, COUNT(*) AS contacted, SUM(x.invited) AS invited,
       SUM(CASE WHEN x.invited = 1 AND t.connected_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted,
       SUM(CASE WHEN COALESCE(t.reply_kind, '') NOT IN (${sqlList(AUTO_REPLY_KINDS)})
                 AND datetime(COALESCE(MAX(COALESCE(t.last_replied_at, ''), COALESCE(t.email_replied_at, '')), '')) >= datetime(x.first_at)
                THEN 1 ELSE 0 END) AS replied
     FROM touched x JOIN targets t ON t.id = x.target_id GROUP BY x.workflow_id`,
  ).all(workspaceId) as Array<{ workflow_id: string; contacted: number; invited: number; accepted: number; replied: number }>);
  const lastSend = by(db.prepare("SELECT workflow_id, MAX(sent_at) AS at FROM step_sends WHERE workspace_id = ? AND workflow_id IS NOT NULL GROUP BY workflow_id").all(workspaceId) as Array<{ workflow_id: string; at: string }>);

  const lists = new Map((db.prepare(
    "SELECT l.id, l.name, (SELECT COUNT(*) FROM list_targets lt WHERE lt.list_id = l.id) AS contacts FROM lists l WHERE l.workspace_id = ?",
  ).all(workspaceId) as Array<{ id: string; name: string; contacts: number }>).map((list) => [list.id, list]));

  return campaigns.map((campaign) => {
    const own = runsOf.get(campaign.id) ?? [];
    const step = steps.get(campaign.id);
    const outcome = outcomes.get(campaign.id);
    const enrolled = enrolment.get(campaign.id);
    const live = own.find((run) => run.status === "running") ?? own.find((run) => run.status === "paused") ?? null;
    const listId = own.find((run) => run.list_id)?.list_id ?? null;
    const channels: Channel[] = [...(step?.linkedin ? ["linkedin" as const] : []), ...(step?.email ? ["email" as const] : [])];
    return {
      id: campaign.id, name: campaign.name, description: campaign.description, created_at: campaign.created_at,
      status: campaignStatus(Boolean(campaign.archived), own.map((run) => run.status)),
      channels, steps: step?.steps ?? 0, gates: gates.get(campaign.id)?.gates ?? 0,
      list: listId ? lists.get(listId) ?? null : null,
      enrolled: enrolled?.enrolled ?? 0, done: enrolled?.done ?? 0,
      contacted: outcome?.contacted ?? 0, replied: outcome?.replied ?? 0,
      reply_rate: outcome?.contacted ? outcome.replied / outcome.contacted : null,
      invited: outcome?.invited ?? 0, accepted: outcome?.accepted ?? 0,
      acceptance_rate: outcome?.invited ? outcome.accepted / outcome.invited : null,
      owner: campaign.owner_id ? { id: campaign.owner_id, name: campaign.owner_name?.trim() || nameFromEmail(campaign.owner_email ?? "") } : null,
      last_activity_at: lastSend.get(campaign.id)?.at ?? own[0]?.started_at ?? own[0]?.created_at ?? campaign.created_at,
      run: live ? { id: live.id, status: live.status } : null,
    };
  });
}

// ── The list, filtered, sorted and paged ──────────────────────────────────────

export const CAMPAIGN_SORTS = ["last_activity", "name", "created", "enrolled", "reply_rate", "acceptance"] as const;
export type CampaignSort = (typeof CAMPAIGN_SORTS)[number];

export interface CampaignListQuery {
  /** A status, or "all": every campaign that is not archived. */
  status?: string;
  q?: string;
  channel?: string;
  /** A member's id, or "none" for campaigns with no owner. */
  owner?: string;
  sort?: { key: CampaignSort; direction: "asc" | "desc" };
  page: number;
  limit: number;
}

export interface CampaignList {
  items: CampaignSummary[];
  total: number;
  page: number;
  limit: number;
  /** How many campaigns each status tab holds, under the other filters. "all" leaves archived ones out. */
  counts: Record<"all" | CampaignStatus, number>;
  /** Everyone who owns a campaign here, for the owner filter. */
  owners: Array<{ id: string; name: string }>;
}

const time = (value: string) => Date.parse(/[TZ]/.test(value) ? value : `${value.replace(" ", "T")}Z`) || 0;

const SORTERS: Record<CampaignSort, (a: CampaignSummary, b: CampaignSummary) => number> = {
  last_activity: (a, b) => time(a.last_activity_at) - time(b.last_activity_at),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  created: (a, b) => time(a.created_at) - time(b.created_at),
  enrolled: (a, b) => a.enrolled - b.enrolled,
  // A campaign with nothing sent yet has no rate: it sorts below every campaign that has one.
  reply_rate: (a, b) => (a.reply_rate ?? -1) - (b.reply_rate ?? -1),
  acceptance: (a, b) => (a.acceptance_rate ?? -1) - (b.acceptance_rate ?? -1),
};

/**
 * Campaigns are few (tens, sometimes hundreds), and every figure on a row is an aggregate
 * over the workspace's runs, so the whole set is summarised once and then filtered, sorted
 * and paged here rather than in SQL.
 */
export function campaignList(db: DB, workspaceId: string, query: CampaignListQuery): CampaignList {
  const all = campaignSummaries(db, workspaceId);
  const q = (query.q ?? "").trim().toLowerCase();
  const matching = all.filter((campaign) =>
    (!q || campaign.name.toLowerCase().includes(q) || (campaign.list?.name.toLowerCase().includes(q) ?? false))
    && (!query.channel || query.channel === "all" || campaign.channels.includes(query.channel as Channel))
    && (!query.owner || query.owner === "all" || (query.owner === "none" ? campaign.owner === null : campaign.owner?.id === query.owner)));

  const counts = { all: 0, active: 0, paused: 0, draft: 0, completed: 0, archived: 0 } as CampaignList["counts"];
  for (const campaign of matching) {
    counts[campaign.status] += 1;
    if (campaign.status !== "archived") counts.all += 1;
  }
  const status = (CAMPAIGN_STATUSES as readonly string[]).includes(query.status ?? "") ? (query.status as CampaignStatus) : "all";
  const shown = matching.filter((campaign) => (status === "all" ? campaign.status !== "archived" : campaign.status === status));

  const sort = query.sort ?? { key: "last_activity" as const, direction: "desc" as const };
  const sorted = [...shown].sort((a, b) => SORTERS[sort.key](a, b) * (sort.direction === "asc" ? 1 : -1));

  const owners = new Map<string, string>();
  for (const campaign of all) if (campaign.owner) owners.set(campaign.owner.id, campaign.owner.name);
  return {
    items: sorted.slice((query.page - 1) * query.limit, query.page * query.limit),
    total: sorted.length, page: query.page, limit: query.limit, counts,
    owners: [...owners].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
