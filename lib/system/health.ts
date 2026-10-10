import type Database from "better-sqlite3";
import { runnerDisabled } from "@/lib/system/runner-switch";

// Whether the background work is running, as far as the database can tell. Each loop
// renews a lease in worker_leases at the top of every pass, so an old heartbeat means a
// loop that has stopped coming round. Nothing here belongs to a workspace: it is safe to
// show anyone who can sign in.

/** A loop whose last heartbeat is older than this is treated as stalled. The LinkedIn loop may spend eight minutes on one pass. */
export const STALLED_AFTER_MINUTES = 12;

const LOOP_LABELS: Record<string, string> = {
  "linkedin-runner": "LinkedIn runner",
  "email-jobs-runner": "Email sender",
  "email-inbox-runner": "Reply reading",
  "warmup-runner": "Warm-up",
  "verification-runner": "Email verification",
  "webhook-runner": "Webhooks",
  "imports-runner": "Imports",
  "health-runner": "Health watch",
};

export interface LoopHealth {
  name: string;
  label: string;
  /** ISO time of the last heartbeat. */
  heartbeat_at: string;
  minutes_since: number;
  stalled: boolean;
}

export type RunnerStatus = "healthy" | "degraded" | "off" | "idle";

export interface RunnerHealth {
  status: RunnerStatus;
  /** One line for the sidebar: "All runners healthy", "1 runner stalled", "Background work is off". */
  summary: string;
  loops: LoopHealth[];
}

export function loopLabel(name: string): string {
  return LOOP_LABELS[name] ?? name;
}

export function readRunnerHealth(db: Database.Database): RunnerHealth {
  if (runnerDisabled()) return { status: "off", summary: "Background work is off", loops: [] };
  const rows = db
    .prepare(
      `SELECT name, strftime('%Y-%m-%dT%H:%M:%SZ', heartbeat_at) AS heartbeat_at,
              CAST((julianday('now') - julianday(heartbeat_at)) * 1440 AS INTEGER) AS minutes_since
       FROM worker_leases ORDER BY name`,
    )
    .all() as { name: string; heartbeat_at: string; minutes_since: number }[];
  const loops = rows.map(row => ({ ...row, label: loopLabel(row.name), stalled: row.minutes_since >= STALLED_AFTER_MINUTES }));
  // The loops start with the first request that needs them, so a process that has just
  // started has no leases yet. That is not a fault.
  if (loops.length === 0) return { status: "idle", summary: "Runners not started yet", loops };
  const stalled = loops.filter(loop => loop.stalled);
  if (stalled.length === 0) return { status: "healthy", summary: "All runners healthy", loops };
  return { status: "degraded", summary: stalled.length === 1 ? `${stalled[0].label} stalled` : `${stalled.length} runners stalled`, loops };
}
