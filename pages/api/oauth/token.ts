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

    // Rotate with a grace window rather than deleting outright. Deleting made every refresh a
    // race the client could lose: two refreshes in flight at once (two Claude surfaces on the
    // same connector, or a retry) meant the second found no row, got invalid_grant, and threw
    // the session away — the "please reconnect" prompt. Any request still carrying the old
    // access token 401'd for the same reason. Both tokens now stay usable for GRACE_MS, which
    // is long enough for concurrent refreshes and in-flight calls to settle and short enough
    // that a leaked token is not durable.
    //
    // The tradeoff is deliberate: OAuth BCP wants refresh reuse to revoke the whole family as
    // theft detection. That rule assumes reuse is anomalous — here it is the normal behaviour
    // of a well-behaved concurrent client, and enforcing it is what logged the user out.
    // MIN, not assignment: re-presenting an already-rotated refresh token must not push its
    // deadline out again, or repeated reuse would keep a superseded token alive indefinitely.
    // The window is measured from the FIRST rotation and only ever shrinks.
    const deadline = graceDeadline();
    db.prepare(
      `UPDATE oauth_tokens
       SET expires_at = MIN(expires_at, ?),
           refresh_expires_at = MIN(COALESCE(refresh_expires_at, ?), ?)
       WHERE id = ?`
    ).run(deadline, deadline, deadline, row.id);
    sweepExpiredTokens(db);
    return res.json(issueTokenPair({ clientId: row.client_id, userId: row.user_id, scopes: requested, resource: row.resource, workspaceId: row.workspace_id }));
  }

  return oauthError(res, "unsupported_grant_type");
}

// How long a rotated token pair stays usable after being superseded. Covers concurrent
// refreshes and requests already in flight; well short of the 1h lifetime of a live token.
const ROTATION_GRACE_MS = 60_000;

function graceDeadline(): string {
  return new Date(Date.now() + ROTATION_GRACE_MS).toISOString();
}

/**
 * Rotation no longer deletes the superseded row, so without this the table would grow by one
 * row per refresh forever. Dead rows are kept briefly for revocation lookups, then dropped.
 */
function sweepExpiredTokens(db: ReturnType<typeof getDb>) {
  try {
    // The cutoff is built in JS so both sides of the comparison are ISO-8601. These columns
    // are written with toISOString(), and SQLite's datetime() renders "YYYY-MM-DD HH:MM:SS" —
    // comparing the two as strings puts every same-day ISO value above the cutoff, because
    // 'T' sorts after ' '. Harmless for a 7-day sweep, wrong if anyone tightens the window.
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    db.prepare(
      "DELETE FROM oauth_tokens WHERE COALESCE(refresh_expires_at, expires_at) < ?"
    ).run(cutoff);
  } catch { /* sweeping is housekeeping — never fail a token request over it */ }
}

function oauthError(res: NextApiResponse, error: string, error_description?: string) {
  return res.status(400).json({ error, ...(error_description ? { error_description } : {}) });
}
