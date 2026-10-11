// The MCP tool for the Deliverability screen: each action reaches the route the screen
// itself uses, with the scope and the confirmation it should need. The routes are tested
// in deliverability.test.ts; here the app's own API is stubbed and only the calls are read.
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
  const auth = { token: "t", clientId: "c", scopes, extra: { workspaceId: "ws-mcp-dlv", userId: "user-mcp-dlv", workspaceRole: "owner" } } as AuthInfo;
  const client = new Client({ name: "test", version: "1.0.0" });
  const [mine, theirs] = InMemoryTransport.createLinkedPair();
  await Promise.all([createLinkiMcpServer({ origin: ORIGIN, auth }).connect(theirs), client.connect(mine)]);
  return async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "deliverability_center", arguments: args }) as { isError?: boolean; content: Array<{ text?: string }> };
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
    calls.push({ method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(url.pathname.endsWith("/report") ? "Domain,Mailbox\r\nacme.test,mia@acme.test\r\n" : JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  all = await connect(["mcp:read", "mcp:write", "mcp:execute"]);
  readOnly = await connect(["mcp:read"]);
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls.length = 0; });

describe("deliverability_center", () => {
  it("reads what the screen reads", async () => {
    await all({ action: "overview", domain: "acme.test", range: "7" });
    await all({ action: "events", domain: "acme.test", kind: "dns_change", limit: 10, offset: 20 });
    await all({ action: "seeds" });
    await all({ action: "placement_runs", domain: "acme.test" });
    await all({ action: "placement_run", run_id: "r1" });
    expect(calls).toEqual([
      { method: "GET", path: "/api/deliverability", query: { domain: "acme.test", range: "7" }, body: undefined },
      { method: "GET", path: "/api/deliverability/events", query: { domain: "acme.test", kind: "dns_change", limit: "10", offset: "20" }, body: undefined },
      { method: "GET", path: "/api/deliverability/seeds", query: {}, body: undefined },
      { method: "GET", path: "/api/deliverability/placement", query: { domain: "acme.test" }, body: undefined },
      { method: "GET", path: "/api/deliverability/placement", query: { run_id: "r1" }, body: undefined },
    ]);
    // The report comes back as the CSV it is.
    expect((await all({ action: "report", range: "90" })).text).toContain("acme.test,mia@acme.test");
    expect(calls.at(-1)).toMatchObject({ path: "/api/deliverability/report", query: { range: "90" } });
  });

  it("changes a domain's selector, its warm-up and the seed list", async () => {
    await all({ action: "set_dkim_selector", domain: "acme.test", selector: "s1" });
    await all({ action: "set_dkim_selector", domain: "acme.test" });
    await all({ action: "domain_warmup", domain: "acme.test", enabled: true });
    await all({ action: "add_seed", seed_email: "seed@acme.test" });
    await all({ action: "remove_seed", seed_id: "s9" });
    expect(calls).toEqual([
      { method: "POST", path: "/api/deliverability/dns", query: {}, body: { domain: "acme.test", selector: "s1" } },
      // No selector forgets the one that was kept.
      { method: "POST", path: "/api/deliverability/dns", query: {}, body: { domain: "acme.test", selector: "" } },
      { method: "POST", path: "/api/deliverability/warmup", query: {}, body: { domain: "acme.test", enabled: true } },
      { method: "POST", path: "/api/deliverability/seeds", query: {}, body: { email: "seed@acme.test" } },
      { method: "DELETE", path: "/api/deliverability/seeds", query: { id: "s9" }, body: undefined },
    ]);
  });

  it("sends a placement run, looks for it and takes a result by hand", async () => {
    await all({ action: "run_placement", email_account_id: "m1", seed_ids: ["s1", "s2"], confirm: true });
    await all({ action: "check_placement", run_id: "r1" });
    await all({ action: "mark_placement", test_id: "t1", placement: "promotions" });
    expect(calls).toEqual([
      { method: "POST", path: "/api/deliverability/placement", query: {}, body: { email_account_id: "m1", seed_ids: ["s1", "s2"] } },
      { method: "PUT", path: "/api/deliverability/placement", query: {}, body: { run_id: "r1" } },
      { method: "PATCH", path: "/api/deliverability/placement", query: {}, body: { test_id: "t1", placement: "promotions" } },
    ]);
  });

  it("asks for confirmation before it sends mail or stops a domain's warm-up", async () => {
    expect(await all({ action: "run_placement", email_account_id: "m1" })).toMatchObject({ failed: true, text: expect.stringMatching(/confirm=true/) });
    expect(await all({ action: "placement_test", email_account_id: "m1", seed_email: "seed@acme.test" })).toMatchObject({ failed: true, text: expect.stringMatching(/confirm=true/) });
    expect(await all({ action: "domain_warmup", domain: "acme.test", enabled: false })).toMatchObject({ failed: true, text: expect.stringMatching(/confirm=true/) });
    expect(calls).toEqual([]);
    await all({ action: "domain_warmup", domain: "acme.test", enabled: false, confirm: true });
    expect(calls).toEqual([{ method: "POST", path: "/api/deliverability/warmup", query: {}, body: { domain: "acme.test", enabled: false } }]);
  });

  it("lets a read-only connection read and nothing else", async () => {
    expect((await readOnly({ action: "overview" })).failed).toBe(false);
    expect((await readOnly({ action: "report" })).failed).toBe(false);
    for (const args of [
      { action: "set_dkim_selector", domain: "acme.test", selector: "s1" }, { action: "domain_warmup", domain: "acme.test", enabled: true }, { action: "add_seed", seed_email: "seed@acme.test" },
      { action: "remove_seed", seed_id: "s9" }, { action: "run_placement", email_account_id: "m1", confirm: true }, { action: "check_placement", run_id: "r1" }, { action: "mark_placement", test_id: "t1", placement: "inbox" },
    ]) expect(await readOnly(args)).toMatchObject({ failed: true, text: expect.stringMatching(/requires the mcp:(write|execute) scope/) });
    expect(calls.map((call) => call.path)).toEqual(["/api/deliverability", "/api/deliverability/report"]);
  });

  it("still answers the older single-address actions the way it did", async () => {
    await all({ action: "get" });
    await all({ action: "check_domain", domain: "acme.test", selector: "google" });
    await all({ action: "configure_warmup", email_account_id: "m1", enabled: true, daily_target: 8, reply_rate: 40 });
    await all({ action: "placement_test", email_account_id: "m1", seed_email: "seed@acme.test", confirm: true });
    expect(calls).toEqual([
      { method: "GET", path: "/api/platform/deliverability", query: {}, body: undefined },
      { method: "POST", path: "/api/platform/deliverability", query: {}, body: { action: "check_domain", domain: "acme.test", selector: "google" } },
      { method: "POST", path: "/api/platform/deliverability", query: {}, body: { action: "configure_warmup", email_account_id: "m1", enabled: true, daily_target: 8, reply_rate: 40 } },
      { method: "POST", path: "/api/platform/deliverability", query: {}, body: { action: "placement_test", email_account_id: "m1", seed_email: "seed@acme.test", confirm: true } },
    ]);
  });
});
