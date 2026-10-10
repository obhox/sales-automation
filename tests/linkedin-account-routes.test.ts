// The LinkedIn accounts screen's server side: the browser settings a session is tied to,
// what a sign-in records, pausing, the workspace preset, and the routes that save an
// account's settings. Real (throwaway) database. No browser is ever launched: the real
// session module is used, but only the parts that stop before one would be needed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ctxHeaders } from "./helpers/ctx";

vi.mock("@/lib/linkedin/health", () => ({ checkLinkedinSession: vi.fn() }));

import accountsHandler from "@/pages/api/accounts/index";
import accountHandler from "@/pages/api/accounts/[id]";
import presetHandler from "@/pages/api/accounts/preset";
import pauseHandler from "@/pages/api/accounts/[id]/pause";
import loginHandler from "@/pages/api/accounts/[id]/login";
import authenticateHandler from "@/pages/api/accounts/[id]/authenticate";
import disconnectHandler from "@/pages/api/accounts/[id]/disconnect";
import { checkLinkedinSession } from "@/lib/linkedin/health";
import { AccountPausedError, ProxyUnavailableError, SessionExpiredError, isProxyFailure } from "@/lib/linkedin/navigation";
import { disconnectAccount, getSessionPage, markNeedsReauth, newSessionContext, recordSignedIn } from "@/lib/linkedin/session";
import { BUILT_IN, contextForNewSession, normaliseProxyUrl, playwrightOptions, proxyProblem, storedContext } from "@/lib/linkedin/session-context";
import { holdForProxy, proxyHeldUntil, releaseProxyHold, PROXY_RETRY_MINUTES } from "@/lib/linkedin/proxy-hold";
import { DEFAULT_PRESET, accountSettingsProblem, getLinkedinPreset } from "@/lib/linkedin/account-settings";
import { linkedinAccountView, type LinkedinAccountsOverview } from "@/lib/linkedin/account-list";
import { listNotifications } from "@/lib/platform/notifications";

const check = vi.mocked(checkLinkedinSession);
const db = () => getDb();
let seq = 0;

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown> };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as Res;
}

