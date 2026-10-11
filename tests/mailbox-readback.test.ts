// A mailbox against a real mail server: signing in, sending a test, and reading back
// where it landed. The server is in memory on this machine (tests/helpers/mail-server.ts)
// and speaks real SMTP and IMAP, so nothing here is stubbed and nothing leaves the machine.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { probeMailbox, recheckDisconnectedMailboxes, testMailboxConnection } from "@/lib/email/connection";
import { SenderDisconnectedError, SenderPausedError, sendEmailDurably } from "@/lib/email/infrastructure";
import { findMessage, parseAuthResults, searchOrder } from "@/lib/email/readback";
import { probeImap } from "@/lib/email/sender";
import { GIVE_UP_AFTER_MINUTES, latestMailboxTest, lookForMailboxTest, sendMailboxTest } from "@/lib/email/test-send";
import { listNotifications } from "@/lib/platform/notifications";
import sendTestHandler from "@/pages/api/email-accounts/[id]/send-test";
import testHandler from "@/pages/api/email-accounts/[id]/test";
import accountsHandler from "@/pages/api/email-accounts/index";
import { ctxHeaders } from "./helpers/ctx";
import { opensslAvailable, startMailServer, type MailServer } from "./helpers/mail-server";

const db = () => getDb();
let seq = 0;
let server: MailServer;
let gmail: MailServer;

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown> };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as Res;
}

function workspace() {
  const ws = `ws-rb-${++seq}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  return ws;
}

/** A mailbox on the local server (or the Gmail-like one), with its user created there. */
function mailbox(ws: string, address: string, opts: { on?: MailServer; password?: string; imap?: boolean; fields?: Record<string, unknown> } = {}) {
  const on = opts.on ?? server;
  const id = `rb-mb-${++seq}`;
  on.addUser(address, "right-password");
  db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, username, password, allow_self_signed, is_verified, daily_email_limit, ramp_up_enabled)
    VALUES (?, ?, ?, ?, 'localhost', ?, 0, ?, ?, ?, ?, 1, 1, 50, 0)`).run(id, ws, address, address, on.smtpPort, opts.imap === false ? null : "localhost", on.imapPort, address, encryptSecret(opts.password ?? "right-password"));
  for (const [column, value] of Object.entries(opts.fields ?? {})) db().prepare(`UPDATE email_accounts SET ${column} = ? WHERE id = ?`).run(value, id);
  return id;
}

