import Imap from "imap";
import { simpleParser } from "mailparser";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { premium } from "@/lib/premium";
import { decryptSecret } from "@/lib/crypto";
import { emitDomainEvent } from "@/lib/platform/events";
import { recordInboundBounce } from "@/lib/email/infrastructure";

const IMAP_POLL_INTERVAL_MS = 5 * 60 * 1000; // push/IDLE fallback reconciliation
// Ceiling on one full IMAP session (connect + header scan + bounce scan). Generous:
// it exists to break a hang, not to cut short a large but progressing mailbox scan.
const SESSION_DEADLINE_MS = 90 * 1000;

// How far back a reply can arrive and still be detected. Reply detection reads the FROM
// headers of everything in this window in ONE fetch, so the window costs bandwidth, not
// round trips — unlike the old per-lead SEARCH, whose cost scaled with the campaign.
const REPLY_LOOKBACK_DAYS = 120;
// Ceiling on how many recent messages one pass reads headers for. A mailbox busier than this
// is scanned newest-first; anything older is picked up by the bounce scan or the next pass.
const MAX_HEADER_SCAN = 3000;
// Mailboxes swept at once by the workspace sweep. Sequential meant an 18-mailbox workspace
// waited for the sum of every mailbox; unbounded would open 18 IMAP sessions and 18 TLS
// handshakes at once and hand the origin exactly the load spike that returns 502s.
const ACCOUNT_SWEEP_CONCURRENCY = 4;

const BOUNCE_SENDER_PATTERNS = [
  /mailer-daemon@/i,
  /postmaster@/i,
  /mail-delivery-subsystem@/i,
  /delivery-status@/i,
  /amazonses\.com$/i,
];

function extractEmails(text: string): string[] {
  return [...text.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)].map(m => m[0].toLowerCase());
}

function isBounce(fromEmail: string): boolean {
  return BOUNCE_SENDER_PATTERNS.some(p => p.test(fromEmail));
}

