import type { Page } from "playwright";
import { pollUntil, readAccountStats, type AccountStats } from "@/lib/linkedin/dom";
import { gotoLinkedin } from "@/lib/linkedin/navigation";

export interface LinkedInStats {
  /** null = LinkedIn's page did not show the figure. Never a made-up zero. */
  connections: number | null;
  pending: number | null;
  profile_views: number | null;
}

/**
 * Read the account's headline numbers: connections, pending sent invitations, and profile
 * views over the last 90 days.
 *
 * Each figure is waited for rather than read after a fixed sleep, and comes back null when
 * it cannot be found. The previous version returned 0 for anything it could not parse —
 * including on a signed-out session, where it stored 0 / 0 / 0 over the real numbers — and
 * always returned 0 profile views, because the first element it matched for
 * "Profile viewers" was the page's <title>.
 *
 * Throws SessionExpiredError (from the first navigation) when the session is signed out.
 */
export async function scrapeLinkedInStats(page: Page): Promise<LinkedInStats> {
  const figure = async (url: string, pick: (s: AccountStats) => number | null): Promise<number | null> => {
    await gotoLinkedin(page, url);
    return pick(await pollUntil(page, readAccountStats, (s) => pick(s) !== null, 12_000, 500));
  };

  const connections = await figure("https://www.linkedin.com/mynetwork/invite-connect/connections/", (s) => s.connections);
  const pending = await figure("https://www.linkedin.com/mynetwork/invitation-manager/sent/", (s) => s.pendingInvitations);
  const profile_views = await figure("https://www.linkedin.com/analytics/profile-views/", (s) => s.profileViews);
  return { connections, pending, profile_views };
}
