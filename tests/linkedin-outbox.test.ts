// Answering on LinkedIn from the inbox: a reply is queued, sent by the LinkedIn loop, and
// ends delivered, failed or unconfirmed. A real (throwaway) database; the browser step
// that types and sends is stubbed, and says how each send ended.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

vi.mock("@/lib/linkedin/session", () => {
  class SessionExpiredError extends Error {}
  return {
    SessionExpiredError,
    getSessionPage: vi.fn(async () => ({ close: async () => {} })),
    getSessionContext: vi.fn(async () => ({})),
    saveSessionState: vi.fn(async () => {}),
    gotoLinkedin: vi.fn(async () => {}),
    markNeedsReauth: vi.fn(async (id: string) => {
      const { getDb } = await import("@/lib/db");
      getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(id);
    }),
  };
});
vi.mock("@/lib/linkedin/message", async (original) => ({ ...(await original<typeof import("@/lib/linkedin/message")>()), sendMessage: vi.fn() }));
vi.mock("@/lib/email/sender", () => ({ sendEmail: vi.fn(async () => ({ messageId: "<x@test>" })) }));
// The routes wake the runner's loops. Here the one pass that matters is called by hand.
vi.mock("@/lib/linkedin/runner", async (original) => ({ ...(await original<typeof import("@/lib/linkedin/runner")>()), ensureGlobalRunnerStarted: vi.fn() }));

import { getDb } from "@/lib/db";
import { SessionExpiredError } from "@/lib/linkedin/session";
import { MessageUnconfirmedError, NotConnectedError, RecipientMismatchError, sendMessage } from "@/lib/linkedin/message";
import { outboxSentBetween } from "@/lib/linkedin/outbox";
import { applyInboxPull, type InboxConversation } from "@/lib/linkedin/inbox-sync";
import { sendQueuedLinkedinMessages } from "@/lib/linkedin/runner";
import { addSuppression } from "@/lib/platform/suppression";
import replyRoute from "@/pages/api/inbox/linkedin-reply";
import threadRoute from "@/pages/api/inbox/linkedin-thread";
import { ctxHeaders } from "./helpers/ctx";

const send = vi.mocked(sendMessage);
const db = () => getDb();
let seq = 0;
const SELF = "urn:li:fsd_profile:ACoAASelf";

async function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

/** A workspace with a signed-in LinkedIn account and a contact who is a connection. */
function workspace() {
  const n = ++seq;
  const ws = `ws-outbox-${n}`;
  // Before the headers below: giving a user a role needs the workspace to exist.
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const w = {
    ws, account: `outbox-acct-${n}`, target: `outbox-target-${n}`, url: `https://www.linkedin.com/in/outbox-lead-${n}/`, profileId: `ACoAAOutbox${n}`,
    member: ctxHeaders(ws, { userId: `outbox-member-${n}`, role: "member" }), memberId: `outbox-member-${n}`,
    viewer: ctxHeaders(ws, { userId: `outbox-viewer-${n}`, role: "viewer" }),
  };
  db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Ada', ?, 1, ?)").run(w.account, `outbox${n}@example.com`, ws);
  db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url, linkedin_profile_id) VALUES (?, ?, 'Lee Lead', ?, ?)").run(w.target, ws, w.url, w.profileId);
  return w;
}
type W = ReturnType<typeof workspace>;

const queue = (w: W, text = "Happy to. Tuesday at 10?", extra: Record<string, unknown> = {}, headers = w.member) => call(replyRoute, { method: "POST", headers, body: { target_id: w.target, text, ...extra } });
const stored = (w: W) => db().prepare("SELECT id, status, error, body, message_urn, created_by FROM linkedin_messages WHERE target_id = ? ORDER BY created_at, rowid").all(w.target) as Array<{ id: string; status: string; error: string | null; body: string; message_urn: string | null; created_by: string | null }>;
const pass = () => sendQueuedLinkedinMessages(db(), { pace: false });

beforeEach(() => {
  // Earlier tests' queues are not this test's business.
  db().prepare("DELETE FROM linkedin_messages").run();
  send.mockReset();
  send.mockResolvedValue("sent");
});

