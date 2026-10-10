import { chromium } from "playwright-extra";
import { emitDomainEvent } from "@/lib/platform/events";
import { notify } from "@/lib/platform/notifications";
import type { Browser, BrowserContext, Page } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { getDb } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { AccountPausedError, SessionExpiredError, isProxyFailure } from "@/lib/linkedin/navigation";
import { releaseProxyHold } from "@/lib/linkedin/proxy-hold";
import { contextForNewSession, playwrightOptions, storedContext, type SessionContextRecord } from "@/lib/linkedin/session-context";

export { AccountPausedError, ProxyUnavailableError, SessionExpiredError, gotoLinkedin, throwIfSignedOut } from "@/lib/linkedin/navigation";

chromium.use(StealthPlugin());

let browser: Browser | null = null;
const contexts: Map<string, BrowserContext> = new Map();

const HEADLESS = process.env.HEADLESS !== "false";
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/**
 * The options a browser context is opened with. Sign-in and every later use of a session
 * must pass the SAME record: LinkedIn ends a session whose browser changes under it. The
 * record is stored on the account at sign-in (lib/linkedin/session-context.ts); an account
 * with none stored gets the built-in settings every account used before.
 */
function contextOptions(record: SessionContextRecord, storageState?: object) {
  const options = playwrightOptions(record, storageState, value => decryptSecret(value));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...options, storageState: options.storageState as any };
}

async function getBrowser(headless = HEADLESS): Promise<Browser> {
  // B1: if the cached browser is disconnected, CLOSE it before relaunching.
  // Without this, a dead-but-not-reaped chromium process tree is orphaned on
  // every relaunch (the leak behind the Jun 2026 zombie pile-up).
  if (browser && !browser.isConnected()) {
    try { await browser.close(); } catch { /* already gone */ }
    browser = null;
  }
  if (!browser) {
    browser = await chromium.launch({
      headless,
      executablePath: CHROMIUM_PATH,
      args: LAUNCH_ARGS,
    });
  }
  return browser;
}

async function getOrCreateContext(accountId: string): Promise<BrowserContext> {
  const db = getDb();
  const account = db.prepare("SELECT cookies_json, email, paused_at, session_context_json FROM accounts WHERE id = ?").get(accountId) as
    | { cookies_json: string | null; email: string; paused_at: string | null; session_context_json: string | null }
    | undefined;

  if (!account) throw new Error(`Account ${accountId} not found`);

  // Every use of an account's session comes through here: campaign steps, reply reading,
  // imports, enrichment, the test endpoint. So this is where a pause is made to hold.
  if (account.paused_at) {
    const live = contexts.get(accountId);
    if (live) {
      contexts.delete(accountId);
      void live.close().catch(() => {});
    }
    throw new AccountPausedError();
  }

  if (!contexts.has(accountId)) {
    // No usable login means there is nothing to drive. Opening an anonymous context anyway
    // is what turned a missing or undecryptable session into a queue of 30s timeouts, each
    // one failing a contact; say so instead, so the account is flagged and the work held.
    let storageState: object | undefined;
    if (account.cookies_json) {
      try {
        storageState = JSON.parse(decryptSecret(account.cookies_json)!);
      } catch {
        storageState = undefined;
      }
    }
    if (!storageState) throw new SessionExpiredError("no stored LinkedIn session");

    const b = await getBrowser();
    const ctx = await b.newContext(contextOptions(storedContext(account.session_context_json), storageState));

    // Auto-evict from map when context closes for any reason (crash, session expiry, etc.)
    ctx.on("close", () => { if (contexts.get(accountId) === ctx) contexts.delete(accountId); });

    contexts.set(accountId, ctx);
  }

  return contexts.get(accountId)!;
}

/** Returns the BrowserContext for an account (for API calls via ctx.request) */
export async function getSessionContext(accountId: string): Promise<BrowserContext> {
  try {
    return await getOrCreateContext(accountId);
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err; // a retry cannot conjure a login
    // First attempt failed — evict and retry once with a fresh context
    contexts.delete(accountId);
    return getOrCreateContext(accountId);
  }
}

/** Returns a new Page from the account's browser context */
export async function getSessionPage(accountId: string): Promise<Page> {
  const ctx = await getOrCreateContext(accountId);
  try {
    return await ctx.newPage();
  } catch {
    // B2: context was dead — CLOSE it before recreating so its underlying
    // browser process isn't left orphaned, then retry once with a fresh one.
    try { await ctx.close(); } catch { /* already gone */ }
    contexts.delete(accountId);
    const freshCtx = await getOrCreateContext(accountId);
    return freshCtx.newPage();
  }
}

