import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  CONTEXT_SIGNATURE_HEADER, ROLE_HEADER, SESSION_IAT_HEADER, USER_HEADER, WORKSPACE_HEADER,
  getSessionToken, hasValidInternalSecret, signContext,
} from "@/lib/auth";

// Routes that manage their own complete auth flow and must not be pre-empted by a
// generic 401 here — every one of them either issues/discovers credentials (not a
// resource to protect) or has its own response contract an upstream 401 would break.
//
//  - /api/auth/*                    NextAuth's own login/session/csrf machinery.
//  - /api/oauth/authorize           Manages its own getServerSession + redirect-to-/login;
//                                   a blanket 401 here would break that browser flow.
//  - /api/oauth/token, /register    Server-to-server OAuth token exchange / dynamic client
//                                   registration — no user session exists at this step.
//  - /api/oauth/metadata-*          RFC 8414/9728 discovery documents, fetched before any
//                                   auth exists by design.
//  - /api/mcp                       Verifies its own Bearer token (lib/premium.ts boundary —
//                                   this file can't import that ee-only check) and, on
//                                   failure, must reply with a WWW-Authenticate header
//                                   pointing at OAuth discovery (RFC 9728) so MCP clients
//                                   can bootstrap the auth flow. A generic 401 here would
//                                   swallow that header and break every MCP client's first
//                                   connection attempt.
//  - /api/health                    Unauthenticated liveness/readiness probe for the
//                                   container healthcheck and uptime monitors; exposes
//                                   no data beyond up/down + uptime.
const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/invitations/", "/api/oauth/", "/api/mcp", "/api/v1/", "/api/t/", "/api/health"];

// Pages anyone may open without signing in: the sign-in flow itself, an invitation, and
// a report someone was sent a link to.
const PUBLIC_PAGES = new Set(["/login", "/reset-password", "/verify-email"]);
const PUBLIC_PAGE_PREFIXES = ["/invite/", "/r/"];

export function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.has(pathname) || PUBLIC_PAGE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

/**
 * Pages are gated here too, not only the API. A signed-out visitor is sent to sign in
 * before any page is rendered, and comes back to where they were going. Pages therefore
 * do not each need a server-side check just to redirect. This decides who may open a
 * page, nothing more: what a page can read is still decided per request by the API.
 */
async function gatePage(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  // Files from /public (logos, favicons) have an extension; pages do not.
  if (/\.[a-z0-9]+$/i.test(pathname) || isPublicPage(pathname)) return NextResponse.next();
  if (await getSessionToken(req)) return NextResponse.next();
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  const destination = `${pathname}${search}`;
  if (destination !== "/") login.searchParams.set("callbackUrl", destination);
  return NextResponse.redirect(login);
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!pathname.startsWith("/api/")) return gatePage(req);
  if (PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))) return NextResponse.next();

  // The workspace a request acts in is decided here and nowhere else. A browser session
  // takes it from its signed cookie, so whatever context headers the client sent are
  // overwritten. Only a caller holding the internal secret (the MCP server's loopback
  // calls, which resolved the workspace from a verified OAuth token) may name one itself.
  const internal = await hasValidInternalSecret(req);
  const token = internal ? null : await getSessionToken(req);
  if (!internal && !token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const claims = token
    ? { workspaceId: String(token.workspaceId ?? ""), userId: String(token.userId ?? token.sub ?? ""), role: String(token.role ?? ""), iat: String(token.iat ?? "") }
    : { workspaceId: req.headers.get(WORKSPACE_HEADER) ?? "", userId: req.headers.get(USER_HEADER) ?? "", role: req.headers.get(ROLE_HEADER) ?? "", iat: "" };
  // No workspace means no access: there is no default workspace to fall back to.
  if (!claims.workspaceId) {
    return NextResponse.json({ error: "No workspace for this request" }, { status: 401 });
  }
  // Signed so lib/workspace.ts can refuse context headers that did not come from here.
  const signature = await signContext(claims);
  if (!signature) {
    return NextResponse.json({ error: "Server is missing NEXTAUTH_SECRET" }, { status: 500 });
  }

  const headers = new Headers(req.headers);
  const forwarded: Array<[string, string]> = [
    [WORKSPACE_HEADER, claims.workspaceId], [USER_HEADER, claims.userId], [ROLE_HEADER, claims.role],
    [SESSION_IAT_HEADER, claims.iat], [CONTEXT_SIGNATURE_HEADER, signature],
  ];
  for (const [name, value] of forwarded) {
    if (value) headers.set(name, value);
    else headers.delete(name);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Every API route, and every page. Next's own assets (/_next/…) are left alone.
  matcher: ["/api/:path*", "/((?!_next/|api/).*)"],
};
