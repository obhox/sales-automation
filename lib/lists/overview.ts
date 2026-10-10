// What the Lists screens read: one page of lists with how complete each is and what is
// using it, the figures across every list, what a selection of lists adds up to (and how
// far the lists overlap), and one list in detail.
import type DatabaseType from "better-sqlite3";
import { paged, parsePaging, type Paged } from "@/lib/api/paging";
import { memberName } from "@/lib/contacts/table";
import { getDailyImportCap, importedToday } from "@/lib/import-jobs";

type DB = DatabaseType.Database;
type Query = Partial<Record<string, string | string[]>>;

const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();

export const LIST_SOURCES = ["sales_navigator", "csv", "manual"] as const;
export type ListSource = (typeof LIST_SOURCES)[number];

export const LIST_STATES = ["active", "paused", "importing", "verifying", "needs_enrichment", "ready", "empty", "archived"] as const;
export type ListState = (typeof LIST_STATES)[number];

export const LIST_SORTS = ["updated", "name", "contacts", "created", "enriched", "verified"] as const;
export type ListSort = (typeof LIST_SORTS)[number];

// What makes a contact count, as SQL over `targets t`. An address that is known is
// "enriched" whether it came from Apollo or with the import; so is a contact Apollo has
// been asked about, found or not, since asking again is the thing that costs.
const HAS_EMAIL = "(t.email IS NOT NULL AND t.email != '')";
const ENRICHED = `(${HAS_EMAIL} OR t.apollo_enriched_at IS NOT NULL)`;
const VALID = `(${HAS_EMAIL} AND t.email_status IN ('verified', 'checked'))`;
const RISKY = `(${HAS_EMAIL} AND t.email_status IN ('catchall', 'unverified'))`;
const INVALID = `(${HAS_EMAIL} AND t.email_status = 'invalid')`;
/** Worth a look-up on Apollo: no email, never asked, and an address to ask about. */
const ENRICHABLE = `(NOT ${HAS_EMAIL} AND t.apollo_enriched_at IS NULL AND ((t.linkedin_url IS NOT NULL AND t.linkedin_url != '') OR (t.sales_nav_url IS NOT NULL AND t.sales_nav_url != '')))`;
/** Worth a check: an address not yet checked, and not already waiting for one. */
const VERIFIABLE = `(${HAS_EMAIL} AND (t.email_status IS NULL OR t.email_status = '') AND t.email_verify_requested_at IS NULL)`;
const sum = (expression: string, as: string) => `COALESCE(SUM(CASE WHEN ${expression} THEN 1 ELSE 0 END), 0) AS ${as}`;
const FIGURES = [
  "COUNT(t.id) AS contacts", sum(HAS_EMAIL, "with_email"), sum(ENRICHED, "enriched"), sum(VALID, "valid"), sum(RISKY, "risky"), sum(INVALID, "invalid"),
  sum(ENRICHABLE, "enrichable"), sum(VERIFIABLE, "verifiable"), sum("t.email_verify_requested_at IS NOT NULL", "verifying"),
].join(", ");

export interface ListFigures {
  contacts: number;
  with_email: number;
  enriched: number;
  valid: number;
  risky: number;
  invalid: number;
  enrichable: number;
  verifiable: number;
  verifying: number;
}

export interface ListRow extends ListFigures {
  id: string;
  name: string;
  description: string | null;
  created_at: string | null;
  owner: { id: string; name: string } | null;
  source: ListSource;
  /** The file a CSV list came from, when it is known. */
  source_detail: string | null;
  sales_nav_url: string | null;
  /** The last import of either kind that finished. */
  last_synced_at: string | null;
  archived: boolean;
  state: ListState;
  /** The campaign using the list now. */
  campaign: { id: string; name: string; status: string } | null;
  past_campaigns: number;
  /** The import under way, when there is one. */
  import: { id: string; status: string; imported: number; total: number; scheduled_for: string | null } | null;
}

