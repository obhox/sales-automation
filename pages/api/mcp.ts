import type { NextApiRequest, NextApiResponse } from "next";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLinkiMcpServer } from "@/lib/mcp/server";
import { mcpResourceUrl, requestOrigin, verifyAccessToken } from "@/lib/mcp/auth";

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
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version, www-authenticate");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = authenticate(req);
  if (!auth) {
    const metadata = `${origin}/.well-known/oauth-protected-resource/api/mcp`;
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadata}", scope="mcp:read"`);
    return res.status(401).json(mcpError(-32001, "Authentication required"));
  }
  if (req.method !== "POST") return res.status(405).json(mcpError(-32000, "Stateless MCP accepts POST requests only"));

  const server = createLinkiMcpServer({ origin, auth });
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
  if (!header?.startsWith("Bearer ")) return null;
  return verifyAccessToken(header.slice(7).trim(), mcpResourceUrl(req));
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

function safeOrigin(value: string) { try { return new URL(value).origin; } catch { return ""; } }
function mcpError(code: number, message: string) { return { jsonrpc: "2.0", error: { code, message }, id: null }; }
