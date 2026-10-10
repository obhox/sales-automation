// Getting back into an account, and proving an address before getting in at all: reset
// links, confirmation links, and the rule that a new password ends every older session.
// Run against a real (throwaway) database; the only thing stubbed is the SMTP send.
import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { NextApiRequest, NextApiResponse } from "next";

const mail = vi.hoisted(() => ({ configured: true, outbox: [] as Array<{ to: string; subject: string; text: string }> }));
vi.mock("@/lib/email/system-mailer", () => ({
  systemMailerConfigured: () => mail.configured,
  sendSystemEmail: async (message: { to: string; subject: string; text: string }) => { mail.outbox.push(message); },
}));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));

import { getServerSession } from "next-auth/next";
import { getDb } from "@/lib/db";
import { consumeAuthToken, issueAuthToken } from "@/lib/auth-tokens";
import { requireWorkspace } from "@/lib/workspace";
import { createWorkspaceInvitation } from "@/lib/workspace-invitations";
import { authOptions, EMAIL_NOT_VERIFIED } from "@/pages/api/auth/[...nextauth]";
import signup from "@/pages/api/auth/signup";
import forgotPassword from "@/pages/api/auth/forgot-password";
import resetPassword from "@/pages/api/auth/reset-password";
import verifyEmail from "@/pages/api/auth/verify-email";
import resendVerification from "@/pages/api/auth/resend-verification";
import changePassword from "@/pages/api/auth/change-password";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

/** POST to a route. Each call comes from its own address, so the per-IP limits never bite. */
async function post(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, body: unknown) {
  const res = mockRes();
  await handler({ method: "POST", body, query: {}, headers: { "x-real-ip": `10.0.0.${++seq}`, host: "linki.test" } } as unknown as NextApiRequest, res);
  return res;
}

/** An account that exists already, confirmed unless said otherwise. */
async function account(opts: { password?: string; verified?: boolean } = {}) {
  const id = `rec-user-${++seq}`;
  const email = `${id}@example.com`;
  db().prepare("INSERT INTO users (id, email, password_hash, email_verified_at) VALUES (?, ?, ?, ?)")
    .run(id, email, await bcrypt.hash(opts.password ?? "old-password", 4), opts.verified === false ? null : new Date().toISOString());
  return { id, email };
}

const user = (id: string) =>
  db().prepare("SELECT password_hash, email_verified_at, sessions_valid_after FROM users WHERE id = ?").get(id) as
    { password_hash: string; email_verified_at: string | null; sessions_valid_after: number | null };
const userByEmail = (email: string) =>
  db().prepare("SELECT id, email_verified_at FROM users WHERE email = ?").get(email) as { id: string; email_verified_at: string | null };

/** The token in the link of the last email sent. */
function mailedToken(path: string): string {
  const last = mail.outbox[mail.outbox.length - 1];
  const match = last.text.match(new RegExp(`${path}\\?token=([^\\s]+)`));
  if (!match) throw new Error(`no ${path} link in: ${last.text}`);
  return decodeURIComponent(match[1]);
}

type Authorize = (credentials: Record<string, string>, req: unknown) => Promise<{ id: string } | null>;
const authorize = (authOptions.providers[0] as unknown as { options: { authorize: Authorize } }).options.authorize;
const signIn = (email: string, password: string) => authorize({ email, password }, { headers: { "x-real-ip": `10.1.0.${++seq}` } });

const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  mail.configured = true;
  mail.outbox.length = 0;
});

