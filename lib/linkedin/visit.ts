import type { Page } from "playwright";
import { waitForProfileCard } from "@/lib/linkedin/dom";
import { gotoLinkedin, throwIfSignedOut } from "@/lib/linkedin/navigation";
import { canonicalLinkedinUrl, profileVanity } from "@/lib/linkedin/url";

/**
 * Visit a LinkedIn profile, which registers as a profile view for that member.
 *
 * Returns only once the profile itself is on screen. It used to navigate, sleep and report
 * success whatever came back, so a sign-in wall or a removed profile was logged as
 * "Visited" and counted against the daily visit cap.
 */
export async function visitProfile(page: Page, linkedinUrl: string): Promise<void> {
  if (!profileVanity(linkedinUrl)) throw new Error(`Not a LinkedIn profile URL: ${linkedinUrl}`);
  await gotoLinkedin(page, canonicalLinkedinUrl(linkedinUrl));

  const card = await waitForProfileCard(page);
  if (!card.found) {
    throwIfSignedOut(page);
    throw new Error(`LinkedIn profile did not load (${card.reason ?? "unknown"})`);
  }
  // Dwell like a reader would rather than leaving the instant the page paints.
  await page.waitForTimeout(3000 + Math.random() * 2000);
}
