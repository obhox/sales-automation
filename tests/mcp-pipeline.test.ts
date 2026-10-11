// The MCP tools for tasks and the pipeline: what they accepted before still reaches the
// same routes in the same shape, and the new arguments reach the new ones. The routes are
// tested in pipeline.test.ts and pipeline-tasks.test.ts; here the app's own API is stubbed
// and only the calls are read.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createLinkiMcpServer } from "@/lib/mcp/server";

const ORIGIN = "http://linki.test";
type Call = { method: string; path: string; query: Record<string, string>; body: unknown };
const calls: Call[] = [];
const realFetch = globalThis.fetch;

async function connect(scopes: string[]) {
  const auth = { token: "t", clientId: "c", scopes, extra: { workspaceId: "ws-mcp-pipe", userId: "user-mcp-pipe", workspaceRole: "owner" } } as AuthInfo;
  const client = new Client({ name: "test", version: "1.0.0" });
  const [mine, theirs] = InMemoryTransport.createLinkedPair();
  await Promise.all([createLinkiMcpServer({ origin: ORIGIN, auth }).connect(theirs), client.connect(mine)]);
  return async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text?: string }> };
    return { failed: Boolean(result.isError), text: result.content.map((part) => part.text ?? "").join("") };
  };
}

let all: Awaited<ReturnType<typeof connect>>;
let readOnly: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== ORIGIN) return new Response("{}", { status: 200 });
    calls.push({ method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  all = await connect(["mcp:read", "mcp:write", "mcp:execute"]);
  readOnly = await connect(["mcp:read"]);
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls.length = 0; });

describe("todos_list and todo_manage", () => {
  it("still take what they took before tasks grew", async () => {
    await all("todos_list", {});
    await all("todos_list", { status: "open" });
    await all("todo_manage", { action: "create", contact_id: "t1", title: "Call Lee", description: "About renewal", due_date: "2026-11-14" });
    await all("todo_manage", { action: "update", todo_id: "td1", status: "done" });
    await all("todo_manage", { action: "delete", todo_id: "td1", confirm: true });
    expect(calls).toEqual([
      { method: "GET", path: "/api/todos", query: {}, body: undefined },
      { method: "GET", path: "/api/todos", query: { status: "open" }, body: undefined },
      { method: "POST", path: "/api/todos", query: {}, body: { target_id: "t1", title: "Call Lee", description: "About renewal", due_date: "2026-11-14" } },
      // An update that does not name the contact leaves it as it is.
      { method: "PATCH", path: "/api/todos/td1", query: {}, body: { status: "done" } },
      { method: "DELETE", path: "/api/todos/td1", query: {}, body: undefined },
    ]);
    expect((await all("todo_manage", { action: "delete", todo_id: "td1" })).failed).toBe(true);
    expect((await all("todo_manage", { action: "update" })).failed).toBe(true);
  });

  it("carry a time, a priority, an assignee and what a task is about", async () => {
    await all("todos_list", { contact_id: "t1", opportunity_id: "o1", assigned_to: "u1" });
    await all("todo_manage", { action: "create", title: "Review the account", company_id: "co1", opportunity_id: "o1", due_date: "2026-11-14", due_at: "2026-11-14T15:00:00Z", priority: "high", assigned_to: "u1" });
    await all("todo_manage", { action: "update", todo_id: "td1", contact_id: null, assigned_to: null, due_date: null, priority: "low" });
    expect(calls).toEqual([
      { method: "GET", path: "/api/todos", query: { target_id: "t1", opportunity_id: "o1", assigned_to: "u1" }, body: undefined },
      { method: "POST", path: "/api/todos", query: {}, body: { title: "Review the account", company_id: "co1", opportunity_id: "o1", due_date: "2026-11-14", due_at: "2026-11-14T15:00:00Z", priority: "high", assigned_to: "u1" } },
      { method: "PATCH", path: "/api/todos/td1", query: {}, body: { target_id: null, assigned_to: null, due_date: null, priority: "low" } },
    ]);
    expect((await all("todo_manage", { action: "create", title: "x", priority: "urgent" })).failed).toBe(true);
  });

  it("need the write scope to change anything", async () => {
    expect((await readOnly("todos_list", {})).failed).toBe(false);
    expect((await readOnly("todo_manage", { action: "create", title: "x" })).failed).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });
});

