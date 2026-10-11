import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { sendEmailDurably } from "@/lib/email/infrastructure";
import { withSignature } from "@/lib/email/mailbox-policy";
import { findMessage, type AuthResults, type Placement, type ReadableMailbox } from "@/lib/email/readback";
import type { EmailDeliveryMode } from "@/lib/email/content";

// A test email from a mailbox, and where it landed.
//
// Linki can only say where a test landed when it can read the mailbox it went to, which
// means the address is one of this workspace's own connected mailboxes (the sending
// mailbox itself is the usual choice). For any other address the test is recorded as
// sent and that is all that is known.

type DB = DatabaseType.Database;

/** After this long without finding it, a test stops being "still looking" and becomes "not found". */
export const GIVE_UP_AFTER_MINUTES = 10;

export interface TestSend {
  id: string;
  email_account_id: string;
  recipient: string;
  /** sent: accepted by the mail server, not found yet (or cannot be looked for). found / not_found: the answer from the receiving mailbox. */
  status: "sent" | "found" | "not_found";
  /** Whether the recipient is a mailbox Linki can look in. */
  readable: boolean;
  placement: Placement | null;
  folder: string | null;
  auth: AuthResults | null;
  sent_at: string;
  checked_at: string | null;
}

interface TestRow {
  id: string;
  workspace_id: string;
  email_account_id: string;
  recipient: string;
  message_id: string;
  reader_account_id: string | null;
  status: TestSend["status"];
  placement: string | null;
  folder: string | null;
  auth_json: string | null;
  sent_at: string;
  checked_at: string | null;
}

function view(row: TestRow): TestSend {
  let auth: AuthResults | null = null;
  try { auth = row.auth_json ? (JSON.parse(row.auth_json) as AuthResults) : null; } catch { /* leave it out */ }
  return {
    id: row.id, email_account_id: row.email_account_id, recipient: row.recipient, status: row.status, readable: Boolean(row.reader_account_id),
    placement: (row.placement as Placement | null) ?? null, folder: row.folder, auth, sent_at: row.sent_at, checked_at: row.checked_at,
  };
}

/** The connected mailbox of this workspace that receives mail for an address, if there is one. */
export function readerFor(db: DB, workspaceId: string, address: string): string | null {
  const row = db.prepare(`SELECT id FROM email_accounts WHERE workspace_id = ? AND lower(from_email) = lower(?)
      AND imap_host IS NOT NULL AND imap_host != '' AND disconnected_at IS NULL ORDER BY created_at LIMIT 1`).get(workspaceId, address.trim()) as { id: string } | undefined;
  return row?.id ?? null;
}

export interface TestSendInput {
  workspaceId: string;
  emailAccountId: string;
  to: string;
  subject?: string;
  body?: string;
  deliveryMode?: EmailDeliveryMode;
  trackOpens?: boolean;
  trackClicks?: boolean;
  userId?: string | null;
}

/** Send a test email from a mailbox and record it. Throws what the sender throws. */
export async function sendMailboxTest(input: TestSendInput, db: DB = getDb()): Promise<{ test: TestSend; jobId: string; messageId: string }> {
  const mailbox = db.prepare("SELECT signature FROM email_accounts WHERE id = ? AND workspace_id = ?").get(input.emailAccountId, input.workspaceId) as { signature: string | null } | undefined;
  if (!mailbox) throw new Error("Mailbox not found");
  const to = input.to.trim();
  const enhanced = input.deliveryMode === "enhanced";
  const receipt = await sendEmailDurably({
    workspaceId: input.workspaceId, emailAccountId: input.emailAccountId, idempotencyKey: `test:${randomUUID()}`, source: "test", to,
    subject: input.subject ?? "Test email from Linki",
    body: withSignature(input.body ?? "This is a test email sent from Linki to check that this mailbox can send.", mailbox.signature?.trim() || null),
    deliveryMode: enhanced ? "enhanced" : "plain", trackOpens: enhanced && Boolean(input.trackOpens), trackClicks: enhanced && Boolean(input.trackClicks),
  });
  const id = randomUUID();
  db.prepare(`INSERT INTO mailbox_test_sends (id, workspace_id, email_account_id, recipient, message_id, reader_account_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.workspaceId, input.emailAccountId, to.toLowerCase(), receipt.messageId, readerFor(db, input.workspaceId, to), input.userId ?? null);
  // Only the last few are of any use.
  db.prepare(`DELETE FROM mailbox_test_sends WHERE email_account_id = ? AND id NOT IN (
    SELECT id FROM mailbox_test_sends WHERE email_account_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT 20)`).run(input.emailAccountId, input.emailAccountId);
  return { test: view(db.prepare("SELECT * FROM mailbox_test_sends WHERE id = ?").get(id) as TestRow), jobId: receipt.jobId, messageId: receipt.messageId };
}

/** The most recent test sent from a mailbox. */
export function latestMailboxTest(db: DB, workspaceId: string, emailAccountId: string): TestSend | null {
  const row = db.prepare("SELECT * FROM mailbox_test_sends WHERE workspace_id = ? AND email_account_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT 1").get(workspaceId, emailAccountId) as TestRow | undefined;
  return row ? view(row) : null;
}

/**
 * Look in the receiving mailbox for a test that has not been found yet, and record the
 * answer. A test to an address Linki cannot read, or one already answered, comes back as it is.
 */
export async function lookForMailboxTest(db: DB, workspaceId: string, testId: string, find: typeof findMessage = findMessage): Promise<TestSend | null> {
  const row = db.prepare("SELECT * FROM mailbox_test_sends WHERE id = ? AND workspace_id = ?").get(testId, workspaceId) as TestRow | undefined;
  if (!row) return null;
  if (row.status !== "sent" || !row.reader_account_id) return view(row);
  const reader = db.prepare("SELECT imap_host, imap_port, username, password, imap_username, imap_password, allow_self_signed FROM email_accounts WHERE id = ? AND workspace_id = ?")
    .get(row.reader_account_id, workspaceId) as ReadableMailbox | undefined;
  if (!reader) return view(row);

  const result = await find(reader, row.message_id);
  if (result.found) {
    db.prepare("UPDATE mailbox_test_sends SET status = 'found', placement = ?, folder = ?, auth_json = ?, checked_at = datetime('now') WHERE id = ?")
      .run(result.placement, result.folder, result.auth ? JSON.stringify(result.auth) : null, row.id);
  } else {
    // Mail can take a minute or two. It is "not found" only once it has had its chance.
    db.prepare(`UPDATE mailbox_test_sends SET checked_at = datetime('now'),
      status = CASE WHEN sent_at <= datetime('now', ?) THEN 'not_found' ELSE status END WHERE id = ?`).run(`-${GIVE_UP_AFTER_MINUTES} minutes`, row.id);
  }
  return view(db.prepare("SELECT * FROM mailbox_test_sends WHERE id = ?").get(row.id) as TestRow);
}
