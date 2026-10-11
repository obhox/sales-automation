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

describe("dashboard totals for a named period", () => {
  const send = (ws: string, workflow: string, run: string, target: string, action: string, at: string) =>
    getDb().prepare("INSERT INTO step_sends (id, workspace_id, run_id, workflow_id, target_id, channel, action, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), ws, run, workflow, target, action === "email" ? "email" : "linkedin", action, at);

  beforeAll(() => {
    const db = getDb();
    // dash-a: first reached in August, still being worked in September.
    send(WS, WORKFLOW, RUN, "dash-a", "visit", "2026-08-10 09:00:00");
    send(WS, WORKFLOW, RUN, "dash-a", "connect", "2026-09-05 09:00:00");
    // dash-b: first reached in September, invited, accepted, messaged, replied in October.
    send(WS, WORKFLOW, RUN, "dash-b", "visit", "2026-09-02 09:00:00");
    send(WS, WORKFLOW, RUN, "dash-b", "connect", "2026-09-03 09:00:00");
    send(WS, WORKFLOW, RUN, "dash-b", "message", "2026-09-20 09:00:00");
    send(WS, WORKFLOW, RUN, "dash-b", "message", "2026-09-25 09:00:00");
    db.prepare("UPDATE targets SET connected_at = '2026-09-10 09:00:00', last_replied_at = '2026-10-02 09:00:00' WHERE id = 'dash-b'").run();
    // dash-c: first reached in September by email, through a second campaign.
    db.prepare("INSERT INTO workflows (id, workspace_id, name) VALUES ('wf-dash-3', ?, 'Email only')").run(WS);
    db.prepare("INSERT INTO runs (id, workflow_id, workspace_id, status) VALUES ('run-dash-3', 'wf-dash-3', ?, 'completed')").run(WS);
    send(WS, "wf-dash-3", "run-dash-3", "dash-c", "email", "2026-09-15 09:00:00");
    // Another workspace, same month.
    send(OTHER, "wf-dash-2", "run-dash-2", "dash-x", "visit", "2026-09-04 09:00:00");
    db.prepare("INSERT INTO logs (id, run_id, target_id, message, created_at) VALUES (?, ?, 'dash-b', 'Message sent to dash-b', '2026-09-20 09:00:00')").run(randomUUID(), RUN);
  });

  const september = { from: "2026-09-01", to: "2026-09-30" };

  it("follow the contacts first reached in it, whenever they answered", () => {
    expect(totals(september)).toMatchObject({
      total_targets: 2,           // dash-b and dash-c; dash-a was first reached in August
      profiles_visited: 1, connections_requested: 1, connected: 1,
      messages_sent: 1,           // one contact messaged, twice
      replies_received: 1,        // the reply came in October and still counts for September's contacts
      emails_sent: 1, email_replies: 0,
    });
  });

  it("can be narrowed to one campaign, and never include another workspace", () => {
    expect(totals({ ...september, workflow_id: WORKFLOW })).toMatchObject({ total_targets: 1, emails_sent: 0, messages_sent: 1 });
    expect(totals({ ...september, workflow_id: "wf-dash-3" })).toMatchObject({ total_targets: 1, emails_sent: 1, messages_sent: 0 });
    expect(totals({ from: "2026-08-01", to: "2026-08-31" })).toMatchObject({ total_targets: 1, profiles_visited: 1, connections_requested: 1 });
  });

  it("chart each day of the period, and refuse a range that makes no sense", () => {
    const call = (query: Record<string, string>) => {
      const res: Record<string, unknown> = { statusCode: 200, body: undefined };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (payload: unknown) => { res.body = payload; return res; };
      res.end = () => res;
      stats({ method: "GET", query, headers: ctxHeaders(WS) } as unknown as NextApiRequest, res as unknown as NextApiResponse);
      return res as unknown as { statusCode: number; body: { activity: Array<{ day: string; messages: number }>; range?: { explicit: boolean } } };
    };
    const period = call(september);
    expect(period.body.activity).toHaveLength(30);
    expect(period.body.activity.filter((day) => day.messages > 0)).toEqual([expect.objectContaining({ day: "2026-09-20", messages: 1 })]);
    expect(period.body.range).toMatchObject({ explicit: true });
    expect(call({ from: "2026-09-30", to: "2026-09-01" }).statusCode).toBe(400);
    // Asked for nothing new, it answers as it always has.
    expect(call({}).body.range).toBeUndefined();
    expect(call({}).body.activity).toHaveLength(7);
  });
});