describe("queueing a reply", () => {
  it("is accepted, not sent: it waits for the LinkedIn loop", async () => {
    const w = workspace();
    const res = await queue(w);
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ status: "queued", account_id: w.account });
    expect(stored(w)).toEqual([expect.objectContaining({ id: res.body.id, status: "queued", body: "Happy to. Tuesday at 10?", created_by: w.memberId, message_urn: null })]);
    expect(send).not.toHaveBeenCalled();
  });

  it("is one message when the button is pressed twice", async () => {
    const w = workspace();
    const first = await queue(w);
    const second = await queue(w);
    expect(second.body.id).toBe(first.body.id);
    expect(stored(w)).toHaveLength(1);
  });

  it.each([
    ["nothing written", { text: "   " }, 400], ["longer than LinkedIn allows", { text: "x".repeat(8001) }, 400], ["an account that is not signed in", { account_id: "no-such-account" }, 400],
  ] as Array<[string, Record<string, unknown>, number]>)("is refused for %s", async (_why, extra, status) => {
    const w = workspace();
    expect((await queue(w, "Hello", extra)).statusCode).toBe(status);
    expect(stored(w)).toEqual([]);
  });

  it("is refused for a contact with no LinkedIn address, one in another workspace, or one who asked not to be contacted", async () => {
    const w = workspace();
    const other = workspace();
    expect((await call(replyRoute, { method: "POST", headers: w.member, body: { target_id: other.target, text: "Hello" } })).statusCode).toBe(404);
    db().prepare("UPDATE targets SET linkedin_url = NULL WHERE id = ?").run(w.target);
    expect((await queue(w)).statusCode).toBe(400);
    db().prepare("UPDATE targets SET linkedin_url = ? WHERE id = ?").run(w.url, w.target);
    addSuppression({ workspaceId: w.ws, kind: "linkedin", value: w.url, reason: "unsubscribe" });
    expect((await queue(w)).statusCode).toBe(409);
    expect(stored(w)).toEqual([]);
  });

  it("is not a viewer's to do, and waits for a teammate who has the reply open", async () => {
    const w = workspace();
    expect((await queue(w, "Hello", {}, w.viewer)).statusCode).toBe(403);
    ctxHeaders(w.ws, { userId: `teammate-${w.ws}`, role: "member" });
    db().prepare("INSERT INTO email_replies (id, workspace_id, target_id, from_email, body_text, received_at, channel, locked_by, locked_at) VALUES (?, ?, ?, '', 'Hi', datetime('now'), 'linkedin', ?, ?)")
      .run(`outbox-reply-${w.ws}`, w.ws, w.target, `teammate-${w.ws}`, new Date().toISOString());
    expect((await queue(w, "Hello", { reply_id: `outbox-reply-${w.ws}` })).statusCode).toBe(409);
  });

  it("goes from the account the conversation is on, and asks when it cannot tell", async () => {
    const w = workspace();
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Second seat', ?, 1, ?)").run(`${w.account}-b`, `second-${w.account}@example.com`, w.ws);
    expect(String((await queue(w)).body.error)).toMatch(/which LinkedIn account/);
    db().prepare("INSERT INTO linkedin_messages (id, workspace_id, account_id, target_id, conversation_urn, message_urn, direction, body, sent_at) VALUES (?, ?, ?, ?, 'urn:c', 'urn:m:1', 'in', 'Hi', ?)")
      .run(`seen-${w.ws}`, w.ws, `${w.account}-b`, w.target, new Date().toISOString());
    expect((await queue(w)).body).toMatchObject({ status: "queued", account_id: `${w.account}-b` });
  });
});

