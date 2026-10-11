// What has happened in the pipeline, newest first: what was written down as it happened
// (pipeline_events: a deal made or moved, a task made or finished, a meeting found in a
// calendar) beside the notes and calls people have logged on a contact (activity_logs).
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

export const ACTIVITY_GROUPS = ["deals", "tasks", "meetings", "notes"] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];
export const isActivityGroup = (value: unknown): value is ActivityGroup => (ACTIVITY_GROUPS as readonly unknown[]).includes(value);

const GROUP_KINDS: Record<ActivityGroup, string[]> = {
  deals: ["opportunity_created", "opportunity_moved", "opportunity_won", "opportunity_lost", "opportunity_deleted"],
  tasks: ["task_created", "task_completed"],
  meetings: ["meeting_booked", "log_meeting"],
  notes: ["log_note", "log_call", "log_email", "log_other"],
};

export interface ActivityItem {
  id: string;
  /** A pipeline event's kind, or `log_` and the kind of a logged note (log_call, log_note …). */
  kind: string;
  at: string;
  /** Who did it. Null for what Linki did by itself. */
  actor: { id: string; name: string } | null;
  /** What it was about, in words: the opportunity's or task's name. Empty for a logged note. */
  subject: string;
  /** The text of a logged note or call. */
  body: string | null;
  detail: Record<string, unknown> | null;
  contact: { id: string; name: string } | null;
  company: { id: string | null; name: string } | null;
  opportunity: { id: string; name: string } | null;
}

export interface ActivityFilters {
  group?: ActivityGroup | null;
  /** A member id; 'me' is resolved by the caller. */
  actor?: string | null;
  target_id?: string | null;
  opportunity_id?: string | null;
}

// Both tables' times as one sortable form (activity_logs keeps "2026-10-01 09:30:00", events an ISO instant).
const ISO = (column: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`;

const FEED = `(
  SELECT 'e:' || pe.id AS id, pe.kind AS kind, ${ISO("pe.occurred_at")} AS at, pe.actor_id AS actor_id, pe.subject AS subject, NULL AS body,
    pe.detail_json AS detail_json, pe.target_id AS target_id, pe.company_id AS company_id, pe.opportunity_id AS opportunity_id
  FROM pipeline_events pe WHERE pe.workspace_id = ?
  UNION ALL
  SELECT 'l:' || al.id, 'log_' || al.type, COALESCE(${ISO("al.logged_at")}, ${ISO("al.created_at")}), al.created_by, '', al.body, NULL, al.target_id, NULL, NULL
  FROM activity_logs al WHERE al.workspace_id = ?
) x`;

export function listActivity(db: DB, workspaceId: string, filters: ActivityFilters, page: { limit: number; offset: number }): { items: ActivityItem[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [workspaceId, workspaceId];
  if (filters.group) { where.push(`x.kind IN (${GROUP_KINDS[filters.group].map(() => "?").join(",")})`); params.push(...GROUP_KINDS[filters.group]); }
  if (filters.actor) { where.push("x.actor_id = ?"); params.push(filters.actor); }
  if (filters.target_id) { where.push("x.target_id = ?"); params.push(filters.target_id); }
  if (filters.opportunity_id) { where.push("x.opportunity_id = ?"); params.push(filters.opportunity_id); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${FEED} ${clause}`).get(...params) as { c: number }).c;
  const rows = db.prepare(`SELECT x.*, u.name AS actor_name, u.email AS actor_email,
      COALESCE(NULLIF(t.full_name, ''), t.email) AS contact_name, c.id AS shown_company_id, COALESCE(c.name, t.company) AS company_name, o.name AS opportunity_name
    FROM ${FEED}
    LEFT JOIN users u ON u.id = x.actor_id
    LEFT JOIN targets t ON t.id = x.target_id
    LEFT JOIN opportunities o ON o.id = x.opportunity_id
    LEFT JOIN companies c ON c.id = COALESCE(x.company_id, o.company_id, t.company_id)
    ${clause} ORDER BY x.at DESC, x.id DESC LIMIT ? OFFSET ?`).all(...params, page.limit, page.offset) as Array<Record<string, string | null>>;
  return {
    total,
    items: rows.map((row): ActivityItem => {
      let detail: Record<string, unknown> | null = null;
      if (row.detail_json) {
        try { const value: unknown = JSON.parse(row.detail_json); if (value && typeof value === "object" && !Array.isArray(value)) detail = value as Record<string, unknown>; } catch { /* a detail that cannot be read is left out */ }
      }
      return {
        id: String(row.id), kind: String(row.kind), at: String(row.at), subject: row.subject ?? "", body: row.body, detail,
        // A member who has since been removed still did it; they are shown without a name to link to.
        actor: row.actor_id ? { id: row.actor_id, name: row.actor_name?.trim() || (row.actor_email ?? "").split("@")[0] || "A former member" } : null,
        contact: row.target_id && row.contact_name ? { id: row.target_id, name: row.contact_name } : null,
        company: row.company_name ? { id: row.shown_company_id, name: row.company_name } : null,
        opportunity: row.opportunity_id && row.opportunity_name ? { id: row.opportunity_id, name: row.opportunity_name } : null,
      };
    }),
  };
}
