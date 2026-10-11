// The inbox's list: conversations a page at a time, filtered, with the counts its filter
// rail shows. One row per contact, read from the conversations table; nothing is worked
// out message by message here.
import type DatabaseType from "better-sqlite3";
import { UNREAD_SQL } from "@/lib/conversations/store";
import { isoOf, nowIso } from "@/lib/conversations/rows";
import { CONVERSATION_STATUSES, LOCK_MINUTES, TEMPERATURES, VERDICTS, statusFrom, temperatureFrom, verdictFrom } from "@/lib/conversations/vocabulary";

type DB = DatabaseType.Database;

export interface ConversationFilters {
  /** 'unread' and 'mine' are about the member asking. */
  view?: "all" | "unread" | "mine";
  verdict?: string[];
  status?: string[];
  temperature?: string[];
  /** Member ids, and 'none' for nobody. */
  assignee?: string[];
  sla?: "overdue" | "today" | null;
  tag?: string | null;
  channel?: "email" | "linkedin" | null;
  /** A campaign (workflow) the contact was in. */
  campaign?: string | null;
  q?: string | null;
  sort?: "newest" | "oldest" | "due";
  /** One conversation by id (for reading a single row in the list's shape). */
  id?: string | null;
}

export interface ConversationItem {
  id: string;
  target_id: string | null;
  /** Its contact was deleted; `name` is then the address it came from. */
  detached: boolean;
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  linkedin_url: string | null;
  intent_score: number | null;
  status: string;
  snoozed_until: string | null;
  temperature: string | null;
  verdict: string | null;
  assignee: { id: string; name: string; email: string } | null;
  sla_due_at: string | null;
  overdue: boolean;
  /** A teammate answering right now. */
  lock: { user_id: string; name: string; at: string } | null;
  unread: boolean;
  last_message_at: string | null;
  last_message_direction: "in" | "out" | null;
  last_message_channel: "email" | "linkedin" | null;
  last_message_preview: string | null;
  last_reply_id: string | null;
  tags: Array<{ id: string; name: string; color: string }>;
}

export interface ConversationFacets {
  total: number;
  unread: number;
  mine: number;
  overdue: number;
  due_today: number;
  verdict: Record<string, number>;
  status: Record<string, number>;
  temperature: Record<string, number>;
  /** Keyed by member id, with 'none' for nobody. */
  assignee: Record<string, number>;
}

const memberName = (name: string | null, email: string | null) => name?.trim() || (email ?? "").split("@")[0] || "Someone";
const list = (values: unknown): string[] => (Array.isArray(values) ? values : typeof values === "string" ? values.split(",") : []).map((value) => String(value).trim()).filter(Boolean);

/** Filters as they arrive in a query string or a saved view, with anything unknown dropped. Old status and sentiment words are read as the new ones. */
export function parseFilters(query: Record<string, unknown>): ConversationFilters {
  const one = (key: string) => (typeof query[key] === "string" && query[key] ? String(query[key]) : null);
  const view = one("view");
  const sla = one("sla");
  const sort = one("sort");
  const channel = one("channel");
  return {
    view: view === "unread" || view === "mine" ? view : "all",
    verdict: [...new Set(list(query.verdict).map(verdictFrom).filter((value): value is NonNullable<typeof value> => value !== null))],
    status: [...new Set(list(query.status).map(statusFrom).filter((value): value is NonNullable<typeof value> => value !== null))],
    temperature: [...new Set(list(query.temperature ?? query.sentiment).map(temperatureFrom).filter((value): value is NonNullable<typeof value> => value !== null))],
    assignee: list(query.assignee ?? query.assigned_to),
    sla: sla === "overdue" || sla === "today" ? sla : null,
    tag: one("tag") ?? one("tag_id"),
    channel: channel === "email" || channel === "linkedin" ? channel : null,
    campaign: one("campaign"),
    q: one("q")?.trim() || null,
    // "recent:asc" and "due:asc" are how a list screen writes its sort in the address bar.
    sort: sort === "oldest" || sort === "recent:asc" ? "oldest" : sort === "due" || sort?.startsWith("due:") ? "due" : "newest",
  };
}

type Group = "view" | "verdict" | "status" | "temperature" | "assignee" | "sla" | "other";
interface Clause { group: Group; sql: string; params: unknown[] }

function endOfToday(): string {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
}

