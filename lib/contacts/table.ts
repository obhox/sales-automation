// What the contacts screen reads: one page of contacts with their lists, campaign, owner
// and tags, and the choices its filters offer. Rows are filtered, sorted and cut by the
// same query the CSV export uses (lib/contacts/filters.ts), so a file has the rows on screen.
import type DatabaseType from "better-sqlite3";
import { paged, parsePaging, parseSort, type Paged } from "@/lib/api/paging";
import { pendingVerificationCount } from "@/lib/email/verify";
import { LINKEDIN_STATUS_SQL, MAX_SELECTION, contactsQuery, type LinkedinStatus, type Query } from "./filters";

type DB = DatabaseType.Database;

// Timestamps arrive in two spellings ("2026-10-10 14:02:11" from SQLite, ISO from the
// runner). Cut both to the same nineteen characters so they compare as text.
const stamp = (column: string) => `replace(substr(${column}, 1, 19), 'T', ' ')`;

/**
 * The last time anything happened with a contact: a step sent on either channel, an
 * invitation accepted, a reply on either channel. NULL when nothing has.
 */
export const LAST_ACTIVITY_SQL = `NULLIF(MAX(
    COALESCE(${stamp("t.last_replied_at")}, ''), COALESCE(${stamp("t.email_replied_at")}, ''),
    COALESCE(${stamp("t.connected_at")}, ''), COALESCE(${stamp("t.connection_requested_at")}, ''),
    COALESCE(${stamp("t.message_sent_at")}, ''), COALESCE(${stamp("t.inmail_sent_at")}, ''),
    COALESCE((SELECT MAX(${stamp("ss.sent_at")}) FROM step_sends ss WHERE ss.target_id = t.id), ''),
    COALESCE((SELECT MAX(${stamp("er.received_at")}) FROM email_replies er WHERE er.target_id = t.id), '')
  ), '')`;

/** What `sort=key:direction` may name, and the SQL each key sorts by. */
export const CONTACT_SORTS: Record<string, string> = {
  name: "t.full_name COLLATE NOCASE",
  company: "t.company COLLATE NOCASE",
  email: "t.email COLLATE NOCASE",
  intent: "t.intent_score",
  last_activity: LAST_ACTIVITY_SQL,
  created: "t.created_at",
};
export const DEFAULT_CONTACT_SORT = { key: "intent", direction: "desc" } as const;

/** `ORDER BY` for a contacts request. Empty values go last either way; ties fall back to the name, then the id, so pages never overlap. */
export function contactsOrder(query: Query): { sort: { key: string; direction: "asc" | "desc" }; orderBy: string } {
  const { sort, orderBy } = parseSort(query, CONTACT_SORTS, DEFAULT_CONTACT_SORT);
  return { sort, orderBy: `ORDER BY ${orderBy} NULLS LAST, t.full_name COLLATE NOCASE ASC, t.id ASC` };
}

export interface ContactRow {
  id: string;
  full_name: string | null;
  title: string | null;
  company: string | null;
  company_id: string | null;
  location: string | null;
  country: string | null;
  email: string | null;
  email_status: string | null;
  phone: string | null;
  linkedin_url: string | null;
  seniority: string | null;
  intent_score: number;
  linkedin_status: LinkedinStatus;
  last_activity_at: string | null;
  created_at: string | null;
  enriched: boolean;
  replied: boolean;
  unsubscribed: boolean;
  owner: { id: string; name: string } | null;
  /** Every list the contact is in, by name. */
  lists: { id: string; name: string }[];
  /** The campaign the contact is in now, or was in last. */
  campaign: { id: string; name: string; status: string } | null;
  campaign_count: number;
  tags: ContactTag[];
}

export interface ContactTag {
  id: string;
  name: string;
  color: string;
}

interface BaseRow {
  id: string; full_name: string | null; title: string | null; company: string | null; company_id: string | null; location: string | null; country: string | null;
  email: string | null; email_status: string | null; phone: string | null; linkedin_url: string | null; seniority: string | null; intent_score: number | null;
  owner_id: string | null; apollo_enriched_at: string | null; created_at: string | null; last_replied_at: string | null; email_replied_at: string | null;
  unsubscribed_at: string | null; linkedin_status: LinkedinStatus; last_activity_at: string | null;
}

const marks = (ids: unknown[]) => ids.map(() => "?").join(",");
export const memberName = (member: { name: string | null; email: string }) => member.name?.trim() || member.email.split("@")[0];

