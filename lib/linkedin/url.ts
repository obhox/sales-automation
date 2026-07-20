/**
 * Canonicalise a LinkedIn URL before navigation.
 *
 * Stored URLs arrive in many shapes depending on how the lead was imported:
 * bare `linkedin.com/in/x`, country subdomains (`ng.`, `ch.`, `uk.` ...),
 * scheme-less, or carrying `?originalSubdomain=` tracking noise. Country and
 * bare hosts bounce through host/locale redirects that an authenticated session
 * can get stuck in, surfacing as `net::ERR_TOO_MANY_REDIRECTS` at page.goto and
 * failing the step before any interaction happens.
 *
 * Only the scheme and host are rewritten. The path is preserved verbatim so
 * Sales Navigator deep links keep working, and the query string is preserved
 * except on `/in/` profile paths where it is never load-bearing.
 *
 * Anything that is not a linkedin.com host, or does not parse, is returned
 * unchanged - this must never mangle an input it does not understand.
 */
export function normalizeLinkedInUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return trimmed;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return trimmed;
  }

  // Matches linkedin.com and any subdomain of it, but not e.g. notlinkedin.com.
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return trimmed;

  url.protocol = "https:";
  url.hostname = "www.linkedin.com";
  url.port = "";

  if (url.pathname.startsWith("/in/")) {
    url.search = "";
    url.hash = "";
    // LinkedIn's own canonical form has no trailing slash.
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}