interface RawRow extends ListFigures {
  id: string; name: string; description: string | null; created_at: string | null; owner_id: string | null; source: string | null; source_detail: string | null;
  sales_nav_url: string | null; last_synced_at: string | null; archived_at: string | null; last_import_at: string | null;
}

const latest = (...values: (string | null)[]) => values.filter((value): value is string => Boolean(value)).map((value) => value.replace("T", " ").slice(0, 19)).sort().pop() ?? null;

/** Lists in a workspace with their figures, narrowed by search, source and owner. State and order are worked out by the caller. */
function loadLists(db: DB, workspaceId: string, query: Query, onlyId?: string): ListRow[] {
  const clauses = ["l.workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (onlyId) { clauses.push("l.id = ?"); params.push(onlyId); }
  const q = one(query.q);
  if (q) {
    clauses.push("(l.name LIKE ? OR l.description LIKE ? OR l.source_detail LIKE ? OR EXISTS (SELECT 1 FROM users u WHERE u.id = l.owner_id AND (u.name LIKE ? OR u.email LIKE ?)))");
    params.push(...Array(5).fill(`%${q}%`));
  }
  const source = one(query.source);
  if (source === "manual") clauses.push("(l.source IS NULL OR l.source NOT IN ('sales_navigator', 'csv'))");
  else if (source === "sales_navigator" || source === "csv") { clauses.push("l.source = ?"); params.push(source); }
  const owner = one(query.owner);
  if (owner === "none") clauses.push("l.owner_id IS NULL");
  else if (owner) { clauses.push("l.owner_id = ?"); params.push(owner); }

  const rows = db.prepare(
    `SELECT l.id, l.name, l.description, l.created_at, l.owner_id, l.source, l.source_detail, l.sales_nav_url, l.last_synced_at, l.archived_at,
            (SELECT MAX(li.finished_at) FROM list_imports li WHERE li.list_id = l.id AND li.status IN ('done', 'completed')) AS last_import_at,
            ${FIGURES}
     FROM lists l LEFT JOIN list_targets lt ON lt.list_id = l.id LEFT JOIN targets t ON t.id = lt.target_id
     WHERE ${clauses.join(" AND ")} GROUP BY l.id`,
  ).all(...params) as RawRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const marks = ids.map(() => "?").join(",");
  const imports = new Map<string, NonNullable<ListRow["import"]>>();
  for (const job of db.prepare(
    `SELECT id, list_id, status, imported, total, scheduled_for FROM list_imports WHERE list_id IN (${marks}) AND status IN ('running', 'scheduled')
     ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, started_at DESC`,
  ).all(...ids) as { id: string; list_id: string; status: string; imported: number; total: number; scheduled_for: string | null }[]) {
    if (!imports.has(job.list_id)) imports.set(job.list_id, { id: job.id, status: job.status, imported: job.imported ?? 0, total: job.total ?? 0, scheduled_for: job.scheduled_for });
  }
  // A list's campaign is the newest run still going on it; everything else it was used for is past.
  const campaigns = new Map<string, { live: ListRow["campaign"]; past: number }>();
  for (const run of db.prepare(
    `SELECT r.list_id, r.status, w.id AS workflow_id, w.name FROM runs r JOIN workflows w ON w.id = r.workflow_id
     WHERE r.list_id IN (${marks}) AND r.workspace_id = ? ORDER BY r.created_at DESC`,
  ).all(...ids, workspaceId) as { list_id: string; status: string; workflow_id: string; name: string }[]) {
    const held = campaigns.get(run.list_id) ?? { live: null, past: 0 };
    if ((run.status === "running" || run.status === "paused") && !held.live) held.live = { id: run.workflow_id, name: run.name, status: run.status };
    else held.past += 1;
    campaigns.set(run.list_id, held);
  }
  const ownerIds = [...new Set(rows.map((row) => row.owner_id).filter((id): id is string => Boolean(id)))];
  const owners = new Map<string, string>();
  if (ownerIds.length) {
    for (const user of db.prepare(`SELECT id, name, email FROM users WHERE id IN (${ownerIds.map(() => "?").join(",")})`).all(...ownerIds) as { id: string; name: string | null; email: string }[]) owners.set(user.id, memberName(user));
  }

  return rows.map((row): ListRow => {
    const campaign = campaigns.get(row.id);
    const job = imports.get(row.id) ?? null;
    const figures: ListFigures = { contacts: row.contacts, with_email: row.with_email, enriched: row.enriched, valid: row.valid, risky: row.risky, invalid: row.invalid, enrichable: row.enrichable, verifiable: row.verifiable, verifying: row.verifying };
    return {
      id: row.id, name: row.name, description: row.description, created_at: row.created_at,
      owner: row.owner_id && owners.has(row.owner_id) ? { id: row.owner_id, name: owners.get(row.owner_id)! } : null,
      source: row.source === "sales_navigator" || row.source === "csv" ? row.source : "manual", source_detail: row.source_detail, sales_nav_url: row.sales_nav_url,
      last_synced_at: latest(row.last_synced_at, row.last_import_at), archived: row.archived_at !== null,
      ...figures,
      state: listState({ archived: row.archived_at !== null, importing: job !== null, campaign: campaign?.live?.status ?? null, ...figures }),
      campaign: campaign?.live ?? null, past_campaigns: campaign?.past ?? 0, import: job,
    };
  });
}

/**
 * The one word for where a list stands, most pressing first: archived; being imported;
 * emails being checked; in a running or paused campaign; empty; mostly without an email
 * and not yet looked up; otherwise ready to use.
 */
export function listState(list: ListFigures & { archived: boolean; importing: boolean; campaign: string | null }): ListState {
  if (list.archived) return "archived";
  if (list.importing) return "importing";
  if (list.verifying > 0) return "verifying";
  if (list.campaign === "running") return "active";
  if (list.campaign === "paused") return "paused";
  if (list.contacts === 0) return "empty";
  if (list.enrichable * 2 > list.contacts) return "needs_enrichment";
  return "ready";
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : -1);
const SORTERS: Record<ListSort, (a: ListRow, b: ListRow) => number> = {
  updated: (a, b) => (latest(a.last_synced_at, a.created_at) ?? "").localeCompare(latest(b.last_synced_at, b.created_at) ?? ""),
  name: (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  contacts: (a, b) => a.contacts - b.contacts,
  created: (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""),
  enriched: (a, b) => ratio(a.enriched, a.contacts) - ratio(b.enriched, b.contacts),
  verified: (a, b) => ratio(a.valid, a.contacts) - ratio(b.valid, b.contacts),
};

/** One page of the lists table. `sort=key:direction` against LIST_SORTS; archived lists come last whatever the order. */
export function listsPage(db: DB, workspaceId: string, query: Query): Paged<ListRow> & { sort: { key: ListSort; direction: "asc" | "desc" } } {
  const paging = parsePaging(query, { defaultLimit: 25, maxLimit: 100 });
  const [rawKey, rawDirection] = one(query.sort).split(":");
  const key: ListSort = (LIST_SORTS as readonly string[]).includes(rawKey) ? (rawKey as ListSort) : "updated";
  const direction: "asc" | "desc" = rawKey && rawDirection === "asc" ? "asc" : rawKey && rawDirection === "desc" ? "desc" : key === "name" ? "asc" : "desc";
  const state = one(query.state);
  let rows = loadLists(db, workspaceId, query);
  if ((LIST_STATES as readonly string[]).includes(state)) rows = rows.filter((row) => row.state === state);
  rows.sort((a, b) => Number(a.archived) - Number(b.archived) || (direction === "asc" ? 1 : -1) * SORTERS[key](a, b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { ...paged(rows.slice(paging.offset, paging.offset + paging.limit), rows.length, paging), sort: { key, direction } };
}

export interface ListsSummary extends ListFigures {
  lists: number;
  /** Contacts in a campaign that is running or paused and has not finished with them. */
  in_campaigns: number;
  /** Contacts looked up on Apollo in the last thirty days. Each look-up spends one credit. */
  apollo_lookups: number;
  apollo_connected: boolean;
  members: { id: string; name: string }[];
  imports: { active: number; today: number; daily_cap: number };
}

/** The figures over every contact that is in at least one list, each counted once. */
export function listsSummary(db: DB, workspaceId: string): ListsSummary {
  const inAList = "EXISTS (SELECT 1 FROM list_targets lt JOIN lists l ON l.id = lt.list_id WHERE lt.target_id = t.id AND l.workspace_id = t.workspace_id)";
  const figures = db.prepare(`SELECT ${FIGURES} FROM targets t WHERE t.workspace_id = ? AND ${inAList}`).get(workspaceId) as ListFigures;
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { c: number }).c;
  return {
    ...figures,
    lists: count("SELECT COUNT(*) AS c FROM lists WHERE workspace_id = ?", workspaceId),
    in_campaigns: count(
      `SELECT COUNT(DISTINCT rp.target_id) AS c FROM run_profiles rp JOIN runs r ON r.id = rp.run_id JOIN targets t ON t.id = rp.target_id
       WHERE r.workspace_id = ? AND r.status IN ('running', 'paused') AND ${inAList}
         AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped'))`,
      workspaceId,
    ),
    apollo_lookups: count("SELECT COUNT(*) AS c FROM targets WHERE workspace_id = ? AND apollo_enriched_at >= datetime('now', '-30 days')", workspaceId),
    apollo_connected: Boolean((db.prepare("SELECT api_key FROM integrations WHERE key = 'apollo' AND workspace_id = ?").get(workspaceId) as { api_key: string | null } | undefined)?.api_key),
    members: (db.prepare("SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at ASC").all(workspaceId) as { id: string; name: string | null; email: string }[])
      .map((member) => ({ id: member.id, name: memberName(member) })),
    imports: {
      active: count("SELECT COUNT(*) AS c FROM list_imports li JOIN lists l ON l.id = li.list_id WHERE l.workspace_id = ? AND li.status IN ('running', 'scheduled')", workspaceId),
      today: importedToday(db, workspaceId), daily_cap: getDailyImportCap(db, workspaceId),
    },
  };
}

export interface ListsOverlap extends ListFigures {
  lists: number;
  /** Places taken across the lists: a contact in two of them counts twice here. */
  memberships: number;
  /** Contacts that are in more than one of the lists. */
  in_several: number;
}

/** What a selection of lists adds up to, each contact counted once, and how far the lists overlap. */
export function listsOverlap(db: DB, workspaceId: string, listIds: string[]): ListsOverlap {
  const owned = listIds.length
    ? (db.prepare(`SELECT id FROM lists WHERE workspace_id = ? AND id IN (${listIds.map(() => "?").join(",")})`).all(workspaceId, ...listIds) as { id: string }[]).map((row) => row.id)
    : [];
  const empty: ListFigures = { contacts: 0, with_email: 0, enriched: 0, valid: 0, risky: 0, invalid: 0, enrichable: 0, verifiable: 0, verifying: 0 };
  if (owned.length === 0) return { ...empty, lists: 0, memberships: 0, in_several: 0 };
  const marks = owned.map(() => "?").join(",");
  const figures = db.prepare(
    `SELECT ${FIGURES} FROM targets t WHERE t.workspace_id = ? AND EXISTS (SELECT 1 FROM list_targets lt WHERE lt.target_id = t.id AND lt.list_id IN (${marks}))`,
  ).get(workspaceId, ...owned) as ListFigures;
  const spread = db.prepare(
    `SELECT COALESCE(SUM(n), 0) AS memberships, COALESCE(SUM(CASE WHEN n > 1 THEN 1 ELSE 0 END), 0) AS in_several
     FROM (SELECT COUNT(*) AS n FROM list_targets lt JOIN targets t ON t.id = lt.target_id WHERE lt.list_id IN (${marks}) AND t.workspace_id = ? GROUP BY lt.target_id)`,
  ).get(...owned, workspaceId) as { memberships: number; in_several: number };
  return { ...figures, lists: owned.length, ...spread };
}

export interface ListDetail {
  list: ListRow;
  /** Further figures for the one list. */
  connected: number;
  replied: number;
  in_campaign: number;
  /** Every campaign run that has used the list, newest first. */
  runs: { id: string; workflow_id: string | null; workflow_name: string | null; account_name: string | null; status: string; created_at: string | null; started_at: string | null; completed_at: string | null; total: number; finished: number }[];
  /** LinkedIn accounts an import or a status sync can run from. */
  accounts: { id: string; name: string; signed_in: boolean }[];
  other_lists: { id: string; name: string }[];
  apollo_connected: boolean;
  imports: { today: number; daily_cap: number };
}

/** One list in detail, or null when it is not in this workspace. */
export function listDetail(db: DB, workspaceId: string, listId: string): ListDetail | null {
  const [list] = loadLists(db, workspaceId, {}, listId);
  if (!list) return null;
  const more = db.prepare(
    `SELECT ${sum("t.degree = 1 OR t.connected_at IS NOT NULL", "connected")}, ${sum("t.last_replied_at IS NOT NULL OR t.email_replied_at IS NOT NULL", "replied")},
            ${sum(`EXISTS (SELECT 1 FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE rp.target_id = t.id AND r.status IN ('running', 'paused')
              AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped')))`, "in_campaign")}
     FROM list_targets lt JOIN targets t ON t.id = lt.target_id WHERE lt.list_id = ? AND t.workspace_id = ?`,
  ).get(listId, workspaceId) as { connected: number; replied: number; in_campaign: number };
  const runs = db.prepare(
    `SELECT r.id, r.workflow_id, w.name AS workflow_name, a.name AS account_name, r.status, r.created_at, r.started_at, r.completed_at,
            COUNT(DISTINCT rp.id) AS total,
            COUNT(DISTINCT CASE WHEN NOT EXISTS (SELECT 1 FROM run_profile_tracks rt2 WHERE rt2.run_profile_id = rp.id AND rt2.state NOT IN ('completed', 'failed', 'skipped'))
              AND EXISTS (SELECT 1 FROM run_profile_tracks rt3 WHERE rt3.run_profile_id = rp.id) THEN rp.id END) AS finished
     FROM runs r LEFT JOIN workflows w ON w.id = r.workflow_id LEFT JOIN accounts a ON a.id = r.account_id LEFT JOIN run_profiles rp ON rp.run_id = r.id
     WHERE r.list_id = ? AND r.workspace_id = ? GROUP BY r.id ORDER BY r.created_at DESC`,
  ).all(listId, workspaceId) as ListDetail["runs"];
  return {
    list, ...more, runs,
    accounts: (db.prepare("SELECT id, name, is_authenticated FROM accounts WHERE workspace_id = ? ORDER BY name").all(workspaceId) as { id: string; name: string; is_authenticated: number }[])
      .map((account) => ({ id: account.id, name: account.name, signed_in: account.is_authenticated === 1 })),
    other_lists: db.prepare("SELECT id, name FROM lists WHERE workspace_id = ? AND id != ? AND archived_at IS NULL ORDER BY name COLLATE NOCASE").all(workspaceId, listId) as { id: string; name: string }[],
    apollo_connected: Boolean((db.prepare("SELECT api_key FROM integrations WHERE key = 'apollo' AND workspace_id = ?").get(workspaceId) as { api_key: string | null } | undefined)?.api_key),
    imports: { today: importedToday(db, workspaceId), daily_cap: getDailyImportCap(db, workspaceId) },
  };
}
