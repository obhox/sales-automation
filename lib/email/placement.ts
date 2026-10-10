import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { domainOf } from "@/lib/email/dns";
import { recordGuardEvent } from "@/lib/email/guard-events";
import { sendEmailDurably } from "@/lib/email/infrastructure";
import { findMessage, PLACEMENTS, type AuthResults, type Placement, type ReadableMailbox } from "@/lib/email/readback";
import { readerFor } from "@/lib/email/test-send";
import { isAddressSuppressed } from "@/lib/platform/suppression";

// Inbox placement tests.
//
// A workspace keeps a list of seed addresses. A test sends the same email from one
// mailbox to every seed and records, for each, where it landed. A seed that is one of the
// workspace's own connected mailboxes is looked in by Linki; for any other, someone looks
// and enters the result. Both kinds count the same.

type DB = DatabaseType.Database;

/** Where a seed's copy ended up: a place read from the mailbox, or `missing` when it never turned up. */
export type PlacementResult = Placement | "missing";
export const PLACEMENT_RESULTS: readonly PlacementResult[] = [...PLACEMENTS, "missing"];

export function isPlacementResult(value: unknown): value is PlacementResult {
  return typeof value === "string" && (PLACEMENT_RESULTS as readonly string[]).includes(value);
}

/** A copy that reached the inbox proper. Gmail's other tabs are delivered, and are not this. */
export const isInbox = (placement: string | null) => placement === "inbox" || placement === "primary";

export const MAX_SEEDS = 50;

/** A copy not found after this long is recorded as missing. */
export const GIVE_UP_AFTER_MINUTES = 15;

// ── Seeds ─────────────────────────────────────────────────────────────────────

export interface Seed {
  id: string;
  email: string;
  label: string | null;
  /** Linki can read this address's mailbox, so its result needs nobody. */
  readable: boolean;
  created_at: string;
}

export function listSeeds(db: DB, workspaceId: string): Seed[] {
  const rows = db.prepare("SELECT id, email, label, created_at FROM placement_seeds WHERE workspace_id = ? ORDER BY created_at, rowid").all(workspaceId) as Array<Omit<Seed, "readable">>;
  return rows.map((row) => ({ ...row, readable: readerFor(db, workspaceId, row.email) !== null }));
}

/** Add a seed address. Returns the seed, or a sentence saying why not. */
export function addSeed(db: DB, workspaceId: string, input: { email?: unknown; label?: unknown }, userId?: string | null): Seed | string {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter the seed's email address.";
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 80) : null;
  if (db.prepare("SELECT 1 FROM placement_seeds WHERE workspace_id = ? AND email = ?").get(workspaceId, email)) return `${email} is already a seed.`;
  if ((db.prepare("SELECT COUNT(*) AS c FROM placement_seeds WHERE workspace_id = ?").get(workspaceId) as { c: number }).c >= MAX_SEEDS) return `A workspace can have ${MAX_SEEDS} seed addresses.`;
  const id = randomUUID();
  db.prepare("INSERT INTO placement_seeds (id, workspace_id, email, label, created_by) VALUES (?, ?, ?, ?, ?)").run(id, workspaceId, email, label, userId ?? null);
  return listSeeds(db, workspaceId).find((seed) => seed.id === id)!;
}

export function removeSeed(db: DB, workspaceId: string, id: string): boolean {
  return db.prepare("DELETE FROM placement_seeds WHERE id = ? AND workspace_id = ?").run(id, workspaceId).changes > 0;
}

// ── A run ─────────────────────────────────────────────────────────────────────

export interface PlacementTest {
  id: string;
  seed_email: string;
  /** sent: on its way or not looked for yet. checked: has a result. failed: could not be sent. */
  status: "sent" | "checked" | "failed";
  placement: PlacementResult | null;
  folder: string | null;
  auth: AuthResults | null;
  /** Linki reads this seed's mailbox. False: the result is entered by hand. */
  readable: boolean;
  error: string | null;
  sent_at: string | null;
  checked_at: string | null;
}

