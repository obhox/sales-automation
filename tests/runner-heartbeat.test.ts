import { describe, it, expect, beforeAll } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import runsHandler from "@/pages/api/runs";

/**
 * The runner stamps runner_pid + last_tick_at at the very top of every tick, before any
 * network I/O. That makes a wedged loop detectable: a run that says `running` while its
 * heartbeat has gone quiet is stuck, not idle. These tests cover the surfacing end of that
 * contract — the migration, the derived flag, and the API shape callers rely on.
 */

const WS = "ws-heartbeat-1";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

const listReq = {
  method: "GET",
  query: {},
  headers: { "x-workspace-id": WS, "x-user-id": "user-1", "x-workspace-role": "admin" },
} as unknown as NextApiRequest;

type RunRow = { id: string; runner_stale: number; last_tick_at: string | null };

let seq = 0;
/** A run in `status` whose last heartbeat was `tickAgo` (SQLite modifier), or never. */
function seedRun(status: string, tickAgo: string | null) {
  const db = getDb();
  const n = ++seq;
  const runId = `hb-run-${n}`;
  db.prepare("INSERT INTO runs (id, status, workspace_id) VALUES (?, ?, ?)").run(runId, status, WS);
  if (tickAgo !== null) {
    db.prepare("UPDATE runs SET last_tick_at = datetime('now', ?) WHERE id = ?").run(tickAgo, runId);
  }
  return runId;
}

async function fetchRuns(): Promise<RunRow[]> {
  const res = mockRes();
  await runsHandler(listReq, res);
  expect(res.statusCode).toBe(200);
  return res.body as RunRow[];
}

beforeAll(() => {
  getDb().prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)")
    .run(WS, "Heartbeat WS", "heartbeat-ws");
});

describe("runs.last_tick_at migration", () => {
  it("exists on the runs table", () => {
    const cols = getDb().prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("last_tick_at");
  });
});

describe("runner staleness flag", () => {
  it("flags a running run whose heartbeat has gone quiet", async () => {
    // The production signature: status 'running', but the tick that drives it stopped.
    const runId = seedRun("running", "-2 hours");
    const run = (await fetchRuns()).find((r) => r.id === runId)!;
    expect(run.runner_stale).toBe(1);
  });

  it("flags a running run that has never been ticked", async () => {
    // Exactly the observed state: resumed, reported running, never picked up.
    const runId = seedRun("running", null);
    const run = (await fetchRuns()).find((r) => r.id === runId)!;
    expect(run.last_tick_at).toBeNull();
    expect(run.runner_stale).toBe(1);
  });

  it("does not flag a run beating within the poll interval", async () => {
    // The runner polls every 30s, so a recent stamp is healthy — no false alarms.
    const runId = seedRun("running", "-20 seconds");
    const run = (await fetchRuns()).find((r) => r.id === runId)!;
    expect(run.runner_stale).toBe(0);
  });

  it("never flags a run that is not running", async () => {
    // A paused or completed run is SUPPOSED to have a quiet heartbeat.
    for (const status of ["paused", "completed", "failed"]) {
      const runId = seedRun(status, "-2 days");
      const run = (await fetchRuns()).find((r) => r.id === runId)!;
      expect(run.runner_stale, `${status} must not be flagged`).toBe(0);
    }
  });
});
