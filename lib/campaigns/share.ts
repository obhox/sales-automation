// Links that show one campaign's results to someone who has no account: a client, a
// manager. A link shows figures only, never a contact, and can be switched off at any time.
import { createHash, randomBytes, randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

export interface ReportShare {
  id: string;
  /** The end of the link, to tell one from another. The whole link is shown once, when it is made. */
  hint: string;
  created_at: string;
  created_by: { id: string; name: string } | null;
  revoked_at: string | null;
  last_viewed_at: string | null;
  views: number;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
export const MAX_LIVE_SHARES = 10;

export function listShares(db: DB, workspaceId: string, workflowId: string): ReportShare[] {
  return (db.prepare(
    `SELECT s.id, s.hint, s.created_at, s.created_by, s.revoked_at, s.last_viewed_at, s.views, COALESCE(NULLIF(u.name, ''), u.email) AS creator
     FROM report_shares s LEFT JOIN users u ON u.id = s.created_by
     WHERE s.workspace_id = ? AND s.workflow_id = ? ORDER BY s.revoked_at IS NOT NULL, datetime(s.created_at) DESC, s.rowid DESC`,
  ).all(workspaceId, workflowId) as Array<Omit<ReportShare, "created_by"> & { created_by: string | null; creator: string | null }>)
    .map(({ creator, created_by, ...share }) => ({ ...share, created_by: created_by ? { id: created_by, name: creator ?? "A former member" } : null }));
}

/** Make a link. The token is returned here and nowhere else: only its hash is stored. */
export function createShare(db: DB, workspaceId: string, workflowId: string, userId: string | null): { share: ReportShare; token: string } | { error: string } {
  const live = (db.prepare("SELECT COUNT(*) AS c FROM report_shares WHERE workflow_id = ? AND revoked_at IS NULL").get(workflowId) as { c: number }).c;
  if (live >= MAX_LIVE_SHARES) return { error: `A campaign can have ${MAX_LIVE_SHARES} live links. Switch one off first.` };
  const token = randomBytes(24).toString("base64url");
  const id = randomUUID();
  db.prepare("INSERT INTO report_shares (id, workspace_id, workflow_id, token_hash, hint, created_by) VALUES (?, ?, ?, ?, ?, ?)").run(id, workspaceId, workflowId, hashOf(token), token.slice(-4), userId);
  return { share: listShares(db, workspaceId, workflowId).find((share) => share.id === id)!, token };
}

/** Switch a link off. It stays in the list, so it is clear that it once existed. Returns whether there was a live one to switch off. */
export function revokeShare(db: DB, workspaceId: string, workflowId: string, shareId: string): boolean {
  return db.prepare("UPDATE report_shares SET revoked_at = datetime('now') WHERE id = ? AND workspace_id = ? AND workflow_id = ? AND revoked_at IS NULL").run(shareId, workspaceId, workflowId).changes > 0;
}

/** The campaign a link opens, or null when the link is unknown, switched off, or its campaign is gone. Counts the view. */
export function openShare(db: DB, token: string): { workspace_id: string; workflow_id: string } | null {
  if (typeof token !== "string" || token.length < 16 || token.length > 100) return null;
  const share = db.prepare("SELECT id, workspace_id, workflow_id FROM report_shares WHERE token_hash = ? AND revoked_at IS NULL").get(hashOf(token)) as { id: string; workspace_id: string; workflow_id: string } | undefined;
  if (!share) return null;
  db.prepare("UPDATE report_shares SET views = views + 1, last_viewed_at = datetime('now') WHERE id = ?").run(share.id);
  return { workspace_id: share.workspace_id, workflow_id: share.workflow_id };
}
