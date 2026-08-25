import { describe, it, expect, beforeAll, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/api-keys";
import { addSuppression } from "@/lib/platform/suppression";
import { recordProviderEvent } from "@/lib/email/infrastructure";
import handler from "@/pages/api/v1/[...path]";

/**
 * Covers the two new outbound-email actions on the public v1 API — POST /contacts/verify
 * and POST /contacts/{id}/send — plus the new read-only GET /email_accounts resource and
 * the email:send scope that gates sending. All three reuse Linki's own battle-tested
 * verification (lib/email/verify) and delivery (lib/email/infrastructure) functions rather
 * than reimplementing anything.
 */

// verifyAndSuppressTargets calls the rapid-email-verifier API via fetch, then falls back to
// a DNS+SMTP worker for anything unresolved. Mocking fetch (and dns/promises, in case a test
// needs domain confirmation) keeps this test offline, matching tests/email-verify-api-only.test.ts.
const RESOLVE_MX = vi.hoisted(() => vi.fn());
vi.mock("dns/promises", () => ({ resolveMx: RESOLVE_MX }));

// sendEmailDurably -> dispatchEmailJob -> sendEmail (lib/email/sender) opens a real SMTP
// socket. Mocking sendEmail keeps the send-path tests offline while still exercising the
// real queueing/idempotency/suppression logic in lib/email/infrastructure.
const SEND_EMAIL = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/sender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/sender")>();
  return { ...actual, sendEmail: SEND_EMAIL };
});

const WS = "ws-v1-outbound-0001";

let writeAndSendKey: string;
let writeOnlyKey: string;
let readKey: string;

let disposableTargetId: string;
let plausibleTargetId: string;
let suppressedTargetId: string;
let sendableTargetId: string;
let noEmailTargetId: string;

let verifiedAccountId: string;

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(WS, "Outbound WS", "outbound-ws");

  writeAndSendKey = createApiKey({ workspaceId: WS, name: "write+send", scopes: ["contacts:write", "email:send", "campaigns:read"] }).key;
  writeOnlyKey = createApiKey({ workspaceId: WS, name: "write-only", scopes: ["contacts:write"] }).key;
  readKey = createApiKey({ workspaceId: WS, name: "reader", scopes: ["campaigns:read"] }).key;

  disposableTargetId = "t-disposable";
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES (?, ?, ?, ?)")
    .run(disposableTargetId, WS, "Dead Mailbox", "dead@mailinator.com");

  plausibleTargetId = "t-plausible";
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES (?, ?, ?, ?)")
    .run(plausibleTargetId, WS, "Plausible Person", "plausible@example.com");

  suppressedTargetId = "t-suppressed";
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES (?, ?, ?, ?)")
    .run(suppressedTargetId, WS, "Suppressed Person", "suppressed@example.com");
  addSuppression({ workspaceId: WS, kind: "email", value: "suppressed@example.com", reason: "manual test setup" });

  sendableTargetId = "t-sendable";
  db.prepare("INSERT INTO targets (id, workspace_id, full_name, email) VALUES (?, ?, ?, ?)")
    .run(sendableTargetId, WS, "Sendable Person", "sendable@example.com");

  noEmailTargetId = "t-no-email";
  db.prepare("INSERT INTO targets (id, workspace_id, full_name) VALUES (?, ?, ?)")
    .run(noEmailTargetId, WS, "No Email Person");

  verifiedAccountId = "ea-verified";
  db.prepare(
    "INSERT INTO email_accounts (id, workspace_id, name, from_email, from_name, smtp_host, username, password, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(verifiedAccountId, WS, "Sender", "sender@outbound.example.com", "Sender", "smtp.example.com", "sender", "plaintext-secret", 1);
  // Unverified account in the same workspace — must never be auto-picked.
  db.prepare(
    "INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("ea-unverified", WS, "Unverified Sender", "unverified@outbound.example.com", "smtp.example.com", "unverified", "plaintext-secret", 0);
});

