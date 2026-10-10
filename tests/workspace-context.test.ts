// Who a request acts as. proxy.ts decides it and signs it; lib/workspace.ts accepts nothing
// that lacks that signature and reads a user's role from workspace_members, not from the
// session cookie. These run the real proxy and the real resolver end to end: a request goes
// in with a real NextAuth cookie, and the headers the proxy forwards are handed to
// requireWorkspace the way Next hands them to a route.
import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { proxy } from "@/proxy";
import { requireWorkspace } from "@/lib/workspace";
import { ctxHeaders, signedHeaders } from "./helpers/ctx";

const WS_A = "ws-ctx-a";
const WS_B = "ws-ctx-b";
const SECRET = "internal-secret-for-ctx-tests";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

function resolve(headers: Record<string, string>, minimum?: Parameters<typeof requireWorkspace>[2]) {
  const res = mockRes();
  const ctx = requireWorkspace({ headers } as unknown as NextApiRequest, res, minimum);
  return { ctx, status: res.statusCode, body: res.body };
}

async function sessionCookie(claims: Record<string, unknown>) {
  const jwt = await encode({ token: claims, secret: process.env.NEXTAUTH_SECRET! });
  return `next-auth.session-token=${jwt}`;
}

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

/** The request headers a route would see: Next carries the proxy's overrides on the response. */
function forwarded(res: Response): Record<string, string> {
  const names = (res.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
  return Object.fromEntries(names.map((name) => [name, res.headers.get(`x-middleware-request-${name}`) ?? ""]));
}

function addUser(id: string, workspaceId: string, role: string) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (?, ?, 'x')").run(id, `${id}@ctx.test`);
  db.prepare("INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(workspaceId, id, role);
}

beforeAll(() => {
  process.env.INTERNAL_API_SECRET = SECRET;
  const db = getDb();
  for (const id of [WS_A, WS_B]) db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(id, id, id);
});

describe("proxy.ts", () => {
  it("turns away a request with no session and no internal secret", async () => {
    const res = await proxy(request("/api/targets"));
    expect(res.status).toBe(401);
  });

  it("leaves the routes that authenticate themselves alone", async () => {
    const res = await proxy(request("/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
  });

  it("acts in the session's workspace whatever context headers the client sends", async () => {
    addUser("ctx-alice", WS_A, "member");
    const res = await proxy(request("/api/targets", {
      cookie: await sessionCookie({ sub: "ctx-alice", userId: "ctx-alice", workspaceId: WS_A, role: "member" }),
      "x-workspace-id": WS_B, "x-workspace-role": "owner", "x-user-id": "someone-else", "x-linki-ctx": "00",
    }));
    expect(res.status).toBe(200);
    const { ctx } = resolve(forwarded(res));
    expect(ctx).toEqual({ workspaceId: WS_A, userId: "ctx-alice", role: "member" });
  });

  it("refuses a session that names no workspace, even when the client names one", async () => {
    // This used to fall through to the client's own x-workspace-id and x-workspace-role.
    const res = await proxy(request("/api/targets", {
      cookie: await sessionCookie({ sub: "ctx-nobody" }),
      "x-workspace-id": WS_A, "x-workspace-role": "owner",
    }));
    expect(res.status).toBe(401);
  });

  it("lets a caller holding the internal secret name the workspace it acts in", async () => {
    addUser("ctx-mcp", WS_B, "admin");
    const res = await proxy(request("/api/targets", {
      "x-internal-secret": SECRET, "x-workspace-id": WS_B, "x-user-id": "ctx-mcp", "x-workspace-role": "admin",
    }));
    expect(res.status).toBe(200);
    expect(resolve(forwarded(res)).ctx).toEqual({ workspaceId: WS_B, userId: "ctx-mcp", role: "admin" });
  });

  it("gives the internal secret no workspace to fall back to", async () => {
    const res = await proxy(request("/api/targets", { "x-internal-secret": SECRET }));
    expect(res.status).toBe(401);
  });

  it("does not accept a wrong internal secret", async () => {
    const res = await proxy(request("/api/targets", {
      "x-internal-secret": "not-the-secret", "x-workspace-id": WS_A, "x-workspace-role": "owner",
    }));
    expect(res.status).toBe(401);
  });
});

describe("requireWorkspace", () => {
  it("rejects context headers that the proxy did not sign", () => {
    addUser("ctx-bob", WS_A, "owner");
    const { ctx, status } = resolve({ "x-workspace-id": WS_A, "x-user-id": "ctx-bob", "x-workspace-role": "owner" });
    expect(ctx).toBeNull();
    expect(status).toBe(401);
  });

  it("rejects a request with no context at all rather than defaulting to a workspace", () => {
    const { ctx, status } = resolve({});
    expect(ctx).toBeNull();
    expect(status).toBe(401);
  });

  it("rejects a signature moved onto a different workspace, user or role", () => {
    addUser("ctx-carol", WS_A, "member");
    const signed = ctxHeaders(WS_A, { userId: "ctx-carol", role: "member" });
    expect(resolve(signed).ctx).not.toBeNull();
    expect(resolve({ ...signed, "x-workspace-id": WS_B }).status).toBe(401);
    expect(resolve({ ...signed, "x-user-id": "ctx-bob" }).status).toBe(401);
    expect(resolve({ ...signed, "x-workspace-role": "owner" }).status).toBe(401);
  });

  it("shuts out a removed member whose session is still valid", () => {
    addUser("ctx-dave", WS_A, "admin");
    const headers = signedHeaders({ workspaceId: WS_A, userId: "ctx-dave", role: "admin", iat: "" });
    expect(resolve(headers).ctx?.role).toBe("admin");

    getDb().prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(WS_A, "ctx-dave");
    const after = resolve(headers);
    expect(after.ctx).toBeNull();
    expect(after.status).toBe(403);
  });

  it("applies a role change at once, in either direction, whatever the session still says", () => {
    addUser("ctx-erin", WS_A, "admin");
    const headers = signedHeaders({ workspaceId: WS_A, userId: "ctx-erin", role: "admin", iat: "" });
    expect(resolve(headers, "admin").ctx?.role).toBe("admin");

    addUser("ctx-erin", WS_A, "viewer");
    expect(resolve(headers).ctx?.role).toBe("viewer");
    const denied = resolve(headers, "admin");
    expect(denied.ctx).toBeNull();
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ required_role: "admin" });

    addUser("ctx-erin", WS_A, "owner");
    expect(resolve(headers, "owner").ctx?.role).toBe("owner");
  });

  it("does not let membership of one workspace reach into another", () => {
    addUser("ctx-frank", WS_A, "owner");
    const { ctx, status } = resolve(signedHeaders({ workspaceId: WS_B, userId: "ctx-frank", role: "owner", iat: "" }));
    expect(ctx).toBeNull();
    expect(status).toBe(403);
  });

  it("takes the signed role for an internal call made on no user's behalf, and no other", () => {
    expect(resolve(ctxHeaders(WS_A, { role: "manager" })).ctx).toEqual({ workspaceId: WS_A, userId: null, role: "manager" });
    expect(resolve(signedHeaders({ workspaceId: WS_A, userId: "", role: "", iat: "" })).status).toBe(401);
    expect(resolve(signedHeaders({ workspaceId: WS_A, userId: "", role: "superuser", iat: "" })).status).toBe(401);
  });
});
