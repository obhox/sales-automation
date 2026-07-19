import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db";
import { issueTokenPair, verifyAccessToken, hashToken } from "@/lib/mcp/auth";
import { getMemberships } from "@/lib/workspace";

// Exercises the mechanism the MCP workspace_switch tool relies on: the active
// workspace lives on the oauth_tokens row, and verifyAccessToken re-reads and
// re-validates it on every request, so updating that column switches the tenant.

const USER = "user-mcp-0001";
const WA = "ws-mcp-a";
const WB = "ws-mcp-b";
const WC = "ws-mcp-c"; // exists, but USER is NOT a member
const RESOURCE = "http://localhost:3000/api/mcp";

let accessToken: string;

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run(USER, "mcp@test.com", "x");
  for (const [id, name, slug] of [
    [WA, "Alpha", "alpha"],
    [WB, "Bravo", "bravo"],
    [WC, "Charlie", "charlie"],
  ]) {
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(id, name, slug);
  }
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(WA, USER);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')").run(WB, USER);

  const pair = issueTokenPair({
    clientId: "client-1",
    userId: USER,
    scopes: ["mcp:read", "mcp:write"],
    resource: RESOURCE,
    workspaceId: WA,
  });
  accessToken = pair.access_token;
});

function tokenId(): string {
  const row = getDb().prepare("SELECT id FROM oauth_tokens WHERE access_hash = ?").get(hashToken(accessToken)) as {
    id: string;
  };
  return row.id;
}

describe("MCP workspace switching mechanism", () => {
  it("lists every workspace the user belongs to", () => {
    const ids = (getMemberships(USER) as Array<{ id: string }>).map((w) => w.id).sort();
    expect(ids).toEqual([WA, WB].sort());
  });

  it("resolves the token's bound workspace and role", () => {
    const info = verifyAccessToken(accessToken, RESOURCE);
    expect(info).not.toBeNull();
    expect(info?.extra?.workspaceId).toBe(WA);
    expect(info?.extra?.workspaceRole).toBe("owner");
  });

  it("switches tenant when the token's workspace_id is updated to another membership", () => {
    getDb().prepare("UPDATE oauth_tokens SET workspace_id = ? WHERE id = ?").run(WB, tokenId());
    const info = verifyAccessToken(accessToken, RESOURCE);
    expect(info?.extra?.workspaceId).toBe(WB);
    expect(info?.extra?.workspaceRole).toBe("member");
  });

  it("rejects the token if switched to a workspace the user is not a member of", () => {
    getDb().prepare("UPDATE oauth_tokens SET workspace_id = ? WHERE id = ?").run(WC, tokenId());
    expect(verifyAccessToken(accessToken, RESOURCE)).toBeNull();
    // Restore a valid membership so the row is not left dangling.
    getDb().prepare("UPDATE oauth_tokens SET workspace_id = ? WHERE id = ?").run(WA, tokenId());
  });
});