function clausesFor(filters: ConversationFilters, userId: string | null, now: string): Clause[] {
  const clauses: Clause[] = [];
  const marks = (values: unknown[]) => values.map(() => "?").join(",");
  if (filters.view === "unread") clauses.push({ group: "view", sql: UNREAD_SQL, params: [userId ?? ""] });
  if (filters.view === "mine") clauses.push({ group: "view", sql: "c.assigned_to = ?", params: [userId ?? ""] });
  // A conversation with no verdict yet is one a person has to read: it counts as "needs review".
  if (filters.verdict?.length) clauses.push({ group: "verdict", sql: `COALESCE(c.verdict, 'human_review') IN (${marks(filters.verdict)})`, params: filters.verdict });
  if (filters.status?.length) clauses.push({ group: "status", sql: `c.status IN (${marks(filters.status)})`, params: filters.status });
  if (filters.temperature?.length) clauses.push({ group: "temperature", sql: `c.temperature IN (${marks(filters.temperature)})`, params: filters.temperature });
  if (filters.assignee?.length) {
    const members = filters.assignee.filter((value) => value !== "none").map((value) => (value === "me" ? userId ?? "" : value));
    const parts = [...(members.length ? [`c.assigned_to IN (${marks(members)})`] : []), ...(filters.assignee.includes("none") ? ["c.assigned_to IS NULL"] : [])];
    clauses.push({ group: "assignee", sql: `(${parts.join(" OR ")})`, params: members });
  }
  if (filters.sla === "overdue") clauses.push({ group: "sla", sql: "c.status = 'open' AND c.sla_due_at IS NOT NULL AND c.sla_due_at < ?", params: [now] });
  if (filters.sla === "today") clauses.push({ group: "sla", sql: "c.status = 'open' AND c.sla_due_at >= ? AND c.sla_due_at <= ?", params: [now, endOfToday()] });
  if (filters.id) clauses.push({ group: "other", sql: "c.id = ?", params: [filters.id] });
  if (filters.tag) clauses.push({ group: "other", sql: "EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.conversation_id = c.id AND ct.tag_id = ?)", params: [filters.tag] });
  if (filters.channel) {
    clauses.push({
      group: "other", params: [filters.channel],
      sql: `(EXISTS (SELECT 1 FROM email_replies er WHERE er.conversation_id = c.id AND er.channel = ?) OR ${filters.channel === "email" ? "t.email_replied_at" : "t.last_replied_at"} IS NOT NULL)`,
    });
  }
  if (filters.campaign) clauses.push({ group: "other", sql: "EXISTS (SELECT 1 FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE rp.target_id = c.target_id AND r.workflow_id = ?)", params: [filters.campaign] });
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    clauses.push({
      group: "other", params: [like, like, like, like, like],
      sql: "(t.full_name LIKE ? ESCAPE '\\' OR t.company LIKE ? ESCAPE '\\' OR t.email LIKE ? ESCAPE '\\' OR c.address LIKE ? ESCAPE '\\' OR c.last_message_preview LIKE ? ESCAPE '\\')",
    });
  }
  return clauses;
}

const FROM = "FROM conversations c LEFT JOIN targets t ON t.id = c.target_id";

function where(workspaceId: string, clauses: Clause[], without?: Group): { sql: string; params: unknown[] } {
  const kept = clauses.filter((clause) => clause.group !== without);
  return { sql: ["c.workspace_id = ?", ...kept.map((clause) => clause.sql)].join(" AND "), params: [workspaceId, ...kept.flatMap((clause) => clause.params)] };
}

