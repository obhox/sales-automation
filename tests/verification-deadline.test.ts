import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { VERIFY_ADDRESS_TIMEOUT_MS, processVerificationQueue, verifyAndSuppressTargets } from "@/lib/email/verify";
import { pruneRetiredLeases, readRunnerHealth } from "@/lib/system/health";

/**
 * Two ways the background work went quiet in production on 2026-10-14:
 *
 *  - an address whose DNS lookup never answered held the verification loop for hours, with
 *    1,000+ contacts queued behind it and no log line;
 *  - two leases left by an older version of the app (`global-runner`, `support-runner`)
 *    read as "stalled" for ever, which hid that real stall in the health summary.
 */

const RESOLVE_MX = vi.hoisted(() => vi.fn());
vi.mock("dns/promises", () => ({ resolveMx: RESOLVE_MX }));

const db = getDb();
const WS = "ws-verify-deadline";

/** One address never gets a DNS answer; every other domain resolves at once. */
function hangOn(domain: string) {
  RESOLVE_MX.mockImplementation((asked: string) =>
    asked === domain ? new Promise(() => { /* never settles */ }) : Promise.resolve([{ exchange: `mx.${asked}`, priority: 10 }]));
}

beforeEach(() => {
  RESOLVE_MX.mockReset();
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, 'Verify deadline', ?)").run(WS, WS);
  db.prepare("DELETE FROM targets WHERE workspace_id = ?").run(WS);
  db.prepare("DELETE FROM suppressions WHERE workspace_id = ?").run(WS);
  // The API is down, so every address takes the DNS + SMTP path.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("verification API unreachable"); }));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an address that never answers", () => {
  it("is reported unverified instead of holding the queue", async () => {
    hangOn("hang.example");
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, email, email_verify_requested_at) VALUES ('vd-hung', ?, 'Hung', 'a@hang.example', datetime('now', '-2 minutes'))").run(WS);
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, email, email_verify_requested_at) VALUES ('vd-fine', ?, 'Fine', 'b@gmail.com', datetime('now', '-1 minutes'))").run(WS);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const pass = processVerificationQueue(db);
    await vi.advanceTimersByTimeAsync(VERIFY_ADDRESS_TIMEOUT_MS + 1_000);

    await expect(pass).resolves.toBe(2);
    const rows = db.prepare("SELECT id, email_status, email_verify_requested_at AS queued FROM targets WHERE workspace_id = ? ORDER BY id").all(WS) as Array<{ id: string; email_status: string; queued: string | null }>;
    // Both left the queue; the one that timed out is sendable but unverified, never suppressed.
    expect(rows).toEqual([
      { id: "vd-fine", email_status: "checked", queued: null },
      { id: "vd-hung", email_status: "unverified", queued: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) c FROM suppressions WHERE workspace_id = ?").get(WS)).toEqual({ c: 0 });
  });

  it("is counted unknown by the on-demand check as well", async () => {
    hangOn("hang.example");
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES ('vd-hung', ?, 'Hung', 'a@hang.example')").run(WS);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const check = verifyAndSuppressTargets(db, WS, ["vd-hung"]);
    await vi.advanceTimersByTimeAsync(VERIFY_ADDRESS_TIMEOUT_MS + 1_000);
    const result = await check;

    expect(result).toMatchObject({ total: 1, unknown: 1, suppressed: 0 });
  });
});

describe("leases of loops that no longer exist", () => {
  const lease = (name: string, ago: string) =>
    db.prepare("INSERT OR REPLACE INTO worker_leases (name, owner_id, expires_at, heartbeat_at) VALUES (?, 'test', datetime('now', '+1 minute'), datetime('now', ?))").run(name, ago);

  afterEach(() => { db.prepare("DELETE FROM worker_leases").run(); });

  it("are removed, and no longer make the runners read as stalled", () => {
    lease("linkedin-runner", "-1 minutes");
    lease("global-runner", "-87 days");
    lease("support-runner", "-87 days");
    expect(readRunnerHealth(db).status).toBe("degraded");

    expect(pruneRetiredLeases(db)).toBe(2);

    expect(readRunnerHealth(db)).toMatchObject({ status: "healthy", summary: "All runners healthy" });
  });

  it("leaves a loop that is merely stalled for the health watch to report", () => {
    lease("verification-runner", "-98 minutes");

    expect(pruneRetiredLeases(db)).toBe(0);

    expect(readRunnerHealth(db)).toMatchObject({ status: "degraded", summary: "Email verification stalled" });
  });
});
