import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { recheckDisconnectedMailboxes } from "@/lib/email/connection";
import { domainOf } from "@/lib/email/dns";
import { checkDomainDeliverability } from "@/lib/platform/deliverability";

// The checks that keep what the Mailboxes screen says true without anyone asking: each
// sending domain's DNS records once a day, and each disconnected mailbox every half hour.

type DB = DatabaseType.Database;

/** A domain's records are looked up again once they are this old. */
export const DNS_RECHECK_HOURS = 24;

/** Domains looked up in one pass, so a workspace with many never holds the loop for long. */
const DOMAINS_PER_PASS = 3;

interface DueDomain {
  workspace_id: string;
  domain: string;
  selector: string | null;
}

/** Every sending domain whose last check is older than a day, or that has never had one. Oldest first. */
export function domainsDueForCheck(db: DB = getDb()): DueDomain[] {
  const mailboxes = db.prepare("SELECT DISTINCT workspace_id, from_email FROM email_accounts WHERE workspace_id IS NOT NULL").all() as Array<{ workspace_id: string; from_email: string }>;
  const seen = new Set<string>();
  const due: Array<DueDomain & { checked_at: string | null }> = [];
  const last = db.prepare("SELECT checked_at, details_json, checked_at <= datetime('now', ?) AS stale FROM deliverability_checks WHERE workspace_id = ? AND domain = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1");
  for (const mailbox of mailboxes) {
    const domain = domainOf(mailbox.from_email);
    if (!domain || seen.has(`${mailbox.workspace_id}:${domain}`)) continue;
    seen.add(`${mailbox.workspace_id}:${domain}`);
    const check = last.get(`-${DNS_RECHECK_HOURS} hours`, mailbox.workspace_id, domain) as { checked_at: string; details_json: string | null; stale: number } | undefined;
    if (check && !check.stale) continue;
    due.push({ workspace_id: mailbox.workspace_id, domain, selector: lastSelector(check?.details_json), checked_at: check?.checked_at ?? null });
  }
  return due.sort((a, b) => (a.checked_at ?? "").localeCompare(b.checked_at ?? "")).map(({ workspace_id, domain, selector }) => ({ workspace_id, domain, selector }));
}

/** The DKIM selector the last check found the key under, so the next one looks there first. */
export function lastSelector(detailsJson: string | null | undefined): string | null {
  if (!detailsJson) return null;
  try {
    const selector = (JSON.parse(detailsJson) as { dkim?: { selector?: unknown } }).dkim?.selector;
    return typeof selector === "string" && selector ? selector : null;
  } catch {
    return null;
  }
}

/** Look up the records of the domains that are due. Returns how many were checked. */
export async function recheckDueDomains(db: DB = getDb(), check: typeof checkDomainDeliverability = checkDomainDeliverability): Promise<number> {
  let checked = 0;
  for (const due of domainsDueForCheck(db).slice(0, DOMAINS_PER_PASS)) {
    try {
      await check({ workspaceId: due.workspace_id, domain: due.domain, selector: due.selector ?? undefined });
      checked++;
    } catch (error) {
      console.warn(`[mailbox] DNS check of ${due.domain} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return checked;
}

/** One pass of the mailbox upkeep loop. */
export async function mailboxUpkeep(): Promise<void> {
  const reconnected = await recheckDisconnectedMailboxes();
  if (reconnected > 0) console.log(`[mailbox] ${reconnected} mailbox${reconnected === 1 ? "" : "es"} reconnected`);
  await recheckDueDomains();
}
