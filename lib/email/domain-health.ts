import type DatabaseType from "better-sqlite3";

// How mail from one sending domain has been received: what its mailboxes sent, and what
// bounced or was reported as spam. Kept apart from the screens' overviews so the DNS
// check can ask without pulling them in.

type DB = DatabaseType.Database;

export interface DomainRates {
  /** Emails of every kind accepted by a mail server from the domain's mailboxes. */
  sent: number;
  bounces: number;
  complaints: number;
  /** Null when nothing was sent: there is no rate to speak of. */
  bounce_rate: number | null;
  complaint_rate: number | null;
}

/** SQL for "this mailbox sends from that domain". */
export const ON_DOMAIN = "lower(substr(ea.from_email, instr(ea.from_email, '@') + 1)) = ?";

export function mailboxIdsOnDomain(db: DB, workspaceId: string, domain: string): string[] {
  return (db.prepare(`SELECT ea.id FROM email_accounts ea WHERE ea.workspace_id = ? AND ${ON_DOMAIN}`).all(workspaceId, domain) as Array<{ id: string }>).map((row) => row.id);
}

/** The domain's figures over the last so many days. The counts are the ones a mailbox's guard goes by, added up. */
export function domainRates(db: DB, workspaceId: string, domain: string, days = 30): DomainRates {
  const ids = mailboxIdsOnDomain(db, workspaceId, domain);
  if (ids.length === 0) return { sent: 0, bounces: 0, complaints: 0, bounce_rate: null, complaint_rate: null };
  const marks = ids.map(() => "?").join(",");
  const since = `-${Math.max(1, Math.round(days))} days`;
  const sent = (db.prepare(`SELECT COUNT(*) AS c FROM sent_messages WHERE email_account_id IN (${marks}) AND accepted_at >= datetime('now', ?)`).get(...ids, since) as { c: number }).c;
  const events = db.prepare(`SELECT COUNT(CASE WHEN event_type = 'bounced' THEN 1 END) AS bounces, COUNT(CASE WHEN event_type = 'complained' THEN 1 END) AS complaints
    FROM sender_events WHERE email_account_id IN (${marks}) AND occurred_at >= datetime('now', ?)`).get(...ids, since) as { bounces: number; complaints: number };
  return { sent, bounces: events.bounces, complaints: events.complaints, bounce_rate: sent ? events.bounces / sent : null, complaint_rate: sent ? events.complaints / sent : null };
}