/**
 * Persist the live context's cookies so the next process start resumes the same session.
 *
 * Only ever refreshes a session that is still signed in. It used to write whatever the
 * context held and set `is_authenticated = 1` unconditionally, so a step that had just been
 * bounced to the login page saved the signed-out jar over the good one AND re-flagged the
 * account as authenticated — a dead session then looked healthy indefinitely (the stats
 * sync returned 0 / 0 / 0 and stored it). Authentication is asserted by the login flows
 * alone; this function never grants it.
 */
export async function saveSessionState(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId);
  if (!ctx) return;
  const state = await ctx.storageState();
  const signedIn = state.cookies.some((c) => c.name === "li_at" && c.value && /linkedin\.com$/i.test(c.domain));
  if (!signedIn) return;
  getDb().prepare("UPDATE accounts SET cookies_json = ?, session_error = NULL WHERE id = ?").run(
    encryptSecret(JSON.stringify(state)),
    accountId
  );
}

export async function closeSession(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId);
  if (ctx) {
    await ctx.close();
    contexts.delete(accountId);
  }
}

/**
 * B4: flag an account as logged out / needing re-auth. Clears is_authenticated
 * so the runner stops working a dead session (no more 30s-timeout fail-loop),
 * and drops the live context. The user re-authenticates from Settings.
 */
export async function markNeedsReauth(accountId: string, options: { quiet?: boolean } = {}): Promise<void> {
  const db = getDb();
  const account = db.prepare("SELECT workspace_id, name, is_authenticated FROM accounts WHERE id = ?").get(accountId) as { workspace_id: string | null; name: string; is_authenticated: number } | undefined;
  db.prepare("UPDATE accounts SET is_authenticated = 0, session_state = 'needs_signin', session_changed_at = datetime('now') WHERE id = ?").run(accountId);
  // Said once, when the session is lost, not on every later attempt to use it. And not at
  // all when the person is standing right there (`quiet`: a session they just pasted was refused).
  if (account?.is_authenticated && account.workspace_id && !options.quiet) {
    emitDomainEvent({ workspaceId: account.workspace_id, type: "linkedin.signin_needed", entityType: "account", entityId: accountId, payload: { name: account.name } });
    notify({
      workspaceId: account.workspace_id, kind: "linkedin.signin_needed", tone: "bad",
      title: `${account.name} needs to sign in to LinkedIn again`,
      body: "LinkedIn ended the session. Campaign steps and reply reading for this account are on hold until it is reconnected.",
      link: "/linkedin-accounts",
    });
  }
  try { await closeSession(accountId); } catch { /* ignore */ }
  console.warn(`[session] account ${accountId} flagged needs-reauth (session logged out)`);
}

/**
 * Sign an account out on purpose: drop the stored session and the live browser context.
 * Unlike {@link markNeedsReauth} this tells nobody, because somebody just asked for it.
 */
export async function disconnectAccount(accountId: string): Promise<void> {
  getDb().prepare(
    "UPDATE accounts SET is_authenticated = 0, cookies_json = NULL, session_state = 'disconnected', session_error = NULL, session_changed_at = datetime('now') WHERE id = ?",
  ).run(accountId);
  try { await closeSession(accountId); } catch { /* ignore */ }
}

/** The browser settings a new sign-in for this account must be created with. */
export function newSessionContext(accountId: string): SessionContextRecord {
  const row = getDb().prepare("SELECT proxy_url, proxy_username, proxy_password, timezone FROM accounts WHERE id = ?").get(accountId) as
    | { proxy_url: string | null; proxy_username: string | null; proxy_password: string | null; timezone: string | null }
    | undefined;
  return contextForNewSession(row ?? {});
}

/**
 * Record a fresh, working sign-in: the session itself, how it was made, and the browser
 * settings it was created with, which every later use of it replays.
 */
export function recordSignedIn(accountId: string, storageState: object, method: "login" | "cookie", record: SessionContextRecord): void {
  releaseProxyHold(accountId);
  getDb().prepare(
    `UPDATE accounts SET cookies_json = ?, is_authenticated = 1, auth_method = ?, session_state = 'healthy', session_error = NULL,
       session_changed_at = datetime('now'), session_context_json = ?,
       -- A warm-up that was set up but has not begun starts on the day the account first signs in.
       ramp_start_date = CASE WHEN ramp_days IS NOT NULL AND ramp_start_date IS NULL THEN date('now') ELSE ramp_start_date END
     WHERE id = ?`,
  ).run(encryptSecret(JSON.stringify(storageState)), method, JSON.stringify(record), accountId);
}

