// The pipeline screen's own reads and writes: tasks (and the rebuild of their table), the
// figures above the board, the opportunity a positive reply opens, the activity list,
// meetings from a calendar feed, and connecting a calendar by signing in. Real (throwaway)
// database. Every request to a calendar or a provider is answered here; none leaves.
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { decryptSecret } from "@/lib/crypto";
import { getDb, migrateDatabase } from "@/lib/db";
import { classifyAndDispatch } from "@/lib/community-replies";
import { runEffects } from "@/lib/outreach/gates";
import { pipelineSettings } from "@/lib/pipeline/settings";
import { pipelineSummary, quarterStart } from "@/lib/pipeline/summary";
import { readCalendarState, signCalendarState } from "@/lib/platform/calendar-oauth";
import { syncConnection } from "@/lib/platform/connectors";
import { createWorkspaceForUser } from "@/lib/workspace";
import activityLogs from "@/pages/api/activity-logs";
import activityRoute from "@/pages/api/pipeline/activity";
import meetingsRoute from "@/pages/api/pipeline/meetings";
import tasksRoute from "@/pages/api/pipeline/tasks";
import oauthCallback from "@/pages/api/platform/calendar-oauth/[provider]/callback";
import oauthStart from "@/pages/api/platform/calendar-oauth/[provider]/start";
import pipelineRoute from "@/pages/api/platform/pipeline";
import todoRoute from "@/pages/api/todos/[id]";
import todosRoute from "@/pages/api/todos/index";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linki-pipeline-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
interface Answer { statusCode: number; body: Record<string, unknown>; location: string | null }

async function call(handler: Handler, req: Partial<NextApiRequest>): Promise<Answer> {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined, location: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  res.redirect = (code: number, url: string) => { res.statusCode = code; res.location = url; return res; };
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as Answer;
}

