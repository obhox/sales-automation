import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";

// The reconciliation rules are plain database work; the browser half of the module is not
// loaded here, so no test in this file can launch Chromium.
vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(),
  saveSessionState: vi.fn(),
  markNeedsReauth: vi.fn(),
}));

import { applyConnections, shouldSyncAccepted, type ApiConnection } from "@/lib/linkedin/sync-accepted";

const OTHER_WS = "ws-sync-2";
const SHARED_WS = "ws-sync-shared";

const ACCEPTED_MS = Date.UTC(2026, 6, 20, 14, 30, 0); // 2026-07-20 14:30:00 UTC
const ACCEPTED_AT = "2026-07-20 14:30:00";

let seq = 0;
function workspace(id: string): string {
  getDb().prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(id, id, id);
  return id;
}
/** A workspace with exactly one LinkedIn account — the common case, and the one where the
 *  account's list speaks for every contact in the workspace. */
function solo(): { ws: string; acct: string } {
  const ws = workspace(`ws-sync-solo-${++seq}`);
  return { ws, acct: account(ws) };
}
function account(workspaceId: string): string {
  const id = `sync-acct-${++seq}`;
  getDb().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, ?, ?, 1, ?)")
    .run(id, `Account ${seq}`, `sync${seq}@example.com`, workspaceId);
  return id;
}

function contact(workspaceId: string, url: string, fields: { requested?: boolean; degree?: number | null; connectedAt?: string | null } = {}): string {
  const id = `sync-target-${++seq}`;
  getDb().prepare(
    "INSERT INTO targets (id, workspace_id, full_name, linkedin_url, connection_requested_at, degree, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, workspaceId, `Contact ${seq}`, url, fields.requested === false ? null : "2026-07-20T10:00:00.000Z", fields.degree ?? null, fields.connectedAt ?? null);
  return id;
}

/** Enrol a contact in a run that belongs to `accountId`. */
function assign(accountId: string, targetId: string, workspaceId: string): void {
  const db = getDb();
  const runId = `sync-run-${++seq}`;
  db.prepare("INSERT INTO runs (id, account_id, status, workspace_id) VALUES (?, ?, 'running', ?)").run(runId, accountId, workspaceId);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`sync-rp-${seq}`, runId, targetId);
}

const state = (id: string) =>
  getDb().prepare("SELECT degree, connected_at FROM targets WHERE id = ?").get(id) as { degree: number | null; connected_at: string | null };

const connection = (vanity: string | null, memberId = `ACoAA${vanity ?? "x"}`): ApiConnection =>
  ({ vanity, memberUrn: `urn:li:fsd_profile:${memberId}`, createdAt: ACCEPTED_MS });

beforeAll(() => {
  workspace(OTHER_WS);
  workspace(SHARED_WS);
});

describe("recognising an accepted invitation", () => {
  // The shapes production contacts are actually stored in. Only the last one has the
  // trailing slash the old `LIKE '%/in/<vanity>/%'` match needed, which is why nine people
  // who accepted within three days were written off as "did not accept after 7 days".
  it.each([
    "http://www.linkedin.com/in/samcarter1",
    "https://linkedin.com/in/priyanair1",
    "https://ca.linkedin.com/in/noor-haddad",
    "https://www.linkedin.com/in/Taylor-Brooks?trk=people",
    "https://www.linkedin.com/in/dana-cole-4b675293/",
  ])("matches %s", (url) => {
    const { ws, acct } = solo();
    const db = getDb();
    const id = contact(ws, url);
    const vanity = url.match(/\/in\/([^/?]+)/)![1].toLowerCase();

    expect(applyConnections(db, acct, [connection(vanity)], { unmarkAbsent: false })).toEqual({ stamped: 1, unmarked: 0 });
    expect(state(id)).toEqual({ degree: 1, connected_at: ACCEPTED_AT });
  });

  it("records LinkedIn's acceptance date, not the time of the sync", () => {
    const { ws, acct } = solo();
    const id = contact(ws, "https://www.linkedin.com/in/date-check/");
    applyConnections(getDb(), acct, [connection("date-check")], { unmarkAbsent: false });
    expect(state(id).connected_at).toBe(ACCEPTED_AT);
  });

  it("corrects a wrong acceptance date without counting the contact as newly accepted", () => {
    // The 15 genuine connections that the old manual sync stamped with its own run time.
    const { ws, acct } = solo();
    const id = contact(ws, "https://www.linkedin.com/in/wrong-date/", { degree: 1, connectedAt: "2026-08-09T21:24:07.000Z" });
    expect(applyConnections(getDb(), acct, [connection("wrong-date")], { unmarkAbsent: false })).toEqual({ stamped: 0, unmarked: 0 });
    expect(state(id)).toEqual({ degree: 1, connected_at: ACCEPTED_AT });
  });

  it("does not mistake a longer identifier for a shorter one", () => {
    const { ws, acct } = solo();
    const id = contact(ws, "https://www.linkedin.com/in/jane-doe-12345/");
    applyConnections(getDb(), acct, [connection("jane-doe")], { unmarkAbsent: false });
    expect(state(id).degree).toBeNull();
  });

  it("matches a contact stored by opaque profile id", () => {
    const { ws, acct } = solo();
    const id = contact(ws, "https://www.linkedin.com/in/ACoAABexampleProfileId0000");
    applyConnections(getDb(), acct, [connection("avery", "ACoAABexampleProfileId0000")], { unmarkAbsent: false });
    expect(state(id).degree).toBe(1);
  });

  it("emits linkedin.connected once, for the newly accepted contact", () => {
    const { ws, acct } = solo();
    const id = contact(ws, "https://www.linkedin.com/in/event-check/");
    const count = () => (getDb().prepare("SELECT COUNT(*) AS c FROM domain_events WHERE type = 'linkedin.connected' AND entity_id = ?").get(id) as { c: number }).c;
    applyConnections(getDb(), acct, [connection("event-check")], { unmarkAbsent: false });
    applyConnections(getDb(), acct, [connection("event-check")], { unmarkAbsent: false });
    expect(count()).toBe(1);
  });

  it("leaves a connected contact the app never invited as it found them", () => {
    const { ws, acct } = solo();
    const id = contact(ws, "https://www.linkedin.com/in/old-friend/", { requested: false, degree: 1 });
    expect(applyConnections(getDb(), acct, [connection("old-friend")], { unmarkAbsent: true })).toEqual({ stamped: 0, unmarked: 0 });
    expect(state(id)).toEqual({ degree: 1, connected_at: null });
  });
});