/** One page of the contacts table. */
export function contactsPage(db: DB, workspaceId: string, query: Query): Paged<ContactRow> & { sort: { key: string; direction: "asc" | "desc" } } {
  const paging = parsePaging(query, { defaultLimit: 25, maxLimit: 200 });
  const { from, where, params } = contactsQuery(query, workspaceId);
  const { sort, orderBy } = contactsOrder(query);

  const total = (db.prepare(`SELECT COUNT(*) AS c ${from} ${where}`).get(...params) as { c: number }).c;
  const rows = db.prepare(
    `SELECT t.id, t.full_name, t.title, t.company, t.company_id, t.location, t.country, t.email, t.email_status, t.phone, t.linkedin_url, t.seniority,
            t.intent_score, t.owner_id, t.apollo_enriched_at, t.created_at, t.last_replied_at, t.email_replied_at, t.unsubscribed_at,
            ${LINKEDIN_STATUS_SQL} AS linkedin_status, ${LAST_ACTIVITY_SQL} AS last_activity_at
     ${from} ${where} ${orderBy} LIMIT ? OFFSET ?`,
  ).all(...params, paging.limit, paging.offset) as BaseRow[];

  const ids = rows.map((row) => row.id);
  const lists = new Map<string, { id: string; name: string }[]>();
  const campaigns = new Map<string, { id: string; name: string; status: string }[]>();
  const tags = new Map<string, ContactTag[]>();
  const owners = new Map<string, string>();
  if (ids.length) {
    const push = <T,>(map: Map<string, T[]>, key: string, value: T) => { const held = map.get(key); if (held) held.push(value); else map.set(key, [value]); };
    for (const row of db.prepare(
      `SELECT lt.target_id, l.id, l.name FROM list_targets lt JOIN lists l ON l.id = lt.list_id
       WHERE lt.target_id IN (${marks(ids)}) AND l.workspace_id = ? ORDER BY l.name COLLATE NOCASE`,
    ).all(...ids, workspaceId) as { target_id: string; id: string; name: string }[]) push(lists, row.target_id, { id: row.id, name: row.name });

    // A live campaign comes before a finished one; within each, the latest first.
    for (const row of db.prepare(
      `SELECT rp.target_id, w.id, w.name, r.status FROM run_profiles rp JOIN runs r ON r.id = rp.run_id JOIN workflows w ON w.id = r.workflow_id
       WHERE rp.target_id IN (${marks(ids)}) AND r.workspace_id = ?
       ORDER BY (r.status IN ('running', 'paused')) DESC, r.created_at DESC`,
    ).all(...ids, workspaceId) as { target_id: string; id: string; name: string; status: string }[]) {
      if (!campaigns.get(row.target_id)?.some((held) => held.id === row.id)) push(campaigns, row.target_id, { id: row.id, name: row.name, status: row.status });
    }

    for (const row of db.prepare(
      `SELECT tt.target_id, ct.id, ct.name, ct.color FROM target_tags tt JOIN contact_tags ct ON ct.id = tt.tag_id
       WHERE tt.target_id IN (${marks(ids)}) AND ct.workspace_id = ? ORDER BY ct.name`,
    ).all(...ids, workspaceId) as { target_id: string; id: string; name: string; color: string }[]) push(tags, row.target_id, { id: row.id, name: row.name, color: row.color });

    const ownerIds = [...new Set(rows.map((row) => row.owner_id).filter((id): id is string => Boolean(id)))];
    if (ownerIds.length) {
      for (const user of db.prepare(`SELECT id, name, email FROM users WHERE id IN (${marks(ownerIds)})`).all(...ownerIds) as { id: string; name: string | null; email: string }[]) owners.set(user.id, memberName(user));
    }
  }

  const items = rows.map((row): ContactRow => {
    const inCampaigns = campaigns.get(row.id) ?? [];
    return {
      id: row.id, full_name: row.full_name, title: row.title, company: row.company, company_id: row.company_id, location: row.location, country: row.country,
      email: row.email || null, email_status: row.email_status, phone: row.phone, linkedin_url: row.linkedin_url, seniority: row.seniority,
      intent_score: Math.round(row.intent_score ?? 0), linkedin_status: row.linkedin_status, last_activity_at: row.last_activity_at, created_at: row.created_at,
      enriched: row.apollo_enriched_at !== null, replied: row.last_replied_at !== null || row.email_replied_at !== null, unsubscribed: row.unsubscribed_at !== null,
      owner: row.owner_id && owners.has(row.owner_id) ? { id: row.owner_id, name: owners.get(row.owner_id)! } : null,
      lists: lists.get(row.id) ?? [],
      campaign: inCampaigns[0] ?? null, campaign_count: inCampaigns.length,
      tags: tags.get(row.id) ?? [],
    };
  });
  return { ...paged(items, total, paging), sort };
}

