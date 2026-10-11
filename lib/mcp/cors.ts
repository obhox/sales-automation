import type { NextApiRequest, NextApiResponse } from "next";

/**
 * CORS for the OAuth endpoints a client reaches before it has any credential: the discovery
 * documents, dynamic registration, the token endpoint and revocation.
 *
 * These are open to any origin on purpose. None of them reads a cookie or a session, the
 * token endpoint is a public-client PKCE exchange, and the discovery documents are public
 * by definition. A browser-based MCP client (the MCP Inspector's direct mode, a web app
 * connector) cannot start without that, and the CORS check is the only thing it asks for.
 *
 * The consent step (/api/oauth/authorize) is deliberately not here: it runs on the user's
 * session cookie and must stay same-origin.
 *
 * Returns true when the request was a preflight and has been answered.
 */
export function openOAuthCors(req: NextApiRequest, res: NextApiResponse, methods = "POST, OPTIONS"): boolean {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-protocol-version");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}
