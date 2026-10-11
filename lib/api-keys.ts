import { createHash, randomBytes, randomUUID } from "crypto";
import { getDb } from "@/lib/db";

export function createApiKey(input: { workspaceId: string; name: string; scopes: string[]; createdBy?: string; expiresAt?: string; rateLimitPerMinute?: number | null }) {
  const raw = `lnk_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  getDb().prepare(`INSERT INTO api_keys
    (id, workspace_id, name, key_hash, key_prefix, scopes, created_by, expires_at, rate_limit_per_minute)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.workspaceId, input.name, hash(raw), raw.slice(0, 12), input.scopes.join(" "), input.createdBy ?? null, input.expiresAt ?? null, input.rateLimitPerMinute ?? null);
  return { id, key: raw, prefix: raw.slice(0, 12), scopes: input.scopes, rate_limit_per_minute: input.rateLimitPerMinute ?? null };
}

export function verifyApiKey(raw: string): { keyId: string; name: string; workspaceId: string; scopes: string[]; rateLimitPerMinute: number | null; createdBy: string | null; expiresAt: string | null } | null {
  const row = getDb().prepare(`SELECT id, name, workspace_id, scopes, rate_limit_per_minute, created_by, expires_at FROM api_keys
    WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))`).get(hash(raw)) as { id: string; name: string; workspace_id: string; scopes: string; rate_limit_per_minute: number | null; created_by: string | null; expires_at: string | null } | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return { keyId: row.id, name: row.name, workspaceId: row.workspace_id, scopes: row.scopes.split(/\s+/).filter(Boolean), rateLimitPerMinute: row.rate_limit_per_minute, createdBy: row.created_by, expiresAt: row.expires_at };
}

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

