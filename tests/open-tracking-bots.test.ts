import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { recordProviderEvent } from "@/lib/email/infrastructure";
import { classifyTrackingHit, ipInAnyRange, DEFAULT_PREFETCH_WINDOW_SECONDS } from "@/lib/email/bot-detection";

/**
 * Two things are under test here.
 *
 * 1. Opens are classified before they are stored, so a corporate security gateway fetching
 *    the pixel on delivery cannot be counted as a prospect reading the email.
 * 2. A bot hit does not consume the message's one dedupe slot. Before the classification
 *    split, the first hit won `provider_event_id` outright, so a scanner prefetching two
 *    seconds after the send permanently suppressed the recipient's real open an hour later.
 */

const WS = "ws-openbot-0001";
const ACCOUNT = "acct-openbot-0001";

function seedSend(opts: { sentAt: string; recipient: string }): { jobId: string; messageId: string } {
  const db = getDb();
  const jobId = randomUUID();
  const messageId = `<${jobId}@test.local>`;
  db.prepare(
    `INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, recipient, subject, body_text, email_delivery_mode, track_opens, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'enhanced', 1, 'sent')`,
  ).run(jobId, WS, ACCOUNT, `key-${jobId}`, opts.recipient, "Subject", "Body");
  db.prepare(
    `INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, recipient, subject, message_id, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), WS, jobId, ACCOUNT, opts.recipient, "Subject", messageId, opts.sentAt);
  return { jobId, messageId };
}

function open(send: { jobId: string; messageId: string }, at: string, userAgent?: string) {
  return recordProviderEvent({
    workspaceId: WS,
    provider: "linki",
    providerEventId: `open:${send.jobId}`,
    eventType: "opened",
    messageId: send.messageId,
    occurredAt: at,
    userAgent: userAgent ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  });
}

function storedOpens(messageId: string) {
  return getDb()
    .prepare("SELECT is_bot, bot_reason FROM sender_events WHERE message_id = ? AND event_type = 'opened' ORDER BY occurred_at")
    .all(messageId) as { is_bot: number; bot_reason: string | null }[];
}

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Open Bot WS", "open-bot-ws");
  db.prepare(
    "INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(ACCOUNT, WS, "Sender", "sender@test.com", "smtp.test.com", "user", "pass");
});

describe("classifyTrackingHit", () => {
  it("flags a hit that lands seconds after the send — the security-gateway signature", () => {
    // The reported symptom: 29 of 31 opens landed 1-5s after their send, across dozens of
    // unrelated companies. Nobody reads a cold email that fast, that consistently.
    const verdict = classifyTrackingHit({
      sentAt: "2026-08-24 23:54:13",
      occurredAt: "2026-08-24 23:54:15",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
    expect(verdict.bot).toBe(true);
    expect(verdict.reason).toBe("prefetch");
    expect(verdict.gapSeconds).toBe(2);
  });

  it("leaves a later open alone", () => {
    const verdict = classifyTrackingHit({
      sentAt: "2026-08-24 23:54:13",
      occurredAt: "2026-08-25 09:12:40",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });
    expect(verdict.bot).toBe(false);
    expect(verdict.reason).toBeNull();
  });

  it("names known scanners by user-agent even when the timing looks human", () => {
    for (const ua of [
      "Mimecast Web Gateway",
      "ProofPoint URL Defense",
      "Barracuda-Link-Protect/1.0",
      "Mozilla/5.0 (compatible; BingPreview/1.0b)",
    ]) {
      const verdict = classifyTrackingHit({ sentAt: "2026-08-24 10:00:00", occurredAt: "2026-08-24 14:00:00", userAgent: ua });
      expect(verdict.bot, ua).toBe(true);
      expect(verdict.reason, ua).toBe("scanner_user_agent");
    }
  });

  it("flags generic HTTP clients — a mail client never looks like curl", () => {
    const verdict = classifyTrackingHit({ sentAt: "2026-08-24 10:00:00", occurredAt: "2026-08-24 14:00:00", userAgent: "python-requests/2.31.0" });
    expect(verdict.bot).toBe(true);
    expect(verdict.reason).toBe("automation_user_agent");
  });

  it("does not mistake real Outlook for a Microsoft scanner", () => {
    // Blanket-matching "Microsoft" would delete genuine opens from the most common
    // enterprise mail client there is.
    const verdict = classifyTrackingHit({
      sentAt: "2026-08-24 10:00:00", occurredAt: "2026-08-24 14:00:00",
      userAgent: "Microsoft Outlook 16.0",
    });
    expect(verdict.bot).toBe(false);
  });

  it("treats Gmail's image proxy as a real open — it fetches when a human displays the message", () => {
    const verdict = classifyTrackingHit({
      sentAt: "2026-08-24 10:00:00", occurredAt: "2026-08-24 14:00:00",
      userAgent: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)",
    });
    expect(verdict.bot).toBe(false);
  });

  it("reads SQLite's zone-less timestamps as UTC, so the window is not skewed by host timezone", () => {
    // datetime('now') writes "YYYY-MM-DD HH:MM:SS" with no zone; Date.parse would read that
    // as local time and shift every send by hours on a non-UTC host.
    const verdict = classifyTrackingHit({ sentAt: "2026-08-24 23:54:13", occurredAt: "2026-08-24T23:54:20.000Z" });
    expect(verdict.gapSeconds).toBe(7);
    expect(verdict.bot).toBe(true);
  });

  it("cannot judge timing when the send time is unknown, and says so rather than guessing", () => {
    const verdict = classifyTrackingHit({ sentAt: null, occurredAt: "2026-08-24 23:54:15", userAgent: "Mozilla/5.0" });
    expect(verdict.gapSeconds).toBeNull();
    expect(verdict.bot).toBe(false);
  });

  it("uses a prefetch window of 15 seconds by default", () => {
    expect(DEFAULT_PREFETCH_WINDOW_SECONDS).toBe(15);
  });
});

describe("ipInAnyRange", () => {
  it("matches an address inside a configured CIDR and rejects one outside it", () => {
    expect(ipInAnyRange("40.94.12.7", ["40.94.0.0/16"])).toBe(true);
    expect(ipInAnyRange("41.94.12.7", ["40.94.0.0/16"])).toBe(false);
    expect(ipInAnyRange("::ffff:40.94.12.7", ["40.94.0.0/16"])).toBe(true);
    expect(ipInAnyRange("40.94.12.7", [])).toBe(false);
  });
});

describe("recordProviderEvent — open classification", () => {
  it("stores the verdict and reason on the event rather than discarding the hit", () => {
    const send = seedSend({ sentAt: "2026-08-24 23:54:13", recipient: "scanner@corp.example" });
    const result = open(send, "2026-08-24 23:54:15");
    expect(result.matched).toBe(true);
    expect(result.bot).toBe(true);

    const rows = storedOpens(send.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_bot).toBe(1);
    expect(rows[0].bot_reason).toBe("prefetch");
  });

  it("lets the recipient's real open through after a scanner already prefetched the pixel", () => {
    // This is the regression that matters most: with one dedupe key per message, the
    // gateway's 2-second hit claimed the slot and the human open an hour later was dropped
    // as a duplicate, so a filtered open count would have been zero for every contact
    // behind a security gateway.
    const send = seedSend({ sentAt: "2026-08-24 20:00:00", recipient: "human@corp.example" });
    expect(open(send, "2026-08-24 20:00:03").bot).toBe(true);
    const human = open(send, "2026-08-24 21:30:00");
    expect(human.duplicate).toBe(false);
    expect(human.bot).toBe(false);

    const rows = storedOpens(send.messageId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.is_bot === 0)).toHaveLength(1);
  });

  it("still counts one open per message however many times the pixel is refetched", () => {
    const send = seedSend({ sentAt: "2026-08-24 20:00:00", recipient: "repeat@corp.example" });
    expect(open(send, "2026-08-24 21:00:00").duplicate).toBe(false);
    expect(open(send, "2026-08-24 22:00:00").duplicate).toBe(true);
    expect(storedOpens(send.messageId).filter((r) => r.is_bot === 0)).toHaveLength(1);
  });

  it("carries the verdict into the domain event so webhook subscribers can filter too", () => {
    const send = seedSend({ sentAt: "2026-08-24 18:00:00", recipient: "event@corp.example" });
    open(send, "2026-08-24 18:00:02");
    const row = getDb()
      .prepare("SELECT payload_json FROM domain_events WHERE workspace_id = ? AND type = 'email.opened' ORDER BY occurred_at DESC LIMIT 1")
      .get(WS) as { payload_json: string };
    const payload = JSON.parse(row.payload_json);
    expect(payload.bot).toBe(true);
    expect(payload.bot_reason).toBe("prefetch");
    expect(payload.seconds_after_send).toBe(2);
  });

  it("leaves non-engagement events unclassified — a bounce is a bounce whoever reported it", () => {
    const send = seedSend({ sentAt: "2026-08-24 18:00:00", recipient: "bounce@corp.example" });
    recordProviderEvent({
      workspaceId: WS, provider: "postmark", providerEventId: `bounce:${send.jobId}`,
      eventType: "bounced", messageId: send.messageId, occurredAt: "2026-08-24 18:00:01",
    });
    const row = getDb()
      .prepare("SELECT is_bot, bot_reason, user_agent FROM sender_events WHERE message_id = ? AND event_type = 'bounced'")
      .get(send.messageId) as { is_bot: number; bot_reason: string | null; user_agent: string | null };
    expect(row.is_bot).toBe(0);
    expect(row.bot_reason).toBeNull();
    expect(row.user_agent).toBeNull();
  });
});
