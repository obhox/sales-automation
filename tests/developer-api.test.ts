// The Developer page's server side: a rate limit per API key, webhooks with a name and a
// health, the MCP tool catalogue, instance health for admins, and connections whose
// settings can be read without reading a secret. Real (throwaway) database. Nothing here
// leaves the machine: webhook delivery and every provider's API are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import type { NextApiRequest, NextApiResponse } from "next";

const wire = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: string }>,
  answer: { status: 200, body: "ok" } as { status: number; body: string } | Error,
}));
vi.mock("@/lib/platform/safe-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/platform/safe-fetch")>()),
  safePost: async (url: string, options: { body: string }) => {
    wire.calls.push({ url, body: options.body });
    if (wire.answer instanceof Error) throw wire.answer;
    return wire.answer;
  },
}));

import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/api-keys";
import { MAX_RATE_LIMIT, parseRateLimit, resetRateLimits, takeRequest } from "@/lib/api/key-rate-limit";
import { groupOf, mcpCatalogue } from "@/lib/mcp/catalogue";
import { emitDomainEvent, processWebhookDeliveries } from "@/lib/platform/events";
import { readInstanceHealth } from "@/lib/system/instance";
import apiKeys, { type ApiKeyRow } from "@/pages/api/platform/api-keys";
import connections, { type ConnectionRow } from "@/pages/api/platform/connections";
import instance from "@/pages/api/platform/instance";
import integrations from "@/pages/api/integrations/index";
import mcpInfo, { type McpInfo } from "@/pages/api/platform/mcp";
import webhooks, { type DeadLetter, type WebhookRow } from "@/pages/api/platform/webhooks";
import v1 from "@/pages/api/v1/[...path]";
import { ctxHeaders } from "./helpers/ctx";

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
interface Answer { statusCode: number; body: unknown; headers: Record<string, string> }

const db = () => getDb();
let seq = 0;
const PUBLIC = "https://93.184.216.34/hooks/linki";