export interface PlacementRun {
  id: string;
  domain: string;
  /** Null when the mailbox has since been removed. */
  mailbox: { id: string; from_email: string } | null;
  created_at: string;
  tests: PlacementTest[];
}

interface TestRow {
  id: string; run_id: string | null; seed_email: string; status: string; placement: string | null; folder: string | null; auth_json: string | null;
  reader_account_id: string | null; error: string | null; sent_at: string | null; checked_at: string | null; message_id: string | null;
}

function testView(row: TestRow): PlacementTest {
  let auth: AuthResults | null = null;
  try { auth = row.auth_json ? (JSON.parse(row.auth_json) as AuthResults) : null; } catch { /* leave it out */ }
  return {
    id: row.id, seed_email: row.seed_email, status: row.status === "checked" ? "checked" : row.status === "failed" ? "failed" : "sent",
    placement: isPlacementResult(row.placement) ? row.placement : null, folder: row.folder, auth, readable: Boolean(row.reader_account_id),
    error: row.error, sent_at: row.sent_at, checked_at: row.checked_at,
  };
}

const TEST_COLUMNS = "id, run_id, seed_email, status, placement, folder, auth_json, reader_account_id, error, sent_at, checked_at, message_id";

export function readPlacementRun(db: DB, workspaceId: string, runId: string): PlacementRun | null {
  const run = db.prepare(`SELECT r.id, r.domain, r.created_at, r.email_account_id, ea.from_email FROM placement_runs r LEFT JOIN email_accounts ea ON ea.id = r.email_account_id
    WHERE r.id = ? AND r.workspace_id = ?`).get(runId, workspaceId) as { id: string; domain: string; created_at: string; email_account_id: string | null; from_email: string | null } | undefined;
  if (!run) return null;
  const tests = db.prepare(`SELECT ${TEST_COLUMNS} FROM inbox_placement_tests WHERE run_id = ? AND workspace_id = ? ORDER BY rowid`).all(runId, workspaceId) as TestRow[];
  return { id: run.id, domain: run.domain, mailbox: run.email_account_id && run.from_email ? { id: run.email_account_id, from_email: run.from_email } : null, created_at: run.created_at, tests: tests.map(testView) };
}

