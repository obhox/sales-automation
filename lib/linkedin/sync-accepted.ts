import type { Page } from "playwright";
import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";
import { SessionExpiredError, gotoLinkedin } from "@/lib/linkedin/navigation";
import { pollUntil, readAccountStats } from "@/lib/linkedin/dom";
import { profileKey, vanityKey } from "@/lib/linkedin/url";
import { emitDomainEvent } from "@/lib/platform/events";
import { parseStoredTime, sqliteUtc } from "@/lib/outreach/schedule";

/**
 * Accepted-connection sync via the authoritative Voyager connections API.
 *
 * Presence in the account's own connections list is the only proof of a first-degree
 * connection this app accepts. The alternative — scroll the SENT invitations and treat a
 * vanished invite as accepted — was measurably wrong twice over: of 1,600 contacts it once
 * marked connected, 325 were; and when the manual sync button still used it in Aug 2026 it
 * marked 116 contacts connected in a single minute, of whom 15 were (the list it scrolls
 * holds 500+ invitations and loads lazily, so most "vanished" ones had simply not loaded).
 *
 * Sources — re-verified against live LinkedIn on 2026-10-09, NO scrolling:
 *  - DATA: GET /voyager/api/relationships/dash/connections
 *          ?decorationId=…ConnectionListWithProfile-16&q=search
 *          &sortType=RECENTLY_ADDED&start=N&count=100
 *      → included[]: Connection { createdAt(ms), connectedMember } and
 *        Profile { publicIdentifier, entityUrn }. Pages run to an empty page at the end;
 *        the API exposes no total.
 *  - TOTAL (checksum): the connections page's "<N> connections". A full pass is "verified
 *    complete" only when it reached the end of the list AND pulled that many.
 *
 * Behaviour:
 *  - First run, or `mode: "full"` → FULL pass over the whole list. When verified complete it
 *    also un-marks phantom degree=1 contacts absent from the list.
 *  - Later runs → incremental: newest first, stop at the stored boundary (less a 24h
 *    overlap). Incremental and unverified passes are ADD-ONLY — a partial pull must never
 *    wipe a real connection.
 *  - Everything it writes is confined to the account's own workspace, and — when the
 *    workspace has more than one LinkedIn account — to contacts that account worked.
 *    `degree` is "distance from the account that looked"; one account's list says nothing
 *    about another's contacts, and nothing at all about another workspace's.
 */

const ACCEPTED_SYNC_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8h — 3x per day
const PAGE_SIZE = 100;
const MAX_PAGES = 150; // safety cap (15,000 connections)
const OVERLAP_MARGIN_MS = 24 * 60 * 60 * 1000; // re-check a day of overlap (idempotent)
const TOTAL_TOLERANCE = 5; // live churn between reading the total and finishing the pull
// How long one pass may keep paging. The runner calls this under a 180s watchdog that
// abandons the wait but cannot stop the browser work, so the pass has to end itself first.
const DEFAULT_BUDGET_MS = 150_000;
const DECORATION = "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16";

type DB = DatabaseType.Database;

export function shouldSyncAccepted(accountId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT accepted_sync_at FROM accounts WHERE id = ?").get(accountId) as
    | { accepted_sync_at: string | null }
    | undefined;
  const last = parseStoredTime(row?.accepted_sync_at);
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= ACCEPTED_SYNC_INTERVAL_MS;
}

export interface ApiConnection {
  /** `urn:li:fsd_profile:<id>` of the connected member — unique per connection. */
  memberUrn: string | null;
  vanity: string | null;
  createdAt: number; // epoch ms
}

export interface SyncResult {
  /** Contacts newly marked as connected. */
  stamped: number;
  /** Contacts that were marked connected but are not in the account's connections list. */
  unmarked: number;
  pulled: number;
  declaredTotal: number | null;
  fullPass: boolean;
  /** The pull reached the end of the list and matched LinkedIn's own total. */
  verifiedComplete: boolean;
  /** The session was signed out; the account has been flagged for re-authentication. */
  signedOut: boolean;
}

export interface SyncOptions {
  /** `full` re-reads the entire list and reconciles it, regardless of the stored boundary. */
  mode?: "auto" | "full";
  /** Paging time budget. Raise it for a user-triggered full pass on a large network. */
  budgetMs?: number;
}