describe("mailed tokens", () => {
  it("work once", async () => {
    const { id } = await account();
    const token = issueAuthToken(id, "password_reset");
    expect(consumeAuthToken(token, "password_reset")).toEqual({ userId: id });
    expect(consumeAuthToken(token, "password_reset")).toBeNull();
  });

  it("do not work for a different purpose, after they expire, or once a newer one was asked for", async () => {
    const { id } = await account();
    const reset = issueAuthToken(id, "password_reset");
    expect(consumeAuthToken(reset, "email_verify")).toBeNull();

    db().prepare("UPDATE auth_tokens SET expires_at = ? WHERE user_id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
    expect(consumeAuthToken(reset, "password_reset")).toBeNull();

    const first = issueAuthToken(id, "password_reset");
    const second = issueAuthToken(id, "password_reset");
    expect(consumeAuthToken(first, "password_reset")).toBeNull();
    expect(consumeAuthToken(second, "password_reset")).toEqual({ userId: id });
  });

  it("are stored hashed", async () => {
    const { id } = await account();
    const token = issueAuthToken(id, "email_verify");
    const stored = db().prepare("SELECT token_hash FROM auth_tokens WHERE user_id = ?").get(id) as { token_hash: string };
    expect(stored.token_hash).not.toBe(token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("asking for a reset link", () => {
  it("answers the same for an address with an account and one without, and only mails the first", async () => {
    const { email } = await account();
    const known = await post(forgotPassword, { email });
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]).toMatchObject({ to: email });
    expect(mail.outbox[0].text).toContain("http://linki.test/reset-password?token=");

    const unknown = await post(forgotPassword, { email: "nobody@example.com" });
    expect(mail.outbox).toHaveLength(1);
    expect([unknown.statusCode, unknown.body]).toEqual([known.statusCode, known.body]);
    expect(known.statusCode).toBe(200);
  });

  it("finds the account whatever the capitalisation", async () => {
    const { email } = await account();
    await post(forgotPassword, { email: `  ${email.toUpperCase()} ` });
    expect(mail.outbox).toHaveLength(1);
  });

  it("says so when the server cannot send mail, rather than pretending a link is coming", async () => {
    mail.configured = false;
    const { email } = await account();
    const res = await post(forgotPassword, { email });
    expect(res.statusCode).toBe(503);
    expect(mail.outbox).toHaveLength(0);
  });
});

describe("setting a new password from the link", () => {
  it("changes the password, and the link cannot be used again", async () => {
    const { id, email } = await account();
    await post(forgotPassword, { email });
    const token = mailedToken("/reset-password");

    expect((await post(resetPassword, { token, password: "brand-new-password" })).statusCode).toBe(200);
    expect(await bcrypt.compare("brand-new-password", user(id).password_hash)).toBe(true);
    expect(await signIn(email, "brand-new-password")).toMatchObject({ id });
    expect(await signIn(email, "old-password")).toBeNull();

    const again = await post(resetPassword, { token, password: "another-password" });
    expect(again.statusCode).toBe(400);
    expect(await bcrypt.compare("brand-new-password", user(id).password_hash)).toBe(true);
  });

  it("leaves the link usable when the password offered is refused", async () => {
    const { id, email } = await account();
    await post(forgotPassword, { email });
    const token = mailedToken("/reset-password");

    expect((await post(resetPassword, { token, password: "short" })).statusCode).toBe(400);
    expect((await post(resetPassword, { token, password: "long-enough-now" })).statusCode).toBe(200);
    expect(await bcrypt.compare("long-enough-now", user(id).password_hash)).toBe(true);
  });

  it("refuses a made-up token", async () => {
    expect((await post(resetPassword, { token: "reset_not-a-real-token", password: "long-enough-now" })).statusCode).toBe(400);
  });

  it("confirms the address too: opening the link proved it is read", async () => {
    const { id, email } = await account({ verified: false });
    await post(forgotPassword, { email });
    await post(resetPassword, { token: mailedToken("/reset-password"), password: "brand-new-password" });
    expect(user(id).email_verified_at).not.toBeNull();
  });
});

describe("sessions after a password is set", () => {
  function resolve(headers: Record<string, string>) {
    const res = mockRes();
    return { ctx: requireWorkspace({ headers } as unknown as NextApiRequest, res), status: res.statusCode };
  }
  const refresh = (id: string, iat: number) =>
    authOptions.callbacks!.jwt!({ token: { sub: id, userId: id, email: "x@example.com", iat } } as never);

  it("ends every session issued before it, and lets one issued after it through", async () => {
    const { id, email } = await account();
    db().prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-rec-sessions', 'r', 'ws-rec-sessions')").run();
    const before = nowSeconds() - 60;
    const old = ctxHeaders("ws-rec-sessions", { userId: id, role: "owner", iat: String(before) });
    expect(resolve(old).ctx).not.toBeNull();
    await expect(refresh(id, before)).resolves.toBeTruthy();

    await post(forgotPassword, { email });
    await post(resetPassword, { token: mailedToken("/reset-password"), password: "brand-new-password" });

    // The old cookie is refused by every route, and cannot renew itself either.
    expect(resolve(old)).toEqual({ ctx: null, status: 401 });
    await expect(refresh(id, before)).rejects.toThrow();

    const fresh = ctxHeaders("ws-rec-sessions", { userId: id, role: "owner", iat: String(nowSeconds() + 1) });
    expect(resolve(fresh).ctx).toMatchObject({ userId: id });
    await expect(refresh(id, nowSeconds() + 1)).resolves.toBeTruthy();
  });

  it("is the same for a password changed while signed in", async () => {
    const { id, email } = await account({ password: "current-password" });
    vi.mocked(getServerSession).mockResolvedValue({ user: { email } } as never);
    expect(user(id).sessions_valid_after).toBeNull();

    expect((await post(changePassword, { currentPassword: "wrong-password", newPassword: "next-password-1" })).statusCode).toBe(400);
    expect(user(id).sessions_valid_after).toBeNull();

    expect((await post(changePassword, { currentPassword: "current-password", newPassword: "next-password-1" })).statusCode).toBe(200);
    expect(user(id).sessions_valid_after).toBeGreaterThanOrEqual(nowSeconds() - 2);
    await expect(refresh(id, nowSeconds() - 60)).rejects.toThrow();
  });

  it("does not touch a call made with no browser session behind it", async () => {
    const { id } = await account();
    db().prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-rec-internal', 'r', 'ws-rec-internal')").run();
    db().prepare("UPDATE users SET sessions_valid_after = ? WHERE id = ?").run(nowSeconds(), id);
    expect(resolve(ctxHeaders("ws-rec-internal", { userId: id, role: "owner" })).ctx).toMatchObject({ userId: id });
  });
});

describe("signing up", () => {
  it("asks for the address to be confirmed, and keeps the account out until it is", async () => {
    const email = `rec-new-${++seq}@example.com`;
    const res = await post(signup, { email, password: "a-good-password" });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ verification_required: true });
    expect(userByEmail(email).email_verified_at).toBeNull();
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0].text).toContain("http://linki.test/verify-email?token=");

    await expect(signIn(email, "a-good-password")).rejects.toThrow(EMAIL_NOT_VERIFIED);
    // A wrong password still looks like any other wrong password.
    expect(await signIn(email, "not-the-password")).toBeNull();

    expect((await post(verifyEmail, { token: mailedToken("/verify-email") })).statusCode).toBe(200);
    expect(userByEmail(email).email_verified_at).not.toBeNull();
    expect(await signIn(email, "a-good-password")).toMatchObject({ id: userByEmail(email).id });
  });

  it("lets a confirmation link be used once", async () => {
    const email = `rec-new-${++seq}@example.com`;
    await post(signup, { email, password: "a-good-password" });
    const token = mailedToken("/verify-email");
    expect((await post(verifyEmail, { token })).statusCode).toBe(200);
    expect((await post(verifyEmail, { token })).statusCode).toBe(400);
  });

  it("sends a new link on request, without saying whether the address needed one", async () => {
    const email = `rec-new-${++seq}@example.com`;
    await post(signup, { email, password: "a-good-password" });
    const first = mailedToken("/verify-email");

    const again = await post(resendVerification, { email });
    expect(mail.outbox).toHaveLength(2);
    expect((await post(verifyEmail, { token: first })).statusCode).toBe(400);
    expect((await post(verifyEmail, { token: mailedToken("/verify-email") })).statusCode).toBe(200);

    const confirmed = await post(resendVerification, { email });
    const unknown = await post(resendVerification, { email: "nobody@example.com" });
    expect(mail.outbox).toHaveLength(2);
    expect([confirmed.statusCode, confirmed.body]).toEqual([again.statusCode, again.body]);
    expect([unknown.statusCode, unknown.body]).toEqual([again.statusCode, again.body]);
  });

  it("asks for no confirmation on a server that cannot send the email", async () => {
    mail.configured = false;
    const email = `rec-new-${++seq}@example.com`;
    const res = await post(signup, { email, password: "a-good-password" });
    expect(res.body).toMatchObject({ verification_required: false });
    expect(mail.outbox).toHaveLength(0);
    expect(userByEmail(email).email_verified_at).not.toBeNull();
    expect(await signIn(email, "a-good-password")).toBeTruthy();
  });

  it("asks for none from someone invited to that address", async () => {
    db().prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-rec-invite', 'r', 'ws-rec-invite')").run();
    const email = `rec-invited-${++seq}@example.com`;
    const { token } = createWorkspaceInvitation({ workspaceId: "ws-rec-invite", email, role: "member", invitedBy: null });

    const res = await post(signup, { email, password: "a-good-password", invite_token: token });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ verification_required: false });
    expect(mail.outbox).toHaveLength(0);
    expect(await signIn(email, "a-good-password")).toBeTruthy();
  });
});

describe("accounts that existed before confirmation was asked for", () => {
  // The statement lib/db.ts runs on every boot, re-executed here to stand in for the next one.
  const BACKFILL = `UPDATE users SET email_verified_at = COALESCE(created_at, datetime('now'))
    WHERE email_verified_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM _migration_flags WHERE key = 'existing_users_verified_v1')`;

  it("were marked confirmed once, and a later start does not confirm newer signups", async () => {
    expect(db().prepare("SELECT 1 FROM _migration_flags WHERE key = 'existing_users_verified_v1'").get()).toBeTruthy();
    const { id } = await account({ verified: false });

    db().exec(BACKFILL);

    expect(user(id).email_verified_at).toBeNull();
  });
});
