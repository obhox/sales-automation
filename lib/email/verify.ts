import net from "net";
import { resolveMx } from "dns/promises";
import type DatabaseType from "better-sqlite3";
import { addSuppression } from "@/lib/platform/suppression";

type DB = DatabaseType.Database;

export type EmailVerifyStatus = "valid" | "invalid" | "catch_all" | "unknown";
export interface EmailVerifyResult { status: EmailVerifyStatus; reason: string }

const SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Only these signals mean "this specific mailbox does not exist" — safe to suppress.
// Any other 5xx (reputation, policy, greylist, rate-limit) must NOT be treated as invalid.
const MAILBOX_NOT_FOUND = /5\.1\.1|5\.1\.0|no such (user|recipient|mailbox|address)|user (unknown|not found|does ?n[o']t exist|not (a )?valid)|unknown (user|recipient|address)|recipient (address )?(rejected|not found|unknown|does ?n[o']t exist)|mailbox (unavailable|not found|does ?n[o']t exist)|address (unknown|rejected|does ?n[o']t exist)|does ?n[o']t exist|invalid (recipient|mailbox|address)|unrouteable address|no mailbox/i;
// Domains that always accept-all at RCPT time — probing them tells us nothing, so we
// skip the SMTP step and report catch_all (send anyway; rely on bounce detection).
const ACCEPT_ALL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

/** Maps a verification status to the `targets.email_status` value the runner reads. */
export function emailStatusFor(status: EmailVerifyStatus): string {
  return status === "valid" ? "verified" : status === "invalid" ? "invalid" : status === "catch_all" ? "catchall" : "unverified";
}

/**
 * Best-effort mailbox verification: syntax → MX → SMTP RCPT probe (with a catch-all
 * test). Definitive failures (bad syntax, no MX, hard 5xx RCPT reject) return "invalid".
 * Big consumer providers and unreachable/greylisting servers return "catch_all"/"unknown"
 * — treated as sendable. Never throws.
 */
export async function verifyEmailAddress(email: string, opts: { fromEmail?: string; timeoutMs?: number } = {}): Promise<EmailVerifyResult> {
  const addr = email.trim().toLowerCase();
  if (!SYNTAX.test(addr)) return { status: "invalid", reason: "Invalid email format" };
  const domain = addr.split("@")[1];

  let mx: { exchange: string; priority: number }[];
  try {
    mx = await resolveMx(domain);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Only a real "this domain/record does not exist" is a definitive failure. A DNS
    // timeout, SERVFAIL, or rate-limit (common under bursty lookups) is inconclusive —
    // never suppress a real domain because our own DNS hiccuped.
    if (code === "ENOTFOUND" || code === "ENODATA") return { status: "invalid", reason: "Domain cannot receive email (no MX record)" };
    return { status: "unknown", reason: "Could not resolve domain (temporary DNS error)" };
  }
  if (!mx.length) return { status: "invalid", reason: "Domain has no mail server (no MX record)" };

  if (ACCEPT_ALL_DOMAINS.has(domain)) return { status: "catch_all", reason: "Major provider — accepts all at connect time" };

  const host = mx.slice().sort((a, b) => a.priority - b.priority)[0].exchange;
  const fromEmail = opts.fromEmail && SYNTAX.test(opts.fromEmail) ? opts.fromEmail : `postmaster@${domain}`;
  try {
    return await smtpProbe(host, fromEmail, addr, domain, opts.timeoutMs ?? 8000);
  } catch {
    return { status: "unknown", reason: "Mailbox check inconclusive (server unreachable)" };
  }
}

function smtpProbe(host: string, fromEmail: string, target: string, domain: string, timeoutMs: number): Promise<EmailVerifyResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection(25, host);
    socket.setTimeout(timeoutMs);
    let stage = 0;
    let rcptCode = 0;
    let rcptText = "";
    let buffer = "";
    const heloDomain = fromEmail.split("@")[1] || domain;
    const randomAddr = `no-such-user-verify-${Math.abs(hashStr(target + host))}@${domain}`;
    const finish = (result: EmailVerifyResult) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
    const send = (line: string) => { try { socket.write(line + "\r\n"); } catch { finish({ status: "unknown", reason: "SMTP write failed" }); } };

    socket.on("timeout", () => finish({ status: "unknown", reason: "Mailbox check timed out" }));
    socket.on("error", () => finish({ status: "unknown", reason: "SMTP connection error" }));
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      // Wait for a complete final reply line (code followed by a space, not a hyphen).
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] ?? "";
      if (!/^\d{3} /.test(last)) return; // still receiving a multi-line reply
      const code = parseInt(last.slice(0, 3), 10);
      buffer = "";

      switch (stage) {
        case 0:
          if (code !== 220) return finish({ status: "unknown", reason: "No SMTP greeting" });
          stage = 1; send(`EHLO ${heloDomain}`); break;
        case 1:
          stage = 2; send(`MAIL FROM:<${fromEmail}>`); break;
        case 2:
          if (code >= 400) return finish({ status: "unknown", reason: "Server refused the check" });
          stage = 3; send(`RCPT TO:<${target}>`); break;
        case 3:
          rcptCode = code;
          rcptText = last;
          stage = 4; send(`RCPT TO:<${randomAddr}>`); break;
        case 4: {
          const catchAllOk = code >= 200 && code < 300;
          send("QUIT");
          if (rcptCode >= 200 && rcptCode < 300) {
            return finish(catchAllOk
              ? { status: "catch_all", reason: "Domain accepts all addresses" }
              : { status: "valid", reason: "Mailbox exists" });
          }
          // Only suppress on an explicit "no such mailbox" signal. Every other rejection
          // (reputation, policy, greylist, rate limit) is inconclusive → left sendable.
          if (rcptCode >= 500 && MAILBOX_NOT_FOUND.test(rcptText)) {
            return finish({ status: "invalid", reason: `Mailbox does not exist (${rcptCode})` });
          }
          return finish({ status: "unknown", reason: `Could not confirm mailbox (${rcptCode})` });
        }
        default:
          finish({ status: "unknown", reason: "Unexpected SMTP flow" });
      }
    });
  });
}

