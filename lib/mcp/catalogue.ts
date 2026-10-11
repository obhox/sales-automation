// What the MCP server offers, for the Developer page: every tool it registers, sorted
// into groups a person would recognise. The list is read from the server itself, so a
// tool added there appears here without anyone remembering to list it.
import { createLinkiMcpServer } from "@/lib/mcp/server";

export interface McpTool {
  name: string;
  title: string;
  /** True when the tool only reads. */
  read_only: boolean;
  group: string;
}

export interface McpGroup {
  key: string;
  label: string;
  tools: number;
}

export interface McpCatalogue {
  tools: McpTool[];
  /** Largest group first. */
  groups: McpGroup[];
}

// The first rule that matches a tool's name decides its group. A tool no rule matches
// goes under "Other", so a new one is still counted.
const GROUPS: Array<{ key: string; label: string; match: RegExp }> = [
  { key: "developer", label: "Developer", match: /^(api_keys|webhook|domain_events|external_connection|integration_credentials|linki_api_request|mcp_)/ },
  { key: "ai", label: "AI", match: /^(ai_|outreach_preview)/ },
  { key: "senders", label: "Sender accounts", match: /^(sender_accounts|linkedin_account|linkedin_sync|email_account|gmail_|email_health|deliverability)/ },
  { key: "inbox", label: "Inbox & tasks", match: /^(inbox_|team_inbox|reply_|linkedin_conversation|todo|activity_)/ },
  { key: "lists", label: "Lists", match: /^(list_|lists_|import|sales_nav)/ },
  { key: "contacts", label: "Contacts", match: /^(contact|compan|custom_fields|suppression)/ },
  { key: "campaigns", label: "Campaigns", match: /^(workflow|template|run_|runs_)/ },
  { key: "pipeline", label: "Pipeline", match: /^(pipeline|signals)/ },
  { key: "workspace", label: "Workspace", match: /^(workspace|audit_|application_settings|system_)/ },
];
const OTHER = { key: "other", label: "Other" };

export function groupOf(name: string): { key: string; label: string } {
  return GROUPS.find((group) => group.match.test(name)) ?? OTHER;
}

let cached: McpCatalogue | null = null;

/** The tools never change while the process runs, so this is worked out once. */
export function mcpCatalogue(): McpCatalogue {
  if (cached) return cached;
  const tools: McpTool[] = [];
  // No tool is called here: the server is only built, with a caller that has no scopes, to hear what it registers.
  createLinkiMcpServer({
    origin: "http://localhost",
    auth: { token: "", clientId: "catalogue", scopes: [] },
    onTool: (name, tool) => tools.push({ name, title: tool.title ?? name, read_only: Boolean(tool.annotations?.readOnlyHint), group: groupOf(name).key }),
  });
  const counts = new Map<string, McpGroup>();
  for (const tool of tools) {
    const group = groupOf(tool.name);
    const entry = counts.get(group.key) ?? { key: group.key, label: group.label, tools: 0 };
    entry.tools += 1;
    counts.set(group.key, entry);
  }
  const order = [...GROUPS.map((group) => group.key), OTHER.key];
  const groups = [...counts.values()].sort((a, b) => b.tools - a.tools || order.indexOf(a.key) - order.indexOf(b.key));
  cached = { tools, groups };
  return cached;
}