let seq = 0;
/** A workspace with four stages, a company, a contact at it, and a member of each kind. */
function workspace() {
  const n = ++seq;
  const ws = `ws-ptask-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const stage = (suffix: string, position: number, probability: number, won = 0, lost = 0) => {
    const id = `${ws}-${suffix}`;
    db().prepare("INSERT INTO pipeline_stages (id, workspace_id, name, position, probability, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, ws, suffix, position, probability, won, lost);
    return id;
  };
  const w = {
    ws, n, fresh: stage("Replied", 0, 20), proposal: stage("Proposal", 1, 50), won: stage("Won", 2, 100, 1), lost: stage("Lost", 3, 0, 0, 1),
    company: `ptask-company-${n}`, target: `ptask-target-${n}`,
    memberId: `ptask-member-${n}`, managerId: `ptask-manager-${n}`, adminId: `ptask-admin-${n}`,
    member: ctxHeaders(ws, { userId: `ptask-member-${n}`, role: "member" }),
    manager: ctxHeaders(ws, { userId: `ptask-manager-${n}`, role: "manager" }),
    admin: ctxHeaders(ws, { userId: `ptask-admin-${n}`, role: "admin" }),
    viewer: ctxHeaders(ws, { userId: `ptask-viewer-${n}`, role: "viewer" }),
  };
  db().prepare("UPDATE users SET name = 'Mara Member' WHERE id = ?").run(w.memberId);
  db().prepare("INSERT INTO companies (id, workspace_id, name) VALUES (?, ?, 'Acme Freight')").run(w.company, ws);
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, title, email, company, company_id, owner_id) VALUES (?, ?, 'Lee Lead', 'VP Sales', ?, 'Acme Freight', ?, ?)")
    .run(w.target, ws, `lee${n}@acme.test`, w.company, w.memberId);
  return w;
}
type W = ReturnType<typeof workspace>;

const task = (id: string) => db().prepare("SELECT * FROM todos WHERE id = ?").get(id) as Record<string, string | number | null>;
const events = (ws: string) => db().prepare("SELECT kind, actor_id, subject, target_id, opportunity_id, detail_json FROM pipeline_events WHERE workspace_id = ? ORDER BY rowid").all(ws) as Array<Record<string, string | null>>;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// ── The table ───────────────────────────────────────────────────────────────────────────

describe("upgrading a database whose tasks all needed a contact", () => {
  const copies = (folder: string) => fs.readdirSync(folder).filter((name) => name.includes(".before-tasks-"));

  it("copies the database, keeps every task, and lets a task go without a contact", () => {
    const folder = fs.mkdtempSync(path.join(dir, "upgrade-"));
    const old = new Database(path.join(folder, "linki.db"));
    migrateDatabase(old);
    old.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-old', 'ws-old', 'ws-old')").run();
    old.prepare("INSERT INTO companies (id, workspace_id, name) VALUES ('old-co', 'ws-old', 'Acme')").run();
    old.prepare("INSERT INTO targets (id, workspace_id, full_name) VALUES ('old-t1', 'ws-old', 'Lee Lead'), ('old-t2', 'ws-old', 'Sam Second')").run();
    // The tasks table as the release before this one left it.
    old.exec(`DROP TABLE todos;
      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'done')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        description TEXT,
        workspace_id TEXT REFERENCES workspaces(id)
      );
      CREATE INDEX idx_todos_target_id ON todos(target_id);
      CREATE INDEX idx_todos_status ON todos(status);`);
    old.prepare(`INSERT INTO todos (id, target_id, title, due_date, status, created_at, description, workspace_id) VALUES
      ('old-1', 'old-t1', 'Call Lee', '2026-03-02', 'open', '2026-03-01 09:00:00', 'About the renewal', 'ws-old'),
      ('old-2', 'old-t2', 'Send the deck', NULL, 'done', '2026-02-11 15:30:00', NULL, 'ws-old')`).run();

    migrateDatabase(old);

    // The copy is the database as it was: the old table, with both tasks.
    expect(copies(folder)).toHaveLength(1);
    const copy = new Database(path.join(folder, copies(folder)[0]), { readonly: true });
    expect((copy.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get() as { sql: string }).sql).toMatch(/target_id TEXT NOT NULL/);
    expect(copy.prepare("SELECT COUNT(*) c FROM todos").get()).toEqual({ c: 2 });
    copy.close();

    // Every task is as it was, with the new columns at their defaults.
    expect(old.prepare("SELECT id, target_id, title, due_date, status, created_at, description, workspace_id, due_at, priority, assigned_to, company_id, opportunity_id, automatic, completed_at FROM todos ORDER BY id").all()).toEqual([
      { id: "old-1", target_id: "old-t1", title: "Call Lee", due_date: "2026-03-02", status: "open", created_at: "2026-03-01 09:00:00", description: "About the renewal", workspace_id: "ws-old", due_at: null, priority: "medium", assigned_to: null, company_id: null, opportunity_id: null, automatic: 0, completed_at: null },
      { id: "old-2", target_id: "old-t2", title: "Send the deck", due_date: null, status: "done", created_at: "2026-02-11 15:30:00", description: null, workspace_id: "ws-old", due_at: null, priority: "medium", assigned_to: null, company_id: null, opportunity_id: null, automatic: 0, completed_at: null },
    ]);
    const column = (name: string) => (old.prepare("SELECT name, \"notnull\" AS required FROM pragma_table_info('todos')").all() as Array<{ name: string; required: number }>).find((item) => item.name === name);
    expect(column("target_id")?.required).toBe(0);
    old.prepare("INSERT INTO todos (id, workspace_id, title, company_id) VALUES ('new-1', 'ws-old', 'Review the account', 'old-co')").run();

    // The table still holds its rules: a status it does not know is refused, a contact's tasks go with the contact.
    expect(() => old.prepare("INSERT INTO todos (id, workspace_id, title, status) VALUES ('bad', 'ws-old', 'x', 'later')").run()).toThrow(/CHECK/);
    expect(old.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(old.pragma("foreign_key_check")).toEqual([]);
    old.prepare("DELETE FROM targets WHERE id = 'old-t1'").run();
    expect((old.prepare("SELECT id FROM todos ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id)).toEqual(["new-1", "old-2"]);
    expect((old.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND name LIKE 'idx_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name))
      .toEqual(["idx_todos_opportunity", "idx_todos_status", "idx_todos_target_id", "idx_todos_workspace"]);

    // Starting again changes nothing and copies nothing.
    migrateDatabase(old);
    expect(copies(folder)).toHaveLength(1);
    expect(old.prepare("SELECT COUNT(*) c FROM todos").get()).toEqual({ c: 2 });
    old.close();
  });

  it("makes no copy when there is no task to lose", () => {
    const folder = fs.mkdtempSync(path.join(dir, "empty-"));
    const old = new Database(path.join(folder, "linki.db"));
    migrateDatabase(old);
    old.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-e', 'ws-e', 'ws-e')").run();
    old.prepare("INSERT INTO companies (id, workspace_id, name) VALUES ('e-co', 'ws-e', 'Acme')").run();
    old.exec("DROP TABLE todos; CREATE TABLE todos (id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE, title TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'done')), created_at TEXT NOT NULL DEFAULT (datetime('now')), description TEXT, workspace_id TEXT REFERENCES workspaces(id))");
    migrateDatabase(old);
    expect(copies(folder)).toEqual([]);
    expect((old.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get() as { sql: string }).sql).not.toMatch(/target_id TEXT NOT NULL/);
    old.close();
  });
});

// ── Tasks ───────────────────────────────────────────────────────────────────────────────

describe("a task", () => {
  it("can be about nothing in particular, and starts open, medium and not automatic", async () => {
    const w = workspace();
    const made = await call(todosRoute, { method: "POST", headers: w.member, body: { title: "  Tidy the pipeline  " } });
    expect(made.statusCode).toBe(201);
    expect(made.body).toMatchObject({ title: "Tidy the pipeline", target_id: null, status: "open", priority: "medium", automatic: 0, created_by: w.memberId, due_date: null, due_at: null });
    expect(events(w.ws)).toEqual([expect.objectContaining({ kind: "task_created", actor_id: w.memberId, subject: "Tidy the pipeline" })]);
  });

  it("takes a time, a priority, someone to do it, and what it is about", async () => {
    const w = workspace();
    const opportunity = (await call(pipelineRoute, { method: "POST", headers: w.member, body: { name: "Acme annual", stage_id: w.fresh, amount: 9000 } })).body.id as string;
    const made = await call(todosRoute, { method: "POST", headers: w.member, body: {
      title: "Send pricing", target_id: w.target, company_id: w.company, opportunity_id: opportunity, assigned_to: w.managerId, priority: "high",
      due_date: "2026-11-14", due_at: "2026-11-14T16:00:00+01:00",
    } });
    expect(made.statusCode).toBe(201);
    expect(made.body).toMatchObject({ target_id: w.target, company_id: w.company, opportunity_id: opportunity, assigned_to: w.managerId, priority: "high", due_date: "2026-11-14", due_at: "2026-11-14T15:00:00.000Z" });
  });

  it("is refused when what it names is not in this workspace", async () => {
    const w = workspace();
    const other = workspace();
    const post = (body: Record<string, unknown>) => call(todosRoute, { method: "POST", headers: w.member, body: { title: "x", ...body } });
    expect((await post({ target_id: other.target })).statusCode).toBe(404);
    expect(await post({ company_id: other.company })).toMatchObject({ statusCode: 400, body: { error: "Company not found" } });
    expect(await post({ assigned_to: other.memberId })).toMatchObject({ statusCode: 400, body: { error: "That person is not a member of this workspace" } });
    expect(await post({ priority: "urgent" })).toMatchObject({ statusCode: 400, body: { error: "priority must be high, medium or low" } });
    expect(await post({ due_date: "soon" })).toMatchObject({ statusCode: 400 });
    expect((await call(todosRoute, { method: "POST", headers: w.member, body: { target_id: w.target } })).statusCode).toBe(400);
    expect(db().prepare("SELECT COUNT(*) c FROM todos WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
  });

  it("notes who finished it and when, and forgets that when it is opened again", async () => {
    const w = workspace();
    const id = (await call(todosRoute, { method: "POST", headers: w.member, body: { title: "Call Lee", target_id: w.target } })).body.id as string;
    const done = await call(todoRoute, { method: "PATCH", headers: w.manager, query: { id }, body: { status: "done" } });
    expect(done.body).toMatchObject({ status: "done" });
    expect(task(id).completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events(w.ws).at(-1)).toMatchObject({ kind: "task_completed", actor_id: w.managerId, subject: "Call Lee", target_id: w.target });

    // Saying "done" again is not a second completion.
    await call(todoRoute, { method: "PATCH", headers: w.manager, query: { id }, body: { status: "done" } });
    expect(events(w.ws).filter((event) => event.kind === "task_completed")).toHaveLength(1);

    await call(todoRoute, { method: "PATCH", headers: w.member, query: { id }, body: { status: "open" } });
    expect(task(id)).toMatchObject({ status: "open", completed_at: null });
  });

  it("changes only what is sent, and a day set alone drops the time", async () => {
    const w = workspace();
    const id = (await call(todosRoute, { method: "POST", headers: w.member, body: { title: "Call Lee", description: "About renewal", priority: "high", due_date: "2026-11-14", due_at: "2026-11-14T09:00:00Z" } })).body.id as string;
    await call(todoRoute, { method: "PATCH", headers: w.member, query: { id }, body: { title: "Call Lee back" } });
    expect(task(id)).toMatchObject({ title: "Call Lee back", description: "About renewal", priority: "high", due_date: "2026-11-14", due_at: "2026-11-14T09:00:00.000Z" });
    await call(todoRoute, { method: "PATCH", headers: w.member, query: { id }, body: { due_date: "2026-11-20" } });
    expect(task(id)).toMatchObject({ due_date: "2026-11-20", due_at: null });
    expect((await call(todoRoute, { method: "PATCH", headers: w.member, query: { id }, body: { title: "  " } })).statusCode).toBe(400);
  });

  it("is not a viewer's to make, change or delete, and stays in its workspace", async () => {
    const w = workspace();
    const other = workspace();
    const id = (await call(todosRoute, { method: "POST", headers: w.member, body: { title: "Call Lee" } })).body.id as string;
    expect((await call(todosRoute, { method: "POST", headers: w.viewer, body: { title: "x" } })).statusCode).toBe(403);
    expect((await call(todoRoute, { method: "PATCH", headers: w.viewer, query: { id }, body: { status: "done" } })).statusCode).toBe(403);
    expect((await call(todoRoute, { method: "DELETE", headers: w.viewer, query: { id } })).statusCode).toBe(403);
    expect((await call(todoRoute, { method: "PATCH", headers: other.member, query: { id }, body: { status: "done" } })).statusCode).toBe(404);
    expect(task(id).status).toBe("open");
    expect((await call(todosRoute, { method: "GET", headers: w.viewer })).body).toHaveLength(1);
  });
});

describe("the task list", () => {
  async function filled() {
    const w = workspace();
    const opportunity = (await call(pipelineRoute, { method: "POST", headers: w.member, body: { name: "Acme annual", stage_id: w.fresh, company_id: w.company } })).body.id as string;
    const make = async (body: Record<string, unknown>) => (await call(todosRoute, { method: "POST", headers: w.member, body })).body.id as string;
    const ids = {
      late: await make({ title: "Chase the contract", target_id: w.target, due_date: day(-2), priority: "low", assigned_to: w.memberId }),
      soon: await make({ title: "Send pricing", opportunity_id: opportunity, due_date: day(3), priority: "high", assigned_to: w.managerId }),
      undated: await make({ title: "Tidy notes" }),
      done: await make({ title: "Book the room", due_date: day(-5), assigned_to: w.memberId }),
    };
    await call(todoRoute, { method: "PATCH", headers: w.member, query: { id: ids.done }, body: { status: "done" } });
    return { w, ids, opportunity };
  }
  const list = async (w: W, query: Record<string, string> = {}, headers = w.member) => (await call(tasksRoute, { method: "GET", headers, query })).body as {
    tasks: Array<Record<string, unknown>>; total: number; counts: Record<string, number>;
  };

  it("puts what is due soonest first, undated last, and leaves finished tasks out unless asked", async () => {
    const { w, ids } = await filled();
    const open = await list(w);
    expect(open.tasks.map((item) => item.id)).toEqual([ids.late, ids.soon, ids.undated]);
    expect(open.total).toBe(3);
    expect((await list(w, { status: "all" })).tasks.map((item) => item.id)).toEqual([ids.late, ids.soon, ids.undated, ids.done]);
    expect((await list(w, { status: "done" })).tasks.map((item) => item.id)).toEqual([ids.done]);
    // "Today" is what is open and what was finished today; a task finished before today has gone from it.
    expect((await list(w, { status: "today" })).tasks.map((item) => item.id)).toEqual([ids.late, ids.soon, ids.undated, ids.done]);
    db().prepare("UPDATE todos SET completed_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 86_400_000).toISOString(), ids.done);
    expect((await list(w, { status: "today" })).tasks.map((item) => item.id)).toEqual([ids.late, ids.soon, ids.undated]);
  });

  it("names the contact, the company, the opportunity and whoever has it", async () => {
    const { w, ids, opportunity } = await filled();
    const { tasks } = await list(w);
    expect(tasks.find((item) => item.id === ids.late)).toMatchObject({
      overdue: true, priority: "low", automatic: false,
      contact: { id: w.target, name: "Lee Lead", title: "VP Sales" }, company: { id: w.company, name: "Acme Freight" }, opportunity: null,
      assignee: { id: w.memberId, name: "Mara Member" },
    });
    // A task about an opportunity is shown with that opportunity's company.
    expect(tasks.find((item) => item.id === ids.soon)).toMatchObject({ overdue: false, contact: null, company: { id: w.company, name: "Acme Freight" }, opportunity: { id: opportunity, name: "Acme annual" } });
    expect(tasks.find((item) => item.id === ids.undated)).toMatchObject({ overdue: false, contact: null, company: null, opportunity: null, assignee: null });
  });

  it("counts what is open, overdue, mine and finished today, whatever the filter", async () => {
    const { w, ids } = await filled();
    const mine = await list(w, { assignee: "me" });
    expect(mine.tasks.map((item) => item.id)).toEqual([ids.late]);
    expect(mine.counts).toEqual({ open: 3, overdue: 1, mine: 1, completed_today: 1, done: 1 });
    expect((await list(w, { overdue: "1" })).tasks.map((item) => item.id)).toEqual([ids.late]);
    expect((await list(w, { assignee: "none" })).tasks.map((item) => item.id)).toEqual([ids.undated]);
    expect((await list(w, { assignee: w.managerId })).tasks.map((item) => item.id)).toEqual([ids.soon]);
    expect((await list(w, { priority: "high" })).tasks.map((item) => item.id)).toEqual([ids.soon]);
    expect((await list(w, { q: "acme annual" })).tasks.map((item) => item.id)).toEqual([ids.soon]);
    expect((await list(w, { q: "lee" })).tasks.map((item) => item.id)).toEqual([ids.late]);
    // A viewer reads the same list; "mine" is theirs, which is nothing.
    expect((await list(w, { assignee: "me" }, w.viewer)).tasks).toEqual([]);
  });

  it("does not call a task overdue on the day it is due, but does once its time has passed", async () => {
    const w = workspace();
    const today = (await call(todosRoute, { method: "POST", headers: w.member, body: { title: "Today, no time", due_date: day(0) } })).body.id as string;
    const earlier = (await call(todosRoute, { method: "POST", headers: w.member, body: { title: "An hour ago", due_date: day(0), due_at: new Date(Date.now() - 3_600_000).toISOString() } })).body.id as string;
    const { tasks, counts } = await list(w);
    expect(tasks.find((item) => item.id === today)?.overdue).toBe(false);
    expect(tasks.find((item) => item.id === earlier)?.overdue).toBe(true);
    expect(counts.overdue).toBe(1);
    // "Today" is the day where the member is: a task with only a day is late once that day is over there.
    const east = await list(w, { today: day(1) });
    expect(east.tasks.find((item) => item.id === today)?.overdue).toBe(true);
    expect(east.counts.overdue).toBe(2);
    expect((await list(w, { today: day(1), overdue: "1" })).tasks.map((item) => item.id).sort()).toEqual([today, earlier].sort());
    const west = await list(w, { today: day(-1) });
    expect(west.tasks.find((item) => item.id === today)?.overdue).toBe(false);
    // A task with a time is late by the clock, whatever the day is called.
    expect(west.tasks.find((item) => item.id === earlier)?.overdue).toBe(true);
  });
});

// ── The figures ─────────────────────────────────────────────────────────────────────────

describe("the pipeline's figures", () => {
  const NOW = new Date("2026-11-20T12:00:00Z");
  const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  let n = 0;
  function opportunity(w: W, fields: { stage: string; amount: number | null; created: number; closed?: number; owner?: string | null; currency?: string; source?: string }) {
    const id = `${w.ws}-opp-${++n}`;
    db().prepare(`INSERT INTO opportunities (id, workspace_id, stage_id, owner_id, name, amount, currency, source, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, w.ws, fields.stage, fields.owner ?? null, id, fields.amount, fields.currency ?? "USD", fields.source ?? "manual", at(fields.created), fields.closed === undefined ? null : at(fields.closed));
    return id;
  }

  it("says which day the quarter began", () => {
    expect(quarterStart(NOW)).toBe("2026-10-01");
    expect(quarterStart(new Date("2026-03-31T23:00:00Z"))).toBe("2026-01-01");
  });

  it("are worked out from the stages' chances, this quarter's wins, and the last twelve months", () => {
    const w = workspace();
    opportunity(w, { stage: w.fresh, amount: 10_000, created: 5, source: "reply", owner: w.memberId });   // 20% → 2,000, added this month
    opportunity(w, { stage: w.proposal, amount: 40_000, created: 60, owner: w.managerId });               // 50% → 20,000
    opportunity(w, { stage: w.proposal, amount: null, created: 2 });                                      // no amount: counted, worth nothing
    opportunity(w, { stage: w.won, amount: 30_000, created: 50, closed: 10, owner: w.memberId });         // won this quarter, 40 days
    opportunity(w, { stage: w.won, amount: 10_000, created: 100, closed: 80, owner: w.memberId });        // won last quarter, 20 days
    opportunity(w, { stage: w.won, amount: 99_000, created: 600, closed: 400 });                          // too old to count
    opportunity(w, { stage: w.lost, amount: 5_000, created: 40, closed: 20 });
    opportunity(w, { stage: w.lost, amount: 5_000, created: 90, closed: 70 });
    opportunity(w, { stage: w.fresh, amount: 7_000, created: 1, currency: "EUR" });                       // another currency: counted, not summed

    expect(pipelineSummary(db(), w.ws, { now: NOW })).toEqual({
      currency: "USD", other_currencies: 1,
      weighted_pipeline: 22_000, weighted_added_30d: 2_000,
      open_count: 4, open_from_replies: 1,
      won_quarter: 30_000, won_quarter_count: 1, quarter_start: "2026-10-01",
      average_deal_size: 20_000, sales_cycle_days: 30,
      win_rate: 0.5, closed_12m: 4,
    });
    // One member's own figures, and those of what nobody owns.
    expect(pipelineSummary(db(), w.ws, { now: NOW, ownerId: w.memberId })).toMatchObject({ weighted_pipeline: 2_000, open_count: 1, won_quarter: 30_000, win_rate: 1, closed_12m: 2 });
    expect(pipelineSummary(db(), w.ws, { now: NOW, ownerId: "none" })).toMatchObject({ open_count: 2, won_quarter: 0, win_rate: 0, closed_12m: 2 });
  });

  it("have no average, cycle or win rate before anything has closed", () => {
    const w = workspace();
    expect(pipelineSummary(db(), w.ws, { now: NOW })).toMatchObject({ currency: "USD", weighted_pipeline: 0, open_count: 0, average_deal_size: null, sales_cycle_days: null, win_rate: null, closed_12m: 0 });
  });

  it("come with the board, narrowed to an owner when one is asked for", async () => {
    const w = workspace();
    await call(pipelineRoute, { method: "POST", headers: w.member, body: { name: "Mine", stage_id: w.proposal, amount: 1000, source: "Referral" } });
    await call(pipelineRoute, { method: "POST", headers: w.manager, body: { name: "Theirs", stage_id: w.proposal, amount: 3000 } });
    await call(pipelineRoute, { method: "POST", headers: w.manager, body: { name: "Nobody's", stage_id: w.fresh, amount: 500, owner_id: null } });
    const read = async (query: Record<string, string>, headers = w.member) => (await call(pipelineRoute, { method: "GET", headers, query })).body as {
      opportunities: Array<Record<string, unknown>>; summary: Record<string, unknown>; settings: Record<string, unknown>; sources: string[];
    };
    const all = await read({});
    expect(all.opportunities).toHaveLength(3);
    expect(all.summary).toMatchObject({ weighted_pipeline: 2100, open_count: 3 });
    expect(all.opportunities.find((item) => item.name === "Mine")).toMatchObject({ source: "referral", owner_name: "Mara Member", open_task_count: 0 });
    expect(all.sources).toContain("reply");
    expect((await read({ owner: "me" })).opportunities.map((item) => item.name)).toEqual(["Mine"]);
    expect((await read({ owner: "me" })).summary).toMatchObject({ weighted_pipeline: 500, open_count: 1 });
    expect((await read({ owner: w.managerId })).opportunities.map((item) => item.name)).toEqual(["Theirs"]);
    expect((await read({ owner: "none" })).opportunities.map((item) => item.name)).toEqual(["Nobody's"]);
    expect((await call(pipelineRoute, { method: "GET", headers: w.member, query: { owner: "someone-else" } })).statusCode).toBe(400);
  });
});

