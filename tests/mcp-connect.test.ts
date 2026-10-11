// What an MCP client needs in order to connect: finding the OAuth documents without being
// signed in, registering itself the way real clients do, and, for a terminal with no browser,
// using an API key that was made for MCP. Real proxy, real handlers, throwaway database.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash, randomUUID } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

vi.mock("@/lib/linkedin/runner", () => ({ ensureGlobalRunnerStarted: vi.fn() }));

import { proxy } from "@/proxy";
import { createApiKey } from "@/lib/api-keys";
import { isSafeRedirectUri, normalizeScopes, resourceMatches, verifyMcpApiKey } from "@/lib/mcp/auth";
import register from "@/pages/api/oauth/register";
import token from "@/pages/api/oauth/token";
import metadata from "@/pages/api/oauth/metadata-authorization-server";

const RESOURCE = "https://linki.test/api/mcp";

function mockRes() {
  const out = { status: 200, body: undefined as unknown, headers: {} as Record<string, string>, ended: false };
  const res = {
    setHeader(name: string, value: string) { out.headers[name.toLowerCase()] = String(value); return res; },
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
    end() { out.ended = true; return res; },
  } as unknown as NextApiResponse;
  return { res, out };
}

let ip = 0;
function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  ip += 1;
  return { method, body, headers: { "x-real-ip": `10.9.${Math.floor(ip / 250)}.${(ip % 250) + 1}`, ...headers }, socket: { remoteAddress: "10.9.0.1" } } as unknown as NextApiRequest;
}

function seedMember(role = "admin", suspended = false) {
  const db = getDb();
  const userId = randomUUID();
  const workspaceId = randomUUID();
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')").run(userId, `${userId}@mcp.test`);
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(workspaceId, "MCP WS", `mcp-${workspaceId.slice(0, 8)}`);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, suspended_at) VALUES (?, ?, ?, ?)")
    .run(workspaceId, userId, role, suspended ? "2026-10-01 00:00:00" : null);
  return { userId, workspaceId };
}

