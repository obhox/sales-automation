import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db";
import { createApiKey, verifyApiKey } from "@/lib/api-keys";

const WS = "ws-apikey-0001";

beforeAll(() => {
  getDb().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Key WS", "key-ws");
});

describe("verifyApiKey", () => {
  it("verifies a freshly created key and returns its scopes and workspace", () => {
    const created = createApiKey({ workspaceId: WS, name: "test", scopes: ["contacts:read", "crm:write"] });
    const verified = verifyApiKey(created.key);
    expect(verified).not.toBeNull();
    expect(verified?.workspaceId).toBe(WS);
    expect(verified?.scopes).toEqual(["contacts:read", "crm:write"]);
  });

  it("rejects an unknown key", () => {
    expect(verifyApiKey("lnk_not_a_real_key")).toBeNull();
  });

  it("rejects an expired key", () => {
    const created = createApiKey({
      workspaceId: WS,
      name: "expired",
      scopes: ["contacts:read"],
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    expect(verifyApiKey(created.key)).toBeNull();
  });

  it("does not cross workspaces or leak scopes for a revoked key", () => {
    const created = createApiKey({ workspaceId: WS, name: "revoke", scopes: ["contacts:read"] });
    getDb().prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?").run(created.id);
    expect(verifyApiKey(created.key)).toBeNull();
  });
});
