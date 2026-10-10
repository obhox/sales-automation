/**
 * Navigation that knows what a dead session looks like.
 *
 * Kept apart from session.ts (which loads Playwright and the browser) so the step
 * modules that use it can be unit tested with a scripted page.
 */
import type { Page } from "playwright";
import { isAuthWallUrl } from "@/lib/linkedin/url";

/**
 * LinkedIn sent the browser to a sign-in or checkpoint page: the stored session is no
 * longer valid. This says nothing about the contact being worked on, so callers must hold
 * the work and flag the account for re-authentication rather than fail the contact.
 */
export class SessionExpiredError extends Error {
  constructor(detail: string) {
    super(`LinkedIn session is signed out — ${detail}`);
    this.name = "SessionExpiredError";
  }
}

/**
 * The account has been paused by a person. Nothing may be done on it, by a campaign or
 * by anything else, until it is resumed. Like a signed-out session this says nothing
 * about the contact being worked on.
 */
export class AccountPausedError extends Error {
  constructor() {
    super("This LinkedIn account is paused. Resume it to use it.");
    this.name = "AccountPausedError";
  }
}

/**
 * The account's proxy could not be reached. The session is never retried without the
 * proxy: LinkedIn would see the account arrive from a different place. Callers hold the
 * account's work until the proxy answers again.
 */
export class ProxyUnavailableError extends Error {
  constructor(detail: string) {
    super(`The account's proxy could not be reached — ${detail}`);
    this.name = "ProxyUnavailableError";
  }
}

// What Chromium reports when a proxy refuses, drops or cannot be found.
const PROXY_FAILURE = /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_AUTH|ERR_NO_SUPPORTED_PROXIES|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED|ERR_PROXY_CERTIFICATE_INVALID/;

/** Whether an error from the browser is the proxy failing, not the page. */
export function isProxyFailure(error: unknown): boolean {
  return PROXY_FAILURE.test(error instanceof Error ? error.message : String(error));
}

/** Throw {@link SessionExpiredError} if the page is currently on a sign-in wall. */
export function throwIfSignedOut(page: Page): void {
  const url = page.url();
  if (isAuthWallUrl(url)) throw new SessionExpiredError(`LinkedIn redirected to ${url.split("?")[0]}`);
}

/**
 * `page.goto` for LinkedIn pages. Every browser step goes through this, so a signed-out
 * session is recognised on the first navigation instead of surfacing as thirty seconds of
 * "element not found" on each contact in the queue.
 */
export async function gotoLinkedin(page: Page, url: string, timeoutMs = 30_000): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch (error) {
    if (isProxyFailure(error)) throw new ProxyUnavailableError((error as Error).message.split("\n")[0]);
    throw error;
  }
  throwIfSignedOut(page);
}