/**
 * Opens a visible browser, navigates to LinkedIn login, and waits for the user
 * to complete login manually. Returns when the user reaches /feed.
 * Saves the full storage state to DB and marks account as authenticated.
 */
export async function authenticateAccount(accountId: string): Promise<void> {
  const account = getDb().prepare("SELECT email FROM accounts WHERE id = ?").get(accountId) as
    | { email: string }
    | undefined;
  if (!account) throw new Error(`Account ${accountId} not found`);

  // Close any existing context for this account — start fresh
  await closeSession(accountId);

  // Always launch a VISIBLE browser for manual login
  const visibleBrowser = await chromium.launch({
    headless: false,
    executablePath: CHROMIUM_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    // The same settings the runner will later use this session with, except for a window
    // size a person can work in.
    const record = newSessionContext(accountId);
    const ctx = await visibleBrowser.newContext({ ...contextOptions(record), viewport: { width: 1440, height: 900 } });

    const page = await ctx.newPage();
    await page.goto("https://www.linkedin.com/login");

    // Pre-fill email to save the user a step
    try {
      await page.waitForSelector("input#username", { timeout: 5000 });
      await page.fill("input#username", account.email);
    } catch {
      // Input not found — page may have redirected already
    }

    // Wait up to 3 minutes for the user to complete login and reach /feed
    await page.waitForURL("**/feed/**", { timeout: 180_000 });

    // Save full storage state (cookies + localStorage) to DB
    recordSignedIn(accountId, await ctx.storageState(), "login", record);

    await ctx.close();
  } finally {
    await visibleBrowser.close();
  }
}

// ─── Server-side headless login ───────────────────────────────────────────────
// Logs in directly on the server (no screen) so the session is born under the
// SAME pinned Chromium fingerprint the runner uses, and so ALL cookies — incl.
// httpOnly ones like li_ep_auth_context (the Sales Nav seat cookie that
// document.cookie cannot read) — are captured. A login from a datacenter IP
// almost always triggers an email/SMS PIN, so it's a two-step flow: start
// (email+password) → maybe a challenge → verify (code).

export type LoginResult =
  | { status: "authenticated" }
  | { status: "challenge"; kind: "otp" | "app" | "captcha" | "unknown"; message: string; /** When the held sign-in is given up (ISO). */ expires_at?: string }
  | { status: "error"; message: string };

type PendingLogin = { ctx: BrowserContext; page: Page; createdAt: number; record: SessionContextRecord };
const pendingLogins: Map<string, PendingLogin> = new Map();
const PENDING_TTL_MS = 10 * 60_000;

// PIN/verification-code input. Named ids first, then type-based fallbacks for
// LinkedIn's React checkpoint pages (which use dynamic ids). Safe: the login
// page itself has no tel/one-time-code input to misfire on.
const PIN_SELECTOR =
  "input[name='pin'], #input__email_verification_pin, input[autocomplete='one-time-code']:visible, input[type='tel']:visible";

async function clearPendingLogin(accountId: string): Promise<void> {
  const p = pendingLogins.get(accountId);
  if (p) {
    pendingLogins.delete(accountId);
    try { await p.ctx.close(); } catch { /* already gone */ }
  }
}

/** A challenge result, stamped with when the sign-in being held for it will be dropped. */
function withExpiry(result: LoginResult, pending: PendingLogin): LoginResult {
  return result.status === "challenge" ? { ...result, expires_at: new Date(pending.createdAt + PENDING_TTL_MS).toISOString() } : result;
}

function sweepPendingLogins(): void {
  const now = Date.now();
  for (const [id, p] of pendingLogins) {
    if (now - p.createdAt > PENDING_TTL_MS) void clearPendingLogin(id);
  }
}

/**
 * Warm the freshly-authenticated session by loading Sales Navigator once, THEN
 * persist. The bare login POST lands on /feed and only mints the ~11 core
 * LinkedIn cookies — it does NOT yet include the Sales Nav SEAT cookie
 * (li_ep_auth_context) nor the secondary auth tokens (li_a, liap) and
 * localStorage. Those are only issued once the browser actually enters Sales
 * Navigator. Without the seat cookie every Sales Nav API call returns nothing
 * ("no intercept after 15s" → import fails → account wrongly flagged
 * needs-reauth). So we navigate to /sales/ and wait for it to settle before
 * calling storageState(), capturing the FULL session the runner needs.
 * Best-effort: if the account has no Sales Nav seat the nav simply doesn't add
 * the seat cookie — the rest of the (regular-LinkedIn) session is still saved.
 */
async function persistLogin(accountId: string, ctx: BrowserContext, record: SessionContextRecord, page?: Page): Promise<void> {
  if (page) {
    try {
      await page.goto("https://www.linkedin.com/sales/home", { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Let Sales Nav's bootstrap requests fire so li_ep_auth_context is set.
      await page.waitForTimeout(4_000);
    } catch {
      // Non-fatal — a missing seat / slow load must not fail the whole login.
    }
  }
  recordSignedIn(accountId, await ctx.storageState(), "login", record);
  // Drop any stale runtime context so the runner reloads the fresh cookies.
  await closeSession(accountId);
}

/**
 * Inspect the page after a login/verify submit and classify the outcome.
 * LinkedIn varies its challenge per attempt — email/SMS code OR device (app)
 * approval — so we detect both: a visible code input = otp; a checkpoint page
 * with no code input and no captcha = device approval.
 */
async function classifyLoginState(page: Page): Promise<LoginResult> {
  const start = Date.now();
  const deadline = start + 20_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/\/feed\//.test(url) || /linkedin\.com\/sales\//.test(url)) {
      return { status: "authenticated" };
    }

    // Email/SMS PIN entry
    const pin = page.locator(PIN_SELECTOR).first();
    if ((await pin.count()) > 0 && (await pin.isVisible().catch(() => false))) {
      return {
        status: "challenge",
        kind: "otp",
        message: "LinkedIn sent you a verification code (email or SMS). Enter it below.",
      };
    }

    if (/checkpoint\/challenge/.test(url)) {
      // CAPTCHA (Arkose / FunCaptcha) — cannot be solved headlessly
      const cap = page.locator("iframe[src*='arkoselabs'], iframe[title*='captcha'], #captcha-internal");
      if ((await cap.count().catch(() => 0)) > 0) {
        return {
          status: "challenge",
          kind: "captcha",
          message: "LinkedIn requires a CAPTCHA, which can't be solved on the server. Use cookie paste instead.",
        };
      }
      // Device/app approval: a settled checkpoint with no code input and no captcha
      if (Date.now() - start > 4_000) {
        return {
          status: "challenge",
          kind: "app",
          message: "LinkedIn sent a sign-in request to your LinkedIn mobile app. Approve it there, then click Continue.",
        };
      }
    }

    // Wrong credentials
    const wrongPw = await page
      .getByText(/that.?s not the right password|please enter a valid|couldn.?t find a linkedin account/i)
      .count()
      .catch(() => 0);
    if (wrongPw > 0) return { status: "error", message: "Wrong email or password." };

    await page.waitForTimeout(800);
  }

  if (/checkpoint/.test(page.url())) {
    return {
      status: "challenge",
      kind: "unknown",
      message: "LinkedIn presented a security checkpoint. If you got a code enter it; if it's an app request, approve it and click Continue.",
    };
  }
  return { status: "error", message: `Login did not complete. Current page: ${page.url()}` };
}

export async function startHeadlessLogin(
  accountId: string,
  email: string,
  password: string
): Promise<LoginResult> {
  sweepPendingLogins();
  await clearPendingLogin(accountId);

  const b = await getBrowser(true);
  // Created with the account's proxy if it has one. The same record is stored with the
  // session when the sign-in succeeds, so the runner opens it identically.
  const record = newSessionContext(accountId);
  const ctx = await b.newContext(contextOptions(record));
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 30_000 });
    // LinkedIn's React login page uses dynamic ids — target by type+visibility
    // (old #username/#password kept as a fallback for the legacy layout).
    const emailInput = page.locator("input#username, input[type='email']:visible").first();
    await emailInput.waitFor({ state: "visible", timeout: 20_000 });
    await emailInput.fill(email);
    const passwordInput = page.locator("input#password, input[type='password']:visible").first();
    await passwordInput.fill(password);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      passwordInput.press("Enter"),
    ]);

    const result = await classifyLoginState(page);
    console.log(`[login] start account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} url=${page.url()}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx, record, page);
      await ctx.close();
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      const pending: PendingLogin = { ctx, page, createdAt: Date.now(), record };
      pendingLogins.set(accountId, pending);
      return withExpiry(result, pending);
    }
    await ctx.close();
    return result;
  } catch (e) {
    console.log(`[login] start account=${accountId} ERROR ${(e as Error).message} url=${page.url()}`);
    try { await ctx.close(); } catch { /* ignore */ }
    if (record.proxy && isProxyFailure(e)) {
      return { status: "error", message: `The proxy for this account (${record.proxy.server}) could not be reached, so LinkedIn was not contacted. Check the address and sign-in with your provider.` };
    }
    return { status: "error", message: (e as Error).message };
  }
}

export async function submitLoginChallenge(accountId: string, code: string): Promise<LoginResult> {
  const p = pendingLogins.get(accountId);
  if (!p) return { status: "error", message: "No login in progress (it may have timed out — start again)." };

  const { ctx, page } = p;
  try {
    const pin = page.locator(PIN_SELECTOR).first();
    await pin.waitFor({ state: "visible", timeout: 15_000 });
    await pin.fill(code);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      pin.press("Enter"),
    ]);

    const result = await classifyLoginState(page);
    console.log(`[login] verify account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} url=${page.url()}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx, p.record, page);
      await clearPendingLogin(accountId);
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      p.createdAt = Date.now(); // keep the session alive for another step
      return withExpiry(result, p);
    }
    await clearPendingLogin(accountId);
    return result.status === "error"
      ? result
      : { status: "error", message: "Code rejected or login failed." };
  } catch (e) {
    await clearPendingLogin(accountId);
    return { status: "error", message: (e as Error).message };
  }
}

