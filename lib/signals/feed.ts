// The signals a workspace has, as the Signals screen lists them: newest first, with who
// each is about, and how many nobody has looked at yet. "Seen" is signals.processed_at, the
// same column the sidebar's count reads.
import type DatabaseType from "better-sqlite3";
import { SIGNAL_TYPES } from "@/lib/platform/signal-types";

type DB = DatabaseType.Database;

export interface SignalRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  score: number;
  source: string | null;
  occurred_at: string;
  /** False until someone marks it seen. */
  seen: boolean;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
}

export interface SignalFilter {
  type?: string | null;
  source?: string | null;
  /** "new": only those nobody has seen. Anything else: all of them. */
  state?: string | null;
  q?: string | null;
}

export interface SignalFeed {
  signals: SignalRow[];
  /** How many match the filter, of which `signals` is one page. */
  total: number;
  /** Across the workspace, whatever the filter. */
  new_count: number;
  all_count: number;
  /** How many of each kind there are under the state and source chosen, for the kind filter's counts. */
  by_type: Record<string, number>;
  sources: string[];
}

const contains = (text: string) => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

function where(workspaceId: string, filter: SignalFilter, parts: { type: boolean }): { sql: string; params: unknown[] } {
  const clauses = ["s.workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (parts.type && filter.type && (SIGNAL_TYPES as readonly string[]).includes(filter.type)) {
    clauses.push("s.type = ?");
    params.push(filter.type);
  }
  if (filter.source) {
    clauses.push("COALESCE(s.source, '') = ?");
    params.push(filter.source);
  }
  if (filter.state === "new") clauses.push("s.processed_at IS NULL");
  const q = filter.q?.trim().slice(0, 80);
  if (q) {
    const like = contains(q);
    clauses.push(`(s.title LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\' OR t.full_name LIKE ? ESCAPE '\\' OR COALESCE(c.name, tc.name, t.company) LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  return { sql: clauses.join(" AND "), params };
}

// A signal about a contact is also about that contact's company.
const FROM = `FROM signals s
  LEFT JOIN targets t ON t.id = s.target_id
  LEFT JOIN companies c ON c.id = s.company_id
  LEFT JOIN companies tc ON tc.id = t.company_id`;

export function signalFeed(db: DB, workspaceId: string, filter: SignalFilter, limit: number, offset: number): SignalFeed {
  const all = where(workspaceId, filter, { type: true });
  const rows = db.prepare(
    `SELECT s.id, s.type, s.title, s.description, s.score, s.source, s.occurred_at, s.processed_at,
            t.id AS contact_id, COALESCE(NULLIF(t.full_name, ''), t.email, t.linkedin_url) AS contact_name,
            COALESCE(c.id, tc.id) AS company_id, COALESCE(c.name, tc.name) AS company_name
     ${FROM} WHERE ${all.sql} ORDER BY datetime(s.occurred_at) DESC, s.rowid DESC LIMIT ? OFFSET ?`,
  ).all(...all.params, limit, offset) as Array<{
    id: string; type: string; title: string; description: string | null; score: number; source: string | null; occurred_at: string; processed_at: string | null;
    contact_id: string | null; contact_name: string | null; company_id: string | null; company_name: string | null;
  }>;
  const total = (db.prepare(`SELECT COUNT(*) AS c ${FROM} WHERE ${all.sql}`).get(...all.params) as { c: number }).c;

  const anyType = where(workspaceId, filter, { type: false });
  const byType: Record<string, number> = {};
  for (const row of db.prepare(`SELECT s.type AS type, COUNT(*) AS c ${FROM} WHERE ${anyType.sql} GROUP BY s.type`).all(...anyType.params) as Array<{ type: string; c: number }>) byType[row.type] = row.c;

  const counts = db.prepare("SELECT COUNT(*) AS every, COALESCE(SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END), 0) AS fresh FROM signals WHERE workspace_id = ?").get(workspaceId) as { every: number; fresh: number };
  const sources = (db.prepare("SELECT DISTINCT COALESCE(source, '') AS source FROM signals WHERE workspace_id = ? ORDER BY 1").all(workspaceId) as Array<{ source: string }>).map((row) => row.source).filter(Boolean);

  return {
    signals: rows.map((row) => ({
      id: row.id, type: row.type, title: row.title, description: row.description, score: row.score, source: row.source, occurred_at: row.occurred_at,
      seen: row.processed_at !== null,
      contact: row.contact_id ? { id: row.contact_id, name: row.contact_name ?? "A contact" } : null,
      company: row.company_id && row.company_name ? { id: row.company_id, name: row.company_name } : null,
    })),
    total, new_count: counts.fresh, all_count: counts.every, by_type: byType, sources,
  };
}

/** Mark signals as seen: the ones named, or every one nobody has seen. Returns how many changed. */
export function markSignalsSeen(db: DB, workspaceId: string, ids: string[] | "all"): number {
  if (ids === "all") return db.prepare("UPDATE signals SET processed_at = datetime('now') WHERE workspace_id = ? AND processed_at IS NULL").run(workspaceId).changes;
  const list = [...new Set(ids)].slice(0, 500);
  if (list.length === 0) return 0;
  return db.prepare(`UPDATE signals SET processed_at = datetime('now') WHERE workspace_id = ? AND processed_at IS NULL AND id IN (${list.map(() => "?").join(", ")})`).run(workspaceId, ...list).changes;
}

/** Put signals back among the new ones. */
export function markSignalsNew(db: DB, workspaceId: string, ids: string[]): number {
  const list = [...new Set(ids)].slice(0, 500);
  if (list.length === 0) return 0;
  return db.prepare(`UPDATE signals SET processed_at = NULL WHERE workspace_id = ? AND id IN (${list.map(() => "?").join(", ")})`).run(workspaceId, ...list).changes;
}