// ── What a positive reply does ──────────────────────────────────────────────────────────

describe("a positive reply", () => {
  let replies = 0;
  function reply(w: W, target = w.target) {
    const id = `ptask-reply-${++replies}`;
    db().prepare("INSERT INTO email_replies (id, workspace_id, target_id, from_email, subject, body_text, received_at) VALUES (?, ?, ?, 'lee@acme.test', 'Re: hello', 'Yes, send me times.', datetime('now'))").run(id, w.ws, target);
    return id;
  }
  const opportunities = (w: W) => db().prepare("SELECT name, stage_id, source, owner_id, target_id, company_id, amount, closed_at FROM opportunities WHERE workspace_id = ? ORDER BY rowid").all(w.ws) as Array<Record<string, string | number | null>>;
  const tasks = (w: W) => db().prepare("SELECT title, priority, automatic, assigned_to, target_id, created_by, due_date FROM todos WHERE workspace_id = ? ORDER BY rowid").all(w.ws) as Array<Record<string, string | number | null>>;

  it("leaves the pipeline alone in a workspace that has not asked for an opportunity", async () => {
    const w = workspace();
    expect(pipelineSettings(w.ws)).toEqual({ auto_opportunity_on_reply: false });
    await classifyAndDispatch(reply(w), "positive");
    expect(opportunities(w)).toEqual([]);
    // The task to answer them is made either way: marked as Linki's own, high, and given to the contact's owner.
    expect(tasks(w)).toEqual([{ title: "Follow up with Lee Lead", priority: "high", automatic: 1, assigned_to: w.memberId, target_id: w.target, created_by: null, due_date: day(1) }]);
    expect(events(w.ws)).toEqual([expect.objectContaining({ kind: "task_created", actor_id: null, target_id: w.target })]);
  });

  it("opens one in the first open stage when the workspace has switched that on, and only one", async () => {
    const w = workspace();
    expect((await call(pipelineRoute, { method: "PATCH", headers: w.member, body: { entity: "settings", auto_opportunity_on_reply: true } })).statusCode).toBe(403);
    expect((await call(pipelineRoute, { method: "PATCH", headers: w.manager, body: { entity: "settings", auto_opportunity_on_reply: "yes" } })).statusCode).toBe(400);
    expect((await call(pipelineRoute, { method: "PATCH", headers: w.manager, body: { entity: "settings", auto_opportunity_on_reply: true } })).body).toEqual({ auto_opportunity_on_reply: true });

    await classifyAndDispatch(reply(w), "positive");
    expect(opportunities(w)).toEqual([{ name: "Acme Freight", stage_id: w.fresh, source: "reply", owner_id: w.memberId, target_id: w.target, company_id: w.company, amount: null, closed_at: null }]);
    expect(events(w.ws).map((event) => [event.kind, event.actor_id])).toEqual([["task_created", null], ["opportunity_created", null]]);

    // They write again while it is open: another task, no second opportunity.
    await classifyAndDispatch(reply(w), "positive");
    expect(opportunities(w)).toHaveLength(1);
    expect(tasks(w)).toHaveLength(2);

    // Once that one is closed, a later positive reply starts a new one.
    db().prepare("UPDATE opportunities SET stage_id = ? WHERE workspace_id = ?").run(w.lost, w.ws);
    await classifyAndDispatch(reply(w), "positive");
    expect(opportunities(w).map((item) => item.stage_id)).toEqual([w.lost, w.fresh]);

    // Switched off again, it stops.
    await call(pipelineRoute, { method: "PATCH", headers: w.manager, body: { entity: "settings", auto_opportunity_on_reply: false } });
    db().prepare("UPDATE opportunities SET stage_id = ? WHERE workspace_id = ?").run(w.lost, w.ws);
    await classifyAndDispatch(reply(w), "positive");
    expect(opportunities(w)).toHaveLength(2);
  });

  it("is switched on from the start in a workspace made now", () => {
    db().prepare("INSERT INTO users (id, email, password_hash) VALUES ('ptask-founder', 'founder@new.test', 'x')").run();
    const made = createWorkspaceForUser("ptask-founder", "founder@new.test");
    expect(pipelineSettings(made.workspaceId)).toEqual({ auto_opportunity_on_reply: true });
  });

  it("does not open one for any other kind of reply", async () => {
    const w = workspace();
    await call(pipelineRoute, { method: "PATCH", headers: w.manager, body: { entity: "settings", auto_opportunity_on_reply: true } });
    await classifyAndDispatch(reply(w), "negative");
    await classifyAndDispatch(reply(w), "human_review");
    expect(opportunities(w)).toEqual([]);
    // A reply that needs a person still gets its task, at ordinary priority.
    expect(tasks(w)).toEqual([expect.objectContaining({ title: "Review reply from Lee Lead", priority: "medium", automatic: 1 })]);
  });
});

