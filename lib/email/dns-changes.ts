import type DatabaseType from "better-sqlite3";
import { isDkimSelector, type RecordStatus } from "@/lib/email/dns";

// Telling when a sending domain's DNS records have changed between two checks, and
// keeping the one thing about a domain that DNS cannot be asked for: which selector its
// DKIM key is published under.

type DB = DatabaseType.Database;

export type RecordName = "SPF" | "DKIM" | "DMARC" | "MX";

/** A record as a check stored it. */
export interface StoredRecord {
  status?: RecordStatus;
  value?: string | null;
  lookup_failed?: boolean;
}

export type StoredDns = Partial<Record<"spf" | "dkim" | "dmarc" | "mx", StoredRecord | string | null>>;

export interface DnsChange {
  record: RecordName;
  /** added: was missing, is there. removed: was there, is missing. stronger / weaker: its standing changed. updated: its text changed and its standing did not. */
  kind: "added" | "removed" | "stronger" | "weaker" | "updated";
  before: string | null;
  after: string | null;
  /** The domain is worse off for it. */
  worse: boolean;
}

const KEYS: Array<["spf" | "dkim" | "dmarc" | "mx", RecordName]> = [["spf", "SPF"], ["dkim", "DKIM"], ["dmarc", "DMARC"], ["mx", "MX"]];
const RANK: Record<RecordStatus, number> = { fail: 0, weak: 1, pass: 2 };
const tidy = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/**
 * What changed between one check and the next. Nothing is reported for a record either
 * check could not look up, or for an earlier check stored before records had a standing:
 * neither says what the record was.
 */
export function dnsChanges(previous: StoredDns | null | undefined, next: StoredDns): DnsChange[] {
  if (!previous) return [];
  const changes: DnsChange[] = [];
  for (const [key, record] of KEYS) {
    const before = previous[key];
    const after = next[key];
    if (!before || !after || typeof before === "string" || typeof after === "string") continue;
    if (!before.status || !after.status || before.lookup_failed || after.lookup_failed) continue;
    const from = RANK[before.status];
    const to = RANK[after.status];
    const values = { before: tidy(before.value) || null, after: tidy(after.value) || null };
    if (from === to) {
      if (values.before !== values.after && from > 0) changes.push({ record, kind: "updated", ...values, worse: false });
      continue;
    }
    const kind = from === 0 ? "added" : to === 0 ? "removed" : to > from ? "stronger" : "weaker";
    changes.push({ record, kind, ...values, worse: to < from });
  }
  return changes;
}

/** "DMARC record updated on acme.io". */
export function changeTitle(change: DnsChange, domain: string): string {
  switch (change.kind) {
    case "added":
      return `${change.record} record found on ${domain}`;
    case "removed":
      return `${change.record} record is gone from ${domain}`;
    case "stronger":
      return `${change.record} record strengthened on ${domain}`;
    case "weaker":
      return `${change.record} record weakened on ${domain}`;
    default:
      return `${change.record} record updated on ${domain}`;
  }
}

const short = (value: string | null) => (value && value.length > 90 ? `${value.slice(0, 87)}…` : value);

/** What it was and what it is, and what that did to the domain's score. */
export function changeDetail(change: DnsChange, scoreBefore: number | null, scoreAfter: number | null): string {
  const parts: string[] = [];
  if (change.kind === "removed") parts.push(`It was: ${short(change.before) ?? "there"}.`);
  else if (change.kind === "added") parts.push(`Now: ${short(change.after) ?? "there"}.`);
  else parts.push(`Was: ${short(change.before) ?? "unknown"}. Now: ${short(change.after) ?? "unknown"}.`);
  if (scoreBefore !== null && scoreAfter !== null) {
    parts.push(scoreBefore === scoreAfter ? `Domain score still ${scoreAfter}.` : `Domain score ${scoreAfter > scoreBefore ? "improved" : "fell"} from ${scoreBefore} to ${scoreAfter}.`);
  }
  return parts.join(" ");
}

// ── The DKIM selector ─────────────────────────────────────────────────────────

/** The selector someone has entered for a domain, or null. */
export function getDomainSelector(db: DB, workspaceId: string, domain: string): string | null {
  const row = db.prepare("SELECT dkim_selector FROM mail_domains WHERE workspace_id = ? AND domain = ?").get(workspaceId, domain) as { dkim_selector: string | null } | undefined;
  return row?.dkim_selector || null;
}

/** Keep a domain's DKIM selector (empty to forget it). Returns a sentence when it is not a selector. */
export function setDomainSelector(db: DB, workspaceId: string, domain: string, selector: string | null): string | null {
  const value = selector?.trim().toLowerCase() || null;
  if (value && !isDkimSelector(value)) return "A DKIM selector is letters, digits, dots and dashes, such as google or selector1.";
  db.prepare(`INSERT INTO mail_domains (workspace_id, domain, dkim_selector, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(workspace_id, domain) DO UPDATE SET dkim_selector = excluded.dkim_selector, updated_at = datetime('now')`).run(workspaceId, domain, value);
  return null;
}