// ── Finding the OAuth documents ──────────────────────────────────────────────
describe("OAuth discovery", () => {
  const open = (path: string) => proxy(new NextRequest(`http://localhost:3000${path}`));

  it("answers a signed-out client at /.well-known, instead of sending it to the sign-in page", async () => {
    // Production sent every one of these to /login, so a client that followed the 401's
    // resource_metadata got HTML where it needed JSON and could never start signing in.
    for (const path of ["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      const res = await open(path);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("still sends a signed-out visitor from an ordinary page to sign in", async () => {
    expect((await open("/contacts")).headers.get("location")).toContain("/login");
  });

  it("may be read from a browser on another origin", () => {
    const { res, out } = mockRes();
    metadata(request("GET"), res);
    expect(out.headers["access-control-allow-origin"]).toBe("*");
    expect((out.body as { token_endpoint_auth_methods_supported: string[] }).token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

// ── Registering a client ─────────────────────────────────────────────────────
describe("dynamic client registration", () => {
  const registerWith = (body: unknown) => {
    const { res, out } = mockRes();
    register(request("POST", body), res);
    return out;
  };

  it("registers a loopback client the way Claude Code and opencode do", () => {
    for (const uri of ["http://localhost:8123/callback", "http://127.0.0.1:19876/mcp/oauth/callback"]) {
      const out = registerWith({ client_name: "opencode", redirect_uris: [uri], token_endpoint_auth_method: "none" });
      expect(out.status, uri).toBe(201);
    }
  });

  it("registers a client that asks for a client secret, as a public client, and says so", () => {
    for (const method of ["client_secret_post", "client_secret_basic"]) {
      const out = registerWith({ client_name: "Some client", redirect_uris: ["https://example.com/cb"], token_endpoint_auth_method: method });
      expect(out.status, method).toBe(201);
      expect((out.body as { token_endpoint_auth_method: string }).token_endpoint_auth_method).toBe("none");
    }
  });

  it("accepts a desktop app's private-use scheme but not one that runs code", () => {
    expect(registerWith({ redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback"] }).status).toBe(201);
    expect(registerWith({ redirect_uris: ["vscode://ms-vscode.mcp/callback"] }).status).toBe(201);
    for (const uri of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "http://evil.example/cb", "https://example.com/cb#frag", "not a url"]) {
      expect(isSafeRedirectUri(uri), uri).toBe(false);
      expect(registerWith({ redirect_uris: [uri] }).status, uri).toBe(400);
    }
  });

  it("answers a request with no usable body as a bad request, not a crash", () => {
    expect(registerWith(undefined).status).toBe(400);
    expect(registerWith("redirect_uris=x").status).toBe(400);
  });
});

// ── The token endpoint ───────────────────────────────────────────────────────
describe("token endpoint", () => {
  it("answers a browser's preflight", () => {
    const { res, out } = mockRes();
    token(request("OPTIONS"), res);
    expect(out.status).toBe(204);
    expect(out.ended).toBe(true);
    expect(out.headers["access-control-allow-origin"]).toBe("*");
    expect(out.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("takes the client id from HTTP Basic when the body has none", () => {
    const { userId, workspaceId } = seedMember("owner");
    const clientId = randomUUID();
    getDb().prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, 'Basic client', ?)").run(clientId, JSON.stringify(["https://example.com/cb"]));
    const refresh = `mcp_refresh_${randomUUID()}`;
    getDb().prepare(`INSERT INTO oauth_tokens (id, access_hash, refresh_hash, client_id, user_id, scope, resource, workspace_id, expires_at, refresh_expires_at)
      VALUES (?, ?, ?, ?, ?, 'mcp:read', ?, ?, ?, ?)`).run(
      randomUUID(), createHash("sha256").update(`mcp_access_${randomUUID()}`).digest("hex"), createHash("sha256").update(refresh).digest("hex"),
      clientId, userId, RESOURCE, workspaceId, new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString(),
    );
    const { res, out } = mockRes();
    token(request("POST", { grant_type: "refresh_token", refresh_token: refresh }, { authorization: `Basic ${Buffer.from(`${clientId}:`).toString("base64")}` }), res);
    expect(out.status).toBe(200);
    expect((out.body as { access_token: string }).access_token).toMatch(/^mcp_access_/);
  });

  it("refuses a request that names no client at all", () => {
    const { res, out } = mockRes();
    token(request("POST", { grant_type: "refresh_token", refresh_token: "x" }), res);
    expect(out.status).toBe(400);
    expect((out.body as { error: string }).error).toBe("invalid_client");
  });
});

// ── What a client may ask for ────────────────────────────────────────────────
describe("resource and scope as clients write them", () => {
  it("takes the resource with or without a trailing slash, or as the bare origin, and no other", () => {
    expect(resourceMatches(RESOURCE, RESOURCE)).toBe(true);
    expect(resourceMatches(`${RESOURCE}/`, RESOURCE)).toBe(true);
    expect(resourceMatches("https://linki.test", RESOURCE)).toBe(true);
    expect(resourceMatches("https://linki.test/", RESOURCE)).toBe(true);
    expect(resourceMatches("https://linki.test/api/other", RESOURCE)).toBe(false);
    expect(resourceMatches("https://evil.example/api/mcp", RESOURCE)).toBe(false);
    expect(resourceMatches("not a url", RESOURCE)).toBe(false);
  });

  it("ignores a scope it does not have, and treats a request of only those as no request", () => {
    expect(normalizeScopes("mcp:read openid offline_access")).toEqual(["mcp:read"]);
    expect(normalizeScopes("openid")).toEqual(["mcp:read", "mcp:write", "mcp:execute"]);
    expect(normalizeScopes(undefined)).toEqual(["mcp:read", "mcp:write", "mcp:execute"]);
    expect(normalizeScopes("openid", [])).toEqual([]);
  });
});

// ── A terminal with no browser: an API key made for MCP ──────────────────────
describe("an API key used as the MCP bearer token", () => {
  let owner: { userId: string; workspaceId: string };
  beforeAll(() => { owner = seedMember("admin"); });

  const key = (scopes: string[], over: { createdBy?: string | null; workspaceId?: string; expiresAt?: string } = {}) =>
    createApiKey({ workspaceId: over.workspaceId ?? owner.workspaceId, name: "terminal", scopes, createdBy: over.createdBy === null ? undefined : (over.createdBy ?? owner.userId), expiresAt: over.expiresAt });

  it("acts as the member who made it, with their role, in the key's workspace", () => {
    const auth = verifyMcpApiKey(key(["mcp:read", "mcp:write"]).key, RESOURCE);
    expect(auth).not.toBeNull();
    expect(auth!.scopes).toEqual(["mcp:read", "mcp:write"]);
    expect(auth!.extra).toMatchObject({ userId: owner.userId, workspaceId: owner.workspaceId, workspaceRole: "admin", clientName: "API key: terminal" });
  });

  it("is refused when it was made for the REST API and carries no MCP scope", () => {
    expect(verifyMcpApiKey(key(["contacts:read", "email:send"]).key, RESOURCE)).toBeNull();
  });

  it("keeps only the MCP scopes of a key that has both kinds", () => {
    expect(verifyMcpApiKey(key(["contacts:read", "mcp:read"]).key, RESOURCE)!.scopes).toEqual(["mcp:read"]);
  });

  it("follows the creator's role as it is now, so demoting them narrows the key", () => {
    const { userId, workspaceId } = seedMember("admin");
    const k = key(["mcp:read", "mcp:write", "mcp:execute"], { createdBy: userId, workspaceId });
    expect(verifyMcpApiKey(k.key, RESOURCE)!.extra).toMatchObject({ workspaceRole: "admin" });
    getDb().prepare("UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
    expect(verifyMcpApiKey(k.key, RESOURCE)!.extra).toMatchObject({ workspaceRole: "viewer" });
  });

  it("stops working when its creator is suspended or removed", () => {
    const suspended = seedMember("admin", true);
    expect(verifyMcpApiKey(key(["mcp:read"], { createdBy: suspended.userId, workspaceId: suspended.workspaceId }).key, RESOURCE)).toBeNull();

    const { userId, workspaceId } = seedMember("admin");
    const k = key(["mcp:read"], { createdBy: userId, workspaceId });
    expect(verifyMcpApiKey(k.key, RESOURCE)).not.toBeNull();
    getDb().prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
    expect(verifyMcpApiKey(k.key, RESOURCE)).toBeNull();
  });

  it("is refused when nobody made it, so there is no one for it to act as", () => {
    expect(verifyMcpApiKey(key(["mcp:read"], { createdBy: null }).key, RESOURCE)).toBeNull();
  });

  it("is refused once revoked or expired, and for a key that does not exist", () => {
    const revoked = key(["mcp:read"]);
    getDb().prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?").run(revoked.id);
    expect(verifyMcpApiKey(revoked.key, RESOURCE)).toBeNull();
    expect(verifyMcpApiKey(key(["mcp:read"], { expiresAt: "2020-01-01 00:00:00" }).key, RESOURCE)).toBeNull();
    expect(verifyMcpApiKey("lnk_not_a_real_key", RESOURCE)).toBeNull();
  });
});