describe("a task made by a campaign step", () => {
  it("is marked as Linki's own and given to the contact's owner", () => {
    const w = workspace();
    runEffects(db(), w.target, [{ type: "create_task", title: "Call {{first_name}}", description: "They accepted", due_in_days: 2 }]);
    expect(db().prepare("SELECT title, description, due_date, automatic, assigned_to, priority FROM todos WHERE workspace_id = ?").all(w.ws))
      .toEqual([{ title: expect.stringMatching(/^Call /), description: "They accepted", due_date: day(2), automatic: 1, assigned_to: w.memberId, priority: "medium" }]);
  });
});

// ── Activity ────────────────────────────────────────────────────────────────────────────

describe("the activity list", () => {
  it("tells what happened, newest first, with who did it", async () => {
    const w = workspace();
    const id = (await call(pipelineRoute, { method: "POST", headers: w.member, body: { name: "Acme annual", stage_id: w.fresh, amount: 9000, target_id: w.target, company_id: w.company } })).body.id as string;
    await call(pipelineRoute, { method: "PATCH", headers: w.manager, body: { id, stage_id: w.proposal } });
    await call(pipelineRoute, { method: "PATCH", headers: w.manager, body: { id, stage_id: w.won } });
    const note = await call(activityLogs, { method: "POST", headers: w.member, body: { target_id: w.target, type: "call", body: "Spoke for twelve minutes. Wants a quote." } });
    expect(note.statusCode).toBe(201);
    // The same moment for everything would leave the order to chance; space them out.
    const rows = db().prepare("SELECT id FROM pipeline_events WHERE workspace_id = ? ORDER BY rowid").all(w.ws) as Array<{ id: string }>;
    rows.forEach((row, index) => db().prepare("UPDATE pipeline_events SET occurred_at = ? WHERE id = ?").run(new Date(Date.now() - (10 - index) * 60_000).toISOString(), row.id));

    const read = async (query: Record<string, string> = {}, headers = w.viewer) => (await call(activityRoute, { method: "GET", headers, query })).body as { items: Array<Record<string, unknown>>; total: number };
    const all = await read();
    expect(all.total).toBe(4);
    expect(all.items.map((item) => item.kind)).toEqual(["log_call", "opportunity_won", "opportunity_moved", "opportunity_created"]);
    expect(all.items[0]).toMatchObject({ actor: { id: w.memberId, name: "Mara Member" }, body: "Spoke for twelve minutes. Wants a quote.", contact: { id: w.target, name: "Lee Lead" }, company: { id: w.company, name: "Acme Freight" } });
    expect(all.items[1]).toMatchObject({ actor: { id: w.managerId }, subject: "Acme annual", opportunity: { id, name: "Acme annual" }, detail: { from_stage: "Proposal", to_stage: "Won", amount: 9000, currency: "USD" } });
    expect(all.items[3]).toMatchObject({ actor: { id: w.memberId }, detail: { amount: 9000 } });

    expect((await read({ group: "deals" })).items).toHaveLength(3);
    expect((await read({ group: "notes" })).items.map((item) => item.kind)).toEqual(["log_call"]);
    expect((await read({ actor: w.managerId })).items.map((item) => item.kind)).toEqual(["opportunity_won", "opportunity_moved"]);
    expect((await read({ actor: "me" }, w.member)).items.map((item) => item.kind)).toEqual(["log_call", "opportunity_created"]);
    expect((await read({ opportunity_id: id, limit: "2", page: "2" })).items.map((item) => item.kind)).toEqual(["opportunity_created"]);
  });

  it("keeps the line for an opportunity that has since been deleted, and shows nothing of another workspace", async () => {
    const w = workspace();
    const other = workspace();
    const id = (await call(pipelineRoute, { method: "POST", headers: w.member, body: { name: "Short-lived", stage_id: w.fresh } })).body.id as string;
    await call(pipelineRoute, { method: "DELETE", headers: w.member, query: { id } });
    const { items } = (await call(activityRoute, { method: "GET", headers: w.viewer })).body as { items: Array<Record<string, unknown>> };
    expect(items.map((item) => [item.kind, item.subject, item.opportunity])).toEqual(expect.arrayContaining([["opportunity_deleted", "Short-lived", null], ["opportunity_created", "Short-lived", null]]));
    expect(((await call(activityRoute, { method: "GET", headers: other.viewer })).body as { total: number }).total).toBe(0);
  });
});