/** A workspace with an admin, and a way to call a route as any of its members. */
function workspace() {
  const n = ++seq;
  const ws = `ws-lir-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const call = async (
    handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
    method: string,
    opts: { id?: string; body?: unknown; query?: Record<string, string>; role?: string; user?: string } = {},
  ) => {
    const res = mockRes();
    const role = opts.role ?? "admin";
    await handler({
      method, body: opts.body ?? {}, query: { ...(opts.id ? { id: opts.id } : {}), ...(opts.query ?? {}) },
      headers: ctxHeaders(ws, { userId: opts.user ?? `${ws}-${role}`, role }),
    } as unknown as NextApiRequest, res);
    return res;
  };
  const account = (fields: Record<string, unknown> = {}) => {
    const id = `lir-acct-${++seq}`;
    db().prepare("INSERT INTO accounts (id, name, email, workspace_id) VALUES (?, ?, ?, ?)").run(id, `Account ${seq}`, `lir${seq}@example.test`, ws);
    for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(value, id);
    return id;
  };
  return { ws, call, account };
}

const row = (id: string) => db().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Record<string, string | number | null>;
const notes = (ws: string) => listNotifications(ws, "nobody", "owner");
const SESSION = { cookies: [{ name: "li_at", value: "secret-session-value", domain: ".linkedin.com", path: "/" }], origins: [] };

beforeEach(() => {
  vi.clearAllMocks();
  releaseProxyHold();
});

// ─────────────────────────────────────────────────────────────────────
describe("the browser settings a session is tied to", () => {
  it("are the built-in ones for an account with no proxy, exactly as before", () => {
    expect(contextForNewSession({})).toEqual(BUILT_IN);
    expect(contextForNewSession({ timezone: "Europe/Berlin" })).toEqual(BUILT_IN);
    expect(BUILT_IN.timezoneId).toBe("America/New_York");
    expect(BUILT_IN.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it("add the proxy, and move the clock to the account's time zone, when it has one", () => {
    const record = contextForNewSession({ proxy_url: "http://proxy.example.com:8080", proxy_username: "user", proxy_password: "enc:abc", timezone: "Europe/Berlin" });
    expect(record.proxy).toEqual({ server: "http://proxy.example.com:8080", username: "user", password: "enc:abc" });
    expect(record.timezoneId).toBe("Europe/Berlin");
    expect(record.userAgent).toBe(BUILT_IN.userAgent);
  });

  it("read back as the built-in ones when nothing, or nonsense, was stored", () => {
    // An account signed in before settings were recorded must keep the session it has.
    expect(storedContext(null)).toEqual(BUILT_IN);
    expect(storedContext("")).toEqual(BUILT_IN);
    expect(storedContext("{not json")).toEqual(BUILT_IN);
    expect(storedContext("42")).toEqual(BUILT_IN);
    expect(storedContext(JSON.stringify({ viewport: { width: 0, height: -1 }, proxy: { server: "" } }))).toEqual(BUILT_IN);
  });

  it("read back exactly what was stored", () => {
    const record = contextForNewSession({ proxy_url: "socks5://10.0.0.1:1080", timezone: "Asia/Tokyo" });
    expect(storedContext(JSON.stringify(record))).toEqual(record);
  });

  it("are handed to the browser with the proxy password opened, and never without the proxy", () => {
    const record = contextForNewSession({ proxy_url: "http://proxy.example.com:8080", proxy_username: "user", proxy_password: encryptSecret("pw-1") });
    const options = playwrightOptions(record, SESSION, decryptSecret);
    expect(options.proxy).toEqual({ server: "http://proxy.example.com:8080", username: "user", password: "pw-1" });
    expect(options.storageState).toBe(SESSION);
    expect(playwrightOptions(BUILT_IN, undefined, decryptSecret).proxy).toBeUndefined();
  });

  it("accept a proxy address only in a form that can be used", () => {
    expect(proxyProblem("http://proxy.example.com:8080")).toBeNull();
    expect(proxyProblem("socks5://10.0.0.1:1080")).toBeNull();
    expect(proxyProblem("proxy.example.com:8080")).toMatch(/must start with|must look like/);
    expect(proxyProblem("ftp://proxy.example.com")).toMatch(/must start with/);
    expect(proxyProblem("http://user:pw@proxy.example.com:8080")).toMatch(/own fields/);
    expect(proxyProblem("http://proxy.example.com:8080/path")).toMatch(/path/);
    expect(proxyProblem("socks5://10.0.0.1:1080", "user")).toMatch(/SOCKS5/);
    expect(normaliseProxyUrl("http://Proxy.Example.com:8080/")).toBe("http://proxy.example.com:8080");
  });

  it("recognise the browser's proxy failures and nothing else", () => {
    expect(isProxyFailure(new Error("page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://www.linkedin.com/feed/"))).toBe(true);
    expect(isProxyFailure(new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED"))).toBe(true);
    expect(isProxyFailure(new Error("page.goto: Timeout 30000ms exceeded"))).toBe(false);
    expect(isProxyFailure(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("signing in and out", () => {
  it("records the session, how it was made, and the settings it was made with", () => {
    const w = workspace();
    const id = w.account({ proxy_url: "http://proxy.example.com:8080", proxy_username: "user", timezone: "Europe/Berlin" });
    recordSignedIn(id, SESSION, "login", newSessionContext(id));
    const saved = row(id);
    expect(saved.is_authenticated).toBe(1);
    expect(saved.auth_method).toBe("login");
    expect(saved.session_state).toBe("healthy");
    expect(String(saved.cookies_json)).not.toContain("secret-session-value");
    expect(JSON.parse(decryptSecret(saved.cookies_json as string)!)).toEqual(SESSION);
    expect(storedContext(saved.session_context_json as string)).toMatchObject({ timezoneId: "Europe/Berlin", proxy: { server: "http://proxy.example.com:8080", username: "user" } });
  });

  it("keeps using the settings the session was made with when the proxy is changed afterwards", () => {
    const w = workspace();
    const id = w.account();
    recordSignedIn(id, SESSION, "cookie", newSessionContext(id));
    db().prepare("UPDATE accounts SET proxy_url = 'http://new.example.com:1' WHERE id = ?").run(id);
    expect(storedContext(row(id).session_context_json as string).proxy).toBeNull();
    expect(linkedinAccountView(db(), w.ws, id)!.proxy).toMatchObject({ server: "http://new.example.com:1", in_use: false });
    // …until the next sign-in, which is created with it.
    recordSignedIn(id, SESSION, "cookie", newSessionContext(id));
    expect(linkedinAccountView(db(), w.ws, id)!.proxy).toMatchObject({ in_use: true });
  });

  it("starts a warm-up that was set up but not begun, and leaves a running one alone", () => {
    const w = workspace();
    const fresh = w.account({ ramp_days: 14, ramp_start_limit: 5 });
    const running = w.account({ ramp_days: 14, ramp_start_limit: 5, ramp_start_date: "2026-01-01" });
    const none = w.account();
    for (const id of [fresh, running, none]) recordSignedIn(id, SESSION, "login", newSessionContext(id));
    expect(row(fresh).ramp_start_date).toBe(new Date().toISOString().slice(0, 10));
    expect(row(running).ramp_start_date).toBe("2026-01-01");
    expect(row(none).ramp_start_date).toBeNull();
  });

  it("lets go of a proxy hold, since the new session may use a different proxy", () => {
    const w = workspace();
    const id = w.account();
    holdForProxy(id);
    expect(proxyHeldUntil(id)).not.toBeNull();
    recordSignedIn(id, SESSION, "login", newSessionContext(id));
    expect(proxyHeldUntil(id)).toBeNull();
  });

  it("holds an account's proxy for half an hour and then tries again", () => {
    const now = Date.now();
    holdForProxy("held-account", now);
    expect(proxyHeldUntil("held-account", now + (PROXY_RETRY_MINUTES - 1) * 60_000)).toBe(now + PROXY_RETRY_MINUTES * 60_000);
    expect(proxyHeldUntil("held-account", now + PROXY_RETRY_MINUTES * 60_000)).toBeNull();
    expect(proxyHeldUntil("never-held")).toBeNull();
  });

  it("refuses to open a paused account's session, whoever asks", async () => {
    const w = workspace();
    const id = w.account({ is_authenticated: 1, cookies_json: encryptSecret(JSON.stringify(SESSION)), paused_at: "2026-10-10 09:00:00" });
    await expect(getSessionPage(id)).rejects.toBeInstanceOf(AccountPausedError);
  });

  it("says a session is missing instead of opening an anonymous browser", async () => {
    const w = workspace();
    await expect(getSessionPage(w.account())).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("tells the workspace once when LinkedIn ends a session, and points at the accounts page", async () => {
    const w = workspace();
    const id = w.account({ is_authenticated: 1 });
    await markNeedsReauth(id);
    await markNeedsReauth(id);
    const told = notes(w.ws).filter((note) => note.kind === "linkedin.signin_needed");
    expect(told).toHaveLength(1);
    expect(told[0].link).toBe("/linkedin-accounts");
    expect(row(id)).toMatchObject({ is_authenticated: 0, session_state: "needs_signin" });
  });

  it("tells nobody when a person disconnects an account themselves", async () => {
    const w = workspace();
    const id = w.account({ is_authenticated: 1, cookies_json: encryptSecret(JSON.stringify(SESSION)) });
    await disconnectAccount(id);
    expect(row(id)).toMatchObject({ is_authenticated: 0, cookies_json: null, session_state: "disconnected" });
    expect(notes(w.ws)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("PUT /api/accounts/{id}", () => {
  it("saves the new settings and clears the ones that can fall back to a default", async () => {
    const w = workspace();
    const id = w.account();
    const saved = await w.call(accountHandler, "PUT", { id, body: { weekly_connection_limit: 80, daily_withdraw_limit: 10, invite_max_wait_days: 21, plan: " Sales Navigator ", ramp_days: 10, ramp_start_limit: 5, ramp_start_date: "2026-10-10" } });
    expect(saved.statusCode).toBe(200);
    expect(row(id)).toMatchObject({ weekly_connection_limit: 80, daily_withdraw_limit: 10, invite_max_wait_days: 21, plan: "Sales Navigator", ramp_days: 10, ramp_start_limit: 5, ramp_start_date: "2026-10-10" });

    await w.call(accountHandler, "PUT", { id, body: { weekly_connection_limit: null, ramp_days: null, ramp_start_limit: null, ramp_start_date: null, plan: "" } });
    expect(row(id)).toMatchObject({ weekly_connection_limit: null, ramp_days: null, ramp_start_limit: null, ramp_start_date: null, plan: null, daily_withdraw_limit: 10 });
  });

  it("leaves a daily limit as it is when sent as null, as the old form relies on", async () => {
    const w = workspace();
    const id = w.account({ daily_connection_limit: 30 });
    const saved = await w.call(accountHandler, "PUT", { id, body: { daily_connection_limit: null, daily_message_limit: 60 } });
    expect(saved.statusCode).toBe(200);
    expect(row(id)).toMatchObject({ daily_connection_limit: 30, daily_message_limit: 60 });
  });

  it("refuses numbers LinkedIn would punish, and lowers a visit limit instead of refusing it", async () => {
    const w = workspace();
    const id = w.account();
    for (const body of [{ daily_connection_limit: 101 }, { weekly_connection_limit: 401 }, { weekly_connection_limit: 0 }, { daily_withdraw_limit: 51 }, { invite_max_wait_days: 2 }, { ramp_days: 1 }, { daily_message_limit: 1.5 }]) {
      const refused = await w.call(accountHandler, "PUT", { id, body });
      expect(refused.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await w.call(accountHandler, "PUT", { id, body: { ramp_start_limit: 25, daily_connection_limit: 20 } })).body.error).toMatch(/cannot start above/);
    expect((await w.call(accountHandler, "PUT", { id, body: { daily_visit_limit: 900 } })).statusCode).toBe(200);
    expect(row(id).daily_visit_limit).toBe(150);
  });

  it("stores a proxy without ever giving its password back", async () => {
    const w = workspace();
    const id = w.account();
    const saved = await w.call(accountHandler, "PUT", { id, body: { proxy_url: "http://Proxy.Example.com:8080/", proxy_username: "user", proxy_password: "pw-secret", proxy_label: "Berlin" } });
    expect(saved.statusCode).toBe(200);
    const stored = row(id);
    expect(stored).toMatchObject({ proxy_url: "http://proxy.example.com:8080", proxy_username: "user", proxy_label: "Berlin" });
    expect(stored.proxy_password).not.toBe("pw-secret");
    expect(decryptSecret(stored.proxy_password as string)).toBe("pw-secret");
    expect(JSON.stringify(saved.body)).not.toMatch(/pw-secret|proxy_password|cookies_json|session_context/);
    const overview = await w.call(accountsHandler, "GET", { query: { view: "overview" }, role: "viewer" });
    expect(JSON.stringify(overview.body)).not.toMatch(/pw-secret|proxy_password|cookies_json|session_context|"user"/);

    // Saving something else keeps the password; an empty address removes the proxy and its sign-in.
    await w.call(accountHandler, "PUT", { id, body: { proxy_label: "Berlin 2" } });
    expect(decryptSecret(row(id).proxy_password as string)).toBe("pw-secret");
    await w.call(accountHandler, "PUT", { id, body: { proxy_url: "" } });
    expect(row(id)).toMatchObject({ proxy_url: null, proxy_username: null, proxy_password: null });
  });

  it("refuses a proxy address it could not use", async () => {
    const w = workspace();
    const id = w.account();
    expect((await w.call(accountHandler, "PUT", { id, body: { proxy_url: "http://user:pw@proxy.example.com:8080" } })).statusCode).toBe(400);
    expect((await w.call(accountHandler, "PUT", { id, body: { proxy_url: "socks5://10.0.0.1:1080", proxy_username: "user" } })).statusCode).toBe(400);
    expect(row(id).proxy_url).toBeNull();
  });

  it("gives an account only to a member of the workspace", async () => {
    const w = workspace();
    const other = workspace();
    const id = w.account();
    await other.call(accountsHandler, "GET", { user: "outsider", role: "admin" });
    expect((await w.call(accountHandler, "PUT", { id, body: { owner_id: "outsider" } })).statusCode).toBe(400);
    await w.call(accountsHandler, "GET", { user: "insider", role: "member" });
    expect((await w.call(accountHandler, "PUT", { id, body: { owner_id: "insider" } })).statusCode).toBe(200);
    expect(row(id).owner_id).toBe("insider");
  });

  it("is for admins, and never reaches another workspace's account", async () => {
    const w = workspace();
    const other = workspace();
    const id = w.account();
    expect((await w.call(accountHandler, "PUT", { id, body: { plan: "x" }, role: "manager" })).statusCode).toBe(403);
    expect((await other.call(accountHandler, "PUT", { id, body: { plan: "x" } })).statusCode).toBe(404);
    expect(row(id).plan).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the workspace preset", () => {
  it("is the old column defaults until somebody changes it", async () => {
    const w = workspace();
    expect(getLinkedinPreset(w.ws)).toEqual(DEFAULT_PRESET);
    const created = await w.call(accountsHandler, "POST", { body: { name: "New", email: `new-${seq}@example.test` }, role: "member" });
    expect(created.statusCode).toBe(201);
    expect(row(created.body.id as string)).toMatchObject({
      daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15, daily_visit_limit: 150, weekly_connection_limit: null,
      active_hours_start: 9, active_hours_end: 18, working_days: "1,2,3,4,5", timezone: "UTC", withdraw_stale_invites: 0, ramp_days: null, ramp_start_date: null,
      owner_id: `${w.ws}-member`,
    });
  });

  it("is what a new account starts with, unless the request says otherwise", async () => {
    const w = workspace();
    const saved = await w.call(presetHandler, "PUT", { body: { daily_connection_limit: 25, weekly_connection_limit: 90, active_hours_start: 8, ramp_days: 14, ramp_start_limit: 5, withdraw_stale_invites: true } });
    expect(saved.statusCode).toBe(200);
    const created = await w.call(accountsHandler, "POST", { body: { name: "New", email: `new-${seq}@example.test`, daily_message_limit: 40, timezone: "Europe/Berlin" } });
    expect(row(created.body.id as string)).toMatchObject({
      daily_connection_limit: 25, weekly_connection_limit: 90, active_hours_start: 8, daily_message_limit: 40, timezone: "Europe/Berlin",
      withdraw_stale_invites: 1, ramp_days: 14, ramp_start_limit: 5, ramp_start_date: null,
    });
  });

  it("refuses a preset that could not be applied", async () => {
    const w = workspace();
    for (const body of [{ daily_connection_limit: 500 }, { ramp_days: 14 }, { ramp_days: 14, ramp_start_limit: 50 }, { active_hours_start: 20 }, { withdraw_stale_invites: "yes" }, { working_days: "1,1" }]) {
      expect((await w.call(presetHandler, "PUT", { body })).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(getLinkedinPreset(w.ws)).toEqual(DEFAULT_PRESET);
    expect((await w.call(presetHandler, "PUT", { body: { daily_connection_limit: 30 }, role: "manager" })).statusCode).toBe(403);
  });

  it("is copied onto the accounts named, in this workspace only, without touching warm-up or clean-up", async () => {
    const w = workspace();
    const other = workspace();
    const mine = w.account({ daily_connection_limit: 99, ramp_days: 7, withdraw_stale_invites: 1 });
    const untouched = w.account({ daily_connection_limit: 99 });
    const theirs = other.account({ daily_connection_limit: 99 });
    await w.call(presetHandler, "PUT", { body: { daily_connection_limit: 15, working_days: "1,2,3" } });
    const applied = await w.call(presetHandler, "POST", { body: { account_ids: [mine, theirs] } });
    expect(applied.body).toEqual({ applied: 1 });
    expect(row(mine)).toMatchObject({ daily_connection_limit: 15, working_days: "1,2,3", ramp_days: 7, withdraw_stale_invites: 1 });
    expect(row(untouched).daily_connection_limit).toBe(99);
    expect(row(theirs).daily_connection_limit).toBe(99);
  });

  it("checks the same rules whichever way a setting arrives", () => {
    expect(accountSettingsProblem({ weekly_connection_limit: 100, timezone: "Europe/Berlin" })).toBeNull();
    expect(accountSettingsProblem({ timezone: "Mars/Olympus" })).toMatch(/timezone/);
    expect(accountSettingsProblem({ active_hours_end: 8 }, { active_hours_start: 9, active_hours_end: 18 })).toMatch(/before/);
    expect(accountSettingsProblem({ ramp_start_date: "10/10/2026" })).toMatch(/date/);
    expect(accountSettingsProblem({ plan: "x".repeat(81) })).toMatch(/80/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("POST /api/accounts/{id}/pause", () => {
  it("pauses with a reason, keeps the first pause time, and resumes", async () => {
    const w = workspace();
    const id = w.account({ is_authenticated: 1 });
    const paused = await w.call(pauseHandler, "POST", { id, body: { paused: true, reason: "On holiday" }, role: "manager" });
    expect(paused.body).toMatchObject({ ok: true, paused: true, reason: "On holiday" });
    const first = row(id).paused_at;
    expect(first).toBeTruthy();
    expect(row(id).is_authenticated).toBe(1); // still signed in

    db().prepare("UPDATE accounts SET paused_at = '2026-01-01 00:00:00' WHERE id = ?").run(id);
    await w.call(pauseHandler, "POST", { id, body: { paused: true } });
    expect(row(id)).toMatchObject({ paused_at: "2026-01-01 00:00:00", paused_reason: null });

    const resumed = await w.call(pauseHandler, "POST", { id, body: { paused: false } });
    expect(resumed.body).toMatchObject({ paused: false });
    expect(row(id)).toMatchObject({ paused_at: null, paused_reason: null });
  });

  it("is for managers and above, in their own workspace, and needs a clear yes or no", async () => {
    const w = workspace();
    const other = workspace();
    const id = w.account();
    expect((await w.call(pauseHandler, "POST", { id, body: { paused: true }, role: "member" })).statusCode).toBe(403);
    expect((await other.call(pauseHandler, "POST", { id, body: { paused: true } })).statusCode).toBe(404);
    expect((await w.call(pauseHandler, "POST", { id, body: { paused: "yes" } })).statusCode).toBe(400);
    expect(row(id).paused_at).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("GET /api/accounts?view=overview", () => {
  it("says where each account stands, most pressing thing first", async () => {
    const w = workspace();
    const signedIn = { is_authenticated: 1, cookies_json: encryptSecret(JSON.stringify(SESSION)), session_state: "healthy" };
    const ids = {
      never_connected: w.account(),
      needs_signin: w.account({ session_state: "needs_signin", cookies_json: "x" }),
      disconnected: w.account({ session_state: "disconnected" }),
      paused: w.account({ ...signedIn, paused_at: "2026-10-10 09:00:00", weekly_limit_hit_at: new Date().toISOString() }),
      weekly_hold: w.account({ ...signedIn, weekly_limit_hit_at: new Date().toISOString(), ramp_days: 10, ramp_start_date: new Date().toISOString().slice(0, 10) }),
      warming_up: w.account({ ...signedIn, ramp_days: 10, ramp_start_limit: 4, ramp_start_date: new Date().toISOString().slice(0, 10) }),
      active: w.account(signedIn),
    };
    const overview = (await w.call(accountsHandler, "GET", { query: { view: "overview" }, role: "viewer" })).body as unknown as LinkedinAccountsOverview;
    const status = Object.fromEntries(overview.accounts.map((account) => [account.id, account.status]));
    for (const [expected, id] of Object.entries(ids)) expect(status[id], expected).toBe(expected);
    // Oldest first, so a card does not move when another account is added.
    expect(overview.accounts.map((account) => account.id)).toEqual(Object.values(ids));
    const warming = overview.accounts.find((account) => account.id === ids.warming_up)!;
    expect(warming.limits).toMatchObject({ connections: 4, connections_full: 20 });
    expect(warming.ramp).toMatchObject({ day: 1, days: 10, limit: 4 });
  });

  it("counts today's work against each limit, and the week's invitations", async () => {
    const w = workspace();
    const id = w.account({ is_authenticated: 1, weekly_connection_limit: 10 });
    const send = (action: string, when: string) =>
      db().prepare("INSERT INTO step_sends (id, workspace_id, channel, action, account_id, sent_at) VALUES (?, ?, 'linkedin', ?, ?, datetime('now', ?))").run(`lir-send-${++seq}`, w.ws, action, id, when);
    send("connect", "-1 minutes"); send("connect", "-2 minutes"); send("message", "-1 minutes"); send("visit", "-1 minutes");
    for (let i = 0; i < 7; i++) send("connect", "-3 days");
    const view = linkedinAccountView(db(), w.ws, id)!;
    expect(view.usage).toMatchObject({ connects: 2, messages: 1, visits: 1, connects_7d: 9 });
    expect(view.weekly).toMatchObject({ used: 9, limit: 10, near: true, hold: null });
    expect(view.status).toBe("active");
    send("connect", "-4 days");
    expect(linkedinAccountView(db(), w.ws, id)!).toMatchObject({ status: "weekly_hold", weekly: { hold: { reason: "cap", used: 10, limit: 10 } } });
  });

  it("measures acceptance on the contacts invited this week and last", async () => {
    const w = workspace();
    w.account();
    const invite = (daysAgo: number, accepted: boolean) =>
      db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url, connection_requested_at, degree) VALUES (?, ?, 'Lead', ?, datetime('now', ?), ?)")
        .run(`lir-target-${++seq}`, w.ws, `https://www.linkedin.com/in/lir-${seq}/`, `-${daysAgo} days`, accepted ? 1 : 2);
    invite(1, true); invite(2, false); invite(3, false); invite(4, false);
    invite(9, true); invite(10, false);
    const overview = (await w.call(accountsHandler, "GET", { query: { view: "overview" } })).body as unknown as LinkedinAccountsOverview;
    expect(overview.acceptance).toEqual({ rate: 0.25, previous: 0.5, sent: 4 });
  });

  it("still answers the plain list in the shape the API has always given", async () => {
    const w = workspace();
    const id = w.account();
    const list = (await w.call(accountsHandler, "GET", {})).body as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    expect(list[0]).toMatchObject({ id, daily_connection_limit: 20 });
    expect(list[0]).toHaveProperty("stale_invites");
    expect(list[0]).not.toHaveProperty("proxy_password");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("connecting an account", () => {
  it("stores a pasted session as a cookie sign-in once LinkedIn accepts it", async () => {
    const w = workspace();
    const id = w.account();
    check.mockResolvedValue({ signedIn: true, detail: null });
    const res = await w.call(authenticateHandler, "POST", { id, body: { li_at: " pasted-value ", document_cookie: "JSESSIONID=ajax:1; lang=v=2" } });
    expect(res.body).toEqual({ ok: true, verified: true });
    expect(check).toHaveBeenCalledWith(id, { quiet: true });
    const saved = row(id);
    expect(saved).toMatchObject({ is_authenticated: 1, auth_method: "cookie", session_state: "healthy" });
    const state = JSON.parse(decryptSecret(saved.cookies_json as string)!) as { cookies: Array<{ name: string; value: string }> };
    expect(state.cookies.map((cookie) => cookie.name)).toEqual(["li_at", "JSESSIONID", "lang"]);
    expect(state.cookies[0].value).toBe("pasted-value");
    expect(storedContext(saved.session_context_json as string)).toEqual(BUILT_IN);
  });

  it("refuses a session LinkedIn does not accept", async () => {
    const w = workspace();
    const id = w.account();
    check.mockResolvedValue({ signedIn: false, detail: "redirected to login" });
    const res = await w.call(authenticateHandler, "POST", { id, body: { li_at: "stale" } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/did not accept/);
  });

  it("keeps a session it could not check, and says when the proxy was why", async () => {
    const w = workspace();
    const id = w.account();
    check.mockRejectedValue(new ProxyUnavailableError("net::ERR_PROXY_CONNECTION_FAILED"));
    const res = await w.call(authenticateHandler, "POST", { id, body: { li_at: "value" } });
    expect(res.body).toMatchObject({ ok: true, verified: false });
    expect(res.body.detail).toMatch(/proxy/);
    check.mockRejectedValue(new Error("no browser here"));
    expect((await w.call(authenticateHandler, "POST", { id, body: { li_at: "value" } })).body).toEqual({ ok: true, verified: false });
  });

  it("has nothing to resend a code on when no sign-in is being held", async () => {
    const w = workspace();
    const id = w.account();
    const res = await w.call(loginHandler, "POST", { id, body: { step: "resend" } });
    expect(res.body).toMatchObject({ status: "error" });
    expect(String(res.body.message)).toMatch(/No login in progress/);
  });

  it("disconnects through the route without a needs-sign-in notice", async () => {
    const w = workspace();
    const id = w.account({ is_authenticated: 1, cookies_json: encryptSecret(JSON.stringify(SESSION)) });
    const res = await w.call(disconnectHandler, "POST", { id });
    expect(res.statusCode).toBe(200);
    expect(row(id)).toMatchObject({ is_authenticated: 0, cookies_json: null, session_state: "disconnected" });
    expect(linkedinAccountView(db(), w.ws, id)!.status).toBe("disconnected");
    expect(notes(w.ws)).toHaveLength(0);
  });
});
