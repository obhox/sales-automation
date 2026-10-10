// How this instance is doing, for a workspace's admins: the background loops (from
// lib/system/health.ts), what this workspace has waiting for each, the database's size
// and how long the process has been up. The loops and the database belong to the whole
// instance; every count here is of this workspace's own rows.
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { readRunnerHealth, type LoopHealth, type RunnerStatus } from "@/lib/system/health";

export interface InstanceLoop extends LoopHealth {
  /** How much of this workspace's work is waiting for the loop. Null: the loop has no queue to count. */
  waiting: number | null;
  /** What `waiting` counts: "queued", "waiting", "running". */
  waiting_noun: string | null;
}

export interface InstanceHealth {
  status: RunnerStatus;
  summary: string;
  version: string;
  node: string;
  uptime_seconds: number;
  database: { bytes: number; /** Free space on the volume the database is on. Null when the system does not say. */ free_bytes: number | null };
  loops: InstanceLoop[];
}

// What each loop works through, counted for one workspace.
const QUEUES: Record<string, { sql: string; noun: string }> = {
  "email-jobs-runner": { sql: "SELECT COUNT(*) AS c FROM email_jobs WHERE workspace_id = ? AND status IN ('pending','leased','sending')", noun: "queued" },
  "webhook-runner": { sql: "SELECT COUNT(*) AS c FROM webhook_deliveries WHERE workspace_id = ? AND status IN ('pending','retrying')", noun: "waiting" },
  "linkedin-runner": { sql: "SELECT COUNT(*) AS c FROM runs WHERE workspace_id = ? AND status = 'running'", noun: "running" },
};

function count(db: Database.Database, sql: string, workspaceId: string): number | null {
  try {
    return (db.prepare(sql).get(workspaceId) as { c: number }).c;
  } catch {
    return null;
  }
}

function databaseSize(db: Database.Database): number {
  try {
    const pages = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    const size = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    return pages * size;
  } catch {
    return 0;
  }
}

function freeSpace(db: Database.Database): number | null {
  try {
    const file = db.name && db.name !== ":memory:" ? db.name : null;
    if (!file) return null;
    const stats = fs.statfsSync(path.dirname(path.resolve(file)));
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function readInstanceHealth(db: Database.Database, workspaceId: string): InstanceHealth {
  const runners = readRunnerHealth(db);
  return {
    status: runners.status,
    summary: runners.summary,
    version: process.env.APP_VERSION ?? "dev",
    node: process.version,
    uptime_seconds: Math.round(process.uptime()),
    database: { bytes: databaseSize(db), free_bytes: freeSpace(db) },
    loops: runners.loops.map((loop) => {
      const queue = QUEUES[loop.name];
      return { ...loop, waiting: queue ? count(db, queue.sql, workspaceId) : null, waiting_noun: queue?.noun ?? null };
    }),
  };
}
