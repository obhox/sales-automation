import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;
export interface ResolvedAccount { id: string; email: string }

/**
 * Resolve which authenticated LinkedIn account to act through for a contact.
 * Order: explicit id → the account that has written to the contact → the contact's most
 * recent campaign assignment → the sole authenticated account. Only ever returns an
 * `is_authenticated = 1` account so callers never drive a dead session.
 */
export function resolveLinkedInAccount(db: DB, targetId: string, explicitId?: string, workspaceId?: string): ResolvedAccount | null {
  const byId = (aid: string) =>
    db.prepare(`SELECT id, email FROM accounts WHERE id = ? AND is_authenticated = 1${workspaceId ? " AND workspace_id = ?" : ""}`).get(...(workspaceId ? [aid,workspaceId] : [aid])) as
      | ResolvedAccount
      | undefined;

  if (explicitId) return byId(explicitId) ?? null;

  // The account that has written to them holds the conversation and the connection.
  const wrote = db.prepare("SELECT linkedin_account_id FROM targets WHERE id = ?").get(targetId) as { linkedin_account_id: string | null } | undefined;
  if (wrote?.linkedin_account_id) {
    const a = byId(wrote.linkedin_account_id);
    if (a) return a;
  }

  // Otherwise the account their latest campaign gave them: their own in a campaign with
  // several accounts, or the campaign's one.
  const assigned = db.prepare(`
    SELECT COALESCE(rp.account_id, r.account_id) AS account_id FROM run_profiles rp
    JOIN runs r ON r.id = rp.run_id
    WHERE rp.target_id = ?
    ORDER BY rp.created_at DESC LIMIT 1
  `).get(targetId) as { account_id: string } | undefined;
  if (assigned?.account_id) {
    const a = byId(assigned.account_id);
    if (a) return a;
  }

  const all = db.prepare(`SELECT id, email FROM accounts WHERE is_authenticated = 1${workspaceId ? " AND workspace_id = ?" : ""}`).all(...(workspaceId ? [workspaceId] : [])) as ResolvedAccount[];
  return all.length === 1 ? all[0] : null;
}

/**
 * Resolve an authenticated LinkedIn account when there's no target/contact to
 * anchor the lookup to (e.g. Sales Navigator search, which runs before any
 * lead exists locally). Order: explicit id → the sole authenticated account.
 */
export function resolveAnyAuthenticatedAccount(db: DB, explicitId?: string): ResolvedAccount | null {
  const byId = (aid: string) =>
    db.prepare("SELECT id, email FROM accounts WHERE id = ? AND is_authenticated = 1").get(aid) as
      | ResolvedAccount
      | undefined;

  if (explicitId) return byId(explicitId) ?? null;

  const all = db.prepare("SELECT id, email FROM accounts WHERE is_authenticated = 1").all() as ResolvedAccount[];
  return all.length === 1 ? all[0] : null;
}