export async function syncAcceptedConnections(accountId: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const db = getDb();
  const result: SyncResult = {
    stamped: 0, unmarked: 0, pulled: 0, declaredTotal: null, fullPass: false, verifiedComplete: false, signedOut: false,
  };

  const boundaryRow = db.prepare("SELECT connections_synced_through_ms FROM accounts WHERE id = ?").get(accountId) as
    | { connections_synced_through_ms: number | null }
    | undefined;
  const boundary = boundaryRow?.connections_synced_through_ms ?? null;
  result.fullPass = opts.mode === "full" || boundary === null;
  const stopBefore = result.fullPass || boundary === null ? null : boundary - OVERLAP_MARGIN_MS;

  let page: Page | null = null;
  try {
    page = await getSessionPage(accountId);

    // The page header carries the declared total (the completeness checksum), and loading
    // it is also the signed-in check: gotoLinkedin throws on a login wall.
    await gotoLinkedin(page, "https://www.linkedin.com/mynetwork/invite-connect/connections/", 35_000);
    const stats = await pollUntil(page, readAccountStats, (s) => s.connections !== null, 12_000, 500);
    result.declaredTotal = stats.connections;

    const seen = new Map<string, ApiConnection>(); // by member URN — the list can shift under us
    let reachedEnd = false;
    let reachedBoundary = false;
    let apiFailed = false;
    const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);

    for (let pageIdx = 0; pageIdx < MAX_PAGES && !reachedBoundary && Date.now() < deadline; pageIdx++) {
      const start = pageIdx * PAGE_SIZE;
      let conns = await fetchConnectionsPage(page, start, PAGE_SIZE);
      if (conns === null) {
        // One retry: a single throttled or dropped response should not abandon the pass.
        await page.waitForTimeout(5_000);
        conns = await fetchConnectionsPage(page, start, PAGE_SIZE);
      }
      if (conns === null) {
        console.warn(`[sync-accepted] connections API failed at start=${start} — stopping`);
        apiFailed = true;
        break;
      }
      if (conns.length === 0) { reachedEnd = true; break; }

      for (const c of conns) {
        if (stopBefore !== null && c.createdAt < stopBefore) { reachedBoundary = true; break; }
        seen.set(c.memberUrn ?? `${c.vanity}:${c.createdAt}`, c);
      }
      if (!reachedBoundary) await page.waitForTimeout(900 + Math.random() * 700); // gentle, API-only
    }

    const pulled = [...seen.values()];
    result.pulled = pulled.length;
    result.verifiedComplete = result.fullPass && reachedEnd
      && result.declaredTotal !== null && Math.abs(pulled.length - result.declaredTotal) <= TOTAL_TOLERANCE;

    const applied = applyConnections(db, accountId, pulled, { unmarkAbsent: result.verifiedComplete });
    result.stamped = applied.stamped;
    result.unmarked = applied.unmarked;

    if (result.verifiedComplete) {
      console.log(`[sync-accepted] Verified full pass (pulled ${pulled.length}, declared ${result.declaredTotal}). Un-marked ${applied.unmarked} phantom degree=1.`);
    } else if (result.fullPass) {
      console.warn(`[sync-accepted] Full pass NOT verified complete (pulled ${pulled.length}, declared ${result.declaredTotal}, reached end: ${reachedEnd}) — add-only, no un-marking.`);
    }

    // Never advance the boundary past a pass the API cut short. Advancing it after a failed
    // first pass made every later run incremental from "now", so the connections that pass
    // never reached could not be found again. Running out of time or pages is different:
    // that network is simply too large to walk in one go, and incremental sync from here on
    // is still correct — only the phantom clean-up is skipped (it needs a verified pass).
    const newest = pulled.reduce<number | null>((max, c) => (max === null || c.createdAt > max ? c.createdAt : max), null);
    if (!apiFailed && newest !== null && (boundary === null || newest > boundary)) {
      db.prepare("UPDATE accounts SET connections_synced_through_ms = ? WHERE id = ?").run(newest, accountId);
    }
    if (result.declaredTotal !== null) {
      db.prepare("UPDATE accounts SET li_connections = ? WHERE id = ?").run(result.declaredTotal, accountId);
    }
    db.prepare("UPDATE accounts SET accepted_sync_at = datetime('now') WHERE id = ?").run(accountId);
    console.log(`[sync-accepted] Stamped ${result.stamped} accepted, un-marked ${result.unmarked} phantom (pulled ${pulled.length}).`);
  } catch (err) {
    if (!(err instanceof SessionExpiredError)) throw err;
    // Not stamping accepted_sync_at: the sync did not happen, and should run as soon as
    // the account is signed in again.
    console.warn(`[sync-accepted] ${err.message} — flagging re-auth`);
    result.signedOut = true;
    try { await markNeedsReauth(accountId); } catch { /* ignore */ }
  } finally {
    try { await page?.close(); } catch { /* ignore */ }
    if (!result.signedOut) {
      try { await saveSessionState(accountId); } catch { /* ignore */ }
    }
  }

  return result;
}

/**
 * Reconcile contacts against a pull of the account's connections list.
 *
 * Separate from the browser work so the rules — which contacts an account's list may
 * speak for, how a stored URL is matched, when a contact may be un-marked — are testable
 * against a plain database.
 */