async function call(handler: Handler, req: Partial<NextApiRequest>): Promise<Answer> {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = (name: string, value: unknown) => { (res.headers as Record<string, string>)[name.toLowerCase()] = String(value); return res; };
  await handler({ query: {}, body: {}, headers: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as Answer;
}

function workspace() {
  const ws = `ws-dev-${++seq}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const as = (role: string) => ctxHeaders(ws, { userId: `${ws}-${role}`, role });
  return { ws, as, admin: as("admin") };
}

beforeEach(() => {
  delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
  wire.calls.length = 0;
  wire.answer = { status: 200, body: "ok" };
  resetRateLimits();
  // A delivery left waiting by an earlier case would be picked up by the next one.
  db().prepare("UPDATE webhook_deliveries SET status = 'delivered' WHERE status IN ('pending','retrying')").run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────
describe("a rate limit on an API key", () => {
  const get = (key: string) => call(v1 as Handler, { method: "GET", headers: { authorization: `Bearer ${key}` }, query: { path: ["contacts"] } });

  it("a key with no limit is never counted and never refused, as before limits existed", async () => {
    const w = workspace();
    const key = createApiKey({ workspaceId: w.ws, name: "No limit", scopes: ["contacts:read"] });
    expect(key.rate_limit_per_minute).toBeNull();
    for (let i = 0; i < 250; i++) {
      const res = await get(key.key);
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
      expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
    }
    expect(takeRequest(key.id, null)).toBeNull();
    expect(takeRequest(key.id, undefined)).toBeNull();
    expect(takeRequest(key.id, 0)).toBeNull();
  });

  it("lets through as many requests a minute as the limit, says how many are left, then answers 429", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const w = workspace();
    const key = createApiKey({ workspaceId: w.ws, name: "Three a minute", scopes: ["contacts:read"], rateLimitPerMinute: 3 });
    for (const left of [2, 1, 0]) {
      const res = await get(key.key);
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBe("3");
      expect(res.headers["x-ratelimit-remaining"]).toBe(String(left));
      vi.advanceTimersByTime(10_000);
    }
    const refused = await get(key.key);
    expect(refused.statusCode).toBe(429);
    expect(refused.body).toEqual({ error: "rate_limited", limit_per_minute: 3, retry_after: 30 });
    expect(refused.headers["retry-after"]).toBe("30");
    // A refused request does not count against the next minute.
    vi.advanceTimersByTime(30_000);
    expect((await get(key.key)).statusCode).toBe(200);
    expect((await get(key.key)).statusCode).toBe(429);
  });

  it("is counted per key: one key at its limit does not slow another", async () => {
    const w = workspace();
    const tight = createApiKey({ workspaceId: w.ws, name: "Tight", scopes: ["contacts:read"], rateLimitPerMinute: 1 });
    const other = createApiKey({ workspaceId: w.ws, name: "Other", scopes: ["contacts:read"], rateLimitPerMinute: 1 });
    expect((await get(tight.key)).statusCode).toBe(200);
    expect((await get(tight.key)).statusCode).toBe(429);
    expect((await get(other.key)).statusCode).toBe(200);
  });

  it("does not let a wrong key use up anyone's allowance", async () => {
    const w = workspace();
    const key = createApiKey({ workspaceId: w.ws, name: "One", scopes: ["contacts:read"], rateLimitPerMinute: 1 });
    for (let i = 0; i < 5; i++) expect((await get(`${key.key}x`)).statusCode).toBe(401);
    expect((await get(key.key)).statusCode).toBe(200);
  });

  it("reads a limit as a whole number from 1 to 10,000, or nothing", () => {
    expect(parseRateLimit(600)).toBe(600);
    expect(parseRateLimit("600")).toBe(600);
    expect(parseRateLimit(MAX_RATE_LIMIT)).toBe(MAX_RATE_LIMIT);
    for (const none of [null, undefined, ""]) expect(parseRateLimit(none)).toBeNull();
    for (const wrong of [0, -5, 1.5, MAX_RATE_LIMIT + 1, "many", "6e2", true, {}]) expect(parseRateLimit(wrong), String(wrong)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("managing API keys", () => {
  const create = (w: ReturnType<typeof workspace>, body: Record<string, unknown>) =>
    call(apiKeys as Handler, { method: "POST", headers: w.admin, body: { name: "Backend", scopes: ["contacts:read"], ...body } });
  const list = async (w: ReturnType<typeof workspace>, role = "admin") => (await call(apiKeys as Handler, { method: "GET", headers: w.as(role) })).body as ApiKeyRow[];

  it("creates a key with no limit unless one is asked for", async () => {
    const w = workspace();
    expect(((await create(w, {})).body as { rate_limit_per_minute: number | null }).rate_limit_per_minute).toBeNull();
    expect(((await create(w, { rate_limit_per_minute: 120 })).body as { rate_limit_per_minute: number | null }).rate_limit_per_minute).toBe(120);
    expect((await list(w)).map((key) => key.rate_limit_per_minute)).toEqual([120, null]);
    for (const wrong of [0, 1.5, 20_000, "fast"]) expect((await create(w, { rate_limit_per_minute: wrong })).statusCode, String(wrong)).toBe(400);
    expect(await list(w)).toHaveLength(2);
  });

  it("shows the key once, at creation, and never again", async () => {
    const w = workspace();
    const created = (await create(w, {})).body as { id: string; key: string; prefix: string };
    expect(created.key.startsWith("lnk_")).toBe(true);
    const listed = await list(w);
    expect(JSON.stringify(listed)).not.toContain(created.key);
    expect(Object.keys(listed[0]).sort()).toEqual(["created_at", "created_by_name", "expires_at", "id", "key_prefix", "last_used_at", "name", "rate_limit_per_minute", "revoked_at", "scopes"]);
    expect(listed[0].key_prefix).toBe(created.key.slice(0, 12));
    const changed = await call(apiKeys as Handler, { method: "PATCH", headers: w.admin, body: { id: created.id, rate_limit_per_minute: 5 } });
    expect(JSON.stringify(changed.body)).not.toContain(created.key);
  });

  it("changes a key's limit and name, and the new limit holds from the next request", async () => {
    const w = workspace();
    const created = (await create(w, {})).body as { id: string; key: string };
    const get = () => call(v1 as Handler, { method: "GET", headers: { authorization: `Bearer ${created.key}` }, query: { path: ["contacts"] } });
    expect((await get()).headers["x-ratelimit-limit"]).toBeUndefined();

    expect((await call(apiKeys as Handler, { method: "PATCH", headers: w.admin, body: { id: created.id, rate_limit_per_minute: 1, name: "  Reporting  " } })).body).toEqual({ ok: true, name: "Reporting", rate_limit_per_minute: 1 });
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(429);

    // Sent empty, the limit is taken off. Not sent, it is left alone.
    expect((await call(apiKeys as Handler, { method: "PATCH", headers: w.admin, body: { id: created.id, name: "Reports" } })).body).toEqual({ ok: true, name: "Reports", rate_limit_per_minute: 1 });
    expect((await call(apiKeys as Handler, { method: "PATCH", headers: w.admin, body: { id: created.id, rate_limit_per_minute: null } })).body).toEqual({ ok: true, name: "Reports", rate_limit_per_minute: null });
    expect((await get()).statusCode).toBe(200);
    expect((await get()).headers["x-ratelimit-limit"]).toBeUndefined();

    expect((await call(apiKeys as Handler, { method: "PATCH", headers: w.admin, body: { id: created.id, rate_limit_per_minute: -1 } })).statusCode).toBe(400);
    expect((await call(apiKeys as Handler, { method: "PATCH", headers: w.admin, body: { id: created.id, name: "  " } })).statusCode).toBe(400);
    const audit = db().prepare("SELECT action FROM audit_logs WHERE workspace_id = ? AND entity_id = ? ORDER BY rowid").all(w.ws, created.id) as Array<{ action: string }>;
    expect(audit.map((row) => row.action)).toEqual(["api_key.created", "api_key.updated", "api_key.updated", "api_key.updated"]);
  });

  it("will not change a revoked key, another workspace's key, or anything for someone below admin", async () => {
    const w = workspace(), other = workspace();
    const created = (await create(w, {})).body as { id: string };
    expect((await call(apiKeys as Handler, { method: "PATCH", headers: other.admin, body: { id: created.id, rate_limit_per_minute: 5 } })).statusCode).toBe(404);
    for (const role of ["viewer", "member", "manager"]) {
      expect((await call(apiKeys as Handler, { method: "PATCH", headers: w.as(role), body: { id: created.id, rate_limit_per_minute: 5 } })).statusCode, role).toBe(403);
      expect((await call(apiKeys as Handler, { method: "POST", headers: w.as(role), body: { name: "x", scopes: ["contacts:read"] } })).statusCode, role).toBe(403);
    }
    expect((await list(w, "viewer"))[0].rate_limit_per_minute).toBeNull();
    await call(apiKeys as Handler, { method: "DELETE", headers: w.admin, query: { id: created.id } });
    expect((await call(apiKeys as Handler, { method: "PATCH", headers: w.admin, body: { id: created.id, rate_limit_per_minute: 5 } })).statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("webhooks with a name and a health", () => {
  const list = async (w: ReturnType<typeof workspace>, role = "admin") => (await call(webhooks as Handler, { method: "GET", headers: w.as(role) })).body as WebhookRow[];
  const create = async (w: ReturnType<typeof workspace>, body: Record<string, unknown> = {}) => {
    const res = await call(webhooks as Handler, { method: "POST", headers: w.admin, body: { url: PUBLIC, ...body } });
    expect(res.statusCode).toBe(201);
    return res.body as { id: string; name: string | null; secret: string };
  };
  const fire = async (w: ReturnType<typeof workspace>, times = 1) => {
    for (let i = 0; i < times; i++) emitDomainEvent({ workspaceId: w.ws, type: "reply.received", payload: { n: i } });
    await processWebhookDeliveries(50);
  };

  it("has no name unless given one, and a name can be changed or cleared", async () => {
    const w = workspace();
    expect((await create(w)).name).toBeNull();
    const named = await create(w, { name: "  Reply   router " });
    expect(named.name).toBe("Reply router");
    expect((await list(w)).map((hook) => hook.name)).toEqual(["Reply router", null]);

    await call(webhooks as Handler, { method: "PATCH", headers: w.admin, body: { id: named.id, name: "CRM bridge" } });
    expect((await list(w))[0].name).toBe("CRM bridge");
    // Changing something else leaves the name alone.
    await call(webhooks as Handler, { method: "PATCH", headers: w.admin, body: { id: named.id, event_types: ["reply.received"] } });
    expect((await list(w))[0]).toMatchObject({ name: "CRM bridge", event_types: "reply.received" });
    await call(webhooks as Handler, { method: "PATCH", headers: w.admin, body: { id: named.id, name: "" } });
    expect((await list(w))[0].name).toBeNull();
    expect((await call(webhooks as Handler, { method: "PATCH", headers: w.admin, body: { id: named.id, name: 7 } })).statusCode).toBe(400);
    expect((await call(webhooks as Handler, { method: "POST", headers: w.admin, body: { url: PUBLIC, name: { a: 1 } } })).statusCode).toBe(400);
  });

  it("never returns the signing secret after creation", async () => {
    const w = workspace();
    const hook = await create(w, { name: "Signed" });
    expect(hook.secret.startsWith("whsec_")).toBe(true);
    const listed = await list(w);
    expect(JSON.stringify(listed)).not.toContain(hook.secret);
    expect(listed[0]).not.toHaveProperty("secret");
  });

  it("is idle before its first delivery, then healthy with a success rate", async () => {
    const w = workspace();
    const hook = await create(w);
    expect((await list(w))[0]).toMatchObject({ health: "idle", success_rate: null, delivery_count: 0, last_delivery_at: null, last_status: null });
    await fire(w, 4);
    const row = (await list(w))[0];
    expect(row).toMatchObject({ id: hook.id, health: "healthy", success_rate: 1, delivery_count: 4, delivered: 4, retrying: 0, dead_letters: 0, last_status: "delivered" });
    expect(row.last_delivery_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it("is retrying while a delivery is being tried again, and its success rate falls", async () => {
    const w = workspace();
    await create(w);
    await fire(w, 3);
    wire.answer = { status: 500, body: "down" };
    await fire(w, 1);
    expect((await list(w))[0]).toMatchObject({ health: "retrying", delivered: 3, retrying: 1, success_rate: 0.75, last_status: "retrying" });
  });

  it("is failing once its newest delivery has been given up on, and lists it as a dead letter", async () => {
    const w = workspace(), other = workspace();
    const hook = await create(w, { name: "Slack alerts" });
    await create(other);
    wire.answer = new Error("connect ECONNREFUSED");
    await fire(w, 1);
    await fire(other, 1);
    // Eight attempts in all; each is due again only after its wait, so the wait is skipped here.
    for (let attempt = 0; attempt < 8; attempt++) {
      db().prepare("UPDATE webhook_deliveries SET next_attempt_at = datetime('now', '-1 minute') WHERE status = 'retrying'").run();
      await processWebhookDeliveries(50);
    }
    expect((await list(w))[0]).toMatchObject({ health: "failing", dead_letters: 1, retrying: 0, success_rate: 0, last_status: "dead_letter" });

    const dead = (await call(webhooks as Handler, { method: "GET", headers: w.as("viewer"), query: { dead_letters: "1" } })).body as DeadLetter[];
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ endpoint_id: hook.id, endpoint: "Slack alerts", event_type: "reply.received", attempt: 8, last_error: "connect ECONNREFUSED" });

    // Sent again by hand, it is delivered and leaves the dead-letter list.
    wire.answer = { status: 200, body: "ok" };
    expect((await call(webhooks as Handler, { method: "PUT", headers: w.admin, body: { delivery_id: dead[0].id } })).body).toMatchObject({ status: "delivered" });
    expect((await call(webhooks as Handler, { method: "GET", headers: w.admin, query: { dead_letters: "1" } })).body).toEqual([]);
    expect((await list(w))[0]).toMatchObject({ health: "healthy", dead_letters: 0, success_rate: 1 });
  });

  it("when paused, is sent nothing and has nothing queued for it; resumed, it receives what happens next", async () => {
    const w = workspace();
    const hook = await create(w);
    await fire(w, 1);
    await call(webhooks as Handler, { method: "PATCH", headers: w.admin, body: { id: hook.id, enabled: false } });
    expect((await list(w))[0]).toMatchObject({ health: "paused", enabled: 0, delivery_count: 1 });
    wire.calls.length = 0;
    await fire(w, 2);
    expect(wire.calls).toHaveLength(0);
    expect((await list(w))[0].delivery_count).toBe(1);

    await call(webhooks as Handler, { method: "PATCH", headers: w.admin, body: { id: hook.id, enabled: true } });
    await fire(w, 1);
    expect(wire.calls).toHaveLength(1);
    expect((await list(w))[0]).toMatchObject({ health: "healthy", delivery_count: 2 });
    const audit = db().prepare("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'webhook.updated' ORDER BY rowid").all(w.ws) as Array<{ metadata_json: string | null }>;
    expect(audit.map((row) => row.metadata_json && JSON.parse(row.metadata_json))).toEqual([{ enabled: false }, { enabled: true }]);
  });

  it("an endpoint created the old way, with only an address, behaves as it did", async () => {
    const w = workspace();
    const res = await call(webhooks as Handler, { method: "POST", headers: w.admin, body: { url: PUBLIC } });
    expect(res.body).toMatchObject({ url: PUBLIC, event_types: "*", name: null });
    await fire(w, 1);
    expect(wire.calls).toHaveLength(1);
    expect(wire.calls[0].url).toBe(PUBLIC);
    const log = (await call(webhooks as Handler, { method: "GET", headers: w.admin, query: { deliveries: (res.body as { id: string }).id } })).body as Array<Record<string, unknown>>;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "delivered", event_type: "reply.received" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the MCP tool catalogue", () => {
  it("lists every tool the server registers, each in exactly one group", () => {
    const catalogue = mcpCatalogue();
    const source = readFileSync(path.join(process.cwd(), "lib/mcp/server.ts"), "utf8");
    const registered = [...source.matchAll(/server\.registerTool\("([a-z_]+)"/g)].map((match) => match[1]);
    expect(catalogue.tools.map((tool) => tool.name).sort()).toEqual([...registered].sort());
    expect(new Set(catalogue.tools.map((tool) => tool.name)).size).toBe(catalogue.tools.length);
    expect(catalogue.groups.reduce((sum, group) => sum + group.tools, 0)).toBe(catalogue.tools.length);
    // Largest first, so the page can show the first few and count the rest.
    expect(catalogue.groups.map((group) => group.tools)).toEqual([...catalogue.groups.map((group) => group.tools)].sort((a, b) => b - a));
    expect(mcpCatalogue()).toBe(catalogue);
  });

  it("sorts tools by what they are for, and still counts one it has no rule for", () => {
    expect(groupOf("contacts_search").label).toBe("Contacts");
    expect(groupOf("list_import_csv").label).toBe("Lists");
    expect(groupOf("workflow_add_step").label).toBe("Campaigns");
    expect(groupOf("run_control").label).toBe("Campaigns");
    expect(groupOf("linkedin_account_manage").label).toBe("Sender accounts");
    expect(groupOf("linkedin_conversation").label).toBe("Inbox & tasks");
    expect(groupOf("webhook_manage").label).toBe("Developer");
    expect(groupOf("ai_configuration_manage").label).toBe("AI");
    expect(groupOf("something_new").label).toBe("Other");
  });

  it("tells any member where the server is and what it offers, with this workspace's own use of it", async () => {
    const w = workspace(), other = workspace();
    const before = process.env.NEXTAUTH_URL;
    process.env.NEXTAUTH_URL = "https://linki.acme.example";
    try {
      const add = db().prepare("INSERT INTO mcp_audit_logs (id, workspace_id, user_id, client_id, tool_name, created_at) VALUES (?, ?, 'u', 'c', 'contacts_search', datetime('now', ?))");
      add.run(`${w.ws}-1`, w.ws, "-1 day");
      add.run(`${w.ws}-2`, w.ws, "-40 days");
      add.run(`${other.ws}-1`, other.ws, "-1 hour");
      const info = (await call(mcpInfo as Handler, { method: "GET", headers: w.as("viewer") })).body as McpInfo;
      expect(info.url).toBe("https://linki.acme.example/api/mcp");
      expect(info.tools).toBe(mcpCatalogue().tools.length);
      expect(info.read_only_tools).toBeGreaterThan(0);
      expect(info.read_only_tools).toBeLessThan(info.tools);
      expect(info.groups).toEqual(mcpCatalogue().groups);
      expect(info.calls_30d).toBe(1);
      expect(info.last_call_at).not.toBeNull();
      expect((await call(mcpInfo as Handler, { method: "POST", headers: w.admin })).statusCode).toBe(405);
    } finally {
      if (before === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = before;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("instance health", () => {
  const lease = (name: string, minutesAgo: number) =>
    db().prepare(`INSERT INTO worker_leases (name, owner_id, expires_at, heartbeat_at) VALUES (?, 'test', datetime('now', '+1 minute'), datetime('now', ?))
      ON CONFLICT(name) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`).run(name, `-${minutesAgo} minutes`);

  beforeEach(() => {
    delete process.env.LINKI_RUNNER;
    db().prepare("DELETE FROM worker_leases").run();
  });

  it("is for owners and admins only", async () => {
    const w = workspace();
    for (const role of ["viewer", "member", "manager"]) expect((await call(instance as Handler, { method: "GET", headers: w.as(role) })).statusCode, role).toBe(403);
    for (const role of ["admin", "owner"]) expect((await call(instance as Handler, { method: "GET", headers: w.as(role) })).statusCode, role).toBe(200);
    expect((await call(instance as Handler, { method: "POST", headers: w.admin })).statusCode).toBe(405);
  });

  it("names the loop that has stopped coming round", () => {
    const w = workspace();
    lease("email-jobs-runner", 1);
    lease("linkedin-runner", 30);
    const health = readInstanceHealth(db(), w.ws);
    expect(health.status).toBe("degraded");
    expect(health.summary).toBe("LinkedIn runner stalled");
    expect(health.loops.map((loop) => [loop.name, loop.stalled])).toEqual([["email-jobs-runner", false], ["linkedin-runner", true]]);
    expect(health.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(health.database.bytes).toBeGreaterThan(0);
  });

  it("counts what this workspace has waiting, and nobody else's", () => {
    const w = workspace(), other = workspace();
    lease("email-jobs-runner", 0);
    lease("webhook-runner", 0);
    lease("warmup-runner", 0);
    for (const [ws, n] of [[w.ws, 2], [other.ws, 5]] as const) {
      db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, 'M', ?, 'smtp.test', 'u', 'p')").run(`${ws}-mail`, ws, `${ws}@mail.test`);
      for (let i = 0; i < n; i++) {
        db().prepare("INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, recipient, subject, body_text) VALUES (?, ?, ?, ?, 'a@b.test', 's', 'b')").run(`${ws}-job-${i}`, ws, `${ws}-mail`, `k${i}`);
      }
    }
    db().prepare("UPDATE email_jobs SET status = 'sent' WHERE id = ?").run(`${w.ws}-job-0`);
    const loops = Object.fromEntries(readInstanceHealth(db(), w.ws).loops.map((loop) => [loop.name, loop]));
    expect(loops["email-jobs-runner"]).toMatchObject({ waiting: 1, waiting_noun: "queued", label: "Email sender" });
    expect(loops["webhook-runner"]).toMatchObject({ waiting: 0, waiting_noun: "waiting" });
    expect(loops["warmup-runner"]).toMatchObject({ waiting: null, waiting_noun: null });
  });

  it("says so when background work is switched off, or has not started", () => {
    const w = workspace();
    expect(readInstanceHealth(db(), w.ws)).toMatchObject({ status: "idle", loops: [] });
    process.env.LINKI_RUNNER = "off";
    try {
      expect(readInstanceHealth(db(), w.ws)).toMatchObject({ status: "off", summary: "Background work is off", loops: [] });
    } finally {
      delete process.env.LINKI_RUNNER;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("connections to a CRM or a calendar", () => {
  const list = async (w: ReturnType<typeof workspace>, role = "viewer") => (await call(connections as Handler, { method: "GET", headers: w.as(role) })).body as ConnectionRow[];
  const create = (w: ReturnType<typeof workspace>, body: Record<string, unknown>) => call(connections as Handler, { method: "POST", headers: w.admin, body });

  it("never sends back a token, and shows only where a private calendar address points", async () => {
    const w = workspace();
    expect((await create(w, { provider: "hubspot", name: "HubSpot", secret: "pat-na1-very-secret-token" })).statusCode).toBe(201);
    expect((await create(w, { provider: "ical", name: "Team calendar", config: { url: "https://calendar.example.test/private-9f8e7d6c/basic.ics" } })).statusCode).toBe(201);
    const rows = await list(w);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("very-secret-token");
    expect(text).not.toContain("private-9f8e7d6c");
    expect(rows.every((row) => !("secret_value" in row))).toBe(true);
    expect(JSON.parse(rows.find((row) => row.provider === "ical")!.config_json)).toEqual({ url: "https://calendar.example.test/…" });
    expect(JSON.parse(rows.find((row) => row.provider === "hubspot")!.config_json)).toEqual({});
  });

  it("asks for what each provider needs before saving", async () => {
    const w = workspace();
    expect((await create(w, { provider: "hubspot", name: "HubSpot" })).statusCode).toBe(400);
    expect((await create(w, { provider: "salesforce", name: "Salesforce", secret: "t" })).statusCode).toBe(400);
    expect((await create(w, { provider: "salesforce", name: "Salesforce", secret: "t", config: { instance_url: "acme.my.salesforce.com", external_id_field: "Linki_Id__c" } })).statusCode).toBe(400);
    expect((await create(w, { provider: "salesforce", name: "Salesforce", secret: "t", config: { instance_url: "https://acme.my.salesforce.com" } })).statusCode).toBe(400);
    expect((await create(w, { provider: "salesforce", name: "Salesforce", secret: "t", config: { instance_url: "https://acme.my.salesforce.com", external_id_field: "Linki_Id__c" } })).statusCode).toBe(201);
    expect((await create(w, { provider: "ical", name: "Feed" })).statusCode).toBe(400);
    expect((await create(w, { provider: "pipedrive", name: "x", secret: "t" })).statusCode).toBe(400);
    expect((await create(w, { provider: "google_calendar", name: "Google Calendar", secret: "t" })).statusCode).toBe(201);
    for (const role of ["viewer", "member", "manager"]) expect((await call(connections as Handler, { method: "POST", headers: w.as(role), body: { provider: "hubspot", name: "x", secret: "t" } })).statusCode, role).toBe(403);
  });

  it("changes one setting without losing the others, or what the sync remembers", async () => {
    const w = workspace();
    const id = ((await create(w, { provider: "salesforce", name: "Salesforce", secret: "t", config: { instance_url: "https://acme.my.salesforce.com", external_id_field: "Linki_Id__c" } })).body as { id: string }).id;
    // What a sync leaves behind in the same JSON.
    db().prepare("UPDATE external_connections SET config_json = json_set(config_json, '$.last_contact_export_at', '2026-10-01T00:00:00Z') WHERE id = ?").run(id);

    expect((await call(connections as Handler, { method: "PATCH", headers: w.admin, body: { id, config_merge: { api_version: "v66.0", made_up: "x" } } })).statusCode).toBe(200);
    const stored = () => JSON.parse((db().prepare("SELECT config_json FROM external_connections WHERE id = ?").get(id) as { config_json: string }).config_json);
    expect(stored()).toEqual({ instance_url: "https://acme.my.salesforce.com", external_id_field: "Linki_Id__c", api_version: "v66.0", last_contact_export_at: "2026-10-01T00:00:00Z" });
    // The bookkeeping is kept, and is not sent to the page.
    expect(JSON.parse((await list(w))[0].config_json)).toEqual({ instance_url: "https://acme.my.salesforce.com", external_id_field: "Linki_Id__c", api_version: "v66.0" });
    // A change that would leave it unusable is refused and nothing is saved.
    expect((await call(connections as Handler, { method: "PATCH", headers: w.admin, body: { id, config_merge: { external_id_field: "" } } })).statusCode).toBe(400);
    expect(stored().external_id_field).toBe("Linki_Id__c");
    // `config` still replaces everything, as it always did.
    await call(connections as Handler, { method: "PATCH", headers: w.admin, body: { id, config: { instance_url: "https://other.my.salesforce.com", external_id_field: "Ext__c" } } });
    expect(stored()).toEqual({ instance_url: "https://other.my.salesforce.com", external_id_field: "Ext__c" });
    // A new token replaces the old one and is not sent back either.
    await call(connections as Handler, { method: "PATCH", headers: w.admin, body: { id, secret: "rotated-token-value" } });
    expect(JSON.stringify(await list(w))).not.toContain("rotated-token-value");
    expect((await call(connections as Handler, { method: "PATCH", headers: workspace().admin, body: { id, config_merge: { api_version: "v1.0" } } })).statusCode).toBe(404);
  });

  it("syncs now against the provider, records when, and keeps the reason when it fails (the provider is a stub)", async () => {
    const w = workspace();
    db().prepare("INSERT INTO targets (id, workspace_id, linkedin_url, full_name, email) VALUES (?, ?, ?, 'Lee Park', 'lee@prospect.test')").run(`${w.ws}-t1`, w.ws, `https://www.linkedin.com/in/${w.ws}-lee`);
    const id = ((await create(w, { provider: "hubspot", name: "HubSpot", secret: "pat-test" })).body as { id: string }).id;
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${String(url)}`);
      expect(new URL(String(url)).host).toBe("api.hubapi.com");
      if (String(url).includes("/batch/upsert")) return new Response(JSON.stringify({ results: [{ id: "501", properties: { email: "lee@prospect.test" } }] }), { status: 200 });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }));
    const synced = await call(connections as Handler, { method: "PUT", headers: w.admin, body: { id } });
    expect(synced.statusCode).toBe(200);
    expect(synced.body).toMatchObject({ provider: "hubspot", contacts_exported: 1 });
    expect(asked[0]).toBe("POST https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert");
    let row = (await list(w))[0];
    expect(row.last_synced_at).not.toBeNull();
    expect(row.sync_error).toBeNull();
    expect(row.sync_record_count).toBe(1);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "This token has expired" }), { status: 401 })));
    const failed = await call(connections as Handler, { method: "PUT", headers: w.admin, body: { id } });
    expect(failed.statusCode).toBe(502);
    row = (await list(w))[0];
    expect(row.sync_error).toContain("This token has expired");
    for (const role of ["viewer", "member", "manager"]) expect((await call(connections as Handler, { method: "PUT", headers: w.as(role), body: { id } })).statusCode, role).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("provider keys", () => {
  it("are saved by an admin, shown as their last four characters, and never returned whole", async () => {
    const w = workspace();
    expect((await call(integrations as Handler, { method: "POST", headers: w.as("manager"), body: { key: "apollo", api_key: "apollo-key-abcdef1234" } })).statusCode).toBe(403);
    expect((await call(integrations as Handler, { method: "POST", headers: w.admin, body: { key: "apollo", api_key: "apollo-key-abcdef1234" } })).statusCode).toBe(200);
    const listed = (await call(integrations as Handler, { method: "GET", headers: w.as("viewer") })).body as Array<{ key: string; configured: boolean; api_key_masked: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ key: "apollo", configured: true, api_key_masked: "••••••••1234" });
    expect(JSON.stringify(listed)).not.toContain("abcdef");
    await call(integrations as Handler, { method: "DELETE", headers: w.admin, query: { key: "apollo" } });
    expect((await call(integrations as Handler, { method: "GET", headers: w.admin })).body).toEqual([]);
  });
});