describe("un-marking contacts that are not connections", () => {
  it("un-marks a phantom only when the whole list was read", () => {
    const { ws, acct } = solo();
    const phantom = contact(ws, "https://www.linkedin.com/in/phantom-one/", { degree: 1, connectedAt: "2026-08-09T21:24:07.000Z" });

    // An incremental or unverified pull is add-only: absence from a partial list proves nothing.
    expect(applyConnections(getDb(), acct, [], { unmarkAbsent: false }).unmarked).toBe(0);
    expect(state(phantom).degree).toBe(1);

    expect(applyConnections(getDb(), acct, [connection("somebody-else")], { unmarkAbsent: true }).unmarked).toBe(1);
    expect(state(phantom)).toEqual({ degree: null, connected_at: null });
  });

  it("keeps a real connection on the same pass", () => {
    const { ws, acct } = solo();
    const real = contact(ws, "http://www.linkedin.com/in/real-one", { degree: 1, connectedAt: "2026-08-09T21:24:07.000Z" });
    applyConnections(getDb(), acct, [connection("real-one")], { unmarkAbsent: true });
    expect(state(real)).toEqual({ degree: 1, connected_at: ACCEPTED_AT });
  });

  it("never un-marks a contact stored by opaque id on absence alone", () => {
    const { ws, acct } = solo();
    const id = contact(ws, "https://www.linkedin.com/in/ACoAAZZZunknownid", { degree: 1 });
    applyConnections(getDb(), acct, [connection("somebody-else")], { unmarkAbsent: true });
    expect(state(id).degree).toBe(1);
  });
});

describe("what one account's connections list may speak for", () => {
  it("leaves another workspace's contacts completely alone", () => {
    // The old sync matched and un-marked across the whole table: one tenant's sync could
    // strip every other tenant's connections.
    const { acct } = solo();
    const theirsConnected = contact(OTHER_WS, "https://www.linkedin.com/in/other-tenant-friend/", { degree: 1, connectedAt: ACCEPTED_AT });
    const theirsWaiting = contact(OTHER_WS, "https://www.linkedin.com/in/shared-vanity/");

    applyConnections(getDb(), acct, [connection("shared-vanity")], { unmarkAbsent: true });

    expect(state(theirsConnected)).toEqual({ degree: 1, connected_at: ACCEPTED_AT });
    expect(state(theirsWaiting).degree).toBeNull();
  });

  it("in a workspace with two accounts, only touches the contacts that account worked", () => {
    const mine = account(SHARED_WS);
    const colleague = account(SHARED_WS);
    const myContact = contact(SHARED_WS, "https://www.linkedin.com/in/my-prospect/", { degree: 1, connectedAt: ACCEPTED_AT });
    const theirContact = contact(SHARED_WS, "https://www.linkedin.com/in/colleague-prospect/", { degree: 1, connectedAt: ACCEPTED_AT });
    assign(mine, myContact, SHARED_WS);
    assign(colleague, theirContact, SHARED_WS);

    // My verified list contains neither of them.
    expect(applyConnections(getDb(), mine, [connection("nobody")], { unmarkAbsent: true }).unmarked).toBe(1);
    expect(state(myContact).degree).toBeNull();
    expect(state(theirContact).degree).toBe(1); // my list says nothing about my colleague's contacts
  });

  it("does nothing for an account that no longer exists", () => {
    expect(applyConnections(getDb(), "no-such-account", [connection("x")], { unmarkAbsent: true })).toEqual({ stamped: 0, unmarked: 0 });
  });
});

describe("when the next sync is due", () => {
  const setLast = (id: string, sqlModifier: string | null) =>
    getDb().prepare(`UPDATE accounts SET accepted_sync_at = ${sqlModifier ? "datetime('now', ?)" : "NULL"} WHERE id = ?`)
      .run(...(sqlModifier ? [sqlModifier, id] : [id]));

  it("is due when it has never run, and again after eight hours", () => {
    const { acct } = solo();
    setLast(acct, null);
    expect(shouldSyncAccepted(acct)).toBe(true);
    setLast(acct, "-9 hours");
    expect(shouldSyncAccepted(acct)).toBe(true);
  });

  it("reads the stored time as UTC, so the interval holds on a non-UTC host", () => {
    // datetime('now') has no zone marker. Parsed as local time it lands hours away from the
    // truth on any host that is not on UTC, stretching or collapsing the 8h interval.
    const { acct } = solo();
    setLast(acct, "-1 hours");
    expect(shouldSyncAccepted(acct)).toBe(false);
    setLast(acct, "-7 hours");
    expect(shouldSyncAccepted(acct)).toBe(false);
  });
});
