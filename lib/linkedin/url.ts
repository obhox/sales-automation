/**
 * LinkedIn URL handling shared by every step that navigates to, or matches on, a profile.
 *
 * Stored profile URLs arrive from CSV uploads, Apollo, the public API and Sales Navigator,
 * and are kept verbatim. In production that meant `http://www.linkedin.com/in/x`,
 * `https://linkedin.com/in/x`, `https://ca.linkedin.com/in/x` and `linkedin.com/in/x` all
 * sat in the same column. Two things broke on that:
 *
 *  - navigation: a bare/country host bounces through redirects, and a scheme-less value is
 *    not a URL at all (`page.goto` rejects it);
 *  - matching: acceptance sync compared with `LIKE '%/in/<vanity>/%'`, which requires a
 *    trailing slash most stored URLs do not have, so accepted invitations were never seen.
 *
 * Kept dependency-free so it is unit testable without loading Playwright or SQLite.
 */

const LINKEDIN_HOST = /(^|\.)linkedin\.com$/i;

function parse(raw: string | null | undefined): URL | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  // `linkedin.com/in/x` and `www.linkedin.com/in/x` are common in uploads; give them a scheme.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
  try {
    const url = new URL(withScheme);
    return LINKEDIN_HOST.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed percent-escape — keep it as written rather than throw
  }
}

/**
 * The public identifier in a `/in/<id>` profile URL, decoded, exactly as written.
 *
 * Case is preserved because the same path slot also carries opaque profile ids
 * (`ACoAA…`), which are case-sensitive. Use {@link vanityKey} to compare two of them.
 */
export function profileVanity(raw: string | null | undefined): string | null {
  const url = parse(raw);
  if (!url) return null;
  const match = url.pathname.match(/^\/in\/([^/]+)/i);
  if (!match) return null;
  const vanity = decodeSegment(match[1]).trim();
  return vanity || null;
}

/** Comparison key for a public identifier: LinkedIn treats vanity names case-insensitively,
 *  and the same name can arrive percent-encoded or in a different Unicode normal form. */
export function vanityKey(vanity: string): string {
  return decodeSegment(vanity).normalize("NFC").trim().toLowerCase();
}

/** {@link vanityKey} of the profile a URL points at, or null when it is not a `/in/` URL. */
export function profileKey(raw: string | null | undefined): string | null {
  const vanity = profileVanity(raw);
  return vanity ? vanityKey(vanity) : null;
}

/**
 * The URL to hand to `page.goto`.
 *
 * `/in/` profiles collapse to `https://www.linkedin.com/in/<id>/` — tracking parameters and
 * sub-paths (`/overlay/contact-info/`, `/detail/…`) are dropped. Any other LinkedIn URL
 * (Sales Navigator leads and lists) only has its scheme and host normalised, because its
 * path and query carry meaning. Anything that is not a LinkedIn URL is returned unchanged
 * so the caller's own error handling still sees what was stored.
 */
export function canonicalLinkedinUrl(raw: string): string {
  const url = parse(raw);
  if (!url) return raw;
  const vanity = profileVanity(raw);
  if (vanity) return `https://www.linkedin.com/in/${encodeURIComponent(vanity)}/`;
  return `https://www.linkedin.com${url.pathname}${url.search}`;
}

/** Where LinkedIn's own Connect link points: the invitation dialog for one member. */
export function inviteUrl(vanity: string): string {
  return `https://www.linkedin.com/preload/custom-invite/?vanityName=${encodeURIComponent(vanity)}`;
}

/** Resolve an href read off a LinkedIn page (often root-relative) to an absolute URL. */
export function absoluteLinkedinUrl(href: string): string {
  return /^https?:\/\//i.test(href) ? href : `https://www.linkedin.com${href.startsWith("/") ? "" : "/"}${href}`;
}

/**
 * True when a navigation ended on a page LinkedIn only shows to a signed-out or challenged
 * session. Every browser step checks this: without it a dead session looked like thirty
 * seconds of "element not found" on each contact, and each contact was failed for it.
 */
export function isAuthWallUrl(raw: string): boolean {
  const url = parse(raw);
  if (!url) return false;
  return /^\/(login|authwall|checkpoint|uas|signup|m\/login)(\/|$)/i.test(url.pathname);
}
