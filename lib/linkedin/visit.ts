import type { Page } from "playwright";
import { normalizeLinkedInUrl } from "./url";

/**
 * Visits a LinkedIn profile page. This registers as a profile view on LinkedIn.
 * Just navigates and waits — no interaction.
 */
export async function visitProfile(page: Page, linkedinUrl: string): Promise<void> {
  // Country/bare hosts can redirect-loop for an authenticated session.
  await page.goto(normalizeLinkedInUrl(linkedinUrl), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000 + Math.random() * 2000);
}
