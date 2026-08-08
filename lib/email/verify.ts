import net from "net";
import { resolveMx } from "dns/promises";
import type DatabaseType from "better-sqlite3";
import { addSuppression } from "@/lib/platform/suppression";

type DB = DatabaseType.Database;

export type EmailVerifyStatus = "valid" | "invalid" | "catch_all" | "unknown";
export interface EmailVerifyResult { status: EmailVerifyStatus; reason: string }

const VERIFY_BASE_URL = process.env.EMAIL_VERIFY_API_URL || "https://rapid-email-verifier.fly.dev";
const BATCH_SIZE = 100; // API-imposed cap on POST /api/validate/batch

const SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Only these signals mean "this specific mailbox does not exist" — safe to suppress.
// Any other 5xx (reputation, policy, greylist, rate-limit) must NOT be treated as invalid.
const MAILBOX_NOT_FOUND = /5\.1\.1|5\.1\.0|no such (user|recipient|mailbox|address)|user (unknown|not found|does ?n[o']t exist|not (a )?valid)|unknown (user|recipient|address)|recipient (address )?(rejected|not found|unknown|does ?n[o']t exist)|mailbox (unavailable|not found|does ?n[o']t exist)|address (unknown|rejected|does ?n[o']t exist)|does ?n[o']t exist|invalid (recipient|mailbox|address)|unrouteable address|no mailbox/i;
// Domains that always accept-all at RCPT time — probing them tells us nothing, so the
// worker fallback skips the SMTP step and reports catch_all (send anyway).
const ACCEPT_ALL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

/** Maps a verification status to the `targets.email_status` value the runner reads. */
export function emailStatusFor(status: EmailVerifyStatus): string {
  return status === "valid" ? "verified" : status === "invalid" ? "invalid" : status === "catch_all" ? "catchall" : "unverified";
}

interface RapidResult {
  email: string;
  status: string; // VALID | PROBABLY_VALID | DISPOSABLE | INVALID_FORMAT | INVALID_DOMAIN | NO_MX_RECORDS
}

// The API doesn't do a real mailbox probe (RCPT), so it can't report a genuine catch-all
// signal — only syntax/domain/MX/disposable checks. Role-based addresses ("admin@…") come
// back PROBABLY_VALID; treat them as sendable rather than a distinct ambiguous bucket.
function mapRapidStatus(status: string): EmailVerifyResult {
  switch (status) {
    case "VALID": return { status: "valid", reason: "Mailbox address is valid" };
    case "PROBABLY_VALID": return { status: "valid", reason: "Role-based mailbox, likely deliverable" };
    case "DISPOSABLE": return { status: "invalid", reason: "Disposable email address" };
    case "INVALID_FORMAT": return { status: "invalid", reason: "Invalid email format" };
    case "INVALID_DOMAIN": return { status: "invalid", reason: "Domain does not exist" };
    case "NO_MX_RECORDS": return { status: "invalid", reason: "Domain has no mail server (no MX record)" };
    default: return { status: "unknown", reason: `Unrecognized verification status (${status})` };
  }
}

/** Single-email call to the rapid-email-verifier API. Returns null on any failure (network, timeout, non-2xx, bad body) so the caller can fall back to the worker. */
async function verifyEmailViaApi(addr: string, timeoutMs: number): Promise<EmailVerifyResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${VERIFY_BASE_URL}/api/validate?email=${encodeURIComponent(addr)}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RapidResult;
    return mapRapidStatus(data.status);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Batch call to the rapid-email-verifier API, chunked to its 100-email cap. Emails missing from the returned map (API/chunk failure) are left for the caller to fall back on. */
async function verifyEmailBatchViaApi(emails: string[], timeoutMs: number): Promise<Map<string, EmailVerifyResult>> {
  const results = new Map<string, EmailVerifyResult>();
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const chunk = emails.slice(i, i + BATCH_SIZE);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${VERIFY_BASE_URL}/api/validate/batch`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ emails: chunk }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Verification API error (${res.status})`);
      const data = (await res.json()) as { results: RapidResult[] };
      for (const r of data.results) results.set(r.email, mapRapidStatus(r.status));
    } catch {
      // Leave this chunk's emails unmapped — caller falls back to the worker per address.
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}

/**
 * Best-effort mailbox verification: syntax → MX → SMTP RCPT probe (with a catch-all test).
 * This is the fallback path used only when the rapid-email-verifier API is unreachable.
 * Definitive failures (bad syntax, no MX, hard 5xx RCPT reject) return "invalid". Big
 * consumer providers and unreachable/greylisting servers return "catch_all"/"unknown" —
 * treated as sendable. Never throws.
 */
async function verifyEmailAddressViaWorker(email: string, opts: { fromEmail?: string; timeoutMs?: number } = {}): Promise<EmailVerifyResult> {
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

/**
 * Mailbox verification, primarily via the rapid-email-verifier API (syntax, domain/MX
 * existence, disposable detection). If the API call fails for any reason — network error,
 * timeout, non-2xx, bad body — falls back to the local DNS+SMTP worker probe. Never throws.
 */
export async function verifyEmailAddress(email: string, opts: { fromEmail?: string; timeoutMs?: number } = {}): Promise<EmailVerifyResult> {
  const addr = email.trim().toLowerCase();
  const apiResult = await verifyEmailViaApi(addr, opts.timeoutMs ?? 8000);
  if (apiResult) return apiResult;
  return verifyEmailAddressViaWorker(addr, opts);
}

/** Cache a workspace's verified sender address, used as SMTP MAIL FROM by the worker fallback. */
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
 * "Verify emails" action). Verifies via one batched API call, falling back to the DNS+SMTP
 * worker per-address for anything the API couldn't resolve. Persists status + verified_at,
 * clears the queue flag, and suppresses definitive invalids. Runs from the global runner loop
 * so the user never has to wait on the page. Returns how many were processed.
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
  const apiResults = await verifyEmailBatchViaApi(rows.map((r) => r.email.trim().toLowerCase()), 15000);

  await Promise.all(rows.map(async (row) => {
    const key = row.email.trim().toLowerCase();
    const verdict = apiResults.get(key) ?? await verifyEmailAddressViaWorker(row.email, { fromEmail: getSender(row.workspace_id) });
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

  const rows = targetIds
    .map((id) => select.get(id, workspaceId) as { id: string; email: string | null } | undefined)
    .filter((row): row is { id: string; email: string } => !!row?.email);
  const apiResults = await verifyEmailBatchViaApi(rows.map((r) => r.email.trim().toLowerCase()), 15000);

  for (const row of rows) {
    const key = row.email.trim().toLowerCase();
    const verdict = apiResults.get(key) ?? await verifyEmailAddressViaWorker(row.email, { fromEmail: opts.fromEmail });
    result.checked++;
    result[verdict.status]++;
    update.run(emailStatusFor(verdict.status), row.id);
    if (verdict.status === "invalid") {
      addSuppression({ workspaceId, kind: "email", value: row.email, reason: `Email verification: ${verdict.reason}`, source: "verification", targetId: row.id, createdBy: opts.createdBy });
      result.suppressed++;
    }
  }
  return result;
}
