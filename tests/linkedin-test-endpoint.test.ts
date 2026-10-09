// POST /api/accounts/{id}/test — the on-demand "run one real LinkedIn action" endpoint.
// The browser steps are stubbed; what is under test is who may call it, what it refuses to
// send without confirmation, and that an outcome is recorded on the contact.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

vi.mock("@/lib/linkedin/session", async () => ({
  ...(await import("@/lib/linkedin/navigation")),
  gotoLinkedin: vi.fn(async () => {}),
  getSessionPage: vi.fn(async () => ({ close: async () => {} })),
  saveSessionState: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async (id: string) => {
    getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(id);
  }),
}));
vi.mock("@/lib/linkedin/health", () => ({ checkLinkedinSession: vi.fn() }));
vi.mock("@/lib/linkedin/connect", async (original) => ({
  ...(await original<typeof import("@/lib/linkedin/connect")>()),
  sendConnectionRequest: vi.fn(),
  readRelation: vi.fn(),
}));
vi.mock("@/lib/linkedin/message", async (original) => ({
  ...(await original<typeof import("@/lib/linkedin/message")>()),
  sendMessage: vi.fn(),
}));
vi.mock("@/lib/linkedin/visit", () => ({ visitProfile: vi.fn(async () => {}) }));

import handler from "@/pages/api/accounts/[id]/test";
import { checkLinkedinSession } from "@/lib/linkedin/health";
import { PendingInviteError, readRelation, sendConnectionRequest } from "@/lib/linkedin/connect";
import { RecipientRepliedError, sendMessage } from "@/lib/linkedin/message";
import { SessionExpiredError } from "@/lib/linkedin/navigation";

const WS = "ws-litest-1";
const OTHER_WS = "ws-litest-2";
const ACCOUNT = "litest-acct";
const URL = "https://www.linkedin.com/in/some-lead/";

const connect = vi.mocked(sendConnectionRequest);
const message = vi.mocked(sendMessage);

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

async function call(body: unknown, opts: { role?: string; account?: string } = {}) {
  const res = mockRes();
  await handler({
    method: "POST",
    query: { id: opts.account ?? ACCOUNT },
    body,
    headers: { "x-workspace-id": WS, "x-user-id": "user-1", "x-workspace-role": opts.role ?? "admin" },
  } as unknown as NextApiRequest, res);
  return res;
}

let seq = 0;
function contact(workspaceId = WS, url: string | null = URL): string {
  const id = `litest-target-${++seq}`;
  getDb().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, ?, ?)")
    .run(id, workspaceId, `Lead ${seq}`, url ? url.replace("some-lead", `some-lead-${seq}`) : null);
  return id;
}
const stored = (id: string) =>
  getDb().prepare("SELECT connection_requested_at, message_sent_at FROM targets WHERE id = ?").get(id) as { connection_requested_at: string | null; message_sent_at: string | null };

beforeAll(() => {
  const db = getDb();
  for (const ws of [WS, OTHER_WS]) db.prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Test', 'litest@example.com', 1, ?)").run(ACCOUNT, WS);
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES ('litest-other', 'Other', 'litest2@example.com', 1, ?)").run(OTHER_WS);
});

beforeEach(() => {
  vi.clearAllMocks();
  getDb().prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = ?").run(ACCOUNT);
  connect.mockResolvedValue({ noteSent: false, noteSkipped: null });
  message.mockResolvedValue("sent");
});

describe("who may run a live LinkedIn action", () => {
  it("is admin-only, because it can send from the account", async () => {
    expect((await call({ action: "session" }, { role: "member" })).statusCode).toBe(403);
  });

  it("cannot reach another workspace's account", async () => {
    const res = await call({ action: "session" }, { account: "litest-other" });
    expect(res.statusCode).toBe(404);
    expect(checkLinkedinSession).not.toHaveBeenCalled();
  });

  it("refuses an account that is not signed in", async () => {
    getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(ACCOUNT);
    expect((await call({ action: "inspect", url: URL })).statusCode).toBe(400);
  });
});

