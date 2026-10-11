import type { NextApiRequest, NextApiResponse } from "next";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLinkiMcpServer } from "@/lib/mcp/server";
import { MCP_SCOPES, mcpResourceUrl, requestOrigin, verifyAccessToken, verifyMcpApiKey } from "@/lib/mcp/auth";
import { takeRequest } from "@/lib/api/key-rate-limit";
import { clientIp } from "@/lib/rate-limit";

export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };

// Claude validates remote connectors from its web origins after OAuth completes.
// Keep this allowlist narrow to preserve the Streamable HTTP origin check while
// permitting the officially documented Claude callback hosts. Other browser-based
// MCP clients can be added explicitly through MCP_ALLOWED_ORIGINS.
const DEFAULT_CLIENT_ORIGINS = ["https://claude.ai", "https://claude.com"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const origin = requestOrigin(req);
  const requestOriginHeader = req.headers.origin;
  const clientOrigin = requestOriginHeader ? allowedClientOrigin(requestOriginHeader, origin) : null;
  if (requestOriginHeader && !clientOrigin) return res.status(403).json(mcpError(-32000, "Invalid Origin header"));

  res.setHeader("Access-Control-Allow-Origin", clientOrigin ?? origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version, www-authenticate");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = authenticate(req);
  // A key with a per-minute limit is held to it here as it is on the REST API.
  if (auth?.extra?.rateLimit) {
    const { keyId, perMinute } = auth.extra.rateLimit as { keyId: string; perMinute: number | null };
    const rate = takeRequest(keyId, perMinute);
    if (rate && !rate.allowed) {
      res.setHeader("Retry-After", String(rate.retry_after));
      return res.status(429).json(mcpError(-32002, "API key rate limit reached"));
    }
  }
  if (!auth) {
    const metadata = `${origin}/.well-known/oauth-protected-resource/api/mcp`;
    // Advertise the full scope set so MCP clients request read + write + execute
    // during authorization, unlocking every tool (not just the read-only ones).
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPES.join(" ")}"`);
    return res.status(401).json(mcpError(-32001, "Authentication required"));
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json(mcpError(-32000, "Stateless MCP accepts POST requests only"));
  }
  // The transport answers 406 unless the client accepts both JSON and an event stream. This server
  // always answers with JSON, so a client that lists only one of them (a hand-written curl, a minimal
  // HTTP client) can be served all the same; say that it accepts both rather than turning it away.
  const accept = String(req.headers.accept ?? "");
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) setAccept(req, "application/json, text/event-stream");

  const server = createLinkiMcpServer({ origin, auth, ip: clientIp(req) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  (req as NextApiRequest & { auth?: AuthInfo }).auth = auth;
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[mcp] request failed", error);
    if (!res.headersSent) res.status(500).json(mcpError(-32603, "Internal MCP server error"));
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function authenticate(req: NextApiRequest): AuthInfo | null {
  const header = req.headers.authorization;
  if (!header || !/^Bearer\s+/i.test(header)) return null;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  const resource = mcpResourceUrl(req);
  // A Linki API key (`lnk_…`) made for MCP, or an OAuth access token (`mcp_access_…`).
  if (token.startsWith("lnk_")) {
    const key = verifyMcpApiKey(token, resource);
    if (!key) return null;
    const { rateLimit, ...info } = key;
    return { ...info, extra: { ...info.extra, rateLimit } };
  }
  return verifyAccessToken(token, resource);
}

function allowedClientOrigin(value: string, serverOrigin: string): string | null {
  const candidate = safeOrigin(value);
  if (!candidate) return null;
  const configured = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(safeOrigin)
    .filter((origin): origin is string => Boolean(origin));
  return new Set([serverOrigin, ...DEFAULT_CLIENT_ORIGINS, ...configured]).has(candidate) ? candidate : null;
}

/**
 * The SDK transport turns the Node request into a web Request from `rawHeaders`, not from the
 * `headers` object, so both have to say the same thing or the change is not seen.
 */
function setAccept(req: NextApiRequest, value: string) {
  req.headers.accept = value;
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) if (raw[i].toLowerCase() === "accept") raw.splice(i, 2);
  raw.push("Accept", value);
}

function safeOrigin(value: string) { try { return new URL(value).origin; } catch { return ""; } }
function mcpError(code: number, message: string) { return { jsonrpc: "2.0", error: { code, message }, id: null }; }
