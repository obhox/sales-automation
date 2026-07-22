import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));

import { getServerSession } from "next-auth/next";
import { getDb } from "@/lib/db";
import overview from "@/pages/api/admin/overview";
import workspacesHandler from "@/pages/api/admin/workspaces";

const mockedSession = vi.mocked(getServerSession);
const ADMIN = "admin@example.com";

// Column names that must never appear anywhere in an admin response. If a future query
// switches to SELECT * or adds a credential column, this fails loudly.
const FORBIDDEN_KEYS = [
  "cookies_json", "proxy_password", "proxy_username", "proxy_url",
  "password", "password_hash", "imap_password", "imap_username",
  "api_key", "key_hash", "key_prefix", "secret", "secret_value",
  "access_hash", "refresh_hash", "code_hash", "code_challenge",
  "access_token", "refresh_token", "client_state", "token_hash",
  "body_text", "generated_text", "prompt", "metadata_json",
  "payload_json", "request_json", "config_json", "ip_address",
];

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}
const req = { method: "GET" } as NextApiRequest;

/** Recursively collect every object key in the payload. */
function allKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, acc));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { acc.push(k); allKeys(v, acc); }
  }
  return acc;
}

/** Any `error` key means one of the aggregate queries failed (bad SQL, missing table). */
function collectErrors(value: unknown, path = "", found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => collectErrors(v, `${path}[${i}]`, found));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "error" && typeof v === "string") found.push(`${path}.${k}: ${v}`);
      collectErrors(v, `${path}.${k}`, found);
    }
  }
  return found;
}

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run("u-admin", ADMIN, "hash");
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run("ws-admin", "Acme", "acme");
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run("ws-admin", "u-admin");
});

beforeEach(() => {
  mockedSession.mockReset();
  process.env.SUPERADMIN_EMAILS = ADMIN;
});

describe("GET /api/admin/overview", () => {
  it("returns the full instance overview for an admin", async () => {
    mockedSession.mockResolvedValue({ user: { email: ADMIN } } as never);
    const res = mockRes();
    await overview(req, res);
    expect(res.statusCode).toBe(200);
    for (const section of ["instance", "tenancy", "volume", "email_queue", "deliverability",
      "campaigns", "linkedin", "workers", "eventing", "governance", "ai_spend", "recent_events"]) {
      expect(res.body).toHaveProperty(section);
    }
  });

  it("executes every aggregate query without error", async () => {
    mockedSession.mockResolvedValue({ user: { email: ADMIN } } as never);
    const res = mockRes();
    await overview(req, res);
    // Catches SQL typos and references to columns/tables that do not exist.
    expect(collectErrors(res.body)).toEqual([]);
  });

  it("never exposes a credential, secret or content column", async () => {
    mockedSession.mockResolvedValue({ user: { email: ADMIN } } as never);
    const res = mockRes();
    await overview(req, res);
    const leaked = allKeys(res.body).filter((k) => FORBIDDEN_KEYS.includes(k));
    expect(leaked).toEqual([]);
  });

  it("404s for a non-admin", async () => {
    mockedSession.mockResolvedValue({ user: { email: "member@example.com" } } as never);
    const res = mockRes();
    await overview(req, res);
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/admin/workspaces", () => {
  it("returns a per-tenant rollup for an admin", async () => {
    mockedSession.mockResolvedValue({ user: { email: ADMIN } } as never);
    const res = mockRes();
    await workspacesHandler(req, res);
    expect(res.statusCode).toBe(200);
    const rows = res.body.workspaces as Array<Record<string, unknown>>;
    expect(rows.some((w) => w.slug === "acme")).toBe(true);
    expect(collectErrors(res.body)).toEqual([]);
  });

  it("never exposes a credential or content column", async () => {
    mockedSession.mockResolvedValue({ user: { email: ADMIN } } as never);
    const res = mockRes();
    await workspacesHandler(req, res);
    const leaked = allKeys(res.body).filter((k) => FORBIDDEN_KEYS.includes(k));
    expect(leaked).toEqual([]);
  });

  it("404s when the allowlist is empty, even for a valid session", async () => {
    delete process.env.SUPERADMIN_EMAILS;
    mockedSession.mockResolvedValue({ user: { email: ADMIN } } as never);
    const res = mockRes();
    await workspacesHandler(req, res);
    expect(res.statusCode).toBe(404);
  });
});

describe("worker lease reporting", () => {
  // expires_at is written by JS as ISO-8601 with a Z; heartbeat_at by SQLite as bare
  // "YYYY-MM-DD HH:MM:SS" UTC. Mixing the two made this view misreport during an outage.
  function seedLease(name: string, expiresInMs: number, heartbeatAgo: string) {
    const db = getDb();
    db.prepare(
      `INSERT INTO worker_leases(name, owner_id, expires_at, heartbeat_at)
       VALUES(?, 'owner-1', ?, datetime('now', ?))
       ON CONFLICT(name) DO UPDATE SET expires_at=excluded.expires_at, heartbeat_at=excluded.heartbeat_at`
    ).run(name, new Date(Date.now() + expiresInMs).toISOString(), heartbeatAgo);
  }

  async function leases() {
    const res = mockRes();
    mockedSession.mockResolvedValue({ user: { email: ADMIN } });
    await overview(req, res);
    const workers = (res.body as Record<string, Record<string, unknown>>).workers;
    return workers.leases as Array<Record<string, unknown>>;
  }

  it("reports a lease that expired earlier today as NOT alive", async () => {
    // The regression: 'T' sorts above ' ', so an ISO expires_at compared lexicographically
    // against datetime('now') stayed "alive" all day after it had actually lapsed. This is
    // the exact state a wedged loop leaves behind.
    seedLease("test-expired-today", -60_000, "-1 minute");
    const row = (await leases()).find((l) => l.name === "test-expired-today")!;
    expect(row.alive).toBe(0);
  });

  it("reports a live lease as alive", async () => {
    seedLease("test-live", 45_000, "-1 minute");
    const row = (await leases()).find((l) => l.name === "test-live")!;
    expect(row.alive).toBe(1);
  });

  it("flags a lease that is alive but no longer beating", async () => {
    // Alive AND stalled at once is a real state — the loop renewed, then wedged inside an
    // await. That combination is what hid a two-day outage.
    seedLease("test-wedged", 45_000, "-30 minutes");
    const row = (await leases()).find((l) => l.name === "test-wedged")!;
    expect(row.alive).toBe(1);
    expect(row.stalled).toBe(1);
  });

  it("emits both timestamps in one unambiguous UTC format", async () => {
    // Rendered client-side with Date.parse, which reads the bare form as LOCAL and the ISO
    // form as UTC — so unnormalised rows showed an expiry hours before their own heartbeat.
    seedLease("test-format", 45_000, "-1 minute");
    const row = (await leases()).find((l) => l.name === "test-format")!;
    for (const field of ["expires_at", "heartbeat_at"]) {
      expect(String(row[field]), field).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
    expect(Date.parse(String(row.expires_at))).toBeGreaterThan(Date.parse(String(row.heartbeat_at)));
  });
});
