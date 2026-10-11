import { createHash, randomBytes, randomUUID } from "crypto";
import type { NextApiRequest } from "next";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getDb } from "@/lib/db";
import { verifyApiKey } from "@/lib/api-keys";

export const MCP_SCOPES = ["mcp:read", "mcp:write", "mcp:execute"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface OAuthClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string;
}

interface OAuthTokenRow {
  id: string;
  client_id: string;
  user_id: string;
  scope: string | null;
  resource: string | null;
  expires_at: string;
  refresh_expires_at: string | null;
  workspace_id: string | null;
}

export function requestOrigin(req: NextApiRequest): string {
  const configured = process.env.NEXTAUTH_URL;
  if (configured) return new URL(configured).origin;
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000").split(",")[0].trim();
  return `${proto}://${host}`;
}

export function mcpResourceUrl(req: NextApiRequest): string {
  return `${requestOrigin(req)}/api/mcp`;
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/**
 * The scopes a client asked for, kept to the ones this server has. A scope it does not know
 * (`openid`, `offline_access`, a client's own default) is ignored rather than refused, and a
 * request that names nothing this server has gets the fallback, exactly as one that names
 * nothing at all does. Refusing it as `invalid_scope` stopped otherwise working clients cold.
 */
export function normalizeScopes(value: unknown, fallback: McpScope[] = [...MCP_SCOPES]): McpScope[] {
  const requested = typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
  const known = [...new Set(requested.filter((scope): scope is McpScope => MCP_SCOPES.includes(scope as McpScope)))];
  return known.length > 0 ? known : fallback;
}

/**
 * Whether a client's `resource` indicator (RFC 8707) names this MCP server. Clients write it
 * with and without a trailing slash, and some send only the origin; all of those mean this
 * server, so all of them match. Anything else is another resource.
 */
export function resourceMatches(requested: string, expected: string): boolean {
  const strip = (value: string) => value.replace(/\/+$/, "");
  try {
    const wanted = strip(requested);
    const server = strip(expected);
    return wanted === server || wanted === new URL(server).origin;
  } catch {
    return false;
  }
}

export function getOAuthClient(clientId: string): OAuthClientRow | undefined {
  return getDb().prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?").get(clientId) as OAuthClientRow | undefined;
}

export function clientRedirectAllowed(client: OAuthClientRow, redirectUri: string): boolean {
  try {
    const registered = JSON.parse(client.redirect_uris) as string[];
    return registered.includes(redirectUri);
  } catch {
    return false;
  }
}

// Schemes that run code or read files when opened. A private-use scheme may be anything else.
const FORBIDDEN_REDIRECT_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:", "chrome:", "view-source:"]);

/**
 * Where an authorization code may be sent. https, plain http on the loopback interface (the
 * command-line clients: Claude Code, opencode, the MCP Inspector), and a private-use scheme
 * for a desktop app (`cursor://…`, `vscode://…`, RFC 8252 section 7.1). Never a fragment.
 */
export function isSafeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !FORBIDDEN_REDIRECT_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
  } catch {
    return false;
  }
}

export function issueAuthorizationCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: McpScope[];
  resource: string;
  workspaceId: string;
}): string {
  const code = createOpaqueToken("mcp_code");
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  getDb().prepare(`
    INSERT INTO oauth_auth_codes
      (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, workspace_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(hashToken(code), input.clientId, input.userId, input.redirectUri, input.codeChallenge, input.scopes.join(" "), input.resource, input.workspaceId, expiresAt);
  return code;
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export function issueTokenPair(input: {
  clientId: string;
  userId: string;
  scopes: McpScope[];
  resource: string;
  workspaceId: string;
}): { access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number; scope: string } {
  const accessToken = createOpaqueToken("mcp_access");
  const refreshToken = createOpaqueToken("mcp_refresh");
  const expiresIn = 60 * 60;
  getDb().prepare(`
    INSERT INTO oauth_tokens
      (id, access_hash, refresh_hash, client_id, user_id, scope, resource, workspace_id, expires_at, refresh_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), hashToken(accessToken), hashToken(refreshToken), input.clientId, input.userId,
    input.scopes.join(" "), input.resource, input.workspaceId,
    new Date(Date.now() + expiresIn * 1000).toISOString(),
    new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
  );
  return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: expiresIn, scope: input.scopes.join(" ") };
}