/** A domain's runs, newest first. */
export function listPlacementRuns(db: DB, workspaceId: string, domain: string | null, limit = 10): PlacementRun[] {
  const ids = (domain
    ? db.prepare("SELECT id FROM placement_runs WHERE workspace_id = ? AND domain = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workspaceId, domain, limit)
    : db.prepare("SELECT id FROM placement_runs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workspaceId, limit)) as Array<{ id: string }>;
  return ids.map(({ id }) => readPlacementRun(db, workspaceId, id)).filter((run): run is PlacementRun => run !== null);
}

export interface StartRunInput {
  workspaceId: string;
  emailAccountId: string;
  /** Leave out to send to every seed. */
  seedIds?: string[];
  userId?: string | null;
}

/**
 * Send a placement test from a mailbox to the workspace's seeds. Returns the run, or a
 * sentence saying why it was not started. A seed the email cannot be sent to (it is on the
 * do-not-contact list, or the server refused it) is recorded as failed and the rest go.
 */
export async function startPlacementRun(input: StartRunInput, db: DB = getDb(), send: typeof sendEmailDurably = sendEmailDurably): Promise<PlacementRun | string> {
  const mailbox = db.prepare("SELECT id, from_email, paused_at, disconnected_at, is_verified FROM email_accounts WHERE id = ? AND workspace_id = ?")
    .get(input.emailAccountId, input.workspaceId) as { id: string; from_email: string; paused_at: string | null; disconnected_at: string | null; is_verified: number | null } | undefined;
  if (!mailbox) return "Choose a mailbox to send the test from.";
  if (mailbox.disconnected_at) return `${mailbox.from_email} cannot sign in, so it cannot send a test.`;
  if (mailbox.paused_at) return `${mailbox.from_email} is paused. Resume it to send a test from it.`;
  const domain = domainOf(mailbox.from_email);
  if (!domain) return "That mailbox has no sending domain.";
  const all = listSeeds(db, input.workspaceId);
  const seeds = input.seedIds ? all.filter((seed) => input.seedIds!.includes(seed.id)) : all;
  if (seeds.length === 0) return all.length === 0 ? "Add at least one seed address first." : "None of those seeds exist.";

  const runId = randomUUID();
  db.prepare("INSERT INTO placement_runs (id, workspace_id, email_account_id, domain, created_by) VALUES (?, ?, ?, ?, ?)").run(runId, input.workspaceId, mailbox.id, domain, input.userId ?? null);
  const insert = db.prepare(`INSERT INTO inbox_placement_tests (id, workspace_id, email_account_id, seed_email, subject, message_id, status, sent_at, run_id, reader_account_id, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const subject = `Placement check ${runId.slice(0, 8)}`;
  for (const seed of seeds) {
    const id = randomUUID();
    const reader = readerFor(db, input.workspaceId, seed.email);
    if (isAddressSuppressed(input.workspaceId, seed.email)) {
      insert.run(id, input.workspaceId, mailbox.id, seed.email, subject, null, "failed", null, runId, reader, "This address is on the do-not-contact list.");
      continue;
    }
    try {
      const receipt = await send({
        workspaceId: input.workspaceId, emailAccountId: mailbox.id, idempotencyKey: `placement:${id}`, source: "placement", to: seed.email, subject,
        body: "This is an inbox placement test sent from Linki, to see which folder mail from this mailbox lands in. No reply is needed.",
      });
      insert.run(id, input.workspaceId, mailbox.id, seed.email, subject, receipt.messageId, "sent", new Date().toISOString().slice(0, 19).replace("T", " "), runId, reader, null);
    } catch (error) {
      insert.run(id, input.workspaceId, mailbox.id, seed.email, subject, null, "failed", null, runId, reader, (error instanceof Error ? error.message : String(error)).slice(0, 300));
    }
  }
  return readPlacementRun(db, input.workspaceId, runId)!;
}

function settle(db: DB, workspaceId: string, runId: string) {
  // Once every copy has a result the run is said in one line in the log.
  const run = readPlacementRun(db, workspaceId, runId);
  if (!run || run.tests.some((test) => test.status === "sent")) return;
  const summary = summarise(run.tests);
  if (summary.checked === 0) return;
  recordGuardEvent({
    workspaceId, kind: "placement_test", domain: run.domain, emailAccountId: run.mailbox?.id ?? null, dedupeKey: `placement:${runId}`,
    tone: summary.spam > 0 ? "warn" : "good",
    title: `Placement test from ${run.mailbox?.from_email ?? run.domain}: ${summary.inbox} of ${summary.checked} in the inbox`,
    detail: [summary.spam ? `${summary.spam} in spam` : null, summary.tabs ? `${summary.tabs} in another tab or folder` : null, summary.missing ? `${summary.missing} not found` : null].filter(Boolean).join(", ") || "None in spam.",
  }, db);
}

/**
 * Look in each readable seed's mailbox for the copies of a run that have no result yet,
 * and record what is found. A copy not found after GIVE_UP_AFTER_MINUTES is recorded as
 * missing. Returns the run as it now stands.
 */
export async function lookForPlacementRun(db: DB, workspaceId: string, runId: string, find: typeof findMessage = findMessage): Promise<PlacementRun | null> {
  const pending = db.prepare(`SELECT ${TEST_COLUMNS} FROM inbox_placement_tests WHERE run_id = ? AND workspace_id = ? AND status = 'sent' AND reader_account_id IS NOT NULL AND message_id IS NOT NULL`)
    .all(runId, workspaceId) as TestRow[];
  for (const test of pending) {
    const reader = db.prepare("SELECT imap_host, imap_port, username, password, imap_username, imap_password, allow_self_signed FROM email_accounts WHERE id = ? AND workspace_id = ?")
      .get(test.reader_account_id, workspaceId) as ReadableMailbox | undefined;
    if (!reader) continue;
    const result = await find(reader, test.message_id!);
    if (result.found) {
      db.prepare("UPDATE inbox_placement_tests SET status = 'checked', placement = ?, folder = ?, auth_json = ?, checked_at = datetime('now') WHERE id = ?")
        .run(result.placement, result.folder, result.auth ? JSON.stringify(result.auth) : null, test.id);
    } else {
      db.prepare(`UPDATE inbox_placement_tests SET status = 'checked', placement = 'missing', checked_at = datetime('now')
        WHERE id = ? AND sent_at <= datetime('now', ?)`).run(test.id, `-${GIVE_UP_AFTER_MINUTES} minutes`);
    }
  }
  settle(db, workspaceId, runId);
  return readPlacementRun(db, workspaceId, runId);
}

/** Enter by hand where a seed's copy landed. Returns the test, or null if the workspace has no such test. */
export function setPlacement(db: DB, workspaceId: string, testId: string, placement: PlacementResult): PlacementTest | null {
  const changed = db.prepare("UPDATE inbox_placement_tests SET placement = ?, status = 'checked', checked_at = datetime('now') WHERE id = ? AND workspace_id = ? AND status != 'failed'")
    .run(placement, testId, workspaceId).changes;
  const row = db.prepare(`SELECT ${TEST_COLUMNS} FROM inbox_placement_tests WHERE id = ? AND workspace_id = ?`).get(testId, workspaceId) as TestRow | undefined;
  if (!row) return null;
  if (changed && row.run_id) settle(db, workspaceId, row.run_id);
  return testView(row);
}

/** Runs with copies still to be found, started recently: what the upkeep loop looks for by itself. */
export async function lookForRecentPlacementRuns(db: DB = getDb(), limit = 3): Promise<number> {
  const runs = db.prepare(`SELECT DISTINCT t.run_id AS id, t.workspace_id FROM inbox_placement_tests t
    WHERE t.status = 'sent' AND t.run_id IS NOT NULL AND t.reader_account_id IS NOT NULL AND t.sent_at >= datetime('now', '-1 day') LIMIT ?`).all(limit) as Array<{ id: string; workspace_id: string }>;
  for (const run of runs) await lookForPlacementRun(db, run.workspace_id, run.id).catch(() => null);
  return runs.length;
}

// ── Figures ───────────────────────────────────────────────────────────────────

export interface PlacementSummary {
  /** Copies sent. */
  sent: number;
  /** Copies with a result. */
  checked: number;
  inbox: number;
  /** Delivered, to a Gmail tab other than Primary or a folder a filter chose. */
  tabs: number;
  spam: number;
  missing: number;
  /** Copies still to be found or entered. */
  waiting: number;
  /** Share of the copies with a result that reached the inbox. Null when none has a result. */
  inbox_rate: number | null;
}

export function summarise(tests: Array<{ status: string; placement: string | null }>): PlacementSummary {
  const sent = tests.filter((test) => test.status !== "failed");
  const checked = sent.filter((test) => test.status === "checked" && test.placement);
  const count = (pick: (placement: string) => boolean) => checked.filter((test) => pick(test.placement!)).length;
  const inbox = count(isInbox);
  const spam = count((placement) => placement === "spam");
  const missing = count((placement) => placement === "missing");
  return {
    sent: sent.length, checked: checked.length, inbox, spam, missing, tabs: checked.length - inbox - spam - missing,
    waiting: sent.length - checked.length, inbox_rate: checked.length ? inbox / checked.length : null,
  };
}

/**
 * How a domain's placement tests came out over the last so many days: every run for the
 * domain, and single tests sent the old way from one of its mailboxes.
 */
export function placementSummary(db: DB, workspaceId: string, domain: string, days: number): PlacementSummary {
  const rows = db.prepare(`SELECT t.status, t.placement FROM inbox_placement_tests t
      LEFT JOIN placement_runs r ON r.id = t.run_id
      LEFT JOIN email_accounts ea ON ea.id = t.email_account_id
    WHERE t.workspace_id = ? AND t.created_at >= datetime('now', ?)
      AND (r.domain = ? OR (t.run_id IS NULL AND lower(substr(ea.from_email, instr(ea.from_email, '@') + 1)) = ?))`)
    .all(workspaceId, `-${Math.max(1, Math.round(days))} days`, domain, domain) as Array<{ status: string; placement: string | null }>;
  return summarise(rows);
}