export function applyConnections(
  db: DB,
  accountId: string,
  connections: ApiConnection[],
  opts: { unmarkAbsent: boolean },
): { stamped: number; unmarked: number } {
  const account = db.prepare("SELECT workspace_id FROM accounts WHERE id = ?").get(accountId) as
    | { workspace_id: string | null }
    | undefined;
  if (!account?.workspace_id) return { stamped: 0, unmarked: 0 };
  const workspaceId = account.workspace_id;

  // With one LinkedIn account in the workspace every contact's degree is relative to it.
  // With several, this account's list only speaks for the contacts it was assigned.
  const accountsInWorkspace = (db.prepare("SELECT COUNT(*) AS c FROM accounts WHERE workspace_id = ?").get(workspaceId) as { c: number }).c;
  const sharedWorkspace = accountsInWorkspace > 1;
  const scope = sharedWorkspace
    ? `AND EXISTS (SELECT 1 FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
                   WHERE rp.target_id = t.id AND r.account_id = ?)`
    : "";

  const byKey = new Map<string, ApiConnection>();
  for (const c of connections) {
    if (c.vanity) byKey.set(vanityKey(c.vanity), c);
    // A stored URL can also be the opaque-id form, /in/ACoAA…
    const id = c.memberUrn?.split(":").pop();
    if (id) byKey.set(vanityKey(id), c);
  }

  const candidates = db.prepare(
    `SELECT t.id, t.full_name, t.linkedin_url, t.degree, t.connected_at, t.connection_requested_at
     FROM targets t
     WHERE t.workspace_id = ? AND t.linkedin_url LIKE '%/in/%'
       AND (t.connection_requested_at IS NOT NULL OR t.degree = 1) ${scope}`
  ).all(...(sharedWorkspace ? [workspaceId, accountId] : [workspaceId])) as Array<{
    id: string; full_name: string | null; linkedin_url: string;
    degree: number | null; connected_at: string | null; connection_requested_at: string | null;
  }>;

  const stamp = db.prepare("UPDATE targets SET degree = 1, connected_at = ? WHERE id = ?");
  const unmark = db.prepare("UPDATE targets SET degree = NULL, connected_at = NULL WHERE id = ?");
  const newlyConnected: string[] = [];
  let unmarked = 0;

  db.transaction(() => {
    for (const t of candidates) {
      const key = profileKey(t.linkedin_url);
      if (!key) continue;
      const match = byKey.get(key);

      if (match) {
        // Only contacts this app invited are recorded as acceptances; the date is LinkedIn's.
        if (!t.connection_requested_at) continue;
        const acceptedAt = sqliteUtc(match.createdAt);
        if (t.degree === 1 && t.connected_at === acceptedAt) continue;
        const wasConnected = t.degree === 1 && !!t.connected_at;
        stamp.run(acceptedAt, t.id);
        if (!wasConnected) {
          newlyConnected.push(t.id);
          console.log(`[sync-accepted] Accepted: ${t.full_name ?? key}`);
        }
        continue;
      }

      // Absent from a complete list → not a connection. An opaque-id URL cannot be looked
      // up by vanity on older pulls, so it is never un-marked on absence alone.
      if (opts.unmarkAbsent && t.degree === 1 && !/^ac[ow]aa/.test(key)) {
        unmark.run(t.id);
        unmarked++;
      }
    }
  })();

  for (const targetId of newlyConnected) {
    emitDomainEvent({ workspaceId, type: "linkedin.connected", entityType: "target", entityId: targetId, payload: { account_id: accountId } });
  }
  return { stamped: newlyConnected.length, unmarked };
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchConnectionsPage(page: Page, start: number, count: number): Promise<ApiConnection[] | null> {
  return page.evaluate(
    async ({ start, count, decoration }): Promise<ApiConnection[] | null> => {
      const cookies = document.cookie.split("; ").reduce((a: Record<string, string>, c) => {
        const i = c.indexOf("=");
        if (i > 0) a[c.slice(0, i)] = c.slice(i + 1);
        return a;
      }, {});
      const csrf = (cookies["JSESSIONID"] || "").replace(/"/g, "");
      const url =
        `https://www.linkedin.com/voyager/api/relationships/dash/connections` +
        `?decorationId=${decoration}&count=${count}&q=search&sortType=RECENTLY_ADDED&start=${start}`;
      let json: {
        included?: Array<{
          $type?: string;
          entityUrn?: string;
          createdAt?: number;
          connectedMember?: string;
          publicIdentifier?: string;
        }>;
      };
      try {
        const r = await fetch(url, {
          headers: {
            "csrf-token": csrf,
            "accept": "application/vnd.linkedin.normalized+json+2.1",
            "x-restli-protocol-version": "2.0.0",
            "x-li-lang": "en_US",
          },
          credentials: "include",
        });
        if (!r.ok) return null;
        json = await r.json();
      } catch {
        return null;
      }

      const included = json.included || [];
      const vanityByUrn: Record<string, string> = {};
      for (const x of included) {
        if ((x.$type || "").includes("identity.profile.Profile") && x.entityUrn && x.publicIdentifier) {
          vanityByUrn[x.entityUrn] = x.publicIdentifier;
        }
      }
      const out: ApiConnection[] = [];
      for (const x of included) {
        if ((x.$type || "").includes("relationships.Connection") && typeof x.createdAt === "number") {
          const memberUrn = x.connectedMember || null;
          out.push({
            memberUrn,
            createdAt: x.createdAt,
            vanity: memberUrn ? vanityByUrn[memberUrn] ?? null : null,
          });
        }
      }
      out.sort((a, b) => b.createdAt - a.createdAt);
      return out;
    },
    { start, count, decoration: DECORATION }
  );
}
