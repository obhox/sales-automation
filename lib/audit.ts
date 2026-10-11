// Reading a workspace's audit log: filtered, a page at a time, with the name of what each
// entry is about, and kept for twelve months. Writing an entry is recordAudit() in
// lib/workspace.ts; this file must not import that one.
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

export const AUDIT_SOURCES = ["web", "api", "mcp"] as const;
/** How a change was made: in the app, with an API key, or by an MCP client. */
export type AuditSource = (typeof AUDIT_SOURCES)[number];
export const isAuditSource = (value: unknown): value is AuditSource => typeof value === "string" && (AUDIT_SOURCES as readonly string[]).includes(value);

/** Entries older than this are deleted. */
export const AUDIT_KEEP_MONTHS = 12;

/** Delete entries past their keep, in every workspace. Returns how many went. */
export function pruneAuditLog(db: DB): number {
  return db.prepare(`DELETE FROM audit_logs WHERE created_at < datetime('now', '-${AUDIT_KEEP_MONTHS} months')`).run().changes;
}

const DAY_MS = 86_400_000;
let lastPruned = 0;

/** Prune at most once a day per process. Called as entries are written, so it needs no schedule of its own. */
export function pruneAuditLogIfDue(db: DB, now: number = Date.now()): void {
  if (now - lastPruned < DAY_MS) return;
  lastPruned = now;
  try {
    pruneAuditLog(db);
  } catch (error) {
    console.warn("[audit] could not prune old entries:", error instanceof Error ? error.message : error);
  }
}

export interface AuditFilter {
  source?: AuditSource | null;
  /** Text to find in the action, the person, the key or client, the address or the entity's id. */
  q?: string | null;
  userId?: string | null;
  /** "2026-10-01": entries from the start of that day (UTC). */
  from?: string | null;
  /** "2026-10-31": entries up to the end of that day (UTC). */
  to?: string | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  /** The name of what the entry is about, when it still exists. */
  entity_label: string | null;
  metadata: Record<string, unknown> | null;
  source: AuditSource | null;
  via: string | null;
  ip_address: string | null;
  created_at: string;
  /** Who did it. Null when it was not a person (an API key). */
  actor: { id: string; name: string; email: string } | null;
}

