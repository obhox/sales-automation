import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getOAuthClient, hashToken, issueTokenPair, normalizeScopes, verifyPkce } from "@/lib/mcp/auth";
import { isRateLimited } from "@/lib/rate-limit";

interface CodeRow { client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; workspace_id: string; expires_at: string }
interface RefreshRow { id: string; client_id: string; user_id: string; scope: string; resource: string; workspace_id: string; refresh_expires_at: string }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (isRateLimited(req, "oauth-token", 60, 15 * 60_000)) return res.status(429).json({ error: "too_many_requests" });
  res.setHeader("Cache-Control", "no-store");
  const body = req.body as Record<string, string | undefined>;
  if (!body.client_id || !getOAuthClient(body.client_id)) return oauthError(res, "invalid_client");

  if (body.grant_type === "authorization_code") {
    if (!body.code || !body.code_verifier || !body.redirect_uri) return oauthError(res, "invalid_request");
    const db = getDb();
    const row = db.prepare(`SELECT client_id, user_id, redirect_uri, code_challenge, scope, resource, workspace_id, expires_at
      FROM oauth_auth_codes WHERE code_hash = ?`).get(hashToken(body.code)) as CodeRow | undefined;
    if (!row || row.client_id !== body.client_id || row.redirect_uri !== body.redirect_uri || Date.parse(row.expires_at) <= Date.now()) {
      return oauthError(res, "invalid_grant");
    }
    if (!verifyPkce(body.code_verifier, row.code_challenge)) return oauthError(res, "invalid_grant", "PKCE verification failed");
    db.prepare("DELETE FROM oauth_auth_codes WHERE code_hash = ?").run(hashToken(body.code));
    return res.json(issueTokenPair({ clientId: row.client_id, userId: row.user_id, scopes: normalizeScopes(row.scope, []), resource: row.resource, workspaceId: row.workspace_id }));
  }

  if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) return oauthError(res, "invalid_request");
    const db = getDb();
    const row = db.prepare(`SELECT id, client_id, user_id, scope, resource, workspace_id, refresh_expires_at
      FROM oauth_tokens WHERE refresh_hash = ?`).get(hashToken(body.refresh_token)) as RefreshRow | undefined;
    if (!row || row.client_id !== body.client_id || !row.refresh_expires_at || Date.parse(row.refresh_expires_at) <= Date.now()) {
      return oauthError(res, "invalid_grant");
    }
    const original = normalizeScopes(row.scope, []);
    const requested = body.scope ? normalizeScopes(body.scope, []) : original;
    if (requested.some((scope) => !original.includes(scope))) return oauthError(res, "invalid_scope");
    db.prepare("DELETE FROM oauth_tokens WHERE id = ?").run(row.id);
    return res.json(issueTokenPair({ clientId: row.client_id, userId: row.user_id, scopes: requested, resource: row.resource, workspaceId: row.workspace_id }));
  }

  return oauthError(res, "unsupported_grant_type");
}

function oauthError(res: NextApiResponse, error: string, error_description?: string) {
  return res.status(400).json({ error, ...(error_description ? { error_description } : {}) });
}
