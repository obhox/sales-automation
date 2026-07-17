import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { isSafeRedirectUri } from "@/lib/mcp/auth";
import { isRateLimited } from "@/lib/rate-limit";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (isRateLimited(req, "oauth-register", 20, 60 * 60_000)) return res.status(429).json({ error: "too_many_requests" });
  const body = req.body as Record<string, unknown>;
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((v): v is string => typeof v === "string") : [];
  if (redirectUris.length === 0 || redirectUris.length > 20 || redirectUris.some((uri) => !isSafeRedirectUri(uri))) {
    return res.status(400).json({ error: "invalid_redirect_uri" });
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    return res.status(400).json({ error: "invalid_client_metadata", error_description: "Only public PKCE clients are supported" });
  }
  const clientId = randomUUID();
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : "MCP client";
  getDb().prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)")
    .run(clientId, clientName, JSON.stringify(redirectUris));
  return res.status(201).json({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}