async function call(
  key: string,
  method: string,
  path: string[],
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  let status = 200;
  let responseBody: unknown;
  const req = {
    headers: { authorization: `Bearer ${key}` },
    method,
    query: { path, ...query },
    body,
  } as unknown as NextApiRequest;
  const res = {
    setHeader: () => {},
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      responseBody = payload;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  await handler(req, res);
  return { status, body: responseBody };
}

function batchApiResponse(statusByEmail: Record<string, string>) {
  return async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as { emails: string[] };
    return {
      ok: true,
      json: async () => ({
        results: parsed.emails
          .filter((email) => email in statusByEmail)
          .map((email) => ({ email, status: statusByEmail[email] })),
      }),
    } as Response;
  };
}

describe("POST /api/v1/contacts/verify", () => {
  it("suppresses a definitely-dead address and leaves a plausible one sendable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(batchApiResponse({
        "dead@mailinator.com": "DISPOSABLE", // determined from a static list — no DNS second-guessing needed
        "plausible@example.com": "VALID", // domain accepts mail; mailbox itself was never probed
      })),
    );

    const { status, body } = await call(writeAndSendKey, "POST", ["contacts", "verify"], {
      contact_ids: [disposableTargetId, plausibleTargetId],
    });

    expect(status).toBe(200);
    const result = body as { total: number; invalid: number; checked: number; suppressed: number };
    expect(result.total).toBe(2);
    expect(result.invalid).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.suppressed).toBe(1);

    const db = getDb();
    const suppression = db
      .prepare("SELECT 1 FROM suppressions WHERE workspace_id = ? AND kind = 'email' AND value = ?")
      .get(WS, "dead@mailinator.com");
    expect(suppression).toBeTruthy();

    const plausibleStatus = db
      .prepare("SELECT email_status FROM targets WHERE id = ?")
      .get(plausibleTargetId) as { email_status: string };
    expect(plausibleStatus.email_status).toBe("checked");
    const notSuppressed = db
      .prepare("SELECT 1 FROM suppressions WHERE workspace_id = ? AND kind = 'email' AND value = ?")
      .get(WS, "plausible@example.com");
    expect(notSuppressed).toBeFalsy();

    vi.unstubAllGlobals();
  });

  it("400s when contact_ids is missing or empty", async () => {
    const { status, body } = await call(writeAndSendKey, "POST", ["contacts", "verify"], {});
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("contact_ids_required");
  });
});