describe("what it will not do without being told to", () => {
  it.each(["connect", "message"])("does not %s without confirm: true", async (action) => {
    const res = await call({ action, url: URL, text: "Hello" });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/really sends/);
    expect(connect).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it("does not send an empty message", async () => {
    expect((await call({ action: "message", url: URL, text: "  ", confirm: true })).statusCode).toBe(400);
    expect(message).not.toHaveBeenCalled();
  });

  it("only accepts a LinkedIn profile URL", async () => {
    for (const url of ["https://example.com/in/x", "https://www.linkedin.com/company/acme/", undefined]) {
      expect((await call({ action: "inspect", url })).statusCode).toBe(400);
    }
  });

  it("will not act on a contact from another workspace", async () => {
    const theirs = contact(OTHER_WS);
    const res = await call({ action: "connect", contact_id: theirs, confirm: true });
    expect(res.statusCode).toBe(404);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects an unknown action", async () => {
    expect((await call({ action: "withdraw", url: URL })).statusCode).toBe(400);
  });
});

describe("reporting what LinkedIn showed", () => {
  it("reports a signed-in and a signed-out session", async () => {
    vi.mocked(checkLinkedinSession).mockResolvedValueOnce({ signedIn: true, detail: null });
    expect((await call({ action: "session" })).body).toMatchObject({ ok: true, outcome: "signed_in" });
    vi.mocked(checkLinkedinSession).mockResolvedValueOnce({ signedIn: false, detail: "LinkedIn redirected to https://www.linkedin.com/login/" });
    expect((await call({ action: "session" })).body).toMatchObject({ ok: false, outcome: "signed_out" });
  });

  it("inspect returns exactly what the automation reads off the profile", async () => {
    vi.mocked(readRelation).mockResolvedValue({
      card: {
        found: true, reason: null, name: "Some Lead", profileId: "ACoAAx", degree: 2, relation: "unknown",
        inviteHref: null, messageHref: "/messaging/compose/?profileUrn=x", hasMoreMenu: true,
      },
      relation: "connectable", inviteHref: "/preload/custom-invite/?vanityName=some-lead", via: "menu",
    });
    const res = await call({ action: "inspect", url: "http://linkedin.com/in/some-lead" });
    expect(res.body).toMatchObject({
      ok: true, outcome: "connectable",
      // A Message button on a non-connection opens InMail, so it does not count as "can message".
      detail: { name: "Some Lead", degree: 2, url: URL, found_via: "menu", can_invite: true, can_message: false },
    });
  });

  it("records a sent connection request on the contact, so a campaign does not repeat it", async () => {
    const id = contact();
    connect.mockResolvedValue({ noteSent: true, noteSkipped: null });
    const res = await call({ action: "connect", contact_id: id, note: "Hello", confirm: true });

    expect(res.body).toMatchObject({ ok: true, outcome: "invitation_pending", detail: { noteSent: true } });
    expect(connect).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("/in/some-lead-"), { note: "Hello" });
    expect(stored(id).connection_requested_at).not.toBeNull();
    const audit = getDb().prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'account.test_connect' AND entity_id = ?").get(ACCOUNT) as { c: number };
    expect(audit.c).toBeGreaterThan(0);
  });

  it("records an invitation LinkedIn already shows as pending", async () => {
    const id = contact();
    connect.mockRejectedValue(new PendingInviteError("Invitation already pending"));
    const res = await call({ action: "connect", contact_id: id, confirm: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: false, outcome: "invitation_already_pending" });
    expect(stored(id).connection_requested_at).not.toBeNull();
  });

  it("records a sent message on the contact", async () => {
    const id = contact();
    const res = await call({ action: "message", contact_id: id, text: "Thanks for connecting.", confirm: true });
    expect(res.body).toMatchObject({ ok: true, outcome: "message_sent" });
    expect(message).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("/in/some-lead-"), "Thanks for connecting.");
    expect(stored(id).message_sent_at).not.toBeNull();
  });

  it("reports a contact who has replied instead of messaging them", async () => {
    const id = contact();
    message.mockRejectedValue(new RecipientRepliedError("Sure"));
    const res = await call({ action: "message", contact_id: id, text: "Following up", confirm: true });
    expect(res.body).toMatchObject({ ok: false, outcome: "contact_has_replied" });
    expect(stored(id).message_sent_at).toBeNull();
  });

  it("flags the account when the session turns out to be signed out", async () => {
    connect.mockRejectedValue(new SessionExpiredError("LinkedIn redirected to https://www.linkedin.com/login/"));
    const res = await call({ action: "connect", url: URL, confirm: true });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ ok: false, outcome: "signed_out" });
    expect((getDb().prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(ACCOUNT) as { is_authenticated: number }).is_authenticated).toBe(0);
  });

  it("returns an unexpected failure as an error, with LinkedIn's own words", async () => {
    connect.mockRejectedValue(new Error("LinkedIn did not confirm the invitation — the profile does not show it as pending"));
    const res = await call({ action: "connect", url: URL, confirm: true });
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ ok: false, outcome: "error" });
    expect(String(res.body.detail)).toMatch(/did not confirm/);
  });
});
