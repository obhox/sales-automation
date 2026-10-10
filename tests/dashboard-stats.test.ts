// The dashboard's "Profiles visited" card showed the number of connection requests, and
// its totals never included a visit count to show instead.
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import stats from "@/pages/api/dashboard/stats";
import { ctxHeaders } from "./helpers/ctx";

const WS = "ws-dash-1";
const OTHER = "ws-dash-2";
const WORKFLOW = "wf-dash-1";
const RUN = "run-dash-1";

function totals(query: Record<string, string> = {}): Record<string, number> {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  stats({ method: "GET", query, headers: ctxHeaders(WS) } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  expect(res.statusCode).toBe(200);
  return (res.body as { totals: Record<string, number> }).totals;
}

function log(runId: string, targetId: string, message: string) {
  getDb().prepare("INSERT INTO logs (id, run_id, target_id, message) VALUES (?, ?, ?, ?)").run(randomUUID(), runId, targetId, message);
}

beforeAll(() => {
  const db = getDb();
  for (const ws of [WS, OTHER]) db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db.prepare("INSERT INTO workflows (id, workspace_id, name) VALUES (?, ?, 'Campaign')").run(WORKFLOW, WS);
  db.prepare("INSERT INTO runs (id, workflow_id, workspace_id, status) VALUES (?, ?, ?, 'running')").run(RUN, WORKFLOW, WS);
  // Another workspace's campaign, running and visiting: none of it belongs on this dashboard.
  db.prepare("INSERT INTO workflows (id, workspace_id, name) VALUES ('wf-dash-2', ?, 'Theirs')").run(OTHER);
  db.prepare("INSERT INTO runs (id, workflow_id, workspace_id, status) VALUES ('run-dash-2', 'wf-dash-2', ?, 'running')").run(OTHER);

  for (const [id, ws] of [["dash-a", WS], ["dash-b", WS], ["dash-c", WS], ["dash-x", OTHER]]) {
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, ?, ?)").run(id, ws, id, `https://www.linkedin.com/in/${id}/`);
  }
  for (const id of ["dash-a", "dash-b", "dash-c"]) db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`rp-${id}`, RUN, id);

  // Three profiles visited (one of them twice), one invited.
  log(RUN, "dash-a", "Visited dash-a");
  log(RUN, "dash-a", "Visited dash-a");
  log(RUN, "dash-b", "Visited dash-b");
  log(RUN, "dash-c", "Visited dash-c");
  log(RUN, "dash-a", "Connection request sent to dash-a");
  log("run-dash-2", "dash-x", "Visited dash-x");
});

describe("dashboard totals", () => {
  it("count the profiles visited, each once, for this workspace only", () => {
    expect(totals().profiles_visited).toBe(3);
  });

  it("count them the same way when narrowed to one campaign", () => {
    const filtered = totals({ workflow_id: WORKFLOW });
    expect(filtered.profiles_visited).toBe(3);
    expect(filtered.connections_requested).toBe(1);
  });

  it("report this workspace's running campaigns, with or without a filter", () => {
    expect(totals().active_runs).toBe(1);
    expect(totals({ workflow_id: WORKFLOW }).active_runs).toBe(1);
  });
});
