import type { Page } from "playwright";
import { getSessionPage, markNeedsReauth, saveSessionState } from "@/lib/linkedin/session";
import { SessionExpiredError, gotoLinkedin } from "@/lib/linkedin/navigation";

/**
 * Ask LinkedIn whether the account's stored session is still signed in.
 *
 * Loads the feed, which a signed-out session cannot reach. A dead session is flagged for
 * re-authentication here rather than left for a campaign step to trip over. Anything else
 * that goes wrong (no browser, a network error) is thrown: it says nothing about the
 * session, and must not be reported as "signed out".
 *
 * `quiet` is for a check made while someone is connecting the account: a refused session
 * is still recorded, but nobody is sent a notification about what they are looking at.
 */
export async function checkLinkedinSession(accountId: string, options: { quiet?: boolean } = {}): Promise<{ signedIn: boolean; detail: string | null }> {
  let page: Page | null = null;
  try {
    page = await getSessionPage(accountId);
    await gotoLinkedin(page, "https://www.linkedin.com/feed/");
    await page.close();
    page = null;
    await saveSessionState(accountId);
    return { signedIn: true, detail: null };
  } catch (err) {
    if (!(err instanceof SessionExpiredError)) throw err;
    await markNeedsReauth(accountId, options).catch(() => {});
    return { signedIn: false, detail: err.message };
  } finally {
    try { await page?.close(); } catch { /* already gone */ }
  }
}
