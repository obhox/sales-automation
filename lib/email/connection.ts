import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { isImapAuthFailure } from "@/lib/email/auth-failure";
import { probeImap, probeSmtp, type ProbeResult } from "@/lib/email/sender";
import { emitDomainEvent } from "@/lib/platform/events";
import { notify } from "@/lib/platform/notifications";

// Whether a mailbox can sign in.
//
// A mailbox whose mail server refuses its sign-in is "disconnected". That is recorded on
// the mailbox, said to the workspace once, and treated by the sender exactly like a pause:
// nothing goes out and every contact waits. Before this existed a refused sign-in failed
// each contact in turn, three attempts at a time, and nothing on any screen said why.
//
// It is only ever a refused sign-in. A server that cannot be reached, a timeout or a
// temporary refusal is a passing fault and does not disconnect anything.

type DB = DatabaseType.Database;

/** Refused sign-ins to read a mailbox, in a row, before it counts as disconnected. One failed read is often a passing fault at the provider. */
export const IMAP_FAILURES_TO_DISCONNECT = 3;

/** How often a disconnected mailbox is tried again by itself. */
export const RECHECK_MINUTES = 30;

interface MailboxRow {
  id: string;
  workspace_id: string;
  from_email: string;
  disconnected_at: string | null;
  imap_auth_failures: number;
}

const mailboxRow = (db: DB, id: string) =>
  db.prepare("SELECT id, workspace_id, from_email, disconnected_at, imap_auth_failures FROM email_accounts WHERE id = ?").get(id) as MailboxRow | undefined;

/**
 * Record that a mailbox cannot sign in. Says so once: a second call while it is already
 * disconnected changes nothing. Returns whether this call was the one that disconnected it.
 */
export function markDisconnected(emailAccountId: string, reason: string, db: DB = getDb()): boolean {
  const mailbox = mailboxRow(db, emailAccountId);
  if (!mailbox || mailbox.disconnected_at) return false;
  const text = reason.trim().slice(0, 300);
  db.prepare("UPDATE email_accounts SET disconnected_at = datetime('now'), disconnect_reason = ?, connection_checked_at = datetime('now') WHERE id = ? AND disconnected_at IS NULL").run(text, emailAccountId);
  emitDomainEvent({ workspaceId: mailbox.workspace_id, type: "mailbox.disconnected", entityType: "email_account", entityId: emailAccountId, payload: { from_email: mailbox.from_email, reason: text } });
  notify({
    workspaceId: mailbox.workspace_id, kind: "mailbox.disconnected", tone: "bad", link: "/mailboxes",
    title: `${mailbox.from_email} cannot sign in`,
    body: `${text} Nothing is sent from it and its contacts wait until it is reconnected.`,
    dedupeKey: `mailbox-disconnected:${emailAccountId}:${new Date().toISOString().slice(0, 10)}`,
  }, db);
  return true;
}

/** Record that a mailbox signs in again. Returns whether it had been disconnected. */
export function markConnected(emailAccountId: string, db: DB = getDb()): boolean {
  const mailbox = mailboxRow(db, emailAccountId);
  if (!mailbox) return false;
  db.prepare("UPDATE email_accounts SET disconnected_at = NULL, disconnect_reason = NULL, imap_auth_failures = 0, connection_checked_at = datetime('now') WHERE id = ?").run(emailAccountId);
  if (!mailbox.disconnected_at) return false;
  emitDomainEvent({ workspaceId: mailbox.workspace_id, type: "mailbox.reconnected", entityType: "email_account", entityId: emailAccountId, payload: { from_email: mailbox.from_email } });
  return true;
}

/**
 * What the reply reader calls when it has tried to open a mailbox: with the error if it
 * could not, with null if it could. Three refused sign-ins in a row disconnect it.
 */
