import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";

const INTERNAL_HEADER = "x-internal-secret";

export const WORKSPACE_HEADER = "x-workspace-id";
export const USER_HEADER = "x-user-id";
export const ROLE_HEADER = "x-workspace-role";
export const SESSION_IAT_HEADER = "x-session-iat";
export const CONTEXT_SIGNATURE_HEADER = "x-linki-ctx";

/** Who a request acts as, as asserted by proxy.ts. `iat` is the session's issue time, empty for internal calls. */
export interface RequestContextClaims { workspaceId: string; userId: string; role: string; iat: string }

export async function getSessionToken(req: NextRequest) {
  return getToken({ req, secret: process.env.NEXTAUTH_SECRET });
}

/**
 * The internal service secret authenticates server-to-server loopback calls (the MCP
 * server's tool handlers calling Linki's own /api/* routes — see lib/mcp/server.ts). It
 * never leaves the host: it's not sent to a browser and never crosses the public ngrok/
 * reverse-proxy path, only Node processes on 127.0.0.1 exchange it.
 */
export async function hasValidInternalSecret(req: NextRequest): Promise<boolean> {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) return false;

  const provided = req.headers.get(INTERNAL_HEADER);
  if (!provided) return false;

  return timingSafeEqual(provided, expected);
}

/** The exact bytes proxy.ts signs and lib/workspace.ts verifies. Header values cannot contain a newline. */
export function contextSigningInput(claims: RequestContextClaims): string {
  return ["linki-ctx-v1", claims.workspaceId, claims.userId, claims.role, claims.iat].join("\n");
}

/**
 * HMAC over the workspace context, so a route can tell headers proxy.ts set from headers a
 * client sent. Web Crypto, like timingSafeEqual below, so it runs wherever the proxy does.
 * Returns null when there is no NEXTAUTH_SECRET to sign with.
 */
export async function signContext(claims: RequestContextClaims): Promise<string | null> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(contextSigningInput(claims)));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string comparison via Web Crypto (available on both the Edge and Node.js
// runtimes) so an internal-secret guess can't be timed byte-by-byte.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}
