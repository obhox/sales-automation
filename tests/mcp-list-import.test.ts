// The MCP tool for importing a CSV: called as before it sends what it always sent, and the
// new settings reach the route. The route is tested in csv-imports.test.ts; here the app's
// own API is stubbed and only the calls are read.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createLinkiMcpServer } from "@/lib/mcp/server";

const ORIGIN = "http://linki.test";
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const realFetch = globalThis.fetch;

async function connect(scopes: string[]) {
  const auth = { token: "t", clientId: "c", scopes, extra: { workspaceId: "ws-mcp-csv", userId: "user-mcp-csv", workspaceRole: "owner" } } as AuthInfo;
  const client = new Client({ name: "test", version: "1.0.0" });
  const [mine, theirs] = InMemoryTransport.createLinkedPair();
  await Promise.all([createLinkiMcpServer({ origin: ORIGIN, auth }).connect(theirs), client.connect(mine)]);
  return async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "list_import_csv", arguments: args }) as { isError?: boolean; content: Array<{ text?: string }> };
    return { failed: Boolean(result.isError), text: result.content.map((part) => part.text ?? "").join("") };
  };
}

let all: Awaited<ReturnType<typeof connect>>;
let readOnly: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    // Anything else the process asks for on its own (a version check) is answered and left out.
    if (url.origin !== ORIGIN) return new Response("{}", { status: 200 });
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ imported: 1 }), { status: 200 });
  }) as typeof fetch;
  all = await connect(["mcp:read", "mcp:write"]);
  readOnly = await connect(["mcp:read"]);
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls.length = 0; });

describe("list_import_csv", () => {
  const csv = "email\nada@acme.test\n";
  const mapping = [{ column: "email", kind: "standard", field: "email" }];

  it("sends exactly what it always sent when called as before", async () => {
    await all({ list_id: "list 1", csv });
    await all({ list_id: "l1", csv, mapping, filename: "people.csv" });
    expect(calls).toEqual([
      { method: "POST", path: "/api/lists/list%201/import-csv", body: { csv } },
      { method: "POST", path: "/api/lists/l1/import-csv", body: { csv, mapping, filename: "people.csv" } },
    ]);
  });

  it("passes on the dry run, what to do with a duplicate, and what to match on", async () => {
    await all({ list_id: "l1", csv, dry_run: true, on_duplicate: "skip", match: { email: true, name_company: true } });
    expect(calls).toEqual([{ method: "POST", path: "/api/lists/l1/import-csv", body: { csv, dry_run: true, on_duplicate: "skip", match: { email: true, name_company: true } } }]);
    expect(await all({ list_id: "l1", csv, on_duplicate: "merge" })).toMatchObject({ failed: true });
  });

  it("lets a read-only connection ask what an import would do, and nothing more", async () => {
    expect((await readOnly({ list_id: "l1", csv, dry_run: true })).failed).toBe(false);
    expect(await readOnly({ list_id: "l1", csv })).toMatchObject({ failed: true, text: expect.stringMatching(/requires the mcp:write scope/) });
    expect(await readOnly({ list_id: "l1", csv, dry_run: false, on_duplicate: "skip" })).toMatchObject({ failed: true });
    expect(calls.map((call) => call.body)).toEqual([{ csv, dry_run: true }]);
  });
});