/**
 * Wait for a device/app-approval challenge to clear. Called after the user
 * approves the sign-in in their LinkedIn mobile app — the checkpoint page then
 * auto-advances to the feed. Also dismisses a possible "remember this browser?"
 * interstitial. If still pending, returns the challenge so the user can retry.
 */
export async function awaitLoginApproval(accountId: string): Promise<LoginResult> {
  const p = pendingLogins.get(accountId);
  if (!p) return { status: "error", message: "No login in progress (it may have timed out — start again)." };

  const { ctx, page } = p;
  p.createdAt = Date.now();
  try {
    const reachedFeed = await page
      .waitForURL(/\/feed\/|linkedin\.com\/sales\//, { timeout: 50_000 })
      .then(() => true)
      .catch(() => false);

    if (!reachedFeed) {
      // Possible post-approval interstitial (e.g. "remember this browser?")
      const btn = page
        .locator("button[type=submit]:visible, button:has-text('Yes'):visible, button:has-text('Ja'):visible")
        .first();
      if ((await btn.count().catch(() => 0)) > 0) {
        await btn.click().catch(() => {});
        await page.waitForURL(/\/feed\/|linkedin\.com\/sales\//, { timeout: 20_000 }).catch(() => {});
      }
    }

    const result = await classifyLoginState(page);
    console.log(`[login] await account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} url=${page.url()}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx, p.record, page);
      await clearPendingLogin(accountId);
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      p.createdAt = Date.now();
      return withExpiry(result, p);
    }
    await clearPendingLogin(accountId);
    return result;
  } catch (e) {
    await clearPendingLogin(accountId);
    return { status: "error", message: (e as Error).message };
  }
}

/**
 * Ask LinkedIn to send the verification code again, on the sign-in being held for this
 * account. LinkedIn words this link differently from one checkpoint to the next, so it
 * is found by its text. If there is none to press, the sign-in is left as it is.
 */
export async function resendLoginCode(accountId: string): Promise<LoginResult> {
  const p = pendingLogins.get(accountId);
  if (!p) return { status: "error", message: "No login in progress (it may have timed out — start again)." };
  try {
    const resend = p.page.getByRole("button", { name: /resend|send (a )?new code|didn.?t (get|receive)/i })
      .or(p.page.getByRole("link", { name: /resend|send (a )?new code|didn.?t (get|receive)/i }))
      .first();
    if ((await resend.count().catch(() => 0)) === 0) {
      return withExpiry({ status: "challenge", kind: "otp", message: "LinkedIn is not offering to send the code again on this page. Use the code you have, or start again." }, p);
    }
    await resend.click();
    await p.page.waitForTimeout(1_500);
    p.createdAt = Date.now();
    return withExpiry({ status: "challenge", kind: "otp", message: "LinkedIn was asked to send a new code." }, p);
  } catch (e) {
    return withExpiry({ status: "challenge", kind: "otp", message: `The code could not be sent again: ${(e as Error).message.split("\n")[0]}` }, p);
  }
}
