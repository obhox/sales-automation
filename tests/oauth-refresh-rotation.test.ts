import { describe, expect, it, beforeEach } from "vitest";
import { createHash, randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import handler from "@/pages/api/oauth/token";
import type { NextApiRequest, NextApiResponse } from "next";

const CLIENT_ID = "test-mcp-client";

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Minimal NextApiResponse capturing status + json body. */
function mockRes() {
  const captured: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const res = {
    setHeader: () => res,
    status(code: number) { captured.status = code; return res; },
    json(body: Record<string, unknown>) { captured.body = body; return res; },
  } as unknown as NextApiResponse;
  return { res, captured };
}

function post(body: Record<string, string>) {
  return {
    method: "POST",
    body,
    headers: { "x-real-ip": `10.0.0.${Math.floor(Math.random() * 250) + 1}` },
    socket: { remoteAddress: "10.0.0.1" },
  } as unknown as NextApiRequest;
}

/** Seed a user + workspace + client and return a live token pair row. */
function seedTokenPair() {
  const db = getDb();
  const userId = randomUUID();
  const workspaceId = randomUUID();
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run(userId, `${userId}@example.com`, "x");
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(workspaceId, "WS", `ws-${workspaceId.slice(0, 8)}`);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(workspaceId, userId);
  db.prepare("INSERT OR IGNORE INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)")
    .run(CLIENT_ID, "Test", JSON.stringify(["https://claude.ai/cb"]));

  const refreshToken = `mcp_refresh_${randomUUID()}`;
  const accessToken = `mcp_access_${randomUUID()}`;
  const tokenId = randomUUID();
  db.prepare(`
    INSERT INTO oauth_tokens (id, access_hash, refresh_hash, client_id, user_id, scope, resource, workspace_id, expires_at, refresh_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenId, hashToken(accessToken), hashToken(refreshToken), CLIENT_ID, userId,
    "mcp:read mcp:write mcp:execute", "https://linki.test/api/mcp", workspaceId,
    new Date(Date.now() + 3_600_000).toISOString(),
    new Date(Date.now() + 30 * 86_400_000).toISOString(),
  );
  return { refreshToken, accessToken, tokenId, userId, workspaceId };
}

describe("oauth refresh rotation", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM oauth_tokens").run();
  });

  it("does not log the client out when two refreshes race", () => {
    const { refreshToken } = seedTokenPair();

    // Two refreshes with the SAME token — a client with two surfaces open, or a retry.
    // Before the grace window the second returned invalid_grant and the session was dropped.
    const first = mockRes();
    handler(post({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }), first.res);
    const second = mockRes();
    handler(post({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }), second.res);

    expect(first.captured.body.access_token).toBeTruthy();
    expect(second.captured.status).not.toBe(400);
    expect(second.captured.body.error).toBeUndefined();
    expect(second.captured.body.access_token).toBeTruthy();
    expect(second.captured.body.access_token).not.toBe(first.captured.body.access_token);
  });

  it("keeps the superseded access token alive briefly for in-flight calls", () => {
    const { refreshToken, accessToken } = seedTokenPair();
    const before = mockRes();
    handler(post({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }), before.res);

    const row = getDb().prepare("SELECT expires_at FROM oauth_tokens WHERE access_hash = ?")
      .get(hashToken(accessToken)) as { expires_at: string } | undefined;

    expect(row, "superseded row must survive rotation").toBeTruthy();
    const remainingMs = Date.parse(row!.expires_at) - Date.now();
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(60_000);
  });

  it("does not extend the grace window when a rotated token is presented again", () => {
    const { refreshToken, tokenId } = seedTokenPair();
    handler(post({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }), mockRes().res);
    const firstDeadline = (getDb().prepare("SELECT refresh_expires_at FROM oauth_tokens WHERE id = ?")
      .get(tokenId) as { refresh_expires_at: string }).refresh_expires_at;

    handler(post({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }), mockRes().res);
    const secondDeadline = (getDb().prepare("SELECT refresh_expires_at FROM oauth_tokens WHERE id = ?")
      .get(tokenId) as { refresh_expires_at: string }).refresh_expires_at;

    expect(Date.parse(secondDeadline)).toBeLessThanOrEqual(Date.parse(firstDeadline));
  });

  it("still rejects a refresh token that is past its grace window", () => {
    const { refreshToken, tokenId } = seedTokenPair();
    getDb().prepare("UPDATE oauth_tokens SET refresh_expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), tokenId);

    const { res, captured } = mockRes();
    handler(post({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe("invalid_grant");
  });
});
