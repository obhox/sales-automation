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
