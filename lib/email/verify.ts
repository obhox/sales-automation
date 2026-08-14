import net from "net";
import { resolveMx } from "dns/promises";
import type DatabaseType from "better-sqlite3";
import { addSuppression } from "@/lib/platform/suppression";

type DB = DatabaseType.Database;

/**
 * `valid` and `checked` are deliberately different things, and conflating them is what made
 * verification look broken.
 *
 * `valid`  — a mail server confirmed THIS mailbox exists (SMTP RCPT probe only).
 * `checked` — syntax, domain, MX and disposable checks all passed; the mailbox itself was
 *             never probed. Sendable, and as much as an API that does not probe can ever say.
 * `unknown` — the check could not reach a conclusion (DNS blip, unreachable server).
 */
export type EmailVerifyStatus = "valid" | "checked" | "invalid" | "catch_all" | "unknown";
export interface EmailVerifyResult {
  status: EmailVerifyStatus;
  reason: string;
  /**
   * Set when an `invalid` verdict rests on a third party's claim about the DOMAIN rather than
   * on something we can see for ourselves (bad syntax, disposable list). Those claims are
   * confirmed against our own DNS before anyone is suppressed — a single bad answer from the
   * verification API would otherwise permanently kill real contacts, which has happened here
   * before (see the one-time release migration in lib/db.ts).
   */
  needsDomainConfirmation?: boolean;
}

const VERIFY_BASE_URL = process.env.EMAIL_VERIFY_API_URL || "https://rapid-email-verifier.fly.dev";
const BATCH_SIZE = 100; // API-imposed cap on POST /api/validate/batch

const SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Only these signals mean "this specific mailbox does not exist" — safe to suppress.
// Any other 5xx (reputation, policy, greylist, rate-limit) must NOT be treated as invalid.
const MAILBOX_NOT_FOUND = /5\.1\.1|5\.1\.0|no such (user|recipient|mailbox|address)|user (unknown|not found|does ?n[o']t exist|not (a )?valid)|unknown (user|recipient|address)|recipient (address )?(rejected|not found|unknown|does ?n[o']t exist)|mailbox (unavailable|not found|does ?n[o']t exist)|address (unknown|rejected|does ?n[o']t exist)|does ?n[o']t exist|invalid (recipient|mailbox|address)|unrouteable address|no mailbox/i;
// Domains that always accept-all at RCPT time — probing them tells us nothing, so the worker
// skips the SMTP step. These report `unknown`, NOT `catch_all`: a genuine catch-all is now a
// do-not-send signal, and these are the mailbox providers most of the world uses. Lumping
// them in would suppress every consumer-domain contact in the database.
const ACCEPT_ALL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

/** Maps a verification status to the `targets.email_status` value the runner reads. */
export function emailStatusFor(status: EmailVerifyStatus): string {
  switch (status) {
    case "valid": return "verified";
    case "checked": return "checked";
    case "invalid": return "invalid";
    case "catch_all": return "catchall";
    default: return "unverified";
  }
}

/**
 * Statuses that still warrant a just-in-time SMTP probe before a send.
 *
 * `checked` belongs here: the domain looked fine but nobody asked whether the mailbox exists,
 * which is exactly the case a pre-send probe is for. Leaving it out would let a bulk check
 * silently disable the only step that catches a dead mailbox before it bounces.
 */
export function needsPreSendVerification(emailStatus: string | null | undefined): boolean {
  return !emailStatus || emailStatus === "unverified" || emailStatus === "checked";
}

/**
 * Verdicts that put an address on the do-not-send list.
 *
 * `invalid` is a proven dead mailbox. `catch_all` is a domain that accepted a randomly
 * generated address we invented — so it will accept anything, a delivery there proves
 * nothing, and a real bounce can still come back later as a silent drop or a spam complaint.
 * Both are treated as do-not-send. The source differs so a catch-all suppression can be
 * lifted in bulk without touching a hard-bounce or verification suppression.
 */
export function suppressionSourceFor(status: EmailVerifyStatus): "verification" | "catchall" | null {
  return status === "invalid" ? "verification" : status === "catch_all" ? "catchall" : null;
}

interface RapidResult {
  email: string;
  status: string; // VALID | PROBABLY_VALID | DISPOSABLE | INVALID_FORMAT | INVALID_DOMAIN | NO_MX_RECORDS
}

// The API doesn't do a real mailbox probe (RCPT) — it checks syntax, domain/MX existence and
// disposable lists. That makes it a good NEGATIVE filter and no evidence at all on the
// positive side: "VALID" means "this domain can receive mail", which is true of every address
// at a live domain, existing or not. Reporting that as `valid` is what put a "verified" badge
// on mailboxes that do not exist and then hard-bounced. A positive result therefore returns
// `unknown` — sendable, but never labelled verified. Only an SMTP RCPT probe can do that.
function mapRapidStatus(status: string): EmailVerifyResult {
  switch (status) {
    // Measured, not assumed: the API returns VALID with score 100 and mailbox_exists=true for
    // addresses invented on the spot at a live domain. Its `mailbox_exists` restates MX
    // presence. A positive answer therefore means "nothing disqualifies this address", which
    // is `checked` — never `valid`.
    case "VALID": return { status: "checked", reason: "Domain accepts mail; mailbox not probed" };
    case "PROBABLY_VALID": return { status: "checked", reason: "Role-based mailbox; mailbox not probed" };
    // Determined from the address itself or a static list — nothing to second-guess.
    case "DISPOSABLE": return { status: "invalid", reason: "Disposable email address" };
    case "INVALID_FORMAT": return { status: "invalid", reason: "Invalid email format" };
    // Claims about the domain. Confirmed against our own DNS before suppressing.
    case "INVALID_DOMAIN": return { status: "invalid", reason: "Domain does not exist", needsDomainConfirmation: true };
    case "NO_MX_RECORDS": return { status: "invalid", reason: "Domain has no mail server (no MX record)", needsDomainConfirmation: true };
    default: return { status: "unknown", reason: `Unrecognized verification status (${status})` };
  }
}

/**
 * Second-opinion check on an `invalid` verdict the API based on the domain.
 *
 * Suppression is effectively permanent and applies to a real prospect, so it must not rest on
 * one answer from a free third-party service with no SLA. Our own resolver gets the deciding
 * vote: MX present means do not suppress, a definitive NXDOMAIN/no-records confirms it, and a
 * temporary DNS failure resolves to inconclusive rather than to either extreme.
 */
async function confirmDomainVerdict(addr: string, verdict: EmailVerifyResult): Promise<EmailVerifyResult> {
  if (!verdict.needsDomainConfirmation) return verdict;
  const domain = addr.split("@")[1];
  if (!domain) return verdict;

  try {
    const mx = await resolveMx(domain);
    if (mx.length > 0) {
      return { status: "checked", reason: `Domain resolves with MX — verification API's "${verdict.reason}" not confirmed` };
    }
    return { status: "invalid", reason: verdict.reason };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { status: "invalid", reason: verdict.reason };
    return { status: "unknown", reason: "Domain check inconclusive (temporary DNS error)" };
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
 * Mailbox verification by probe: syntax → MX → SMTP RCPT (with a catch-all test). This is the
 * only path that can return "valid", because it is the only one that asks the receiving
 * server whether the specific mailbox exists.
 *
 * Definitive failures (bad syntax, no MX, hard 5xx RCPT reject) return "invalid". A domain
 * that also accepts an invented address returns "catch_all" — do-not-send. Big consumer
 * providers and unreachable/greylisting servers return "unknown" — sendable but unverified.
 * Never throws.
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

  // `checked`, not `unknown`: syntax, MX and the disposable list all passed, and the only
  // reason the mailbox went unprobed is that this provider accepts every address at RCPT.
  // That is precisely what `checked` means, and reporting it as inconclusive would put a
  // consumer-domain contact back in the bucket that made verification look broken.
  if (ACCEPT_ALL_DOMAINS.has(domain)) return { status: "checked", reason: "Major provider — mailbox cannot be probed" };

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
 * Full verification of one address: the API as a cheap negative filter, then a real SMTP
 * RCPT probe for anything it did not rule out.
 *
 * The probe is not a fallback for API failure — it is the only step that can confirm a
 * mailbox exists, so it runs whenever the API has not already returned a definitive
 * `invalid`. This is the path used just before a send, where the cost of a wrong answer is a
 * bounce against the sending domain's reputation. Bulk paths deliberately do NOT call this
 * (see processVerificationQueue). Never throws.
 */
export async function verifyEmailAddress(email: string, opts: { fromEmail?: string; timeoutMs?: number } = {}): Promise<EmailVerifyResult> {
  const addr = email.trim().toLowerCase();
  const apiResult = await verifyEmailViaApi(addr, opts.timeoutMs ?? 8000);
  if (apiResult?.status === "invalid") {
    const confirmed = await confirmDomainVerdict(addr, apiResult);
    // Only a confirmed dead address short-circuits. If our DNS contradicted the API, fall
    // through to the probe rather than trusting either party.
    if (confirmed.status === "invalid") return confirmed;
  }
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
    const apiVerdict = apiResults.get(key);
    const verdict = apiVerdict
      ? await confirmDomainVerdict(key, apiVerdict)
      : await verifyEmailAddressViaWorker(row.email, { fromEmail: getSender(row.workspace_id) });
    update.run(emailStatusFor(verdict.status), row.id);
    const source = suppressionSourceFor(verdict.status);
    if (source) {
      addSuppression({ workspaceId: row.workspace_id, kind: "email", value: row.email, reason: `Email verification: ${verdict.reason}`, source, targetId: row.id });
    }
  }));
  return rows.length;
}