const row = (id: string) => db().prepare("SELECT * FROM email_accounts WHERE id = ?").get(id) as Record<string, string | number | null>;
const call = async (handler: (req: NextApiRequest, res: NextApiResponse) => unknown, ws: string, method: string, opts: { id?: string; body?: unknown; role?: string } = {}) => {
  const res = mockRes();
  const role = opts.role ?? "admin";
  await handler({ method, body: opts.body ?? {}, query: opts.id ? { id: opts.id } : {}, headers: ctxHeaders(ws, { userId: `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
  return res;
};

describe.skipIf(!opensslAvailable())("a mailbox against a mail server", () => {
  beforeAll(async () => {
    server = await startMailServer({ route: (message) => (/spam/i.test(message.subject ?? "") ? "Spam" : /filed/i.test(message.subject ?? "") ? "Receipts" : "INBOX"), folders: [{ name: "Spam", attribs: ["\\Junk"] }, { name: "Sent", attribs: ["\\Sent"] }, { name: "Receipts" }] });
    gmail = await startMailServer({ gmail: true, gmailTab: (message) => (/offer/i.test(message.subject ?? "") ? "promotions" : null), folders: [{ name: "[Gmail]/Spam", attribs: ["\\Junk"] }, { name: "[Gmail]/All Mail", attribs: ["\\All"] }] });
  });
  afterAll(async () => {
    await server?.stop();
    await gmail?.stop();
  });

  describe("signing in", () => {
    it("works for both servers with the right password, and changes nothing by looking", async () => {
      const ws = workspace();
      const id = mailbox(ws, "ada@one.test", { fields: { is_verified: 0 } });
      const test = await probeMailbox(id);
      expect(test).toEqual({ ok: true, smtp: { error: null, auth: false }, imap: { error: null, auth: false } });
      expect(row(id).is_verified).toBe(0);
    });

    it("a passing test marks the mailbox verified; a refused sign-in marks it disconnected, once", async () => {
      const ws = workspace();
      const good = mailbox(ws, "good@one.test", { fields: { is_verified: 0 } });
      expect((await call(testHandler, ws, "POST", { id: good })).body).toEqual({ ok: true, smtp: { ok: true }, imap: { ok: true }, disconnected: false });
      expect(row(good)).toMatchObject({ is_verified: 1, disconnected_at: null });

      const bad = mailbox(ws, "bad@one.test", { password: "wrong-password" });
      const refused = await call(testHandler, ws, "POST", { id: bad });
      expect(refused.statusCode).toBe(400);
      expect(refused.body).toMatchObject({ ok: false, smtp: { ok: false }, disconnected: true });
      expect(row(bad).disconnected_at).not.toBeNull();
      expect(String(row(bad).disconnect_reason)).toMatch(/refused the sign-in used to send/);
      await call(testHandler, ws, "POST", { id: bad });
      const notices = listNotifications(ws, "nobody", "owner").filter((note) => note.kind === "mailbox.disconnected");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ tone: "bad", title: "bad@one.test cannot sign in", link: "/mailboxes" });
      expect(db().prepare("SELECT COUNT(*) c FROM domain_events WHERE workspace_id = ? AND type = 'mailbox.disconnected'").get(ws)).toEqual({ c: 1 });
    });

    it("a server that cannot be reached does not disconnect anything", async () => {
      const ws = workspace();
      const id = mailbox(ws, "away@one.test", { fields: { smtp_port: 1, imap_host: null } });
      const test = await testMailboxConnection(id);
      expect(test?.ok).toBe(false);
      expect(test?.smtp.auth).toBe(false);
      expect(row(id).disconnected_at).toBeNull();
    });

    it("a stored password that cannot be read is a mailbox that cannot sign in, not a crash", async () => {
      const ws = workspace();
      // Encrypted under a key that is not this server's, as after a database is moved.
      const foreign = "v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAA";
      const id = mailbox(ws, "moved@one.test", { fields: { password: foreign } });
      const res = await call(testHandler, ws, "POST", { id });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ ok: false, disconnected: true, smtp: { ok: false, error: expect.stringMatching(/cannot be read\. Enter it again/) } });
      expect(row(id).disconnect_reason).toMatch(/cannot be read/);
      const reader = { imap_host: "localhost", imap_port: server.imapPort, username: "moved@one.test", password: foreign, imap_username: null, imap_password: null, allow_self_signed: 1 };
      expect(await findMessage(reader, "<abc@one.test>")).toMatchObject({ found: false, error: expect.stringMatching(/cannot be read/) });
    });

    it("the test is an admin's to run", async () => {
      const ws = workspace();
      const id = mailbox(ws, "roles@one.test");
      expect((await call(testHandler, ws, "POST", { id, role: "manager" })).statusCode).toBe(403);
      expect((await call(testHandler, workspace(), "POST", { id })).statusCode).toBe(404);
    });
  });

  describe("sending when the server refuses the sign-in", () => {
    it("disconnects the mailbox, keeps the email for later, and holds the contact as a pause does", async () => {
      const ws = workspace();
      const id = mailbox(ws, "revoked@one.test");
      server.setPassword("revoked@one.test", "changed-at-the-provider");

      const send = () => sendEmailDurably({ workspaceId: ws, emailAccountId: id, idempotencyKey: "revoked-1", to: "lee@prospect.test", subject: "Hello", body: "Hi" });
      const error = await send().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SenderDisconnectedError);
      // The runner holds a contact on SenderPausedError; a disconnected mailbox is one of those.
      expect(error).toBeInstanceOf(SenderPausedError);
      expect(row(id).disconnected_at).not.toBeNull();
      const job = db().prepare("SELECT status, attempt FROM email_jobs WHERE workspace_id = ? AND idempotency_key = 'revoked-1'").get(ws);
      expect(job).toEqual({ status: "pending", attempt: 0 });
      expect(server.received.filter((message) => message.to === "lee@prospect.test")).toHaveLength(0);

      // While it is disconnected nothing is even tried.
      db().prepare("UPDATE email_jobs SET available_at = datetime('now', '-1 minute') WHERE workspace_id = ?").run(ws);
      await expect(send()).rejects.toBeInstanceOf(SenderDisconnectedError);

      // The password is put right: the half-hourly check reconnects it and the same email goes.
      server.setPassword("revoked@one.test", "right-password");
      db().prepare("UPDATE email_accounts SET connection_checked_at = datetime('now', '-31 minutes') WHERE id = ?").run(id);
      expect(await recheckDisconnectedMailboxes()).toBe(1);
      expect(row(id)).toMatchObject({ disconnected_at: null, disconnect_reason: null });
      expect(db().prepare("SELECT COUNT(*) c FROM domain_events WHERE workspace_id = ? AND type = 'mailbox.reconnected'").get(ws)).toEqual({ c: 1 });
      db().prepare("UPDATE email_jobs SET available_at = datetime('now', '-1 minute') WHERE workspace_id = ?").run(ws);
      await send();
      expect(server.received.filter((message) => message.to === "lee@prospect.test")).toHaveLength(1);
    });

    it("a disconnected mailbox is not tried again before half an hour is up", async () => {
      const ws = workspace();
      const id = mailbox(ws, "soon@one.test", { fields: { disconnected_at: "2026-10-10 08:00:00" } });
      db().prepare("UPDATE email_accounts SET connection_checked_at = datetime('now', '-5 minutes') WHERE id = ?").run(id);
      await recheckDisconnectedMailboxes();
      expect(row(id).disconnected_at).not.toBeNull();
    });
  });

  describe("connecting a mailbox with the sign-in tried first", () => {
    const fields = (address: string, password: string) => ({
      name: address, from_email: address, smtp_host: "localhost", smtp_port: server.smtpPort, smtp_secure: 0, imap_host: "localhost", imap_port: server.imapPort,
      username: address, password, allow_self_signed: true, verify: true,
    });

    it("saves nothing when the server refuses it, and saves a verified mailbox when it does not", async () => {
      const ws = workspace();
      server.addUser("new@one.test", "right-password");
      const refused = await call(accountsHandler, ws, "POST", { body: fields("new@one.test", "typo") });
      expect(refused.statusCode).toBe(400);
      expect(String(refused.body.error)).toMatch(/SMTP server did not accept/);
      expect(db().prepare("SELECT COUNT(*) c FROM email_accounts WHERE workspace_id = ?").get(ws)).toEqual({ c: 0 });

      const saved = await call(accountsHandler, ws, "POST", { body: fields("new@one.test", "right-password") });
      expect(saved.statusCode).toBe(201);
      expect(saved.body).toMatchObject({ verified: true });
      expect(row(String(saved.body.id))).toMatchObject({ is_verified: 1, allow_self_signed: 1, from_email: "new@one.test" });
      // The password is stored encrypted, and the same address cannot be connected twice this way.
      expect(row(String(saved.body.id)).password).not.toBe("right-password");
      expect((await call(accountsHandler, ws, "POST", { body: fields("new@one.test", "right-password") })).statusCode).toBe(409);
    });

    it("without the flag saves as it always has: untested", async () => {
      const ws = workspace();
      const saved = await call(accountsHandler, ws, "POST", { body: { ...fields("legacy@one.test", "anything"), verify: undefined } });
      expect(saved.statusCode).toBe(201);
      expect(row(String(saved.body.id)).is_verified).toBe(0);
    });
  });

  describe("reading back where an email landed", () => {
    it("finds it in the inbox, with what the receiving server made of SPF, DKIM and DMARC", async () => {
      const ws = workspace();
      const id = mailbox(ws, "self@one.test");
      const { test, messageId } = await sendMailboxTest({ workspaceId: ws, emailAccountId: id, to: "Self@One.test" });
      expect(test).toMatchObject({ status: "sent", readable: true, recipient: "self@one.test", placement: null });
      expect(server.mailbox("self@one.test").some((message) => message.messageId === messageId)).toBe(true);

      const found = await lookForMailboxTest(db(), ws, test.id);
      expect(found).toMatchObject({ status: "found", placement: "inbox", folder: "INBOX", auth: { spf: "pass", dkim: "pass", dmarc: "pass" } });
      expect(found?.checked_at).not.toBeNull();
      expect(latestMailboxTest(db(), ws, id)).toEqual(found);
      // Asked again, it answers from what it already knows.
      expect(await lookForMailboxTest(db(), ws, test.id, async () => { throw new Error("must not look again"); })).toEqual(found);
    });

    it("says spam when that is where it is, and names any other folder a filter moved it to", async () => {
      const ws = workspace();
      const sender = mailbox(ws, "from@one.test");
      mailbox(ws, "seed@one.test");
      const spam = await sendMailboxTest({ workspaceId: ws, emailAccountId: sender, to: "seed@one.test", subject: "Is this spam" });
      expect(await lookForMailboxTest(db(), ws, spam.test.id)).toMatchObject({ status: "found", placement: "spam", folder: "Spam" });
      const filed = await sendMailboxTest({ workspaceId: ws, emailAccountId: sender, to: "seed@one.test", subject: "Filed away" });
      expect(await lookForMailboxTest(db(), ws, filed.test.id)).toMatchObject({ status: "found", placement: "other", folder: "Receipts" });
    });

    it("tells Gmail's tabs apart on Gmail", async () => {
      const ws = workspace();
      const sender = mailbox(ws, "g-from@one.test", { on: gmail });
      mailbox(ws, "g-seed@one.test", { on: gmail });
      const primary = await sendMailboxTest({ workspaceId: ws, emailAccountId: sender, to: "g-seed@one.test", subject: "A note" });
      expect(await lookForMailboxTest(db(), ws, primary.test.id)).toMatchObject({ status: "found", placement: "primary" });
      const promo = await sendMailboxTest({ workspaceId: ws, emailAccountId: sender, to: "g-seed@one.test", subject: "Special offer" });
      expect(await lookForMailboxTest(db(), ws, promo.test.id)).toMatchObject({ status: "found", placement: "promotions" });
    });

    it("cannot say for an address it cannot read, and does not pretend to", async () => {
      const ws = workspace();
      const sender = mailbox(ws, "out@one.test");
      const { test } = await sendMailboxTest({ workspaceId: ws, emailAccountId: sender, to: "someone@elsewhere.test" });
      expect(test).toMatchObject({ status: "sent", readable: false });
      expect(await lookForMailboxTest(db(), ws, test.id, async () => { throw new Error("there is nowhere to look"); })).toMatchObject({ status: "sent", readable: false, placement: null });
      // Another workspace's mailbox with that address is not ours to read.
      mailbox(workspace(), "someone@elsewhere.test");
      const again = await sendMailboxTest({ workspaceId: ws, emailAccountId: sender, to: "someone@elsewhere.test" });
      expect(again.test.readable).toBe(false);
    });

    it("keeps looking for ten minutes, then says it was not found", async () => {
      const ws = workspace();
      const sender = mailbox(ws, "lost-from@one.test");
      mailbox(ws, "lost@one.test");
      const { test } = await sendMailboxTest({ workspaceId: ws, emailAccountId: sender, to: "lost@one.test" });
      const nowhere = async () => ({ found: false, placement: null, folder: null, auth: null });
      expect(await lookForMailboxTest(db(), ws, test.id, nowhere)).toMatchObject({ status: "sent" });
      db().prepare("UPDATE mailbox_test_sends SET sent_at = datetime('now', ?) WHERE id = ?").run(`-${GIVE_UP_AFTER_MINUTES + 1} minutes`, test.id);
      expect(await lookForMailboxTest(db(), ws, test.id, nowhere)).toMatchObject({ status: "not_found", placement: null });
    });

    it("reports a mailbox that cannot be opened instead of throwing", async () => {
      const reader = { imap_host: "localhost", imap_port: server.imapPort, username: "nobody@one.test", password: encryptSecret("x"), imap_username: null, imap_password: null, allow_self_signed: 1 };
      const result = await findMessage(reader, "<abc@one.test>");
      expect(result.found).toBe(false);
      expect(result.error).toMatch(/Invalid credentials/);
      expect(await findMessage({ ...reader, imap_host: null }, "<abc@one.test>")).toMatchObject({ found: false, error: expect.stringMatching(/no IMAP server/) });
    });

    it("says so when the IMAP server is given as an IP address, where it used to throw", async () => {
      // Node will not open a secure connection to a server named by number, and says so by throwing.
      const reader = { imap_host: "127.0.0.1", imap_port: server.imapPort, username: "ada@one.test", password: encryptSecret("secret"), imap_username: null, imap_password: null, allow_self_signed: 1 };
      expect(await findMessage(reader, "<abc@one.test>")).toMatchObject({ found: false, error: expect.stringMatching(/not its IP address/) });
      expect(await probeImap({ ...reader, imap_host: "127.0.0.1", password: "secret" })).toEqual({ error: expect.stringMatching(/not its IP address/), auth: false });
    });
  });

  describe("the test-send route", () => {
    it("sends, records, and looks for it; a viewer can see the result and nothing more", async () => {
      const ws = workspace();
      const id = mailbox(ws, "route@one.test", { fields: { signature: "Ada\nAcme" } });
      expect((await call(sendTestHandler, ws, "GET", { id })).body).toEqual({ test: null });
      expect((await call(sendTestHandler, ws, "POST", { id, body: {} })).statusCode).toBe(400);
      expect((await call(sendTestHandler, ws, "POST", { id, body: { to: "route@one.test" }, role: "manager" })).statusCode).toBe(403);
      expect((await call(sendTestHandler, ws, "PUT", { id })).statusCode).toBe(404);

      const sent = await call(sendTestHandler, ws, "POST", { id, body: { to: "route@one.test" } });
      expect(sent.statusCode).toBe(200);
      expect(sent.body).toMatchObject({ ok: true, test: { status: "sent", readable: true } });
      expect(typeof sent.body.job_id).toBe("string");
      // The signature goes on a test, as it always has.
      expect(server.mailbox("route@one.test").at(-1)?.raw).toMatch(/--\r?\nAda\r?\nAcme/);

      const looked = await call(sendTestHandler, ws, "PUT", { id });
      expect(looked.body).toMatchObject({ test: { status: "found", placement: "inbox" } });
      const seen = await call(sendTestHandler, ws, "GET", { id, role: "viewer" });
      expect(seen.body).toMatchObject({ test: { status: "found", placement: "inbox", recipient: "route@one.test" } });
      expect((await call(sendTestHandler, ws, "PUT", { id, role: "viewer" })).statusCode).toBe(403);
    });

    it("refuses an address on the do-not-contact list", async () => {
      const ws = workspace();
      const id = mailbox(ws, "dnc@one.test");
      db().prepare("INSERT INTO suppressions (id, workspace_id, kind, value, reason) VALUES (?, ?, 'email', 'gone@prospect.test', 'unsubscribed')").run(`rb-sup-${++seq}`, ws);
      expect((await call(sendTestHandler, ws, "POST", { id, body: { to: "gone@prospect.test" } })).statusCode).toBe(409);
    });
  });
});

describe("reading a mailbox's folders and headers", () => {
  it("looks in the inbox first, then spam, then the rest, and never in what the mailbox sent or binned", () => {
    const box = (attribs: string[] = [], children: Record<string, unknown> | null = null) => ({ attribs, delimiter: "/", children, parent: null });
    const order = searchOrder({
      Sent: box(["\\Sent"]), Archive: box(), INBOX: box(), Junk: box(["\\Junk"]), Drafts: box(["\\Drafts"]),
      "[Gmail]": box(["\\Noselect"], { "All Mail": box(["\\All"]), Spam: box(["\\Junk"]), Trash: box(["\\Trash"]) }),
    } as never);
    expect(order.map((folder) => `${folder.kind}:${folder.path}`)).toEqual(["inbox:INBOX", "spam:Junk", "spam:[Gmail]/Spam", "other:Archive"]);
  });

  it("reads SPF, DKIM and DMARC from the receiving server's header", () => {
    expect(parseAuthResults("Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@acme.io header.s=google;\r\n       spf=pass (google.com: domain of mia@acme.io designates 1.2.3.4) smtp.mailfrom=mia@acme.io;\r\n       dmarc=fail (p=NONE) header.from=acme.io\r\n"))
      .toEqual({ spf: "pass", dkim: "pass", dmarc: "fail" });
    expect(parseAuthResults("Authentication-Results: mx.one; spf=softfail\r\nAuthentication-Results: relay.two; spf=pass; dkim=pass")).toEqual({ spf: "softfail", dkim: null, dmarc: null });
    expect(parseAuthResults("")).toBeNull();
    expect(parseAuthResults("Authentication-Results: mx.one; none")).toBeNull();
  });
});