function hashStr(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

/** Cache a workspace's verified sender address for the SMTP MAIL FROM (per process call). */
function senderResolver(db: DB) {
  const cache = new Map<string, string | undefined>();
  const stmt = db.prepare("SELECT from_email FROM email_accounts WHERE workspace_id = ? AND is_verified = 1 AND from_email IS NOT NULL ORDER BY created_at LIMIT 1");
  return (workspaceId: string): string | undefined => {
    if (!cache.has(workspaceId)) cache.set(workspaceId, (stmt.get(workspaceId) as { from_email: string } | undefined)?.from_email);
    return cache.get(workspaceId);
  };
}

/** Number of contacts still queued for background verification (for progress display). */
export function pendingVerificationCount(db: DB, workspaceId: string): number {
  return (db.prepare("SELECT COUNT(*) c FROM targets WHERE workspace_id = ? AND email_verify_requested_at IS NOT NULL").get(workspaceId) as { c: number }).c;
}

/**
 * Process one batch of the background verification queue (contacts a user queued via the
 * "Verify emails" action). Verifies concurrently, persists status + verified_at, clears the
 * queue flag, and suppresses definitive invalids. Runs from the global runner loop so the
 * user never has to wait on the page. Returns how many were processed.
 */
export async function processVerificationQueue(db: DB, opts: { limit?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 20;
  const rows = db.prepare(
    `SELECT id, email, workspace_id FROM targets
     WHERE email_verify_requested_at IS NOT NULL AND email IS NOT NULL
     ORDER BY email_verify_requested_at LIMIT ?`
  ).all(limit) as { id: string; email: string; workspace_id: string }[];
  if (!rows.length) return 0;

  const getSender = senderResolver(db);
  const update = db.prepare("UPDATE targets SET email_status = ?, email_verified_at = datetime('now'), email_verify_requested_at = NULL WHERE id = ?");

  await Promise.all(rows.map(async (row) => {
    const verdict = await verifyEmailAddress(row.email, { fromEmail: getSender(row.workspace_id) });
    update.run(emailStatusFor(verdict.status), row.id);
    if (verdict.status === "invalid") {
      addSuppression({ workspaceId: row.workspace_id, kind: "email", value: row.email, reason: `Email verification: ${verdict.reason}`, source: "verification", targetId: row.id });
    }
  }));
  return rows.length;
}

export interface VerifyBatchResult {
  checked: number;
  valid: number;
  invalid: number;
  catch_all: number;
  unknown: number;
  suppressed: number;
}

/**
 * Verify a set of contacts, persist their email_status, and add DEFINITIVE invalids to
 * the do-not-send (suppression) list. Catch-all / unknown are left sendable.
 */
export async function verifyAndSuppressTargets(
  db: DB,
  workspaceId: string,
  targetIds: string[],
  opts: { fromEmail?: string; createdBy?: string } = {},
): Promise<VerifyBatchResult> {
  const result: VerifyBatchResult = { checked: 0, valid: 0, invalid: 0, catch_all: 0, unknown: 0, suppressed: 0 };
  const select = db.prepare("SELECT id, email FROM targets WHERE id = ? AND workspace_id = ?");
  const update = db.prepare("UPDATE targets SET email_status = ? WHERE id = ?");

  for (const id of targetIds) {
    const row = select.get(id, workspaceId) as { id: string; email: string | null } | undefined;
    if (!row?.email) continue;
    const verdict = await verifyEmailAddress(row.email, { fromEmail: opts.fromEmail });
    result.checked++;
    result[verdict.status]++;
    update.run(emailStatusFor(verdict.status), id);
    if (verdict.status === "invalid") {
      addSuppression({ workspaceId, kind: "email", value: row.email, reason: `Email verification: ${verdict.reason}`, source: "verification", targetId: id, createdBy: opts.createdBy });
      result.suppressed++;
    }
  }
  return result;
}
