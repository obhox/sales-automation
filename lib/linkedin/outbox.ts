// LinkedIn messages a person asked this app to send: a reply typed in the inbox.
//
// A message waits here as `queued`, is `sending` while the browser has it, and ends as
// `delivered`, `failed` (it did not go, and the reason says why) or `uncertain` (Send was
// pressed and LinkedIn never showed the message). An uncertain message is never sent again
// by itself: it may have gone, and sending it twice is worse than asking a person to look.
// The next read of the inbox settles it, because a message that did go is found there.
//
// These are rows in linkedin_messages, the same table the inbox read fills, so a
// conversation shows what is waiting in line with what was said.
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import type { Page } from "playwright";
import { getSessionPage, markNeedsReauth, saveSessionState, SessionExpiredError } from "@/lib/linkedin/session";
import { MessageUnconfirmedError, NotConnectedError, RecipientMismatchError, sendMessage } from "@/lib/linkedin/message";

type DB = DatabaseType.Database;

/** LinkedIn's own limit on a message. */
export const LINKEDIN_MESSAGE_MAX = 8000;
/** Messages sent for one account on one pass of the runner. */
export const OUTBOX_PER_PASS = 3;

export interface QueuedMessage { id: string; account_id: string; target_id: string; body: string; linkedin_url: string | null; full_name: string | null }

/** Put a message in line to be sent from an account to a contact. Returns its id. */
export function queueLinkedinMessage(db: DB, input: { workspaceId: string; accountId: string; targetId: string; text: string; createdBy: string | null }): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO linkedin_messages (id, workspace_id, account_id, target_id, direction, body, sent_at, status, created_by)
    VALUES (?, ?, ?, ?, 'out', ?, ?, 'queued', ?)`).run(id, input.workspaceId, input.accountId, input.targetId, input.text.replace(/\r\n?/g, "\n").trim(), new Date().toISOString(), input.createdBy ?? "api");
  return id;
}

/**
 * What is waiting for an account, oldest first. Anything still marked `sending` when this
 * is asked was left that way by a send that never finished (the app stopped, or the step
 * timed out): it is not known to have gone, so it becomes `uncertain` rather than being
 * tried again.
 */
export function nextQueuedMessages(db: DB, accountId: string, limit = OUTBOX_PER_PASS): QueuedMessage[] {
  db.prepare(`UPDATE linkedin_messages SET status = 'uncertain', error = 'The send did not finish, so it is not known whether this went. Check the conversation on LinkedIn before sending it again.'
    WHERE account_id = ? AND status = 'sending'`).run(accountId);
  return db.prepare(`SELECT m.id, m.account_id, m.target_id, m.body, t.linkedin_url, t.full_name
    FROM linkedin_messages m JOIN targets t ON t.id = m.target_id
    WHERE m.account_id = ? AND m.status = 'queued' ORDER BY m.created_at, m.rowid LIMIT ?`).all(accountId, limit) as QueuedMessage[];
}

/** Accounts that are signed in and have something waiting. */
export function accountsWithQueuedMessages(db: DB): string[] {
  return (db.prepare(`SELECT DISTINCT m.account_id FROM linkedin_messages m JOIN accounts a ON a.id = m.account_id
    WHERE m.status = 'queued' AND a.is_authenticated = 1`).all() as Array<{ account_id: string }>).map((row) => row.account_id);
}

export type OutboxOutcome = "delivered" | "failed" | "uncertain" | "signed_out";

/**
 * Send one queued message and record how it ended. The other person having written is the
 * reason for a reply, so that does not hold it; the recipient is still proven by identity
 * and the same text is still not sent twice (lib/linkedin/message.ts).
 */
export async function sendQueuedMessage(db: DB, message: QueuedMessage): Promise<OutboxOutcome> {
  const settle = (status: "delivered" | "failed" | "uncertain" | "queued", error: string | null) =>
    db.prepare("UPDATE linkedin_messages SET status = ?, error = ?, sent_at = CASE WHEN ? = 'delivered' THEN ? ELSE sent_at END WHERE id = ?").run(status, error, status, new Date().toISOString(), message.id);
  if (!message.linkedin_url) { settle("failed", "This contact has no LinkedIn profile address"); return "failed"; }
  // Marked before the browser is touched, so a send that never returns is not mistaken for one that never started.
  if (!db.prepare("UPDATE linkedin_messages SET status = 'sending', error = NULL WHERE id = ? AND status = 'queued'").run(message.id).changes) return "failed";

  let page: Page | null = null;
  try {
    page = await getSessionPage(message.account_id);
    const outcome = await sendMessage(page, message.linkedin_url, message.body, { allowReplied: true });
    // The message step will not put the same words into a conversation twice in a row. If
    // that is this message's own earlier attempt showing up, it has been delivered. If the
    // words are already there from another message, this one did not go, and saying
    // "delivered" would be telling someone a second message was sent when it was not.
    if (outcome === "already-sent" && db.prepare("SELECT 1 FROM linkedin_messages WHERE target_id = ? AND id != ? AND direction = 'out' AND body = ? AND status = 'delivered'").get(message.target_id, message.id, message.body)) {
      settle("failed", "This exact message is already the last one in the conversation, so it was not sent a second time.");
      return "failed";
    }
    settle("delivered", null);
    await saveSessionState(message.account_id).catch(() => {});
    return "delivered";
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      // Nothing was sent. It waits for the account to be signed in again.
      settle("queued", null);
      await markNeedsReauth(message.account_id);
      return "signed_out";
    }
    if (error instanceof MessageUnconfirmedError) { settle("uncertain", "Send was pressed but LinkedIn did not show the message. It may have gone. Check the conversation on LinkedIn before sending it again."); return "uncertain"; }
    const reason = error instanceof NotConnectedError ? "LinkedIn will not deliver this: the contact is not a connection of this account"
      : error instanceof RecipientMismatchError ? "The conversation that opened was not with this contact, so nothing was sent"
      : error instanceof Error ? error.message : String(error);
    settle("failed", reason);
    return "failed";
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** Messages this app sent for an account between two times (as stored: UTC, "YYYY-MM-DD HH:MM:SS"). They count towards its daily message limit. */
export function outboxSentBetween(db: DB, accountId: string, start: string, end: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM linkedin_messages WHERE account_id = ? AND created_by IS NOT NULL AND status IN ('delivered', 'uncertain')
    AND datetime(sent_at) >= ? AND datetime(sent_at) < ?`).get(accountId, start, end) as { c: number }).c;
}
