// The pipeline board's route: moving an opportunity between stages, what that does to its
// closed date and who is told, and reshaping the stages themselves. Real (throwaway)
// database; nothing is sent.
import { describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import pipeline from "@/pages/api/platform/pipeline";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

async function call(req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await pipeline({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

/** A workspace with four stages (two open, won, lost), a contact, a company and a member of each kind. */
function workspace() {
  const n = ++seq;
  const ws = `ws-pipe-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const stage = (suffix: string, position: number, probability: number, won = 0, lost = 0) => {
    const id = `${ws}-${suffix}`;
    db().prepare("INSERT INTO pipeline_stages (id, workspace_id, name, position, probability, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, ws, suffix, position, probability, won, lost);
    return id;
  };
  const w = {
    ws, fresh: stage("new", 0, 10), meeting: stage("meeting", 1, 50), won: stage("won", 2, 100, 1), lost: stage("lost", 3, 0, 0, 1),
    target: `pipe-target-${n}`, company: `pipe-company-${n}`,
    member: ctxHeaders(ws, { userId: `pipe-member-${n}`, role: "member" }),
    manager: ctxHeaders(ws, { userId: `pipe-manager-${n}`, role: "manager" }),
    viewer: ctxHeaders(ws, { userId: `pipe-viewer-${n}`, role: "viewer" }),
    memberId: `pipe-member-${n}`,
  };
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, 'Lee Lead', ?)").run(w.target, ws, `https://www.linkedin.com/in/pipe-lead-${n}/`);
  db().prepare("INSERT INTO companies (id, workspace_id, name) VALUES (?, ?, 'Acme')").run(w.company, ws);
  return w;
}

type W = ReturnType<typeof workspace>;
const create = async (w: W, body: Record<string, unknown> = {}) => (await call({ method: "POST", headers: w.member, body: { name: "Acme annual", stage_id: w.fresh, amount: 1200, ...body } })).body as { id: string; closed_at: string | null; owner_id: string | null };
const patch = (w: W, body: Record<string, unknown>, headers = w.member) => call({ method: "PATCH", headers, body });
const stored = (id: string) => db().prepare("SELECT stage_id, closed_at, amount, target_id, company_id, owner_id FROM opportunities WHERE id = ?").get(id) as { stage_id: string | null; closed_at: string | null; amount: number | null; target_id: string | null; company_id: string | null; owner_id: string | null } | undefined;
const stageEvents = (id: string) => (db().prepare("SELECT payload_json FROM domain_events WHERE type = 'opportunity.stage_changed' AND entity_id = ? ORDER BY rowid").all(id) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json));

describe("moving an opportunity", () => {
  it("stamps a closed date on reaching a won stage and clears it on going back", async () => {
    const w = workspace();
    const o = await create(w);
    expect(o.closed_at).toBeNull();

    await patch(w, { id: o.id, stage_id: w.won });
    expect(stored(o.id)?.closed_at).toBeTruthy();

    await patch(w, { id: o.id, stage_id: w.meeting });
    expect(stored(o.id)).toMatchObject({ stage_id: w.meeting, closed_at: null });
  });

  it("tells subscribers where it went from and to, once per move", async () => {
    const w = workspace();
    const o = await create(w);
    await patch(w, { id: o.id, stage_id: w.meeting });
    await patch(w, { id: o.id, stage_id: w.meeting });   // already there
    await patch(w, { id: o.id, amount: 5000 });          // not a move
    await patch(w, { id: o.id, stage_id: w.lost });

    const events = stageEvents(o.id);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ from_stage: "new", to_stage: "meeting", is_won: false, is_lost: false, target_id: null });
    expect(events[1]).toMatchObject({ from_stage_id: w.meeting, to_stage_id: w.lost, is_lost: true, amount: 5000 });
  });

  it("is closed from the start when it is created in a won stage, with no move announced", async () => {
    const w = workspace();
    const o = await create(w, { stage_id: w.won });
    expect(o.closed_at).toBeTruthy();
    expect(stageEvents(o.id)).toHaveLength(0);
  });

  it("refuses a stage from another workspace and leaves it where it was", async () => {
    const w = workspace();
    const other = workspace();
    const o = await create(w);
    const res = await patch(w, { id: o.id, stage_id: other.meeting });
    expect(res.statusCode).toBe(400);
    expect(stored(o.id)?.stage_id).toBe(w.fresh);
  });

  it("cannot be done to another workspace's opportunity", async () => {
    const w = workspace();
    const other = workspace();
    const o = await create(w);
    const res = await patch(other, { id: o.id, stage_id: other.meeting });
    expect(res.statusCode).toBe(404);
    expect(stored(o.id)?.stage_id).toBe(w.fresh);
  });

  it("is not open to a viewer", async () => {
    const w = workspace();
    const o = await create(w);
    expect((await patch(w, { id: o.id, stage_id: w.meeting }, w.viewer)).statusCode).toBe(403);
  });
});

describe("editing an opportunity", () => {
  it("belongs to whoever made it unless an owner is named", async () => {
    const w = workspace();
    expect((await create(w)).owner_id).toBe(w.memberId);
  });

  it("links and unlinks a contact and a company of this workspace", async () => {
    const w = workspace();
    const o = await create(w);
    await patch(w, { id: o.id, target_id: w.target, company_id: w.company });
    expect(stored(o.id)).toMatchObject({ target_id: w.target, company_id: w.company });
    await patch(w, { id: o.id, target_id: null, owner_id: null });
    expect(stored(o.id)).toMatchObject({ target_id: null, company_id: w.company, owner_id: null });
  });

  it("refuses a contact from another workspace", async () => {
    const w = workspace();
    const other = workspace();
    const o = await create(w);
    expect((await patch(w, { id: o.id, target_id: other.target })).statusCode).toBe(400);
    expect((await call({ method: "POST", headers: w.member, body: { name: "x", company_id: other.company } })).statusCode).toBe(400);
  });

  it("can have its amount cleared, which is not the same as zero", async () => {
    const w = workspace();
    const o = await create(w);
    await patch(w, { id: o.id, amount: null });
    expect(stored(o.id)?.amount).toBeNull();
  });

  it.each([
    [{ amount: -5 }], [{ amount: "lots" }], [{ currency: "dollars" }], [{ expected_close_date: "next week" }], [{ expected_close_date: "2026-13-45" }], [{ name: "  " }],
  ])("refuses %j", async (change) => {
    const w = workspace();
    const o = await create(w);
    expect((await patch(w, { id: o.id, ...change })).statusCode).toBe(400);
    expect(stored(o.id)?.amount).toBe(1200);
  });

  it("is deleted by a member, leaving a meeting that pointed at it", async () => {
    const w = workspace();
    const o = await create(w);
    db().prepare("INSERT INTO meetings (id, workspace_id, opportunity_id, title, starts_at) VALUES (?, ?, ?, 'Intro', datetime('now'))").run(`meet-${o.id}`, w.ws, o.id);
    expect((await call({ method: "DELETE", headers: w.viewer, query: { id: o.id } })).statusCode).toBe(403);
    expect((await call({ method: "DELETE", headers: w.member, query: { id: o.id } })).statusCode).toBe(204);
    expect(stored(o.id)).toBeUndefined();
    expect(db().prepare("SELECT opportunity_id FROM meetings WHERE id = ?").get(`meet-${o.id}`)).toEqual({ opportunity_id: null });
    expect((await call({ method: "DELETE", headers: w.member, query: { id: o.id } })).statusCode).toBe(404);
  });
});

describe("the stages", () => {
  const stageRow = (id: string) => db().prepare("SELECT name, position, probability, is_won, is_lost FROM pipeline_stages WHERE id = ?").get(id) as { name: string; position: number; probability: number; is_won: number; is_lost: number } | undefined;

  it("are a manager's to change, not a member's", async () => {
    const w = workspace();
    expect((await patch(w, { entity: "stage", id: w.fresh, name: "Lead" })).statusCode).toBe(403);
    expect((await call({ method: "POST", headers: w.member, body: { entity: "stage", name: "Demo" } })).statusCode).toBe(403);
    expect((await call({ method: "DELETE", headers: w.member, query: { stage_id: w.fresh } })).statusCode).toBe(403);
    expect((await patch(w, { entity: "stage", id: w.fresh, name: "Lead", probability: 20 }, w.manager)).statusCode).toBe(200);
    expect(stageRow(w.fresh)).toMatchObject({ name: "Lead", probability: 20 });
  });

  it("go at the end when added", async () => {
    const w = workspace();
    const res = await call({ method: "POST", headers: w.manager, body: { entity: "stage", name: "Demo", probability: 40 } });
    expect(stageRow(String(res.body.id))).toMatchObject({ position: 4, probability: 40 });
  });

  it("cannot be both won and lost, or have a chance outside 0 to 100", async () => {
    const w = workspace();
    expect((await patch(w, { entity: "stage", id: w.won, is_lost: true }, w.manager)).statusCode).toBe(400);
    expect((await patch(w, { entity: "stage", id: w.fresh, probability: 140 }, w.manager)).statusCode).toBe(400);
    expect(stageRow(w.won)).toMatchObject({ is_won: 1, is_lost: 0 });
  });

  it("close the opportunities in them when marked won, and reopen them when unmarked", async () => {
    const w = workspace();
    const o = await create(w, { stage_id: w.meeting });
    await patch(w, { entity: "stage", id: w.meeting, is_won: true }, w.manager);
    expect(stored(o.id)?.closed_at).toBeTruthy();
    await patch(w, { entity: "stage", id: w.meeting, is_won: false }, w.manager);
    expect(stored(o.id)?.closed_at).toBeNull();
  });

  it("are put in the order given, which must name each of them once", async () => {
    const w = workspace();
    const order = [w.meeting, w.fresh, w.lost, w.won];
    expect((await patch(w, { entity: "stage_order", ids: order }, w.manager)).statusCode).toBe(200);
    const read = await call({ method: "GET", headers: w.viewer });
    expect((read.body.stages as Array<{ id: string }>).map((stage) => stage.id)).toEqual(order);

    const other = workspace();
    for (const ids of [[w.meeting, w.fresh], [w.meeting, w.meeting, w.lost, w.won], [w.meeting, w.fresh, w.lost, other.won]]) {
      expect((await patch(w, { entity: "stage_order", ids }, w.manager)).statusCode).toBe(400);
    }
  });

  it("are not deleted while holding opportunities unless told where those go", async () => {
    const w = workspace();
    const o = await create(w, { stage_id: w.meeting });
    const refused = await call({ method: "DELETE", headers: w.manager, query: { stage_id: w.meeting } });
    expect(refused.statusCode).toBe(409);
    expect(refused.body.opportunity_count).toBe(1);
    expect(stageRow(w.meeting)).toBeDefined();

    const other = workspace();
    expect((await call({ method: "DELETE", headers: w.manager, query: { stage_id: w.meeting, move_to: other.fresh } })).statusCode).toBe(400);
    expect((await call({ method: "DELETE", headers: w.manager, query: { stage_id: w.meeting, move_to: w.meeting } })).statusCode).toBe(400);

    const done = await call({ method: "DELETE", headers: w.manager, query: { stage_id: w.meeting, move_to: w.lost } });
    expect(done.body).toMatchObject({ ok: true, moved: 1 });
    expect(stageRow(w.meeting)).toBeUndefined();
    expect(stored(o.id)?.stage_id).toBe(w.lost);
    expect(stored(o.id)?.closed_at).toBeTruthy();
    expect(stageEvents(o.id).at(-1)).toMatchObject({ from_stage_id: w.meeting, to_stage: "lost", is_lost: true });
  });

  it("are deleted outright when empty", async () => {
    const w = workspace();
    expect((await call({ method: "DELETE", headers: w.manager, query: { stage_id: w.meeting } })).statusCode).toBe(200);
    expect(stageRow(w.meeting)).toBeUndefined();
  });
});

describe("reading the board", () => {
  it("lists only this workspace's stages, opportunities and members", async () => {
    const w = workspace();
    const other = workspace();
    await create(w);
    await create(other, { name: "Theirs" });
    const read = await call({ method: "GET", headers: w.viewer });
    expect((read.body.opportunities as Array<{ name: string }>).map((row) => row.name)).toEqual(["Acme annual"]);
    expect((read.body.stages as unknown[]).length).toBe(4);
    const emails = (read.body.members as Array<{ email: string }>).map((row) => row.email);
    expect(emails.length).toBe(3);
    expect(emails.every((email) => email.startsWith("pipe-") && !email.includes(other.memberId))).toBe(true);
  });
});

describe("a move made through the public API", () => {
  it("closes the opportunity and announces the move like one made on the board", async () => {
    const { createApiKey } = await import("@/lib/api-keys");
    const { default: v1 } = await import("@/pages/api/v1/[...path]");
    const w = workspace();
    const o = await create(w);
    const key = createApiKey({ workspaceId: w.ws, name: "crm", scopes: ["crm:read", "crm:write"] }).key;
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    res.end = () => res;
    res.setHeader = () => res;
    await v1({ method: "PATCH", query: { path: ["opportunities", o.id] }, headers: { authorization: `Bearer ${key}` }, body: { stage_id: w.won }, socket: { remoteAddress: "127.0.0.1" } } as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(200);
    expect(stored(o.id)).toMatchObject({ stage_id: w.won });
    expect(stored(o.id)?.closed_at).toBeTruthy();
    expect(stageEvents(o.id)).toHaveLength(1);
    expect(stageEvents(o.id)[0]).toMatchObject({ from_stage: "new", to_stage: "won", is_won: true });
  });
});
