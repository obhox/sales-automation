import { createHash, randomBytes, randomUUID } from "crypto";
import { getDb } from "@/lib/db";

export function createApiKey(input: { workspaceId: string; name: string; scopes: string[]; createdBy?: string; expiresAt?: string }) {
  const raw = `lnk_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  getDb().prepare(`INSERT INTO api_keys
    (id, workspace_id, name, key_hash, key_prefix, scopes, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.workspaceId, input.name, hash(raw), raw.slice(0, 12), input.scopes.join(" "), input.createdBy ?? null, input.expiresAt ?? null);
  return { id, key: raw, prefix: raw.slice(0, 12), scopes: input.scopes };
}

export function verifyApiKey(raw: string): { keyId: string; workspaceId: string; scopes: string[] } | null {
  const row = getDb().prepare(`SELECT id, workspace_id, scopes FROM api_keys
    WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))`).get(hash(raw)) as { id: string; workspace_id: string; scopes: string } | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return { keyId: row.id, workspaceId: row.workspace_id, scopes: row.scopes.split(/\s+/).filter(Boolean) };
}

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

