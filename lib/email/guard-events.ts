import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";

// One log of what the guards around a mailbox did, and of what changed underneath it.
//
// Before this the same facts were scattered: an auto-pause was a line in domain_events, a
// daily limit was a sentence in each campaign's run log, a DNS change was not recorded at
// all. They are written here as they happen, in words, so the Deliverability screen reads
// one table.

type DB = DatabaseType.Database;

export const GUARD_EVENT_KINDS = ["auto_pause", "disconnected", "reconnected", "daily_limit", "dns_change", "warmup_cycle", "complaint", "placement_test"] as const;
export type GuardEventKind = (typeof GUARD_EVENT_KINDS)[number];

export type GuardEventTone = "bad" | "warn" | "good" | "mail" | "neutral";

export interface GuardEventInput {
  workspaceId: string;
  kind: GuardEventKind;
  title: string;
  detail?: string;
  tone?: GuardEventTone;
  emailAccountId?: string | null;
  domain?: string | null;
  data?: Record<string, unknown>;
  /** Something that stays true for a while is logged once: a second event with the same key is dropped. */
  dedupeKey?: string;
  /** SQLite's own format, UTC. Default: now. */
  occurredAt?: string;
}

/** Record an event. Never throws: failing to log must not undo what happened. Returns the id, or null for a duplicate. */
export function recordGuardEvent(input: GuardEventInput, db: DB = getDb()): string | null {
  try {
    const id = randomUUID();
    const result = db.prepare(`INSERT OR IGNORE INTO mailbox_guard_events (id, workspace_id, email_account_id, domain, kind, tone, title, detail, data_json, dedupe_key, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`).run(
      id, input.workspaceId, input.emailAccountId ?? null, input.domain ?? null, input.kind, input.tone ?? "neutral",
      input.title.slice(0, 200), input.detail?.slice(0, 600) ?? null, input.data ? JSON.stringify(input.data) : null, input.dedupeKey ?? null, input.occurredAt ?? null,
    );
    return result.changes ? id : null;
  } catch (error) {
    console.warn("[guard-events] could not record an event:", error instanceof Error ? error.message : error);
    return null;
  }
}

export interface GuardEvent {
  id: string;
  kind: GuardEventKind;
  tone: GuardEventTone;
  title: string;
  detail: string | null;
  email_account_id: string | null;
  domain: string | null;
  occurred_at: string;
}

export interface GuardEventQuery {
  /** Only events about this domain or a mailbox on it. */
  domain?: string | null;
  kind?: GuardEventKind | null;
  /** Only events from the last so many hours. */
  hours?: number | null;
  limit?: number;
  offset?: number;
}

/** A workspace's events, newest first, with how many there are in all for the same filter. */
export function listGuardEvents(db: DB, workspaceId: string, query: GuardEventQuery = {}): { events: GuardEvent[]; total: number } {
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (query.domain) { where.push("domain = ?"); params.push(query.domain); }
  if (query.kind) { where.push("kind = ?"); params.push(query.kind); }
  if (query.hours) { where.push("occurred_at >= datetime('now', ?)"); params.push(`-${Math.max(1, Math.round(query.hours))} hours`); }
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const sql = `FROM mailbox_guard_events WHERE ${where.join(" AND ")}`;
  return {
    events: db.prepare(`SELECT id, kind, tone, title, detail, email_account_id, domain, occurred_at ${sql} ORDER BY occurred_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as GuardEvent[],
    total: (db.prepare(`SELECT COUNT(*) AS c ${sql}`).get(...params) as { c: number }).c,
  };
}

/** Events older than this are dropped when a new one is written by the daily summary. */
export const KEEP_GUARD_EVENTS_DAYS = 180;

export function pruneGuardEvents(db: DB = getDb()): number {
  return db.prepare("DELETE FROM mailbox_guard_events WHERE occurred_at < datetime('now', ?)").run(`-${KEEP_GUARD_EVENTS_DAYS} days`).changes;
}
