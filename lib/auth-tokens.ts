import { getDb } from "@/lib/db";
import { createOpaqueToken, hashToken } from "@/lib/mcp/auth";

export type AuthTokenPurpose = "password_reset" | "email_verify";

// A reset link is a password in transit, so it is short-lived. A confirmation link only
// proves the address is read, and people open those late.
const LIFETIME_MS: Record<AuthTokenPurpose, number> = {
  password_reset: 60 * 60_000,
  email_verify: 48 * 60 * 60_000,
};

/** A fresh single-use token for a link mailed to the user. Asking again cancels the links sent before. */
export function issueAuthToken(userId: string, purpose: AuthTokenPurpose): string {
  const db = getDb();
  const token = createOpaqueToken(purpose === "password_reset" ? "reset" : "verify");
  db.transaction(() => {
    db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?").run(userId, purpose);
    db.prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(token), userId, purpose, new Date(Date.now() + LIFETIME_MS[purpose]).toISOString());
  })();
  return token;
}

/** Spend a token: the user it was issued to, or null if it is unknown, expired, already used or for something else. */
export function consumeAuthToken(token: string, purpose: AuthTokenPurpose): { userId: string } | null {
  if (!token) return null;
  const row = getDb().prepare(`UPDATE auth_tokens SET used_at = datetime('now')
    WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
    RETURNING user_id`).get(hashToken(token), purpose, new Date().toISOString()) as { user_id: string } | undefined;
  return row ? { userId: row.user_id } : null;
}

/** Sign a user out everywhere: sessions issued before now are refused from here on. */
export function revokeUserSessions(userId: string): void {
  getDb().prepare("UPDATE users SET sessions_valid_after = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), userId);
}

/** True when a session issued at `issuedAt` (Unix seconds) predates the user's last sign-out-everywhere, or the user is gone. */
export function sessionRevoked(userId: string, issuedAt: number): boolean {
  const user = getDb().prepare("SELECT sessions_valid_after FROM users WHERE id = ?").get(userId) as { sessions_valid_after: number | null } | undefined;
  if (!user) return true;
  return user.sessions_valid_after !== null && issuedAt < user.sessions_valid_after;
}
