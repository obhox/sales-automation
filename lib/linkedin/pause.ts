import type DatabaseType from "better-sqlite3";
import type { NextApiResponse } from "next";

// A paused account is refused where a session is opened (lib/linkedin/session.ts). The
// routes that act on an account for a person check first, so they can say so plainly
// instead of failing partway.

export const PAUSED_MESSAGE = "This LinkedIn account is paused. Resume it to use it.";

/** Answers 409 and returns true when the account is paused. */
export function refuseIfPaused(db: DatabaseType.Database, accountId: string, res: NextApiResponse): boolean {
  const row = db.prepare("SELECT paused_at FROM accounts WHERE id = ?").get(accountId) as { paused_at: string | null } | undefined;
  if (!row?.paused_at) return false;
  res.status(409).json({ ok: false, error: PAUSED_MESSAGE, outcome: "paused" });
  return true;
}