describe("pipeline_manage", () => {
  it("still does what it did", async () => {
    await all("pipeline_manage", { action: "get" });
    await all("pipeline_manage", { action: "create_opportunity", name: "Acme annual", stage_id: "s1", amount: 1200, source: "referral" });
    await all("pipeline_manage", { action: "update_opportunity", id: "o1", stage_id: "s2" });
    await all("pipeline_manage", { action: "create_stage", name: "Negotiation", probability: 80 });
    await all("pipeline_manage", { action: "reorder_stages", stage_ids: ["s2", "s1"] });
    await all("pipeline_manage", { action: "delete_stage", id: "s1", move_to: "s2", confirm: true });
    expect(calls).toEqual([
      { method: "GET", path: "/api/platform/pipeline", query: {}, body: undefined },
      { method: "POST", path: "/api/platform/pipeline", query: {}, body: { name: "Acme annual", stage_id: "s1", amount: 1200, source: "referral", entity: "opportunity" } },
      { method: "PATCH", path: "/api/platform/pipeline", query: {}, body: { id: "o1", stage_id: "s2" } },
      { method: "POST", path: "/api/platform/pipeline", query: {}, body: { name: "Negotiation", probability: 80, entity: "stage" } },
      { method: "PATCH", path: "/api/platform/pipeline", query: {}, body: { entity: "stage_order", ids: ["s2", "s1"] } },
      { method: "DELETE", path: "/api/platform/pipeline", query: { stage_id: "s1", move_to: "s2" }, body: undefined },
    ]);
    expect((await all("pipeline_manage", { action: "delete_opportunity", id: "o1" })).failed).toBe(true);
  });

  it("reads one owner's board, the meetings and the activity list, and sets what the pipeline does by itself", async () => {
    await all("pipeline_manage", { action: "get", owner: "u1" });
    await all("pipeline_manage", { action: "get_meetings", when: "past", match: "all", page: 2, limit: 10 });
    await all("pipeline_manage", { action: "get_activity", group: "deals", owner: "u1", target_id: "t1" });
    await all("pipeline_manage", { action: "link_meeting", id: "m1", target_id: "t1" });
    await all("pipeline_manage", { action: "update_settings", auto_opportunity_on_reply: true });
    expect(calls).toEqual([
      { method: "GET", path: "/api/platform/pipeline", query: { owner: "u1" }, body: undefined },
      { method: "GET", path: "/api/pipeline/meetings", query: { when: "past", match: "all", page: "2", limit: "10" }, body: undefined },
      { method: "GET", path: "/api/pipeline/activity", query: { group: "deals", actor: "u1", target_id: "t1" }, body: undefined },
      { method: "PATCH", path: "/api/pipeline/meetings", query: {}, body: { id: "m1", target_id: "t1" } },
      { method: "PATCH", path: "/api/platform/pipeline", query: {}, body: { entity: "settings", auto_opportunity_on_reply: true } },
    ]);
  });

  it("reads with the read scope and changes nothing without the write scope", async () => {
    for (const action of ["get", "get_meetings", "get_activity"]) expect((await readOnly("pipeline_manage", { action })).failed).toBe(false);
    for (const args of [{ action: "link_meeting", id: "m1", target_id: "t1" }, { action: "update_settings", auto_opportunity_on_reply: true }, { action: "create_opportunity", name: "x" }]) {
      expect((await readOnly("pipeline_manage", args)).failed).toBe(true);
    }
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});
