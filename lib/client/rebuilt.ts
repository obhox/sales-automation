/**
 * Pages already on the new design system. Every other page still uses the old
 * styles and is rendered inside the `.legacy` wrapper (see styles/legacy.css).
 * A phase that rebuilds a page adds its route here; when the list covers every
 * page, the wrapper, this file and the old styles are deleted together.
 */
const REBUILT_PREFIXES = ["/dev/", "/campaigns/", "/r/", "/developers/", "/invite/", "/oauth/"];
const REBUILT_PATHS = new Set<string>(["/login", "/reset-password", "/verify-email", "/404", "/500", "/", "/linkedin-accounts", "/campaigns", "/ai", "/team", "/account", "/mailboxes", "/contacts", "/contacts/[id]", "/inbox", "/deliverability", "/lists", "/lists/[id]", "/developers", "/integrations", "/admin", "/templates", "/signals", "/lists/import/[id]", "/companies/[[...id]]", "/pipeline"]);

export function isRebuiltPath(pathname: string): boolean {
  return REBUILT_PATHS.has(pathname) || REBUILT_PREFIXES.some(prefix => pathname.startsWith(prefix));
}