/** The ids a request selects, for "select all matching". Never more than MAX_SELECTION. */
export function contactIds(db: DB, workspaceId: string, query: Query): { ids: string[]; total: number; capped: boolean } {
  const { from, where, params } = contactsQuery(query, workspaceId);
  const { orderBy } = contactsOrder(query);
  const total = (db.prepare(`SELECT COUNT(*) AS c ${from} ${where}`).get(...params) as { c: number }).c;
  const ids = (db.prepare(`SELECT t.id ${from} ${where} ${orderBy} LIMIT ?`).all(...params, MAX_SELECTION) as { id: string }[]).map((row) => row.id);
  return { ids, total, capped: total > ids.length };
}

export interface ContactFacets {
  /** Every contact in the workspace, whatever the filters say. */
  total: number;
  /** Contacts waiting in the email verification queue. */
  verifying: number;
  lists: { id: string; name: string; count: number }[];
  /** Campaigns to filter by. `run_id` is the run a contact can be added to, when there is a live one. */
  campaigns: { id: string; name: string; status: string | null; run_id: string | null }[];
  members: { id: string; name: string }[];
  tags: (ContactTag & { count: number })[];
  countries: string[];
  seniorities: string[];
  apollo_connected: boolean;
  custom_fields: number;
  max_selection: number;
}

/** Everything the screen's filters, pickers and header need, in one read. */
export function contactFacets(db: DB, workspaceId: string): ContactFacets {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM targets WHERE workspace_id = ?").get(workspaceId) as { c: number }).c;
  const lists = db.prepare(
    `SELECT l.id, l.name, COUNT(lt.target_id) AS count FROM lists l LEFT JOIN list_targets lt ON lt.list_id = l.id
     WHERE l.workspace_id = ? GROUP BY l.id ORDER BY l.name COLLATE NOCASE`,
  ).all(workspaceId) as ContactFacets["lists"];
  // The run to add contacts to is the newest one that is still going.
  const campaigns = db.prepare(
    `SELECT w.id, w.name,
            (SELECT r.status FROM runs r WHERE r.workflow_id = w.id ORDER BY (r.status IN ('running', 'paused')) DESC, r.created_at DESC LIMIT 1) AS status,
            (SELECT r.id FROM runs r WHERE r.workflow_id = w.id AND r.status IN ('running', 'paused') ORDER BY r.created_at DESC LIMIT 1) AS run_id
     FROM workflows w WHERE w.workspace_id = ? AND COALESCE(w.is_archived, 0) = 0 ORDER BY w.name COLLATE NOCASE`,
  ).all(workspaceId) as ContactFacets["campaigns"];
  const members = (db.prepare(
    "SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at ASC",
  ).all(workspaceId) as { id: string; name: string | null; email: string }[]).map((member) => ({ id: member.id, name: memberName(member) }));
  const distinct = (column: "country" | "seniority") =>
    (db.prepare(`SELECT DISTINCT ${column} AS value FROM targets WHERE workspace_id = ? AND ${column} IS NOT NULL AND ${column} != '' ORDER BY ${column} COLLATE NOCASE LIMIT 300`).all(workspaceId) as { value: string }[]).map((row) => row.value);
  return {
    total,
    verifying: pendingVerificationCount(db, workspaceId),
    lists,
    campaigns,
    members,
    tags: listContactTags(db, workspaceId),
    countries: distinct("country"),
    seniorities: distinct("seniority"),
    apollo_connected: Boolean((db.prepare("SELECT api_key FROM integrations WHERE key = 'apollo' AND workspace_id = ?").get(workspaceId) as { api_key: string | null } | undefined)?.api_key),
    custom_fields: (db.prepare("SELECT COUNT(*) AS c FROM custom_field_definitions WHERE workspace_id = ?").get(workspaceId) as { c: number }).c,
    max_selection: MAX_SELECTION,
  };
}

/** The workspace's contact tags, each with how many contacts carry it. */
export function listContactTags(db: DB, workspaceId: string): (ContactTag & { count: number })[] {
  return db.prepare(
    `SELECT ct.id, ct.name, ct.color, (SELECT COUNT(*) FROM target_tags tt WHERE tt.tag_id = ct.id) AS count
     FROM contact_tags ct WHERE ct.workspace_id = ? ORDER BY ct.name`,
  ).all(workspaceId) as (ContactTag & { count: number })[];
}
