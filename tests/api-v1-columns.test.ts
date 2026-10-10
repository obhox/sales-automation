// The public API returns named fields, not whole rows. These tests keep the lists of
// fields honest: every listed column exists, every column on a published table has been
// consciously published or withheld, and a column nobody listed does not leak out.
import { beforeAll, describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/api-keys";
import { V1_COLUMNS, V1_WITHHELD, v1Select, type V1Table } from "@/lib/api/v1-columns";
import handler from "@/pages/api/v1/[...path]";

const WS = "ws-v1-columns";
const tables = Object.keys(V1_COLUMNS) as V1Table[];
const actualColumns = (table: string) => (getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name);

let key: string;

async function call(method: string, path: string[], opts: { query?: Record<string, string>; body?: unknown } = {}) {
  let statusCode = 200;
  let body: unknown;
  const res = {
    setHeader: () => res,
    status(code: number) { statusCode = code; return res; },
    json(payload: unknown) { body = payload; return res; },
  } as unknown as NextApiResponse;
  await handler({ method, headers: { authorization: `Bearer ${key}` }, query: { path, ...(opts.query ?? {}) }, body: opts.body ?? {} } as unknown as NextApiRequest, res);
  return { statusCode, body: body as Record<string, unknown> };
}

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, WS, WS);
  key = createApiKey({ workspaceId: WS, name: "columns", scopes: ["contacts:read", "contacts:write", "campaigns:read", "crm:read", "crm:write", "events:read"] }).key;
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES ('v1c-contact', ?, 'Ada Lovelace', 'ada@example.test')").run(WS);
  db.prepare("INSERT INTO workflows (id, workspace_id, name) VALUES ('v1c-wf', ?, 'Campaign')").run(WS);
  db.prepare("INSERT INTO runs (id, workspace_id, workflow_id, status) VALUES ('v1c-run', ?, 'v1c-wf', 'running')").run(WS);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES ('v1c-rp', 'v1c-run', 'v1c-contact')").run();
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES ('v1c-track', 'v1c-rp', 'email', 'pending')").run();
});

describe("the lists of published fields", () => {
  it.each(tables)("%s: every listed column exists", table => {
    const actual = new Set(actualColumns(table));
    expect(V1_COLUMNS[table].filter(column => !actual.has(column))).toEqual([]);
  });

  it.each(tables)("%s: every column is either published or deliberately withheld", table => {
    const decided = new Set<string>([...V1_COLUMNS[table], ...(V1_WITHHELD[table] ?? [])]);
    const undecided = actualColumns(table).filter(column => !decided.has(column));
    expect(undecided, `add these to V1_COLUMNS or V1_WITHHELD in lib/api/v1-columns.ts`).toEqual([]);
  });

  it.each(tables)("%s: no column is in both lists, and none is listed twice", table => {
    const published: readonly string[] = V1_COLUMNS[table];
    expect((V1_WITHHELD[table] ?? []).filter(column => published.includes(column))).toEqual([]);
    expect(new Set(published).size).toBe(published.length);
  });

  it("never publishes a credential, even from a table that has one", () => {
    const everything = tables.flatMap(table => V1_COLUMNS[table].map(column => `${table}.${column}`));
    expect(everything.filter(name => /password|secret|token|cookie|key_hash|api_key/i.test(name))).toEqual([]);
  });

  it("qualifies columns with an alias when asked", () => {
    expect(v1Select("pipeline_stages", "ps").split(", ").every(part => part.startsWith("ps."))).toBe(true);
    expect(v1Select("lists")).not.toContain(".");
  });
});

describe("what the API returns", () => {
  it("is exactly the listed fields for one record and for a page", async () => {
    const one = await call("GET", ["contacts", "v1c-contact"]);
    expect(one.statusCode).toBe(200);
    expect(Object.keys(one.body).sort()).toEqual([...V1_COLUMNS.targets].sort());

    const page = await call("GET", ["contacts"]);
    const rows = page.body.data as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual([...V1_COLUMNS.targets].sort());
  });

  it("is the listed track fields plus the contact and run for per-contact progress", async () => {
    const tracks = await call("GET", ["run_profile_tracks"], { query: { run_id: "v1c-run" } });
    const rows = tracks.body.data as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([...new Set([...V1_COLUMNS.run_profile_tracks, "target_id", "run_id"])].sort());
    expect(rows[0]).toMatchObject({ id: "v1c-track", target_id: "v1c-contact", run_id: "v1c-run", track: "email" });
  });

  it("does not grow when a column is added to a table", async () => {
    const db = getDb();
    db.exec("ALTER TABLE targets ADD COLUMN zz_internal_score TEXT");
    db.exec("ALTER TABLE opportunities ADD COLUMN zz_internal_note TEXT");
    db.prepare("UPDATE targets SET zz_internal_score = 'private' WHERE id = 'v1c-contact'").run();

    const read = await call("GET", ["contacts", "v1c-contact"]);
    expect(read.body).not.toHaveProperty("zz_internal_score");

    // Nor on the rows a write hands back.
    const patched = await call("PATCH", ["contacts", "v1c-contact"], { body: { title: "Analyst" } });
    expect(patched.body).toMatchObject({ id: "v1c-contact", title: "Analyst" });
    expect(patched.body).not.toHaveProperty("zz_internal_score");

    const created = await call("POST", ["opportunities"], { body: { name: "Pilot" } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toHaveProperty("zz_internal_note");
    expect(Object.keys(created.body).sort()).toEqual([...V1_COLUMNS.opportunities].sort());
  });
});
