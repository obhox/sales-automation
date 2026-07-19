import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionToken, isAuthenticated } from "@/lib/auth";

const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_HEADER = "x-workspace-id";
const USER_HEADER = "x-user-id";
const ROLE_HEADER = "x-workspace-role";

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

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))) return NextResponse.next();

  const authed = await isAuthenticated(req);
  if (!authed) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const headers = new Headers(req.headers);
  const token = await getSessionToken(req);
  if (token?.workspaceId) {
    headers.set(WORKSPACE_HEADER, String(token.workspaceId));
    headers.set(USER_HEADER, String(token.userId ?? token.sub ?? ""));
    headers.set(ROLE_HEADER, String(token.role ?? "viewer"));
  } else {
    // Internal service calls can select a workspace explicitly; otherwise they operate
    // on the legacy workspace for backwards-compatible background jobs.
    if (!headers.get(WORKSPACE_HEADER)) headers.set(WORKSPACE_HEADER, DEFAULT_WORKSPACE_ID);
    if (!headers.get(ROLE_HEADER)) headers.set(ROLE_HEADER, "owner");
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: "/api/:path*",
};
