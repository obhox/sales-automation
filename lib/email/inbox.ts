import Imap from "imap";
import { simpleParser } from "mailparser";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { premium } from "@/lib/premium";
import { decryptSecret } from "@/lib/crypto";
import { emitDomainEvent } from "@/lib/platform/events";

const IMAP_POLL_INTERVAL_MS = 5 * 60 * 1000; // push/IDLE fallback reconciliation

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

function parseHeaderValue(raw: string, field: string): string {
  const regex = new RegExp(`^${field}:[ \\t]*(.+?)(?=\\r?\\n[^\\s]|$)`, "im");
  const m = raw.match(regex);
  if (!m) return "";
  return m[1].replace(/\r?\n[\t ]+/g, " ").trim();
}

interface EmailAccount {
  id: string;
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
 * Fetches the body + headers for a given UID and inserts a row into
 * `email_replies` (idempotent — skips if a row with the same target_id +
 * received_at already exists). Best-effort: errors are swallowed by the caller.
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

          // Dedup: skip if we already have a row for this target with the same received_at
          const existing = db.prepare(
            "SELECT id FROM email_replies WHERE target_id = ? AND received_at = ?"
          ).get(targetId, receivedAt) as { id: string } | undefined;

          if (existing) { resolve(null); return; }

          // Look up the most recent active run for this target — the dispatcher needs
          // it to find the email track to reschedule / enroll a substitute into.
          const runRow = db.prepare(
            `SELECT r.id FROM runs r
             JOIN run_profiles rp ON rp.run_id = r.id
             WHERE rp.target_id = ? AND r.status IN ('running', 'paused')
             ORDER BY r.created_at DESC LIMIT 1`
          ).get(targetId) as { id: string } | undefined;

          const targetRow = db.prepare("SELECT workspace_id FROM targets WHERE id = ?").get(targetId) as { workspace_id: string } | undefined;
          const replyId = randomUUID();
          db.prepare(
            `INSERT INTO email_replies (id, workspace_id, target_id, run_id, email_account_id, from_email, subject, body_text, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(replyId, targetRow?.workspace_id ?? null, targetId, runRow?.id ?? null, emailAccountId, parsedFrom, subject, bodyText, receivedAt);
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
    .prepare("SELECT id, imap_host, imap_port, username, password, imap_username, imap_password, allow_self_signed, inbox_synced_at FROM email_accounts WHERE id = ?")
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

    const done = () => {
      try { imap.end(); } catch { /* ignore */ }
      resolve();
    };

    imap.once("error", (err: Error) => {
      console.warn(`[email-inbox] IMAP error for account ${emailAccountId}:`, err.message);
      done();
    });

    imap.once("ready", () => {
      imap.openBox("INBOX", true, async (err, box) => {
        if (err || !box) { console.warn("[email-inbox] openBox failed:", err?.message); done(); return; }

        // ── Reply detection: one FROM search per lead ──────────────────────────
        // Run sequentially — the imap library serialises commands over one TCP connection
        for (const target of pendingTargets) {
          await new Promise<void>((resSearch) => {
            imap.search([["FROM", target.email]], async (searchErr, uids) => {
              if (searchErr) { resSearch(); return; }
              if (uids.length > 0) {
                console.log(`[email-inbox] Reply detected for ${target.email} (target ${target.id})`);
                replies++;

                // Capture the body, then let the classifier+dispatcher decide the action.
                // We no longer eagerly stamp email_replied_at here — the dispatcher does it
                // for skip-buckets (call_task / human_reply / not_interested) but leaves it
                // unset for OOO follow-ups so the runner keeps the contact enrolled.
                // On any failure the contact stays enrolled (safe fallback, plan §3.2).
                try {
                  const latestUid = uids[uids.length - 1];
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
              resSearch();
            });
          });
        }

        // ── Bounce detection: scan last 50 messages for mailer-daemon ─────────
        if (box.messages.total > 0) {
          const total = box.messages.total;
          const start = Math.max(1, total - 49);
          const range = `${start}:${total}`;

          await new Promise<void>((resFetch) => {
            const fetch = imap.seq.fetch(range, {
              bodies: ["HEADER.FIELDS (FROM TO)", "TEXT"],
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

                // Also extract Final-Recipient from DSN bodies (SES bounce format)
                const finalRecipient = msg.body.match(/Final-Recipient:\s*rfc822;\s*([^\s\r\n]+)/i)?.[1] ?? "";
                const candidates = extractEmails(msg.body + " " + toRaw + " " + finalRecipient);
                for (const candidate of candidates) {
                  if (BOUNCE_SENDER_PATTERNS.some(p => p.test(candidate))) continue;

                  const target = db
                    .prepare("SELECT id, workspace_id, email_status, company_id FROM targets WHERE lower(email) = ?")
                    .get(candidate) as { id: string; workspace_id: string; email_status: string | null; company_id: string | null } | undefined;

                  if (!target || target.email_status === "invalid") continue;

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

                  console.log(`[email-inbox] Bounce for ${candidate} (target ${target.id}) — marked invalid`);
                  emitDomainEvent({ workspaceId: target.workspace_id, type: "email.bounced", entityType: "contact", entityId: target.id, payload: { email: candidate, company_id: target.company_id } });
                  bounces++;
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
 * Immediately sync every IMAP-configured account in a workspace, ignoring the
 * per-account throttle. Backs the manual "Check for replies now" button.
 */
export async function syncWorkspaceEmailInboxes(workspaceId: string): Promise<{ accounts: number; replies: number; bounces: number; skipped_no_imap: number; no_imap_accounts: Array<{ id: string; from_email: string }>; warning?: string }> {
  const ids = listImapEmailAccountIds(workspaceId);
  // Senders that can send but have no IMAP — silently excluded from reply detection. Surface
  // them so a mailbox that can't receive replies is visible rather than a quiet account drop.
  const noImap = getDb().prepare("SELECT id, from_email FROM email_accounts WHERE workspace_id = ? AND (imap_host IS NULL OR imap_host = '')").all(workspaceId) as Array<{ id: string; from_email: string }>;
  let replies = 0;
  let bounces = 0;
  for (const id of ids) {
    try {
      const r = await syncEmailInbox(id);
      replies += r.replies;
      bounces += r.bounces;
    } catch (e) {
      console.warn(`[email-inbox] workspace sync error for account ${id}:`, e instanceof Error ? e.message : e);
    }
  }
  return {
    accounts: ids.length,
    replies,
    bounces,
    skipped_no_imap: noImap.length,
    no_imap_accounts: noImap,
    ...(noImap.length ? { warning: `${noImap.length} sender(s) have no IMAP and cannot receive replies: ${noImap.map(a => a.from_email).join(", ")}` } : {}),
  };
}