function hashStr(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function parseHeaderValue(raw: string, field: string): string {
  const regex = new RegExp(`^${field}:[ \\t]*(.+?)(?=\\r?\\n[^\\s]|$)`, "im");
  const m = raw.match(regex);
  if (!m) return "";
  return m[1].replace(/\r?\n[\t ]+/g, " ").trim();
}

interface EmailAccount {
  id: string;
  workspace_id: string;
  from_email: string | null;
  imap_host: string | null;
  imap_port: number | null;
  username: string;
  password: string;
  imap_username: string | null;
  imap_password: string | null;
  allow_self_signed: number;
  inbox_synced_at: string | null;
}

/**
 * Fetches the body + headers for a given UID and inserts a row into `email_replies`.
 *
 * Idempotent on the message, not on the contact: the same message is recognised by its
 * Message-ID (falling back to sender + timestamp), so re-ingestion is blocked even when the
 * contact it was filed under has been deleted and recreated under a new id. A row that is
 * already stored but detached from any contact is RE-LINKED to `targetId` rather than skipped
 * — that is the path that brings a reply back into the inbox after the contact is recreated.
 * Best-effort: errors are swallowed by the caller.
 */
export function captureReplyBody(
  imap: Imap,
  db: ReturnType<typeof getDb>,
  targetId: string,
  fromEmail: string,
  uid: number,
  emailAccountId: string,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    // Fetch the full raw RFC822 message — mailparser handles MIME multipart,
    // base64 / quoted-printable transfer encodings, and charset decoding. The
    // old HEADER+TEXT regex approach stored raw base64 / =XX escapes for the
    // common German auto-reply formats, feeding the classifier garbage.
    const fetch = imap.fetch(uid, { bodies: [""], struct: false });

    const chunks: Buffer[] = [];

    fetch.on("message", (msg) => {
      msg.on("body", (stream) => {
        stream.on("data", (c: Buffer) => chunks.push(c));
      });
    });

    fetch.once("error", () => resolve(null));
    fetch.once("end", () => {
      void (async () => {
        try {
          const raw = Buffer.concat(chunks);

          // Never let a warmup message (or its auto-reply) enter the reply inbox — the
          // inbox is for campaign replies only. Warmup mail carries these headers.
          if (raw.toString("latin1", 0, 8000).match(/^X-Linki-Warmup(-Reply-To|-ID)?:/im)) {
            resolve(null);
            return;
          }

          const parsed = await simpleParser(raw);

          const subject = parsed.subject ?? null;
          const parsedFrom =
            parsed.from?.value?.[0]?.address?.toLowerCase().trim() || fromEmail.toLowerCase();
          const receivedAt = parsed.date ? parsed.date.toISOString() : new Date().toISOString();

          // Prefer decoded plain text; fall back to stripping the HTML part.
          const rawText =
            parsed.text ??
            (parsed.html ? parsed.html.replace(/<[^>]+>/g, " ") : "");
          const bodyText = rawText
            .replace(/\r\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/[ \t]{2,}/g, " ")
            .trim()
            .slice(0, 16_000);

          if (!bodyText) { resolve(null); return; }

          const messageId = parsed.messageId?.trim() || null;
          const targetRow = db.prepare("SELECT workspace_id FROM targets WHERE id = ?").get(targetId) as { workspace_id: string } | undefined;

          // Identify the MESSAGE, never the contact. Message-ID is the mail system's own
          // identifier and survives the contact being deleted and recreated; sender +
          // timestamp is the fallback for the (rare) message that carries no Message-ID.
          const existing = (messageId
            ? db.prepare("SELECT id, target_id FROM email_replies WHERE email_account_id = ? AND message_id = ?").get(emailAccountId, messageId)
            : db.prepare("SELECT id, target_id FROM email_replies WHERE email_account_id = ? AND from_email = ? AND received_at = ?").get(emailAccountId, parsedFrom, receivedAt)
          ) as { id: string; target_id: string | null } | undefined;

          if (existing) {
            // Already filed against a live contact — a genuine duplicate, nothing to do.
            if (existing.target_id) { resolve(null); return; }
            // Detached (its contact was deleted). Re-attach it and hand it back so the
            // classifier runs against the contact it now belongs to.
            db.prepare("UPDATE email_replies SET target_id = ?, workspace_id = COALESCE(workspace_id, ?) WHERE id = ?")
              .run(targetId, targetRow?.workspace_id ?? null, existing.id);
            console.log(`[email-inbox] Re-linked detached reply ${existing.id} to target ${targetId}`);
            resolve(existing.id);
            return;
          }

          // Look up the most recent active run for this target — the dispatcher needs
          // it to find the email track to reschedule / enroll a substitute into.
          const runRow = db.prepare(
            `SELECT r.id FROM runs r
             JOIN run_profiles rp ON rp.run_id = r.id
             WHERE rp.target_id = ? AND r.status IN ('running', 'paused')
             ORDER BY r.created_at DESC LIMIT 1`
          ).get(targetId) as { id: string } | undefined;

          const replyId = randomUUID();
          db.prepare(
            `INSERT INTO email_replies (id, workspace_id, target_id, run_id, email_account_id, from_email, subject, body_text, received_at, message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(replyId, targetRow?.workspace_id ?? null, targetId, runRow?.id ?? null, emailAccountId, parsedFrom, subject, bodyText, receivedAt, messageId);
          if (targetRow?.workspace_id) emitDomainEvent({ workspaceId: targetRow.workspace_id, type: "reply.received", entityType: "email_reply", entityId: replyId, payload: { target_id: targetId, from_email: parsedFrom, subject, received_at: receivedAt } });
          resolve(replyId);
        } catch (err) {
          console.warn(`[email-inbox] captureReplyBody parse/insert failed:`, err);
          resolve(null);
        }
      })();
    });
  });
}

export function shouldSyncEmailInbox(emailAccountId: string): boolean {
  const db = getDb();
  const account = db
    .prepare("SELECT inbox_synced_at FROM email_accounts WHERE id = ?")
    .get(emailAccountId) as { inbox_synced_at: string | null } | undefined;
  if (!account?.inbox_synced_at) return true;
  return Date.now() - new Date(account.inbox_synced_at).getTime() >= IMAP_POLL_INTERVAL_MS;
}

/**
 * Opens one IMAP connection, then for each lead that has been emailed but
 * not yet replied, runs a server-side FROM search. Only touches the mailbox
 * index — never downloads message bodies for reply detection.
 *
 * Also scans the last 50 messages for bounces (mailer-daemon etc.).
 */
export async function syncEmailInbox(emailAccountId: string): Promise<{ replies: number; bounces: number }> {
  const db = getDb();

  const account = db
    .prepare("SELECT id, workspace_id, from_email, imap_host, imap_port, username, password, imap_username, imap_password, allow_self_signed, inbox_synced_at FROM email_accounts WHERE id = ?")
    .get(emailAccountId) as EmailAccount | undefined;

  if (!account?.imap_host) {
    console.warn(`[email-inbox] Account ${emailAccountId} has no IMAP config — skipping`);
    return { replies: 0, bounces: 0 };
  }

  // Contacts CURRENTLY OR PREVIOUSLY IN A CAMPAIGN that we emailed from this account and
  // who haven't replied yet. The inbox is a campaign-reply inbox only — never warmup,
  // never manual/one-off sends. Two campaign sources, unioned: (a) leads enrolled in a
  // campaign email step, and (b) campaign emails recorded in the durable mail plane
  // (source='campaign'), so replies still surface after a run is deleted.
  // `IS NOT 'invalid'` is null-safe: a contact with an unset email_status is NOT excluded.
  const pendingTargets = db.prepare(`
    SELECT DISTINCT t.id, t.email FROM targets t
    JOIN run_profiles rp ON rp.target_id = t.id
    JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id
    WHERE t.email IS NOT NULL
      AND t.email_replied_at IS NULL
      AND t.email_status IS NOT 'invalid'
      AND rt.track = 'email'
      AND rt.state NOT IN ('pending')
      AND rp.email_account_id = ?
    UNION
    SELECT DISTINCT t.id, t.email FROM targets t
    JOIN email_jobs ej ON ej.target_id = t.id
    WHERE t.email IS NOT NULL
      AND t.email_replied_at IS NULL
      AND t.email_status IS NOT 'invalid'
      AND ej.email_account_id = ?
      AND ej.source = 'campaign'
      AND ej.status = 'sent'
  `).all(emailAccountId, emailAccountId) as { id: string; email: string }[];

  if (pendingTargets.length === 0) {
    db.prepare("UPDATE email_accounts SET inbox_synced_at = datetime('now') WHERE id = ?").run(emailAccountId);
    return { replies: 0, bounces: 0 };
  }

  console.log(`[email-inbox] Checking ${pendingTargets.length} leads via IMAP FROM search`);

  const imapUser = account.imap_username ?? account.username;
  const imapPass = decryptSecret(account.imap_password) ?? decryptSecret(account.password)!;

  // Every address this workspace sends from. A DSN quotes the original message, so our own
  // sending addresses appear in the body of practically every bounce — they must never be
  // mistaken for the bounced recipient and suppressed.
  const ourAddresses = new Set(
    (db.prepare("SELECT lower(from_email) e FROM email_accounts WHERE workspace_id = ? AND from_email IS NOT NULL").all(account.workspace_id) as { e: string }[])
      .map(r => r.e)
      .concat([account.username.toLowerCase()]),
  );

  let replies = 0;
  let bounces = 0;

  await new Promise<void>((resolve) => {
    const imap = new Imap({
      host: account.imap_host!,
      port: account.imap_port ?? 993,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: account.allow_self_signed !== 1,
        servername: account.imap_host!,
      },
      user: imapUser,
      password: imapPass,
      authTimeout: 10_000,
      connTimeout: 12_000,
    });

    // `done` must be idempotent and must be reachable from EVERY exit path. This promise
    // previously resolved only via the success path or an `error` event: `authTimeout` and
    // `connTimeout` cover connect and auth only, so once `ready` fired a stalled TLS stream
    // left the per-lead search loop awaiting a callback that never came, and the promise
    // never settled. That single hang froze the whole campaign runner for two days.
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { imap.end(); } catch { /* ignore */ }
      resolve();
    };

    // Hard ceiling on the whole session, independent of the caller's own watchdog, so this
    // is safe even when invoked directly (the "Check for replies now" button).
    const deadline = setTimeout(() => {
      console.warn(`[email-inbox] IMAP session for account ${emailAccountId} exceeded ${SESSION_DEADLINE_MS / 1000}s — abandoning`);
      try { imap.destroy(); } catch { /* ignore */ }
      done();
    }, SESSION_DEADLINE_MS);
    deadline.unref?.();

    imap.once("error", (err: Error) => {
      console.warn(`[email-inbox] IMAP error for account ${emailAccountId}:`, err.message);
      done();
    });

    // A socket that closes mid-command resolves nothing on its own — without these the
    // pending search callback is simply orphaned.
    imap.once("end", done);
    imap.once("close", done);

    imap.once("ready", () => {
      imap.openBox("INBOX", true, async (err, box) => {
        if (err || !box) { console.warn("[email-inbox] openBox failed:", err?.message); done(); return; }

        // ── Reply detection: ONE header scan answers the whole pending set ────
        // This was previously one IMAP SEARCH per pending lead, serialised over the single
        // connection the protocol gives us: a campaign with 400 leads meant 400 round trips
        // per mailbox, and an 18-mailbox workspace took ~16 minutes for what is seconds of
        // real work — while pinning the origin hard enough to return 502s to everything else.
        // One `SEARCH SINCE` plus one headers-only FETCH answers the same question for every
        // lead at once, so the cost scales with recent mailbox traffic, not with campaign size.
        //
        // The tradeoff is the lookback window: a reply older than REPLY_LOOKBACK_DAYS is no
        // longer detected, where the per-lead search scanned the mailbox back to its first
        // message. Replies that old are not actionable, and the window is far wider than any
        // sequence's follow-up horizon.
        const targetsByEmail = new Map<string, { id: string; email: string }>();
        for (const t of pendingTargets) targetsByEmail.set(t.email.toLowerCase(), t);

        const since = new Date(Date.now() - REPLY_LOOKBACK_DAYS * 86_400_000);
        const candidateUids = await new Promise<number[]>((resSearch) => {
          imap.search([["SINCE", since]], (searchErr, uids) => resSearch(searchErr || !uids ? [] : uids));
        });

        // Newest-first cap: a mailbox with more recent mail than one pass will read gets its
        // newest slice now and the remainder on the next pass.
        const scanUids = candidateUids.slice(-MAX_HEADER_SCAN);

        // sender address -> highest (newest) UID from that sender
        const latestUidByEmail = new Map<string, number>();

        if (scanUids.length > 0) {
          await new Promise<void>((resScan) => {
            const fetch = imap.fetch(scanUids, { bodies: "HEADER.FIELDS (FROM)", struct: false });
            const pending: Promise<void>[] = [];

            fetch.on("message", (msg) => {
              let uid = 0;
              msg.on("attributes", (attrs) => { uid = attrs.uid; });
              // The body stream's `end` and the message's own `end` race. Whichever arrives
              // first settles this message, reading whatever header bytes have landed — so a
              // message that emits no body part cannot strand the batch, and one whose
              // message-end wins the race is still matched on the data it did deliver.
              pending.push(new Promise<void>((resMsg) => {
                const chunks: Buffer[] = [];
                let handled = false;
                const finish = () => {
                  if (handled) return;
                  handled = true;
                  const fromRaw = parseHeaderValue(Buffer.concat(chunks).toString(), "From");
                  const emailMatch = fromRaw.match(/<([^>]+)>/) ?? fromRaw.match(/([^\s]+@[^\s]+)/);
                  const from = emailMatch?.[1]?.toLowerCase().trim();
                  if (from && targetsByEmail.has(from)) {
                    const prev = latestUidByEmail.get(from);
                    if (prev === undefined || uid > prev) latestUidByEmail.set(from, uid);
                  }
                  resMsg();
                };
                msg.on("body", (stream) => {
                  stream.on("data", (c: Buffer) => chunks.push(c));
                  stream.once("end", finish);
                });
                // Deferred a tick so a body stream that ends in the same turn wins the race.
                msg.once("end", () => setImmediate(finish));
              }));
            });

            fetch.once("error", () => resScan());
            fetch.once("end", () => { void Promise.allSettled(pending).then(() => resScan()); });
          });
        }

        for (const [fromEmail, latestUid] of latestUidByEmail) {
          const target = targetsByEmail.get(fromEmail)!;
          console.log(`[email-inbox] Reply detected for ${target.email} (target ${target.id})`);
          replies++;

          // Capture the body, then let the classifier+dispatcher decide the action.
          // We no longer eagerly stamp email_replied_at here — the dispatcher does it
          // for skip-buckets (call_task / human_reply / not_interested) but leaves it
          // unset for OOO follow-ups so the runner keeps the contact enrolled.
          // On any failure the contact stays enrolled (safe fallback, plan §3.2).
          try {
            const replyId = await captureReplyBody(imap, db, target.id, target.email, latestUid, emailAccountId);
            // The reply is always stored. Classification and automatic follow-up
            // run only when a reply processor is configured.
            if (replyId && premium?.replies) {
              await premium.replies.classifyAndDispatch(replyId);
            }
          } catch (err) {
            console.warn(`[email-inbox] Failed to capture/dispatch reply for ${target.email}:`, err);
          }
        }

        // ── Bounce detection: scan last 50 messages for mailer-daemon ─────────
        if (box.messages.total > 0) {
          const total = box.messages.total;
          const start = Math.max(1, total - 49);
          const range = `${start}:${total}`;

          await new Promise<void>((resFetch) => {
            const fetch = imap.seq.fetch(range, {
              // MESSAGE-ID identifies the DSN itself, which is what makes recording it
              // idempotent. Sequence numbers cannot serve that purpose — they shift as mail
              // arrives, and this range is re-read on every poll.
              bodies: ["HEADER.FIELDS (FROM TO MESSAGE-ID DATE)", "TEXT"],
              struct: false,
            });

            type RawMsg = { header: string; body: string };
            const msgs: RawMsg[] = [];

            fetch.on("message", (msg) => {
              const entry: RawMsg = { header: "", body: "" };
              msg.on("body", (stream, info) => {
                const chunks: Buffer[] = [];
                stream.on("data", (c: Buffer) => chunks.push(c));
                stream.once("end", () => {
                  const text = Buffer.concat(chunks).toString();
                  if (info.which.startsWith("HEADER")) entry.header = text;
                  else entry.body = text.slice(0, 3000);
                });
              });
              msg.once("end", () => msgs.push(entry));
            });

            fetch.once("error", () => resFetch());
            fetch.once("end", () => {
              for (const msg of msgs) {
                const fromRaw = parseHeaderValue(msg.header, "From");
                const toRaw = parseHeaderValue(msg.header, "To");

                const emailMatch = fromRaw.match(/<([^>]+)>/) ?? fromRaw.match(/([^\s]+@[^\s]+)/);
                const fromEmail = emailMatch?.[1]?.toLowerCase().trim();
                if (!fromEmail || !isBounce(fromEmail)) continue;

                const dsnMessageId = parseHeaderValue(msg.header, "Message-ID") || `seq-fallback:${hashStr(msg.header + msg.body)}`;

                // Also extract Final-Recipient from DSN bodies (SES bounce format)
                const finalRecipient = msg.body.match(/Final-Recipient:\s*rfc822;\s*([^\s\r\n]+)/i)?.[1] ?? "";
                // Final-Recipient is the DSN's own statement of which address failed, so it
                // outranks a scrape of the body — the body also contains our own sending
                // address, the postmaster, and anything quoted from the original message.
                const authoritative = finalRecipient.trim().toLowerCase();
                const scraped = extractEmails(msg.body + " " + toRaw + " " + finalRecipient);
                const candidates = authoritative && !BOUNCE_SENDER_PATTERNS.some(p => p.test(authoritative))
                  ? [authoritative, ...scraped.filter(c => c !== authoritative)]
                  : scraped;

                for (const candidate of candidates) {
                  if (BOUNCE_SENDER_PATTERNS.some(p => p.test(candidate))) continue;
                  // Never suppress ourselves: our own from_email appears in most DSN bodies
                  // (it was the original sender), and suppressing it would silently kill the
                  // mailbox for every future send.
                  if (ourAddresses.has(candidate)) continue;

                  const target = db
                    .prepare("SELECT id, workspace_id, email_status, company_id FROM targets WHERE lower(email) = ?")
                    .get(candidate) as { id: string; workspace_id: string; email_status: string | null; company_id: string | null } | undefined;

                  // The Final-Recipient is trustworthy on its own. Anything merely scraped
                  // out of the body is only acted on when it matches a contact we know, which
                  // is what keeps quoted third-party addresses out of the suppression list.
                  const trusted = candidate === authoritative;
                  if (!trusted && !target) continue;

                  // Recorded even when the contact is already invalid, and even when there is
                  // no contact row at all. The suppression entry and the sender-health event
                  // are the durable half of this — `targets.email_status` is per-contact and
                  // does not survive a re-import, which is how a dead address gets re-sent to.
                  const outcome = recordInboundBounce({
                    workspaceId: target?.workspace_id ?? account.workspace_id,
                    emailAccountId,
                    recipient: candidate,
                    targetId: target?.id,
                    companyId: target?.company_id,
                    detail: `Hard bounce received at ${account.from_email ?? emailAccountId}`,
                    dedupeKey: `${emailAccountId}:${dsnMessageId}:${candidate}`,
                  });
                  if (outcome.recorded) bounces++;

                  if (!target || target.email_status === "invalid") break;

                  const note = `Email bounced on ${new Date().toISOString().slice(0, 10)} — marked invalid`;
                  db.prepare(`
                    UPDATE targets SET email_status = 'invalid',
                      notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END
                    WHERE id = ?
                  `).run(note, note, target.id);

                  db.prepare(`
                    UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Email bounced — invalid address'
                    WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)
                    AND state IN ('pending', 'in_progress')
                  `).run(target.id);

                  if (target.company_id) {
                    const companyNote = `Email domain flagged invalid — bounce for ${candidate} on ${new Date().toISOString().slice(0, 10)}`;
                    db.prepare(`
                      UPDATE companies SET email_domain_invalid = 1,
                        notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END
                      WHERE id = ?
                    `).run(companyNote, companyNote, target.company_id);

                    const siblings = db.prepare(`
                      SELECT id FROM targets WHERE company_id = ? AND id != ? AND email IS NOT NULL AND email_status != 'invalid'
                    `).all(target.company_id, target.id) as { id: string }[];

                    for (const sibling of siblings) {
                      const sibNote = `Email bounced on ${new Date().toISOString().slice(0, 10)} — marked invalid (domain flagged via company)`;
                      db.prepare(`
                        UPDATE targets SET email_status = 'invalid',
                          notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END
                        WHERE id = ?
                      `).run(sibNote, sibNote, sibling.id);
                      db.prepare(`
                        UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Email domain invalid — company flagged'
                        WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)
                        AND state IN ('pending', 'in_progress')
                      `).run(sibling.id);
                    }

                    if (siblings.length > 0) {
                      console.log(`[email-inbox] Company ${target.company_id} flagged — ${siblings.length} sibling(s) marked invalid`);
                    }
                  }

                  console.log(`[email-inbox] Bounce for ${candidate} (target ${target.id}) — suppressed and marked invalid`);
                  break;
                }
              }
              resFetch();
            });
          });
        }

        done();
      });
    });

    imap.connect();
  });

  // Stamped on every outcome, including a timeout or a connection error. This is a THROTTLE,
  // not a success marker: when it was only advanced on success, a mailbox that hung left it
  // untouched, so the next poll retried immediately and hung again — the stall reproduced
  // itself across restarts. A persistently broken mailbox now backs off to one attempt per
  // IMAP_POLL_INTERVAL_MS instead of monopolising every pass.
  db.prepare("UPDATE email_accounts SET inbox_synced_at = datetime('now') WHERE id = ?").run(emailAccountId);
  return { replies, bounces };
}

/** Every email account with IMAP configured (used by the always-on poller). */
export function listImapEmailAccountIds(workspaceId?: string): string[] {
  const db = getDb();
  const rows = workspaceId
    ? db.prepare("SELECT id FROM email_accounts WHERE workspace_id = ? AND imap_host IS NOT NULL AND imap_host != ''").all(workspaceId)
    : db.prepare("SELECT id FROM email_accounts WHERE imap_host IS NOT NULL AND imap_host != ''").all();
  return (rows as { id: string }[]).map((r) => r.id);
}

/**
 * Re-attaches replies that lost their contact (the contact was deleted) to a contact in the
 * same workspace with the same email address — which is what recreating a deleted contact
 * produces, under a new id. Without this, a reply captured before the deletion stays detached
 * forever: it is not re-ingested (the message is already stored, by Message-ID) and it is not
 * filed against the new contact (nothing ever looked).
 *
 * Matching is on email address only, and only within the reply's own workspace.
 * Returns the number of replies re-linked.
 */
export function relinkDetachedReplies(workspaceId: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE email_replies
    SET target_id = (
      SELECT t.id FROM targets t
      WHERE t.workspace_id = email_replies.workspace_id
        AND lower(t.email) = lower(email_replies.from_email)
      ORDER BY t.created_at DESC LIMIT 1
    )
    WHERE workspace_id = ?
      AND target_id IS NULL
      AND EXISTS (
        SELECT 1 FROM targets t
        WHERE t.workspace_id = email_replies.workspace_id
          AND lower(t.email) = lower(email_replies.from_email)
      )
  `).run(workspaceId);
  if (result.changes > 0) {
    console.log(`[email-inbox] Re-linked ${result.changes} detached repl${result.changes === 1 ? "y" : "ies"} in workspace ${workspaceId}`);
  }
  return result.changes;
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Immediately sync every IMAP-configured account in a workspace, ignoring the
 * per-account throttle. Backs the manual "Check for replies now" button.
 */
export async function syncWorkspaceEmailInboxes(workspaceId: string): Promise<{ accounts: number; replies: number; bounces: number; relinked: number; skipped_no_imap: number; no_imap_accounts: Array<{ id: string; from_email: string }>; warning?: string }> {
  const ids = listImapEmailAccountIds(workspaceId);
  // Senders that can send but have no IMAP — silently excluded from reply detection. Surface
  // them so a mailbox that can't receive replies is visible rather than a quiet account drop.
  const noImap = getDb().prepare("SELECT id, from_email FROM email_accounts WHERE workspace_id = ? AND (imap_host IS NULL OR imap_host = '')").all(workspaceId) as Array<{ id: string; from_email: string }>;

  // Before touching IMAP: anything already stored but detached that now has a matching
  // contact again is filed immediately, with no mailbox round trip at all.
  let relinked = relinkDetachedReplies(workspaceId);

  let replies = 0;
  let bounces = 0;
  // Mailboxes are independent, so they sweep in parallel — but capped, because 18 concurrent
  // IMAP sessions is itself a load spike on the origin. Counters are only touched after each
  // await, and Node runs this on one thread, so the increments cannot interleave.
  await mapWithConcurrency(ids, ACCOUNT_SWEEP_CONCURRENCY, async (id) => {
    try {
      const r = await syncEmailInbox(id);
      replies += r.replies;
      bounces += r.bounces;
    } catch (e) {
      console.warn(`[email-inbox] workspace sync error for account ${id}:`, e instanceof Error ? e.message : e);
    }
  });

  // And again afterwards: a reply captured during this sweep for a contact that was deleted
  // mid-flight is detached on insert and would otherwise wait for the next sweep.
  relinked += relinkDetachedReplies(workspaceId);

  return {
    accounts: ids.length,
    replies,
    bounces,
    relinked,
    skipped_no_imap: noImap.length,
    no_imap_accounts: noImap,
    ...(noImap.length ? { warning: `${noImap.length} sender(s) have no IMAP and cannot receive replies: ${noImap.map(a => a.from_email).join(", ")}` } : {}),
  };
}
