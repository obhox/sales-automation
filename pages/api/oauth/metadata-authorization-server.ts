import type { NextApiRequest, NextApiResponse } from "next";
import { MCP_SCOPES, requestOrigin } from "@/lib/mcp/auth";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const origin = requestOrigin(req);
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    scopes_supported: MCP_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  });
}