interface AuditRow {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata_json: string | null;
  ip_address: string | null;
  source: string | null;
  via: string | null;
  created_at: string;
  user_email: string | null;
  user_name: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

function where(workspaceId: string, filter: AuditFilter): { sql: string; params: unknown[] } {
  const parts = ["al.workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (filter.source) {
    parts.push("al.source = ?");
    params.push(filter.source);
  }
  if (filter.userId) {
    parts.push("al.user_id = ?");
    params.push(filter.userId);
  }
  if (filter.from && DATE.test(filter.from)) {
    parts.push("al.created_at >= ?");
    params.push(`${filter.from} 00:00:00`);
  }
  if (filter.to && DATE.test(filter.to)) {
    parts.push("al.created_at <= ?");
    params.push(`${filter.to} 23:59:59`);
  }
  const q = filter.q?.trim().slice(0, 80);
  if (q) {
    const like = contains(q);
    // A search for "paused campaign" should find "workflow.paused" no less than one for "workflow.paused".
    const asAction = contains(q.toLowerCase().replace(/\s+/g, "_"));
    parts.push(`(al.action LIKE ? ESCAPE '\\' OR al.action LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR al.via LIKE ? ESCAPE '\\' OR al.ip_address LIKE ? ESCAPE '\\' OR al.entity_id LIKE ? ESCAPE '\\')`);
    params.push(like, asAction, like, like, like, like, like);
  }
  return { sql: parts.join(" AND "), params };
}

export function countAudit(db: DB, workspaceId: string, filter: AuditFilter = {}): number {
  const clause = where(workspaceId, filter);
  return (db.prepare(`SELECT COUNT(*) AS c FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id WHERE ${clause.sql}`).get(...clause.params) as { c: number }).c;
}

/** How many entries there are from each source, for the filter's counts. Entries from before sources were recorded count only towards `all`. */
export function auditSourceCounts(db: DB, workspaceId: string): Record<"all" | AuditSource, number> {
  const rows = db.prepare("SELECT source, COUNT(*) AS c FROM audit_logs WHERE workspace_id = ? GROUP BY source").all(workspaceId) as Array<{ source: string | null; c: number }>;
  const counts = { all: 0, web: 0, api: 0, mcp: 0 };
  for (const row of rows) {
    counts.all += row.c;
    if (isAuditSource(row.source)) counts[row.source] += row.c;
  }
  return counts;
}

// Where the name of each kind of thing lives. A kind not listed here has no name to show.
const LABELS: Record<string, { table: string; label: string }> = {
  workflow: { table: "workflows", label: "name" },
  list: { table: "lists", label: "name" },
  contact: { table: "targets", label: "COALESCE(NULLIF(full_name, ''), email, linkedin_url)" },
  target: { table: "targets", label: "COALESCE(NULLIF(full_name, ''), email, linkedin_url)" },
  company: { table: "companies", label: "name" },
  template: { table: "templates", label: "name" },
  account: { table: "accounts", label: "name" },
  email_account: { table: "email_accounts", label: "from_email" },
  user: { table: "users", label: "COALESCE(NULLIF(name, ''), email)" },
  api_key: { table: "api_keys", label: "name" },
  webhook: { table: "webhook_endpoints", label: "url" },
  workspace_invitation: { table: "workspace_invitations", label: "email" },
  opportunity: { table: "opportunities", label: "name" },
  todo: { table: "todos", label: "title" },
  signal_rule: { table: "signal_rules", label: "name" },
  pipeline_stage: { table: "pipeline_stages", label: "name" },
  workspace: { table: "workspaces", label: "name" },
};

function labelsFor(db: DB, rows: AuditRow[]): Map<string, string> {
  const wanted = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.entity_type || !row.entity_id) continue;
    if (!LABELS[row.entity_type] && row.entity_type !== "run") continue;
    if (!wanted.has(row.entity_type)) wanted.set(row.entity_type, new Set());
    wanted.get(row.entity_type)!.add(row.entity_id);
  }
  const labels = new Map<string, string>();
  for (const [type, ids] of wanted) {
    const list = [...ids];
    const marks = list.map(() => "?").join(", ");
    try {
      const found = type === "run"
        // A run has no name of its own: it is known by its campaign.
        ? db.prepare(`SELECT r.id AS id, w.name AS label FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id IN (${marks})`).all(...list)
        : db.prepare(`SELECT id, ${LABELS[type].label} AS label FROM ${LABELS[type].table} WHERE id IN (${marks})`).all(...list);
      for (const row of found as Array<{ id: string | number; label: string | null }>) if (row.label) labels.set(`${type}:${row.id}`, String(row.label));
    } catch {
      // A table this build does not have: the entry is shown without a name.
    }
  }
  return labels;
}

function parseMetadata(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return null;
  }
}

/** Rows exactly as they are stored, newest first, with the member's email beside them. */
export function listAuditRows(db: DB, workspaceId: string, filter: AuditFilter, limit: number): Array<Record<string, unknown>> {
  const clause = where(workspaceId, filter);
  return db.prepare(
    `SELECT al.*, u.email AS user_email FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
     WHERE ${clause.sql} ORDER BY al.created_at DESC, al.rowid DESC LIMIT ?`,
  ).all(...clause.params, limit) as Array<Record<string, unknown>>;
}

/** Entries newest first. `limit` and `offset` page through them; the order is total, so pages never overlap. */
export function listAudit(db: DB, workspaceId: string, filter: AuditFilter, limit: number, offset: number): AuditEntry[] {
  const clause = where(workspaceId, filter);
  const rows = db.prepare(
    `SELECT al.id, al.user_id, al.action, al.entity_type, al.entity_id, al.metadata_json, al.ip_address, al.source, al.via, al.created_at,
            u.email AS user_email, u.name AS user_name
     FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
     WHERE ${clause.sql} ORDER BY al.created_at DESC, al.rowid DESC LIMIT ? OFFSET ?`,
  ).all(...clause.params, limit, offset) as AuditRow[];
  const labels = labelsFor(db, rows);
  return rows.map((row) => ({
    id: row.id, action: row.action, entity_type: row.entity_type, entity_id: row.entity_id,
    entity_label: row.entity_type && row.entity_id ? labels.get(`${row.entity_type}:${row.entity_id}`) ?? null : null,
    metadata: parseMetadata(row.metadata_json),
    source: isAuditSource(row.source) ? row.source : null, via: row.via, ip_address: row.ip_address, created_at: row.created_at,
    actor: row.user_id && row.user_email ? { id: row.user_id, name: row.user_name?.trim() || row.user_email, email: row.user_email } : null,
  }));
}