/** One page of conversations, and how many match in all. */
export function listConversations(db: DB, ctx: { workspaceId: string; userId: string | null }, filters: ConversationFilters, page: { limit: number; offset: number }): { conversations: ConversationItem[]; total: number } {
  const now = nowIso();
  const scope = where(ctx.workspaceId, clausesFor(filters, ctx.userId, now));
  const order = filters.sort === "oldest" ? "c.last_message_at ASC" : filters.sort === "due" ? "c.sla_due_at IS NULL, c.sla_due_at ASC, c.last_message_at DESC" : "c.last_message_at DESC";
  const total = (db.prepare(`SELECT COUNT(*) AS c ${FROM} WHERE ${scope.sql}`).get(...scope.params) as { c: number }).c;
  const rows = db.prepare(`
    SELECT c.id, c.target_id, c.address, c.status, c.snoozed_until, c.temperature, c.verdict, c.assigned_to, c.sla_due_at, c.locked_by, c.locked_at,
      c.last_message_at, c.last_message_direction, c.last_message_channel, c.last_message_preview, c.last_reply_id,
      t.full_name, COALESCE(NULLIF(t.title, ''), t.headline) AS title, t.company, t.email, t.linkedin_url, t.intent_score,
      a.name AS assignee_name, a.email AS assignee_email, lk.name AS locker_name, lk.email AS locker_email,
      ${UNREAD_SQL} AS unread,
      COALESCE((SELECT json_group_array(json_object('id', it.id, 'name', it.name, 'color', it.color))
        FROM (SELECT tag.id, tag.name, tag.color FROM conversation_tags ct JOIN inbox_tags tag ON tag.id = ct.tag_id WHERE ct.conversation_id = c.id ORDER BY tag.name) it), '[]') AS tags_json
    ${FROM} LEFT JOIN users a ON a.id = c.assigned_to LEFT JOIN users lk ON lk.id = c.locked_by
    WHERE ${scope.sql} ORDER BY ${order}, c.id LIMIT ? OFFSET ?`).all(ctx.userId ?? "", ...scope.params, page.limit, page.offset) as Array<Record<string, unknown>>;

  const lockAfter = Date.now() - LOCK_MINUTES * 60_000;
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  const conversations = rows.map((row): ConversationItem => {
    let tags: ConversationItem["tags"] = [];
    try { tags = JSON.parse(String(row.tags_json)) as ConversationItem["tags"]; } catch { /* nothing readable: no tags */ }
    const lockedAt = Date.parse(isoOf(text(row.locked_at)) ?? "");
    const sla = text(row.sla_due_at);
    return {
      id: String(row.id), target_id: text(row.target_id), detached: row.target_id === null,
      name: text(row.full_name)?.trim() || text(row.email) || text(row.address) || "Unknown sender",
      title: text(row.title), company: text(row.company), email: text(row.email) ?? (row.target_id === null && String(row.address ?? "").includes("@") ? text(row.address) : null),
      linkedin_url: text(row.linkedin_url), intent_score: typeof row.intent_score === "number" ? row.intent_score : null,
      status: String(row.status), snoozed_until: text(row.snoozed_until), temperature: text(row.temperature), verdict: text(row.verdict),
      assignee: row.assigned_to ? { id: String(row.assigned_to), name: memberName(text(row.assignee_name), text(row.assignee_email)), email: text(row.assignee_email) ?? "" } : null,
      sla_due_at: sla, overdue: row.status === "open" && Boolean(sla) && sla! < now,
      lock: row.locked_by && Number.isFinite(lockedAt) && lockedAt > lockAfter ? { user_id: String(row.locked_by), name: memberName(text(row.locker_name), text(row.locker_email)), at: String(row.locked_at) } : null,
      unread: Boolean(row.unread),
      last_message_at: text(row.last_message_at), last_message_direction: text(row.last_message_direction) as ConversationItem["last_message_direction"],
      last_message_channel: text(row.last_message_channel) as ConversationItem["last_message_channel"], last_message_preview: text(row.last_message_preview),
      last_reply_id: text(row.last_reply_id), tags,
    };
  });
  return { conversations, total };
}

/**
 * The counts beside each filter. Each group is counted with every other group's filter
 * applied and its own left out, so picking "Positive" does not turn the other verdicts
 * to zero.
 */
export function conversationFacets(db: DB, ctx: { workspaceId: string; userId: string | null }, filters: ConversationFilters): ConversationFacets {
  const now = nowIso();
  const clauses = clausesFor(filters, ctx.userId, now);
  const grouped = (group: Group, expression: string): Record<string, number> => {
    const scope = where(ctx.workspaceId, clauses, group);
    const rows = db.prepare(`SELECT ${expression} AS key, COUNT(*) AS n ${FROM} WHERE ${scope.sql} GROUP BY 1`).all(...scope.params) as Array<{ key: string | null; n: number }>;
    return Object.fromEntries(rows.filter((row) => row.key !== null).map((row) => [String(row.key), row.n]));
  };
  const counted = (group: Group, condition: string, params: unknown[]): number => {
    const scope = where(ctx.workspaceId, clauses, group);
    return (db.prepare(`SELECT COUNT(*) AS c ${FROM} WHERE ${scope.sql} AND ${condition}`).get(...scope.params, ...params) as { c: number }).c;
  };
  const fill = (keys: readonly string[], counts: Record<string, number>) => Object.fromEntries(keys.map((key) => [key, counts[key] ?? 0]));
  const all = where(ctx.workspaceId, clauses, "view");
  return {
    total: (db.prepare(`SELECT COUNT(*) AS c ${FROM} WHERE ${all.sql}`).get(...all.params) as { c: number }).c,
    unread: counted("view", UNREAD_SQL, [ctx.userId ?? ""]),
    mine: counted("view", "c.assigned_to = ?", [ctx.userId ?? ""]),
    overdue: counted("sla", "c.status = 'open' AND c.sla_due_at IS NOT NULL AND c.sla_due_at < ?", [now]),
    due_today: counted("sla", "c.status = 'open' AND c.sla_due_at >= ? AND c.sla_due_at <= ?", [now, endOfToday()]),
    verdict: fill(VERDICTS, grouped("verdict", "COALESCE(c.verdict, 'human_review')")),
    status: fill(CONVERSATION_STATUSES, grouped("status", "c.status")),
    temperature: fill(TEMPERATURES, grouped("temperature", "c.temperature")),
    assignee: grouped("assignee", "COALESCE(c.assigned_to, 'none')"),
  };
}