export function noteImapSignIn(emailAccountId: string, error: unknown, db: DB = getDb()): void {
  try {
    if (error === null || error === undefined) {
      db.prepare("UPDATE email_accounts SET imap_auth_failures = 0 WHERE id = ? AND imap_auth_failures != 0").run(emailAccountId);
      return;
    }
    if (!isImapAuthFailure(error)) return;
    db.prepare("UPDATE email_accounts SET imap_auth_failures = imap_auth_failures + 1 WHERE id = ?").run(emailAccountId);
    const mailbox = mailboxRow(db, emailAccountId);
    if (mailbox && mailbox.imap_auth_failures >= IMAP_FAILURES_TO_DISCONNECT) {
      markDisconnected(emailAccountId, `The mail server refused the sign-in used to read replies (${errorText(error)}).`, db);
    }
  } catch (cause) {
    // Keeping count must never get in the way of reading mail.
    console.warn("[mailbox] could not record a sign-in result:", cause instanceof Error ? cause.message : cause);
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 160);
}

// ── Testing a connection ──────────────────────────────────────────────────────

interface CredentialRow {
  id: string;
  from_email: string;
  from_name: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  imap_host: string | null;
  imap_port: number | null;
  username: string;
  password: string;
  imap_username: string | null;
  imap_password: string | null;
  allow_self_signed: number;
}

export interface ConnectionTest {
  ok: boolean;
  smtp: ProbeResult;
  /** Null for a mailbox with no IMAP server: it can send, and nothing can be read from it. */
  imap: ProbeResult | null;
}

/** Sign in to a mailbox's SMTP server, and its IMAP server if it has one. Changes nothing. */
export async function probeMailbox(emailAccountId: string, db: DB = getDb()): Promise<ConnectionTest | null> {
  const row = db.prepare("SELECT id, from_email, from_name, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, username, password, imap_username, imap_password, allow_self_signed FROM email_accounts WHERE id = ?")
    .get(emailAccountId) as CredentialRow | undefined;
  if (!row) return null;
  const password = decryptSecret(row.password) ?? "";
  const [smtp, imap] = await Promise.all([
    probeSmtp({ ...row, password }),
    row.imap_host
      ? probeImap({ imap_host: row.imap_host, imap_port: row.imap_port ?? 993, username: row.username, password, imap_username: row.imap_username, imap_password: decryptSecret(row.imap_password), allow_self_signed: row.allow_self_signed })
      : Promise.resolve(null),
  ]);
  return { ok: !smtp.error && !imap?.error, smtp, imap };
}

/**
 * Test a mailbox and record what was found: verified and connected when both sign-ins
 * work, disconnected when either is refused. A server that could not be reached leaves
 * the mailbox as it was.
 */
export async function testMailboxConnection(emailAccountId: string, db: DB = getDb()): Promise<ConnectionTest | null> {
  const test = await probeMailbox(emailAccountId, db);
  if (!test) return null;
  db.prepare("UPDATE email_accounts SET connection_checked_at = datetime('now') WHERE id = ?").run(emailAccountId);
  if (test.ok) {
    db.prepare("UPDATE email_accounts SET is_verified = 1 WHERE id = ?").run(emailAccountId);
    markConnected(emailAccountId, db);
  } else if (test.smtp.auth) {
    markDisconnected(emailAccountId, `The mail server refused the sign-in used to send (${test.smtp.error}).`, db);
  } else if (test.imap?.auth) {
    markDisconnected(emailAccountId, `The mail server refused the sign-in used to read replies (${test.imap.error}).`, db);
  }
  return test;
}

/**
 * Try each disconnected mailbox again, at most once every RECHECK_MINUTES, and reconnect
 * the ones that now sign in. A password changed back, or a provider's fault that cleared,
 * should not need a person. Returns how many reconnected.
 */
export async function recheckDisconnectedMailboxes(db: DB = getDb(), limit = 5): Promise<number> {
  const due = db.prepare(`SELECT id FROM email_accounts WHERE disconnected_at IS NOT NULL
      AND (connection_checked_at IS NULL OR connection_checked_at <= datetime('now', ?))
    ORDER BY connection_checked_at LIMIT ?`).all(`-${RECHECK_MINUTES} minutes`, limit) as Array<{ id: string }>;
  let reconnected = 0;
  for (const { id } of due) {
    // Stamped first, so a probe that hangs or throws is not tried again on the next pass.
    db.prepare("UPDATE email_accounts SET connection_checked_at = datetime('now') WHERE id = ?").run(id);
    const test = await probeMailbox(id, db).catch(() => null);
    if (test?.ok && markConnected(id, db)) reconnected++;
  }
  return reconnected;
}