describe("sending what is queued", () => {
  it("answers the conversation even though the contact has written, to that contact's own profile", async () => {
    const w = workspace();
    await queue(w);
    await pass();
    expect(send).toHaveBeenCalledWith(expect.anything(), w.url, "Happy to. Tuesday at 10?", { allowReplied: true });
    expect(stored(w)).toEqual([expect.objectContaining({ status: "delivered", error: null })]);
  });

  it("does not send the same message again on the next pass", async () => {
    const w = workspace();
    await queue(w);
    await pass();
    await pass();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never retries a send LinkedIn did not confirm", async () => {
    const w = workspace();
    send.mockRejectedValueOnce(new MessageUnconfirmedError("Send was pressed but LinkedIn did not show the message"));
    await queue(w);
    await pass();
    expect(stored(w)[0]).toMatchObject({ status: "uncertain" });
    expect(stored(w)[0].error).toMatch(/may have gone/);
    await pass();
    await pass();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new NotConnectedError("not_connected" as never, 2), /not a connection/], [new RecipientMismatchError("x"), /not with this contact/], [new Error("LinkedIn's message box did not open"), /message box did not open/],
  ] as Array<[Error, RegExp]>)("records why a message did not go: %s", async (error, reason) => {
    const w = workspace();
    send.mockRejectedValueOnce(error);
    await queue(w);
    await pass();
    expect(stored(w)[0].status).toBe("failed");
    expect(stored(w)[0].error).toMatch(reason);
    await pass();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps a message waiting when the account turns out to be signed out, and stops there", async () => {
    const w = workspace();
    send.mockRejectedValueOnce(new SessionExpiredError("signed out"));
    await queue(w, "First");
    await queue(w, "Second");
    await pass();
    expect(stored(w).map((m) => m.status)).toEqual(["queued", "queued"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db().prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(w.account)).toEqual({ is_authenticated: 0 });
    // Signed in again, both go.
    db().prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = ?").run(w.account);
    await pass();
    expect(stored(w).map((m) => m.status)).toEqual(["delivered", "delivered"]);
  });

  it("sends a few per pass, oldest first", async () => {
    const w = workspace();
    for (const text of ["one", "two", "three", "four"]) await queue(w, text);
    await pass();
    expect(send.mock.calls.map((args) => args[2])).toEqual(["one", "two", "three"]);
    expect(stored(w).map((m) => m.status)).toEqual(["delivered", "delivered", "delivered", "queued"]);
  });

  it("treats a send that never finished as unconfirmed, not as one to try again", async () => {
    const w = workspace();
    await queue(w);
    db().prepare("UPDATE linkedin_messages SET status = 'sending' WHERE target_id = ?").run(w.target);
    await queue(w, "A later one");
    await pass();
    expect(stored(w).map((m) => [m.body, m.status])).toEqual([["Happy to. Tuesday at 10?", "uncertain"], ["A later one", "delivered"]]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("counts towards the account's messages for the day", async () => {
    const w = workspace();
    await queue(w);
    expect(outboxSentBetween(db(), w.account, "2000-01-01 00:00:00", "2100-01-01 00:00:00")).toBe(0);
    await pass();
    expect(outboxSentBetween(db(), w.account, "2000-01-01 00:00:00", "2100-01-01 00:00:00")).toBe(1);
    expect(outboxSentBetween(db(), w.account, "2000-01-01 00:00:00", "2000-01-02 00:00:00")).toBe(0);
  });
});

describe("a message that did not go", () => {
  async function ended(error: Error) {
    const w = workspace();
    send.mockRejectedValueOnce(error);
    const id = String((await queue(w)).body.id);
    await pass();
    return { w, id };
  }

  it("can be sent again when it failed", async () => {
    const { w, id } = await ended(new Error("LinkedIn's message box did not open"));
    expect((await call(replyRoute, { method: "POST", headers: w.member, body: { retry_id: id } })).statusCode).toBe(202);
    await pass();
    expect(stored(w)[0].status).toBe("delivered");
  });

  it("is sent again when unconfirmed only once a person says they have looked", async () => {
    const { w, id } = await ended(new MessageUnconfirmedError("x"));
    expect((await call(replyRoute, { method: "POST", headers: w.member, body: { retry_id: id } })).statusCode).toBe(400);
    expect(stored(w)[0].status).toBe("uncertain");
    expect((await call(replyRoute, { method: "POST", headers: w.member, body: { retry_id: id, confirm: true } })).statusCode).toBe(202);
    expect(stored(w)[0].status).toBe("queued");
  });

  it("can be discarded, which a delivered one cannot", async () => {
    const { w, id } = await ended(new Error("nope"));
    expect((await call(replyRoute, { method: "DELETE", headers: w.member, query: { id } })).statusCode).toBe(204);
    expect(stored(w)).toEqual([]);

    const sent = String((await queue(w, "This one goes")).body.id);
    await pass();
    expect((await call(replyRoute, { method: "DELETE", headers: w.member, query: { id: sent } })).statusCode).toBe(409);
    expect(stored(w)).toHaveLength(1);
  });

  it("is not another workspace's to touch", async () => {
    const { w, id } = await ended(new Error("nope"));
    const other = workspace();
    expect((await call(replyRoute, { method: "DELETE", headers: other.member, query: { id } })).statusCode).toBe(404);
    expect((await call(replyRoute, { method: "POST", headers: other.member, body: { retry_id: id } })).statusCode).toBe(404);
    expect(stored(w)).toHaveLength(1);
  });
});

describe("when the inbox is next read", () => {
  const seenOnLinkedin = (w: W, text: string, at = Date.now()): InboxConversation[] => [{
    urn: `urn:li:msg_conversation:(${SELF},2-${w.profileId})`, lastActivityAt: at, selfUrn: SELF, counterpart: { profileId: w.profileId, memberUrn: null, name: "Lee Lead" },
    messages: [{ urn: `urn:li:msg_message:(${SELF},2-${w.profileId}-9)`, sentAt: at, text, fromSelf: true }],
  }];

  it("the reply this app sent is recognised, not stored a second time", async () => {
    const w = workspace();
    await queue(w);
    await pass();
    const read = applyInboxPull(db(), w.account, seenOnLinkedin(w, "Happy to. Tuesday at 10?"));
    expect(read.stored).toBe(0);
    expect(stored(w)).toEqual([expect.objectContaining({ status: "delivered", message_urn: `urn:li:msg_message:(${SELF},2-${w.profileId}-9)` })]);
  });

  it("an unconfirmed reply that is found in the conversation is confirmed", async () => {
    const w = workspace();
    send.mockRejectedValueOnce(new MessageUnconfirmedError("x"));
    await queue(w);
    await pass();
    applyInboxPull(db(), w.account, seenOnLinkedin(w, "Happy to. Tuesday at 10?"));
    expect(stored(w)).toEqual([expect.objectContaining({ status: "delivered", error: null })]);
  });

  it("a message still waiting is not mistaken for one already in the conversation", async () => {
    const w = workspace();
    await queue(w, "Same words as before");
    applyInboxPull(db(), w.account, seenOnLinkedin(w, "Same words as before", Date.now() - 86_400_000));
    expect(stored(w).map((m) => m.status).sort()).toEqual(["delivered", "queued"]);
  });
});

describe("the conversation as the inbox shows it", () => {
  it("lists what was said and what is waiting, and says who a reply would go from", async () => {
    const w = workspace();
    db().prepare("INSERT INTO linkedin_messages (id, workspace_id, account_id, target_id, conversation_urn, message_urn, direction, body, sent_at) VALUES (?, ?, ?, ?, 'urn:c', 'urn:m:1', 'in', 'Can we talk Tuesday?', '2026-10-01T10:00:00.000Z')")
      .run(`seen-${w.ws}`, w.ws, w.account, w.target);
    await queue(w);
    const res = await call(threadRoute, { method: "GET", headers: w.viewer, query: { target_id: w.target } });
    expect(res.body).toMatchObject({ can_reply: true, why_not: null, account: { id: w.account, name: "Ada" }, reading: true, last_read_at: null });
    expect((res.body.messages as Array<Record<string, unknown>>).map((m) => [m.direction, m.body, m.status, m.sent_here])).toEqual([
      ["in", "Can we talk Tuesday?", "delivered", 0], ["out", "Happy to. Tuesday at 10?", "queued", 1],
    ]);
  });

  it("says why a reply cannot be sent", async () => {
    const w = workspace();
    db().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(w.account);
    expect((await call(threadRoute, { method: "GET", headers: w.member, query: { target_id: w.target } })).body).toMatchObject({ can_reply: false, why_not: "No LinkedIn account is signed in" });
  });

  it("can ask for the inbox to be read now, and is only this workspace's", async () => {
    const w = workspace();
    const other = workspace();
    expect((await call(threadRoute, { method: "POST", headers: w.member, body: { target_id: w.target } })).statusCode).toBe(202);
    expect(db().prepare("SELECT inbox_sync_requested_at IS NOT NULL asked FROM accounts WHERE id = ?").get(w.account)).toEqual({ asked: 1 });
    expect((await call(threadRoute, { method: "GET", headers: other.member, query: { target_id: w.target } })).statusCode).toBe(404);
    expect((await call(threadRoute, { method: "POST", headers: w.viewer, body: { target_id: w.target } })).statusCode).toBe(403);
  });
});
