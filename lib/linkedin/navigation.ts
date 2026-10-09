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
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  throwIfSignedOut(page);
}