export function verifyAccessToken(token: string, expectedResource: string): AuthInfo | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, client_id, user_id, scope, resource, workspace_id, expires_at, refresh_expires_at
    FROM oauth_tokens WHERE access_hash = ?
  `).get(hashToken(token)) as OAuthTokenRow | undefined;
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
  if (row.resource && row.resource !== expectedResource) return null;
  // A suspended membership is no membership: the token stops working for that workspace.
  const membership = row.workspace_id ? db.prepare(`SELECT workspace_id,role FROM workspace_members WHERE user_id=? AND workspace_id=? AND suspended_at IS NULL`).get(row.user_id,row.workspace_id) :
    db.prepare(`SELECT workspace_id, role FROM workspace_members WHERE user_id = ? AND suspended_at IS NULL ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'member' THEN 3 ELSE 4 END, created_at LIMIT 1`).get(row.user_id);
  const typedMembership = membership as { workspace_id: string; role: string } | undefined;
  if (!typedMembership) return null;
  return {
    token,
    clientId: row.client_id,
    scopes: normalizeScopes(row.scope, []),
    expiresAt: Math.floor(Date.parse(row.expires_at) / 1000),
    resource: new URL(row.resource || expectedResource),
    extra: { userId: row.user_id, tokenId: row.id, workspaceId: typedMembership.workspace_id, workspaceRole: typedMembership.role, clientName: getOAuthClient(row.client_id)?.client_name ?? null },
  };
}

/**
 * A Linki API key used as the bearer token, for a client that cannot or need not run the
 * browser sign-in: a terminal on a server, a CI job, a client given a static header.
 *
 * It is deliberately narrower than "any key may use MCP":
 *  - The key must carry at least one of the mcp:* scopes. A key made for the REST API
 *    (`contacts:read`, `email:send`) is refused here; it was never agreed to act as a person.
 *  - It acts as the member who created it, with that member's role as it is now, in the
 *    workspace the key belongs to. So it can do what that person could do over OAuth and no
 *    more, and it stops when they are suspended or removed, or when the key is revoked or expires.
 *  - Its mcp:* scopes cap what it may call, exactly as they do for an OAuth token.
 */
export function verifyMcpApiKey(raw: string, expectedResource: string): (AuthInfo & { rateLimit: { keyId: string; perMinute: number | null } }) | null {
  const key = verifyApiKey(raw);
  if (!key || !key.createdBy) return null;
  const scopes = key.scopes.filter((scope): scope is McpScope => MCP_SCOPES.includes(scope as McpScope));
  if (scopes.length === 0) return null;
  const member = getDb().prepare(
    "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND suspended_at IS NULL",
  ).get(key.workspaceId, key.createdBy) as { role: string } | undefined;
  if (!member) return null;
  const expiresAt = key.expiresAt ? Date.parse(key.expiresAt.includes("T") ? key.expiresAt : `${key.expiresAt.replace(" ", "T")}Z`) : NaN;
  return {
    token: raw,
    clientId: `api-key:${key.keyId}`,
    scopes,
    ...(Number.isFinite(expiresAt) ? { expiresAt: Math.floor(expiresAt / 1000) } : {}),
    resource: new URL(expectedResource),
    extra: { userId: key.createdBy, tokenId: key.keyId, workspaceId: key.workspaceId, workspaceRole: member.role, clientName: `API key: ${key.name}` },
    rateLimit: { keyId: key.keyId, perMinute: key.rateLimitPerMinute },
  };
}
