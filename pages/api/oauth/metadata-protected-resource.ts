import type { NextApiRequest, NextApiResponse } from "next";
import { openOAuthCors } from "@/lib/mcp/cors";
import { MCP_SCOPES, mcpResourceUrl, requestOrigin } from "@/lib/mcp/auth";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (openOAuthCors(req, res, "GET, OPTIONS")) return;
  const origin = requestOrigin(req);
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.json({
    resource: mcpResourceUrl(req),
    resource_name: "Linki Sales Automation",
    authorization_servers: [origin],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/developers`,
  });
}