export interface VerifyBatchResult {
  /** How many addresses were looked at. Named `total` because `checked` is now a verdict. */
  total: number;
  valid: number;
  checked: number;
  invalid: number;
  catch_all: number;
  unknown: number;
  suppressed: number;
}

/**
 * Verify a set of contacts, persist their email_status, and add both definitive invalids and
 * catch-all domains to the do-not-send (suppression) list. Only "unknown" stays sendable.
 */
export async function verifyAndSuppressTargets(
  db: DB,
  workspaceId: string,
  targetIds: string[],
  opts: { fromEmail?: string; createdBy?: string } = {},
): Promise<VerifyBatchResult> {
  const result: VerifyBatchResult = { total: 0, valid: 0, checked: 0, invalid: 0, catch_all: 0, unknown: 0, suppressed: 0 };
  const select = db.prepare("SELECT id, email FROM targets WHERE id = ? AND workspace_id = ?");
  const update = db.prepare("UPDATE targets SET email_status = ? WHERE id = ?");

  const rows = targetIds
    .map((id) => select.get(id, workspaceId) as { id: string; email: string | null } | undefined)
    .filter((row): row is { id: string; email: string } => !!row?.email);
  const apiResults = await verifyEmailBatchViaApi(rows.map((r) => r.email.trim().toLowerCase()), 15000);

  for (const row of rows) {
    const key = row.email.trim().toLowerCase();
    const apiVerdict = apiResults.get(key);
    const verdict = apiVerdict
      ? await confirmDomainVerdict(key, apiVerdict)
      : await verifyEmailAddressViaWorker(row.email, { fromEmail: opts.fromEmail });
    result.total++;
    result[verdict.status]++;
    update.run(emailStatusFor(verdict.status), row.id);
    const source = suppressionSourceFor(verdict.status);
    if (source) {
      addSuppression({ workspaceId, kind: "email", value: row.email, reason: `Email verification: ${verdict.reason}`, source, targetId: row.id, createdBy: opts.createdBy });
      result.suppressed++;
    }
  }
  return result;
}