describe("POST /api/v1/contacts/{id}/send", () => {
  it("returns 409 when the recipient is on the suppression list", async () => {
    const { status, body } = await call(writeAndSendKey, "POST", ["contacts", suppressedTargetId, "send"], {
      subject: "Hi",
      body: "Hello there",
    });
    expect(status).toBe(409);
    expect((body as { error: string }).error).toBe("recipient_suppressed");
    expect((body as { suppression: unknown }).suppression).toBeTruthy();
    expect(SEND_EMAIL).not.toHaveBeenCalled();
  });

  it("auto-picks the workspace's verified sender when email_account_id is omitted", async () => {
    SEND_EMAIL.mockReset();
    SEND_EMAIL.mockResolvedValue({ messageId: "<generated@outbound.example.com>", response: "250 OK" });

    const { status, body } = await call(writeAndSendKey, "POST", ["contacts", sendableTargetId, "send"], {
      subject: "Hello",
      body: "Body text",
    });

    expect(status).toBe(200);
    const result = body as { ok: boolean; job_id: string; message_id: string };
    expect(result.ok).toBe(true);
    expect(result.job_id).toBeTruthy();
    expect(result.message_id).toBeTruthy();
    expect(SEND_EMAIL).toHaveBeenCalledTimes(1);
    const [accountArg] = SEND_EMAIL.mock.calls[0];
    expect(accountArg.id).toBe(verifiedAccountId);

    const db = getDb();
    const job = db.prepare("SELECT email_account_id FROM email_jobs WHERE id = ?").get(result.job_id) as
      | { email_account_id: string }
      | undefined;
    expect(job?.email_account_id).toBe(verifiedAccountId);
  });

  it("files the send against the contact, so the CRM can see it", async () => {
    SEND_EMAIL.mockReset();
    SEND_EMAIL.mockResolvedValue({ messageId: "<attributed@outbound.example.com>", response: "250 OK" });

    const { body } = await call(writeAndSendKey, "POST", ["contacts", sendableTargetId, "send"], {
      subject: "Attributed",
      body: "Body text",
    });
    const { job_id } = body as { job_id: string };

    const sent = getDb()
      .prepare("SELECT target_id FROM sent_messages WHERE job_id = ?")
      .get(job_id) as { target_id: string | null } | undefined;
    expect(sent?.target_id).toBe(sendableTargetId);
  });

  it("lets a bounce on a public-API send mark that contact's email invalid", async () => {
    // The reason target_id matters, stated as the behaviour rather than the column:
    // recordProviderEvent only touches targets when the sent_message carries one. Without
    // it a hard bounce suppressed the address but left the contact looking sendable, so the
    // next import or campaign would queue them again.
    SEND_EMAIL.mockReset();
    SEND_EMAIL.mockResolvedValue({ messageId: "<bouncing@outbound.example.com>", response: "250 OK" });

    const db = getDb();
    const targetId = "target-bounce-attribution";
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, email, linkedin_url) VALUES (?, ?, ?, ?, ?)")
      .run(targetId, WS, "Bouncer", "bouncer@outbound.example.com", "https://linkedin.com/in/bouncer");

    const { body } = await call(writeAndSendKey, "POST", ["contacts", targetId, "send"], {
      subject: "Will bounce",
      body: "Body text",
    });
    const { message_id } = body as { message_id: string };

    recordProviderEvent({
      workspaceId: WS,
      provider: "postmark",
      providerEventId: `bounce-${targetId}`,
      eventType: "bounced",
      messageId: message_id,
    });

    const target = db.prepare("SELECT email_status FROM targets WHERE id = ?").get(targetId) as { email_status: string | null };
    expect(target.email_status).toBe("invalid");
  });

  it("400s when the contact has no email", async () => {
    const { status, body } = await call(writeAndSendKey, "POST", ["contacts", noEmailTargetId, "send"], {
      subject: "Hi",
      body: "Hello",
    });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("contact_has_no_email");
  });

  it("404s for a contact that does not exist in this workspace", async () => {
    const { status, body } = await call(writeAndSendKey, "POST", ["contacts", "does-not-exist", "send"], {
      subject: "Hi",
      body: "Hello",
    });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("contact_not_found");
  });

  it("enforces the email:send scope independently of contacts:write", async () => {
    const { status, body } = await call(writeOnlyKey, "POST", ["contacts", sendableTargetId, "send"], {
      subject: "Hi",
      body: "Hello",
    });
    expect(status).toBe(403);
    expect((body as { error: string }).error).toBe("insufficient_scope");
    expect((body as { required: string }).required).toBe("email:send");
  });
});

describe("GET /api/v1/email_accounts", () => {
  it("never returns password or smtp_host fields", async () => {
    const { status, body } = await call(readKey, "GET", ["email_accounts"]);
    expect(status).toBe(200);
    const result = body as { data: Array<Record<string, unknown>> };
    expect(result.data.length).toBeGreaterThan(0);
    for (const row of result.data) {
      expect(row).not.toHaveProperty("password");
      expect(row).not.toHaveProperty("smtp_host");
      expect(row).not.toHaveProperty("username");
      expect(row).not.toHaveProperty("smtp_port");
    }
    const ids = result.data.map((r) => r.id);
    expect(ids).toContain(verifiedAccountId);
  });
});
