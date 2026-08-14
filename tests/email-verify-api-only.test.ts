import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { emailStatusFor, needsPreSendVerification, verifyAndSuppressTargets } from "@/lib/email/verify";
import { getDb } from "@/lib/db";

/**
 * The verification API cannot probe mailboxes — measured, not assumed: it returns
 * VALID / score 100 / mailbox_exists=true for addresses invented on the spot at a live
 * domain. These tests pin the consequences of that:
 *
 *  - a positive API answer is `checked`, never `verified`
 *  - `checked` does not switch off the pre-send SMTP probe
 *  - an `invalid` verdict that rests on the API's claim about the DOMAIN is confirmed
 *    against our own DNS before anyone is suppressed
 */

const RESOLVE_MX = vi.hoisted(() => vi.fn());
vi.mock("dns/promises", () => ({ resolveMx: RESOLVE_MX }));

function apiResponse(status: string) {
  return {
    ok: true,
    json: async () => ({ results: [{ email: "person@example.com", status }] }),
  } as Response;
}

describe("email status mapping", () => {
  it("never reports a verified mailbox from an API that cannot probe one", () => {
    expect(emailStatusFor("checked")).toBe("checked");
    expect(emailStatusFor("checked")).not.toBe("verified");
  });

  it("reserves 'verified' for the SMTP probe verdict", () => {
    expect(emailStatusFor("valid")).toBe("verified");
  });

  it("still probes before sending to an address the bulk check only domain-checked", () => {
    expect(needsPreSendVerification("checked")).toBe(true);
    expect(needsPreSendVerification("unverified")).toBe(true);
    expect(needsPreSendVerification(null)).toBe(true);
    // Already probed, or already ruled out — no repeat probe.
    expect(needsPreSendVerification("verified")).toBe(false);
    expect(needsPreSendVerification("invalid")).toBe(false);
    expect(needsPreSendVerification("catchall")).toBe(false);
  });
});

describe("how each status is presented", () => {
  it("does not render a healthy checked address as a warning", async () => {
    const { emailStatusBadge } = await import("@/lib/email-status");
    const checked = emailStatusBadge("checked");
    // The old UI showed anything not "verified" in amber, which is what made a working
    // check look broken. `checked` is a normal outcome and must not read as a problem.
    expect(checked.className).not.toContain("warning");
    expect(checked.className).toContain("success");
    expect(checked.label).toBe("checked");
  });

  it("distinguishes never-checked from checked-but-inconclusive", async () => {
    const { emailStatusBadge } = await import("@/lib/email-status");
    expect(emailStatusBadge(null).label).toBe("unchecked");
    expect(emailStatusBadge("unverified").label).toBe("inconclusive");
    expect(emailStatusBadge(null).icon).not.toBe(emailStatusBadge("unverified").icon);
  });

  it("keeps do-not-send states visually distinct from sendable ones", async () => {
    const { emailStatusBadge } = await import("@/lib/email-status");
    expect(emailStatusBadge("invalid").className).toContain("error");
    expect(emailStatusBadge("catchall").className).toContain("warning");
    expect(emailStatusBadge("verified").className).toContain("success");
  });
});

describe("domain-verdict confirmation before suppression", () => {
  const db = getDb();

  beforeEach(() => {
    RESOLVE_MX.mockReset();
    db.prepare("DELETE FROM targets WHERE id = 't-1'").run();
    db.prepare("DELETE FROM suppressions WHERE workspace_id = 'ws-1'").run();
    db.prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('ws-1', 'WS', 'ws-1')").run();
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES ('t-1', 'ws-1', 'Person', 'person@example.com')").run();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not suppress when our own DNS contradicts the API", async () => {
    // API says the domain is dead; our resolver finds MX. A free third-party service with no
    // SLA must not be able to permanently kill a real prospect on one bad answer.
    vi.stubGlobal("fetch", vi.fn(async () => apiResponse("INVALID_DOMAIN")));
    RESOLVE_MX.mockResolvedValue([{ exchange: "mx.example.com", priority: 10 }]);

    const result = await verifyAndSuppressTargets(db, "ws-1", ["t-1"]);

    expect(result.suppressed).toBe(0);
    expect(result.invalid).toBe(0);
    expect(result.checked).toBe(1);
    const row = db.prepare("SELECT email_status FROM targets WHERE id = 't-1'").get() as { email_status: string };
    expect(row.email_status).toBe("checked");
  });

  it("suppresses when our own DNS confirms the domain is dead", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => apiResponse("INVALID_DOMAIN")));
    const err = Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    RESOLVE_MX.mockRejectedValue(err);

    const result = await verifyAndSuppressTargets(db, "ws-1", ["t-1"]);

    expect(result.invalid).toBe(1);
    expect(result.suppressed).toBe(1);
  });

  it("treats a temporary DNS failure as inconclusive rather than suppressing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => apiResponse("NO_MX_RECORDS")));
    const err = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    RESOLVE_MX.mockRejectedValue(err);

    const result = await verifyAndSuppressTargets(db, "ws-1", ["t-1"]);

    expect(result.suppressed).toBe(0);
    expect(result.unknown).toBe(1);
  });

  it("suppresses a disposable address without asking DNS", async () => {
    // Determined from a static list, not a claim about the domain — nothing to second-guess.
    vi.stubGlobal("fetch", vi.fn(async () => apiResponse("DISPOSABLE")));

    const result = await verifyAndSuppressTargets(db, "ws-1", ["t-1"]);

    expect(result.invalid).toBe(1);
    expect(result.suppressed).toBe(1);
    expect(RESOLVE_MX).not.toHaveBeenCalled();
  });
});
