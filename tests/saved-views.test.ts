// Saved views: who can see, make, share, change and remove a named arrangement of a list
// screen. Real (throwaway) database.
import { describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import views from "@/pages/api/platform/saved-views";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

async function call(req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await views({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

function workspace() {
  const n = ++seq;
  const ws = `ws-views-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  return {
    ws,
    manager: ctxHeaders(ws, { userId: `views-manager-${n}`, role: "manager" }),
    ada: ctxHeaders(ws, { userId: `views-ada-${n}`, role: "member" }),
    ben: ctxHeaders(ws, { userId: `views-ben-${n}`, role: "member" }),
    viewer: ctxHeaders(ws, { userId: `views-viewer-${n}`, role: "viewer" }),
    service: ctxHeaders(ws, { role: "owner" }),
  };
}

type Headers = Record<string, string>;
const create = (headers: Headers, body: Record<string, unknown>) => call({ method: "POST", headers, body: { resource: "contacts", name: "Hot leads", state: { intent: "60" }, ...body } });
const list = async (headers: Headers, resource = "contacts") => ((await call({ method: "GET", headers, query: { resource } })).body.views ?? []) as Array<Record<string, unknown>>;
const names = async (headers: Headers, resource?: string) => (await list(headers, resource)).map(view => view.name);

describe("a personal view", () => {
  it("is kept with its state and shown only to the member who made it", async () => {
    const w = workspace();
    const made = await create(w.ada, { state: { intent: "60", sort: "intent:desc", q: "revops" } });
    expect(made.statusCode).toBe(201);
    expect(made.body).toMatchObject({ name: "Hot leads", resource: "contacts", shared: false, editable: true, state: { intent: "60", sort: "intent:desc", q: "revops" } });

    expect(await names(w.ada)).toEqual(["Hot leads"]);
    expect(await names(w.ben)).toEqual([]);
    expect(await names(w.manager)).toEqual([]);
  });

  it("belongs to one screen", async () => {
    const w = workspace();
    await create(w.ada, {});
    expect(await names(w.ada, "inbox")).toEqual([]);
    expect(await names(w.ada, "contacts")).toEqual(["Hot leads"]);
  });

  it("cannot be read, changed or removed by another member", async () => {
    const w = workspace();
    const id = (await create(w.ada, {})).body.id;
    expect((await call({ method: "PATCH", headers: w.ben, body: { id, name: "Mine now" } })).statusCode).toBe(404);
    expect((await call({ method: "DELETE", headers: w.ben, query: { id: String(id) } })).statusCode).toBe(404);
    // Not even by a manager: a personal view is the member's own.
    expect((await call({ method: "PATCH", headers: w.manager, body: { id, name: "Mine now" } })).statusCode).toBe(404);
    expect(await names(w.ada)).toEqual(["Hot leads"]);
  });

  it("can be renamed, updated and removed by its owner", async () => {
    const w = workspace();
    const id = (await create(w.ada, {})).body.id;
    const changed = await call({ method: "PATCH", headers: w.ada, body: { id, name: "Warm leads", state: { intent: "40" } } });
    expect(changed.body).toMatchObject({ name: "Warm leads", state: { intent: "40" } });
    expect((await call({ method: "DELETE", headers: w.ada, query: { id: String(id) } })).statusCode).toBe(200);
    expect(await names(w.ada)).toEqual([]);
  });

  it("may reuse a name another member already uses, but not one of the member's own", async () => {
    const w = workspace();
    expect((await create(w.ada, {})).statusCode).toBe(201);
    expect((await create(w.ben, {})).statusCode).toBe(201);
    const again = await create(w.ada, { name: "hot LEADS" });
    expect(again.statusCode).toBe(409);
  });
});

describe("a shared view", () => {
  it("is seen by everyone in the workspace, listed ahead of personal ones", async () => {
    const w = workspace();
    await create(w.ada, { name: "Ada's own" });
    const shared = await create(w.manager, { name: "Team: unassigned positive", shared: true });
    expect(shared.body).toMatchObject({ shared: true, editable: true });

    expect(await names(w.ada)).toEqual(["Team: unassigned positive", "Ada's own"]);
    expect(await names(w.viewer)).toEqual(["Team: unassigned positive"]);
    // A member sees it but may not change it.
    expect((await list(w.ada))[0]).toMatchObject({ shared: true, editable: false });
  });

  it("can only be made, changed or removed by a manager or above", async () => {
    const w = workspace();
    expect((await create(w.ada, { shared: true })).statusCode).toBe(403);
    const id = (await create(w.manager, { shared: true })).body.id;
    expect((await call({ method: "PATCH", headers: w.ada, body: { id, name: "Renamed" } })).statusCode).toBe(403);
    expect((await call({ method: "DELETE", headers: w.ada, query: { id: String(id) } })).statusCode).toBe(403);
    expect((await call({ method: "PATCH", headers: w.manager, body: { id, name: "Renamed" } })).body).toMatchObject({ name: "Renamed" });
  });

  it("a member cannot turn their own view into a shared one", async () => {
    const w = workspace();
    const id = (await create(w.ada, {})).body.id;
    expect((await call({ method: "PATCH", headers: w.ada, body: { id, shared: true } })).statusCode).toBe(403);
    expect((await list(w.ben)).length).toBe(0);
  });

  it("goes to the manager who un-shares it, so it is never left without an owner", async () => {
    const w = workspace();
    const id = (await create(w.manager, { shared: true })).body.id;
    const personal = await call({ method: "PATCH", headers: w.manager, body: { id, shared: false } });
    expect(personal.body).toMatchObject({ shared: false, editable: true });
    expect(await names(w.ada)).toEqual([]);
    expect(await names(w.manager)).toEqual(["Hot leads"]);
  });
});

describe("limits", () => {
  it("a viewer keeps no views", async () => {
    const w = workspace();
    expect((await create(w.viewer, {})).statusCode).toBe(403);
  });

  it("a view needs a person: an internal call is refused", async () => {
    const w = workspace();
    expect((await create(w.service, {})).statusCode).toBe(403);
    expect((await call({ method: "GET", headers: w.service, query: { resource: "contacts" } })).statusCode).toBe(403);
  });

  it("never crosses workspaces", async () => {
    const a = workspace();
    const b = workspace();
    const id = (await create(a.manager, { shared: true })).body.id;
    expect(await names(b.manager)).toEqual([]);
    expect((await call({ method: "PATCH", headers: b.manager, body: { id, name: "Taken" } })).statusCode).toBe(404);
    expect((await call({ method: "DELETE", headers: b.manager, query: { id: String(id) } })).statusCode).toBe(404);
    expect(await names(a.ada)).toEqual(["Hot leads"]);
  });

  it("refuses a screen it does not know, a missing or long name, and state that is not a small object", async () => {
    const w = workspace();
    expect((await create(w.ada, { resource: "workflows" })).statusCode).toBe(400);
    expect((await call({ method: "GET", headers: w.ada, query: { resource: "users" } })).statusCode).toBe(400);
    expect((await create(w.ada, { name: "   " })).statusCode).toBe(400);
    expect((await create(w.ada, { name: "x".repeat(61) })).statusCode).toBe(400);
    expect((await create(w.ada, { state: ["a"] })).statusCode).toBe(400);
    expect((await create(w.ada, { state: "status=open" })).statusCode).toBe(400);
    expect((await create(w.ada, { state: { blob: "x".repeat(9000) } })).statusCode).toBe(400);
    expect(await names(w.ada)).toEqual([]);
  });

  it("is removed with the member who owned it", async () => {
    const w = workspace();
    await create(w.ada, {});
    db().prepare("DELETE FROM users WHERE id LIKE 'views-ada-%' AND id IN (SELECT user_id FROM workspace_members WHERE workspace_id = ?)").run(w.ws);
    expect((db().prepare("SELECT COUNT(*) AS c FROM saved_views WHERE workspace_id = ?").get(w.ws) as { c: number }).c).toBe(0);
  });
});