// ── Meetings from a calendar feed ───────────────────────────────────────────────────────

const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function feed(events: Array<{ uid: string; title: string; start: Date; minutes?: number; attendee?: string; status?: string }>) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap((event) => [
    "BEGIN:VEVENT", `UID:${event.uid}`, `SUMMARY:${event.title}`, `DTSTART:${stamp(event.start)}`,
    `DTEND:${stamp(new Date(event.start.getTime() + (event.minutes ?? 30) * 60_000))}`,
    ...(event.attendee ? [`ATTENDEE;CN=Guest:mailto:${event.attendee}`] : []), ...(event.status ? [`STATUS:${event.status}`] : []), "END:VEVENT",
  ]), "END:VCALENDAR"].join("\r\n");
}

describe("meetings read from a calendar feed", () => {
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

  async function synced() {
    const w = workspace();
    const connection = `ptask-ical-${w.n}`;
    db().prepare("INSERT INTO external_connections (id, workspace_id, provider, name, config_json) VALUES (?, ?, 'ical', 'Team calendar', ?)")
      .run(connection, w.ws, JSON.stringify({ url: "https://calendar.example.test/private-9f3c/basic.ics" }));
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requested.push(String(url));
      return new Response(feed([
        { uid: "demo", title: "Demo with Acme", start: inDays(2), minutes: 45, attendee: `LEE${w.n}@acme.test` },
        { uid: "dentist", title: "Dentist", start: inDays(1) },
        { uid: "intro", title: "Intro call", start: inDays(-6), attendee: `lee${w.n}@acme.test` },
        { uid: "off", title: "Called off", start: inDays(4), attendee: `lee${w.n}@acme.test`, status: "CANCELLED" },
      ]), { status: 200 });
    });
    expect(await syncConnection(connection, w.ws)).toEqual({ provider: "ical", meetings_imported: 4 });
    expect(requested).toEqual(["https://calendar.example.test/private-9f3c/basic.ics"]);
    return { w, connection };
  }
  const read = async (w: W, query: Record<string, string> = {}, headers = w.viewer) => (await call(meetingsRoute, { method: "GET", headers, query })).body as {
    meetings: Array<Record<string, unknown>>; total: number; counts: Record<string, number>; calendars: Array<Record<string, unknown>>; sign_in: Record<string, boolean>;
  };

  it("shows the next ones that are with a contact, and leaves a member's own appointments out", async () => {
    const { w, connection } = await synced();
    const upcoming = await read(w);
    expect(upcoming.meetings).toEqual([expect.objectContaining({
      title: "Demo with Acme", duration_minutes: 45, all_day: false, cancelled: false, attendee_count: 1,
      contact: { id: w.target, name: "Lee Lead", title: "VP Sales" }, company: { id: w.company, name: "Acme Freight" },
      calendar: { id: connection, provider: "ical", name: "Team calendar" },
    })]);
    expect(upcoming.counts).toEqual({ upcoming: 1, upcoming_unmatched: 1, past: 1 });
    expect((await read(w, { match: "unmatched" })).meetings.map((item) => item.title)).toEqual(["Dentist"]);
    expect((await read(w, { when: "past" })).meetings.map((item) => item.title)).toEqual(["Intro call"]);
    // What the campaign overview counts a meeting by is as it was: the contact, when it was first seen, and its status.
    expect(db().prepare("SELECT target_id, status, created_at IS NOT NULL AS seen FROM meetings WHERE workspace_id = ? AND external_id = 'demo'").get(w.ws)).toEqual({ target_id: w.target, status: null, seen: 1 });
    // Only the meetings with a contact are written into the activity list.
    expect(events(w.ws).map((event) => [event.kind, event.subject])).toEqual([["meeting_booked", "Demo with Acme"], ["meeting_booked", "Intro call"]]);
  });

  it("lists the calendar without giving away the feed's private address", async () => {
    const { w, connection } = await synced();
    const { calendars, sign_in } = await read(w);
    expect(calendars).toEqual([expect.objectContaining({ id: connection, provider: "ical", name: "Team calendar", host: "calendar.example.test", signed_in: false, enabled: true, sync_error: null, meeting_count: 4 })]);
    expect(JSON.stringify(calendars)).not.toContain("private-9f3c");
    expect(sign_in).toEqual({ google_calendar: false, microsoft_calendar: false });
  });

  it("lets a member say who an unmatched meeting is with, and keeps that through the next read", async () => {
    const { w, connection } = await synced();
    const dentist = (await read(w, { match: "unmatched" })).meetings[0].id as string;
    expect((await call(meetingsRoute, { method: "PATCH", headers: w.viewer, body: { id: dentist, target_id: w.target } })).statusCode).toBe(403);
    expect((await call(meetingsRoute, { method: "PATCH", headers: w.member, body: { id: dentist, target_id: "nobody" } })).statusCode).toBe(404);
    expect((await call(meetingsRoute, { method: "PATCH", headers: w.member, body: { id: dentist, target_id: w.target } })).statusCode).toBe(200);
    expect((await read(w)).meetings.map((item) => item.title)).toEqual(["Dentist", "Demo with Acme"]);
    await syncConnection(connection, w.ws);
    expect((await read(w)).counts).toEqual({ upcoming: 2, upcoming_unmatched: 0, past: 1 });
  });

  it("keeps the reason on the calendar when the feed cannot be read", async () => {
    const { w, connection } = await synced();
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
    await expect(syncConnection(connection, w.ws)).rejects.toThrow("iCal 404");
    expect((await read(w)).calendars[0]).toMatchObject({ sync_error: "iCal 404", meeting_count: 4 });
  });
});

