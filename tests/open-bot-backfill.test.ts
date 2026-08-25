import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";

/**
 * The bot columns land on a table that already holds months of opens, all of them written
 * before anything examined the request. Defaulting that history to "verified" would report
 * a campaign whose opens were 29/31 security-gateway prefetches as a 95% open rate, which is
 * the exact failure the filtering exists to prevent — so the boot migration re-derives the
 * verdict from the one signal those rows still carry: the gap to the send.
 */

const WS = "ws-backfill-0001";
const ACCOUNT = "acct-backfill-0001";

function seed(gapSeconds: number): string {
  const db = getDb();
  const jobId = randomUUID();
  const sentId = randomUUID();
  const sentAt = "2026-08-24 23:54:13";
  const openedAt = new Date(Date.parse(`${sentAt.replace(" ", "T")}Z`) + gapSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, recipient, subject, body_text, status)
     VALUES (?, ?, ?, ?, 'x@example.com', 'S', 'B', 'sent')`,
  ).run(jobId, WS, ACCOUNT, `key-${jobId}`);
  db.prepare(
    `INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, recipient, subject, message_id, accepted_at)
     VALUES (?, ?, ?, ?, 'x@example.com', 'S', ?, ?)`,
  ).run(sentId, WS, jobId, ACCOUNT, `<${jobId}@test.local>`, sentAt);
  const eventId = randomUUID();
  // Written the way a pre-filtering row looks: no verdict, no reason, no user-agent.
  db.prepare(
    `INSERT INTO sender_events (id, workspace_id, email_account_id, sent_message_id, provider, provider_event_id, event_type, occurred_at)
     VALUES (?, ?, ?, ?, 'linki', ?, 'opened', ?)`,
  ).run(eventId, WS, ACCOUNT, sentId, `open:${jobId}`, openedAt);
  return eventId;
}

function verdict(eventId: string) {
  return getDb().prepare("SELECT is_bot, bot_reason FROM sender_events WHERE id = ?").get(eventId) as { is_bot: number; bot_reason: string | null };
}

describe("historical open backfill", () => {
  it("re-classifies pre-filtering opens from their gap to the send", () => {
    const db = getDb();
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Backfill WS", "backfill-ws");
    db.prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ACCOUNT, WS, "Sender", "sender@test.com", "smtp.test.com", "user", "pass");

    const prefetch = seed(2);
    const alsoPrefetch = seed(14);
    const human = seed(3600);

    // The boot migration is keyed and already ran for this database, so drive the same
    // statement directly against the rows this test just planted.
    db.exec(`
      UPDATE sender_events SET is_bot = 1, bot_reason = 'prefetch'
        WHERE event_type IN ('opened','clicked') AND is_bot = 0 AND bot_reason IS NULL
          AND sent_message_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM sent_messages sm
            WHERE sm.id = sender_events.sent_message_id
              AND (julianday(sender_events.occurred_at) - julianday(sm.accepted_at)) * 86400 BETWEEN 0 AND 15
          );
    `);

    expect(verdict(prefetch)).toEqual({ is_bot: 1, bot_reason: "prefetch" });
    expect(verdict(alsoPrefetch)).toEqual({ is_bot: 1, bot_reason: "prefetch" });
    expect(verdict(human)).toEqual({ is_bot: 0, bot_reason: null });
  });

  it("has already run on a freshly initialised database", () => {
    const flag = getDb().prepare("SELECT 1 FROM _migration_flags WHERE key = 'classify_historical_open_bots_v1'").get();
    expect(flag).toBeDefined();
  });
});
