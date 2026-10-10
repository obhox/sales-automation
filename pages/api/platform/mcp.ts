import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requestOrigin } from "@/lib/mcp/auth";
import { mcpCatalogue, type McpGroup } from "@/lib/mcp/catalogue";
import { requireWorkspace } from "@/lib/workspace";

export interface McpInfo {
  /** The address an MCP client connects to. Signing in happens in the browser; there is no key to paste. */
  url: string;
  tools: number;
  read_only_tools: number;
  groups: McpGroup[];
  /** How this workspace has used it: tool calls in the last 30 days, and the latest. */
  calls_30d: number;
  last_call_at: string | null;
}

// What the MCP server offers and where it is, for the Developer page.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;
  const catalogue = mcpCatalogue();
  const usage = getDb().prepare(
    "SELECT COUNT(*) AS calls, MAX(created_at) AS last FROM mcp_audit_logs WHERE workspace_id = ? AND created_at >= datetime('now', '-30 days')",
  ).get(ctx.workspaceId) as { calls: number; last: string | null };
  const info: McpInfo = {
    url: `${requestOrigin(req)}/api/mcp`,
    tools: catalogue.tools.length,
    read_only_tools: catalogue.tools.filter((tool) => tool.read_only).length,
    groups: catalogue.groups,
    calls_30d: usage.calls,
    last_call_at: usage.last,
  };
  return res.json(info);
}