// ── Connecting a calendar by signing in ─────────────────────────────────────────────────

describe("connecting a Google or Microsoft calendar by signing in", () => {
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
  const start = (w: W, provider: string, headers = w.admin) => call(oauthStart, { method: "GET", headers: { ...headers, host: "linki.test" }, query: { provider } });
  const callback = (w: W, provider: string, query: Record<string, string>, headers = w.admin) => call(oauthCallback, { method: "GET", headers: { ...headers, host: "linki.test" }, query: { provider, ...query } });
  const outcome = (answer: Answer) => Object.fromEntries(new URL(answer.location!, "http://x").searchParams);
  const connections = (w: W) => db().prepare("SELECT * FROM external_connections WHERE workspace_id = ?").all(w.ws) as Array<Record<string, string | number | null>>;

  it("says the server is not set up for it, rather than sending anyone anywhere", async () => {
    const w = workspace();
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_MAIL_CLIENT_ID", "");
    const answer = await start(w, "google_calendar");
    expect(answer.statusCode).toBe(302);
    expect(answer.location).toMatch(/^\/pipeline\?/);
    expect(outcome(answer)).toMatchObject({ view: "meetings", calendars: "1", calendar_error: "not_set_up", provider: "google_calendar" });
    expect((await start(w, "hubspot")).statusCode).toBe(404);
  });

  it("is an admin's to do", async () => {
    const w = workspace();
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_SECRET", "client-secret");
    expect((await start(w, "google_calendar", w.member)).statusCode).toBe(403);
    expect((await start(w, "google_calendar", w.manager)).statusCode).toBe(403);
  });

  it("sends the member to the provider with a state only they can bring back", async () => {
    const w = workspace();
    vi.stubEnv("NEXTAUTH_URL", "https://linki.test");
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_SECRET", "client-secret");
    const answer = await start(w, "google_calendar");
    const url = new URL(answer.location!);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-id", response_type: "code", access_type: "offline", prompt: "consent",
      redirect_uri: "https://linki.test/api/platform/calendar-oauth/google_calendar/callback",
      scope: "openid email https://www.googleapis.com/auth/calendar.events.readonly",
    });
    expect(answer.location).not.toContain("client-secret");
    const state = url.searchParams.get("state")!;
    expect(readCalendarState(state)).toEqual({ workspaceId: w.ws, userId: w.adminId, provider: "google_calendar" });
    // Changed, or left too long, it is nothing.
    expect(readCalendarState(`${state.slice(0, -2)}xx`)).toBeNull();
    expect(readCalendarState(state.replace(/^[^.]+/, Buffer.from(JSON.stringify({ w: "other", u: w.adminId, p: "google_calendar", e: Date.now() + 60_000 })).toString("base64url")))).toBeNull();
    expect(readCalendarState(state, Date.now() + 11 * 60_000)).toBeNull();

    // Microsoft is the same sign-in with its own address and scope, and falls back to the mail app's registration.
    vi.stubEnv("MICROSOFT_MAIL_CLIENT_ID", "ms-id");
    vi.stubEnv("MICROSOFT_MAIL_CLIENT_SECRET", "ms-secret");
    const microsoft = new URL((await start(w, "microsoft_calendar")).location!);
    expect(`${microsoft.origin}${microsoft.pathname}`).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(Object.fromEntries(microsoft.searchParams)).toMatchObject({ client_id: "ms-id", scope: "openid profile email offline_access Calendars.Read", redirect_uri: "https://linki.test/api/platform/calendar-oauth/microsoft_calendar/callback" });
  });

  it("keeps the tokens it is given, encrypted, and reads the calendar", async () => {
    const w = workspace();
    vi.stubEnv("NEXTAUTH_URL", "https://linki.test");
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_SECRET", "client-secret");
    const sent: Array<{ url: string; body: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? ""), authorization: new Headers(init?.headers).get("authorization") });
      if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, id_token: idToken("Jordan@Example.test") });
      return Response.json({ items: [{ id: "g1", summary: "Pricing call", start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() }, end: { dateTime: new Date(Date.now() + 86_400_000 + 1_800_000).toISOString() }, attendees: [{ email: `lee${w.n}@acme.test` }] }], nextSyncToken: "s1" });
    });
    const state = signCalendarState({ workspaceId: w.ws, userId: w.adminId, provider: "google_calendar" });

    const answer = await callback(w, "google_calendar", { state, code: "the-code" });
    expect(outcome(answer)).toMatchObject({ calendar: "connected", provider: "google_calendar", view: "meetings" });
    const exchange = new URLSearchParams(sent[0].body);
    expect(Object.fromEntries(exchange)).toEqual({ client_id: "client-id", client_secret: "client-secret", grant_type: "authorization_code", code: "the-code", redirect_uri: "https://linki.test/api/platform/calendar-oauth/google_calendar/callback" });

    const [row] = connections(w);
    expect(row).toMatchObject({ provider: "google_calendar", name: "Google Calendar (jordan@example.test)", auth_method: "oauth", account_email: "jordan@example.test", created_by: w.adminId, enabled: 1 });
    expect(row.secret_value).not.toContain("access-1");
    expect(row.refresh_token).not.toContain("refresh-1");
    expect(decryptSecret(String(row.secret_value))).toBe("access-1");
    expect(decryptSecret(String(row.refresh_token))).toBe("refresh-1");
    expect(answer.location).not.toMatch(/access-1|refresh-1|the-code/);

    // The first read is started without keeping the member waiting; give it a moment.
    await vi.waitFor(() => expect(db().prepare("SELECT COUNT(*) c FROM meetings WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 1 }));
    expect(sent.at(-1)).toMatchObject({ authorization: "Bearer access-1" });
    expect(sent.at(-1)!.url).toMatch(/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?/);

    // Signing in to the same account again renews that connection; it does not make a second.
    await callback(w, "google_calendar", { state: signCalendarState({ workspaceId: w.ws, userId: w.adminId, provider: "google_calendar" }), code: "again" });
    expect(connections(w)).toHaveLength(1);
  });

  it("gets a new token when the one it has has run out, and uses that", async () => {
    const w = workspace();
    vi.stubEnv("MICROSOFT_CALENDAR_CLIENT_ID", "ms-id");
    vi.stubEnv("MICROSOFT_CALENDAR_CLIENT_SECRET", "ms-secret");
    const sent: Array<{ url: string; body: string; authorization: string | null }> = [];
    let refreshes = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? ""), authorization: new Headers(init?.headers).get("authorization") });
      if (String(url).includes("/oauth2/v2.0/token")) {
        refreshes += 1;
        return String(init?.body).includes("authorization_code")
          ? Response.json({ access_token: "ms-access-1", refresh_token: "ms-refresh-1", expires_in: 3600, id_token: idToken("jordan@contoso.test") })
          : Response.json({ access_token: "ms-access-2", expires_in: 3600 });
      }
      return Response.json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d1" });
    });
    await callback(w, "microsoft_calendar", { state: signCalendarState({ workspaceId: w.ws, userId: w.adminId, provider: "microsoft_calendar" }), code: "c" });
    const [row] = connections(w);
    await vi.waitFor(() => expect(db().prepare("SELECT last_synced_at FROM external_connections WHERE id = ?").get(row.id)).not.toEqual({ last_synced_at: null }));

    // In date: read with the token it has, and ask the provider for nothing else.
    sent.length = 0;
    await syncConnection(String(row.id), w.ws);
    expect(sent.map((request) => request.authorization)).toEqual(["Bearer ms-access-1"]);

    // Out of date: a new one first.
    db().prepare("UPDATE external_connections SET token_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), row.id);
    sent.length = 0;
    await syncConnection(String(row.id), w.ws);
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "ms-refresh-1", client_id: "ms-id", client_secret: "ms-secret" });
    expect(sent[1].authorization).toBe("Bearer ms-access-2");
    const after = connections(w)[0];
    expect(decryptSecret(String(after.secret_value))).toBe("ms-access-2");
    // The provider sent no new refresh token, so the one it has is kept.
    expect(decryptSecret(String(after.refresh_token))).toBe("ms-refresh-1");
    expect(Date.parse(String(after.token_expires_at))).toBeGreaterThan(Date.now());
    expect(refreshes).toBe(2);

    // When the provider will not renew it, the calendar says it needs signing in to again.
    db().prepare("UPDATE external_connections SET token_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), row.id);
    vi.stubGlobal("fetch", async () => Response.json({ error: "invalid_grant", error_description: "The refresh token has expired." }, { status: 400 }));
    await expect(syncConnection(String(row.id), w.ws)).rejects.toThrow("Microsoft Calendar did not accept the sign-in: The refresh token has expired.");
    expect(connections(w)[0].sync_error).toBe("Microsoft Calendar did not accept the sign-in: The refresh token has expired.");
  });

  it("does not use a token that was pasted in as if it could be renewed", async () => {
    const w = workspace();
    db().prepare("INSERT INTO external_connections (id, workspace_id, provider, name, config_json, secret_value) VALUES (?, ?, 'google_calendar', 'Pasted', '{}', 'pasted-token')").run(`ptask-pasted-${w.n}`, w.ws);
    const sent: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => { sent.push(new Headers(init?.headers).get("authorization")); return Response.json({ items: [] }); });
    await syncConnection(`ptask-pasted-${w.n}`, w.ws);
    expect(sent).toEqual(["Bearer pasted-token"]);
  });

  it("connects nothing when the member says no, the state is not theirs, or the provider refuses the code", async () => {
    const w = workspace();
    const other = workspace();
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_SECRET", "client-secret");
    const fetched = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    vi.stubGlobal("fetch", fetched);
    const mine = signCalendarState({ workspaceId: w.ws, userId: w.adminId, provider: "google_calendar" });

    expect(outcome(await callback(w, "google_calendar", { error: "access_denied", state: mine }))).toMatchObject({ calendar_error: "declined" });
    expect(outcome(await callback(w, "google_calendar", { code: "c", state: "not-a-state" }))).toMatchObject({ calendar_error: "expired" });
    // A state made for another member, another workspace, or another provider.
    expect(outcome(await callback(w, "google_calendar", { code: "c", state: signCalendarState({ workspaceId: w.ws, userId: w.managerId, provider: "google_calendar" }) }))).toMatchObject({ calendar_error: "expired" });
    expect(outcome(await callback(w, "google_calendar", { code: "c", state: signCalendarState({ workspaceId: other.ws, userId: w.adminId, provider: "google_calendar" }) }))).toMatchObject({ calendar_error: "expired" });
    expect(outcome(await callback(w, "google_calendar", { code: "c", state: signCalendarState({ workspaceId: w.ws, userId: w.adminId, provider: "microsoft_calendar" }) }))).toMatchObject({ calendar_error: "expired" });
    expect(fetched).not.toHaveBeenCalled();
    expect((await callback(w, "google_calendar", { code: "c", state: mine }, w.member)).statusCode).toBe(403);

    expect(outcome(await callback(w, "google_calendar", { code: "bad", state: mine }))).toMatchObject({ calendar_error: "exchange" });
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(connections(w)).toEqual([]);
  });
});
