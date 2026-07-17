import { randomUUID } from "crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { getDb } from "@/lib/db";
import type { McpScope } from "@/lib/mcp/auth";

type JsonObject = Record<string, unknown>;
type ApiOptions = { method?: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown };

const MCP_DOMAINS = ["contacts","companies","lists","imports","templates","workflows","workflow-steps","outreach-previews","conditional-branches","runs","enrollments","LinkedIn-senders","email-senders","reply-intelligence","team-inbox","todos","activities","suppression","deliverability","signals","custom-fields","pipeline","meetings","CRM-sync","calendar-sync","integration-credentials","AI-configuration","domain-events","webhooks","API-keys","workspaces","invitations","members","RBAC","audit","settings"];
const MCP_ROUTE_FAMILIES = ["accounts","activity-logs","agent/preview","companies","dashboard","email-accounts","email-accounts/gmail-app-password","email-health","imports","inbox","integrations","lists","openrouter/models","platform/*","premium-status","runs","settings/import-cap","targets","templates","todos","tour","workflows","workflows/preview"];
const MCP_FEATURES = ["contact-specific manual and AI outreach previews","Gmail sender connection using an app password","plain or enhanced email delivery with open/click tracking controls"];
const MCP_EXCLUSIONS = ["password authentication and signup","OAuth token issuance/revocation","the MCP endpoint itself","host software update","public invitation acceptance","the versioned public-API façade (its underlying workspace operations are exposed directly)","the diagnostic hello endpoint"];

export function createLinkiMcpServer(input: { origin: string; auth: AuthInfo }) {
  const server = new McpServer({
    name: "linki-sales-automation",
    version: "1.1.0",
    description: "MCP-native sales automation, CRM, campaigns, inbox and analytics",
  }, { capabilities: { logging: {} } });

  const api = async (path: string, options: ApiOptions = {}) => {
    const url = new URL(path, input.origin);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (process.env.INTERNAL_API_SECRET) headers["x-internal-secret"] = process.env.INTERNAL_API_SECRET;
    if (input.auth.extra?.workspaceId) headers["x-workspace-id"] = String(input.auth.extra.workspaceId);
    if (input.auth.extra?.userId) headers["x-user-id"] = String(input.auth.extra.userId);
    if (input.auth.extra?.workspaceRole) headers["x-workspace-role"] = String(input.auth.extra.workspaceRole);
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    let data: unknown = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
    return data;
  };

  const run = async (name: string, scope: McpScope, args: unknown, work: () => Promise<unknown>) => {
    const started = Date.now();
    if (!input.auth.scopes.includes(scope)) return failure(`This tool requires the ${scope} scope.`);
    try {
      const data = await work();
      audit(input.auth, name, args, true, null, Date.now() - started);
      return success(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown MCP tool error";
      audit(input.auth, name, args, false, message, Date.now() - started);
      return failure(message);
    }
  };

  server.registerTool("system_overview", {
    title: "Sales workspace overview", description: "Read dashboard metrics, campaign state, and current system capabilities.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run("system_overview", "mcp:read", {}, async () => ({
    dashboard: await api("/api/dashboard/stats"),
    capabilities: await api("/api/premium-status"),
  })));

  server.registerTool("contacts_search", {
    title: "Search contacts", description: "Search and page through CRM contacts, optionally limited to a list.",
    inputSchema: { search: z.string().optional(), list_id: z.string().optional(), page: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("contacts_search", "mcp:read", args, () => api("/api/targets", { query: args })));

  server.registerTool("contact_get", {
    title: "Get contact", description: "Read a complete contact, its company, lists, CRM activity, todos, runs and email history.",
    inputSchema: { contact_id: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ contact_id }) => run("contact_get", "mcp:read", { contact_id }, async () => ({
    contact: await api(`/api/targets/${enc(contact_id)}`),
    custom_fields: await api("/api/platform/custom-fields", { query: { target_id: contact_id } }),
    runs: await api(`/api/targets/${enc(contact_id)}/runs`),
    replies: getDb().prepare("SELECT * FROM email_replies WHERE target_id = ? AND workspace_id = ? ORDER BY received_at DESC LIMIT 100").all(contact_id, String(input.auth.extra?.workspaceId)),
    todos: getDb().prepare("SELECT * FROM todos WHERE target_id = ? AND workspace_id = ? ORDER BY created_at DESC").all(contact_id, String(input.auth.extra?.workspaceId)),
    activity: getDb().prepare("SELECT * FROM activity_logs WHERE target_id = ? AND workspace_id = ? ORDER BY logged_at DESC").all(contact_id, String(input.auth.extra?.workspaceId)),
  })));

  server.registerTool("contact_create", {
    title: "Create contact", description: "Create a CRM contact and optionally add it to a list.",
    inputSchema: { full_name: z.string().min(1), linkedin_url: z.string().url(), title: z.string().optional(), company: z.string().optional(), location: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional(), list_id: z.string().optional() },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, (args) => run("contact_create", "mcp:write", args, () => api("/api/targets", { method: "POST", body: args })));

  server.registerTool("contact_update", {
    title: "Update contact", description: "Update editable CRM fields on a contact.",
    inputSchema: { contact_id: z.string(), full_name: z.string().optional(), first_name: z.string().optional(), last_name: z.string().optional(), title: z.string().optional(), company: z.string().optional(), location: z.string().optional(), email: z.string().email().nullable().optional(), phone: z.string().nullable().optional(), headline: z.string().optional(), summary: z.string().optional(), notes: z.string().optional() },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ contact_id, ...body }) => run("contact_update", "mcp:write", { contact_id, ...body }, () => api(`/api/targets/${enc(contact_id)}`, { method: "PATCH", body })));

  server.registerTool("contact_delete", {
    title: "Delete contact", description: "Permanently delete a contact and its automation history.",
    inputSchema: { contact_id: z.string(), confirm: z.literal(true) }, annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ contact_id, confirm }) => run("contact_delete", "mcp:write", { contact_id, confirm }, () => api(`/api/targets/${enc(contact_id)}`, { method: "DELETE" })));

  server.registerTool("companies_list", {
    title: "List companies", description: "List and search CRM companies.",
    inputSchema: { search: z.string().optional(), page: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("companies_list", "mcp:read", args, () => api("/api/companies", { query: args })));

  server.registerTool("company_manage", {
    title: "Manage company", description: "Get, create, update or delete a CRM company.",
    inputSchema: { action: z.enum(["get", "create", "update", "delete"]), company_id: z.string().optional(), name: z.string().optional(), domain: z.string().optional(), industry: z.string().optional(), location: z.string().optional(), website: z.string().optional(), linkedin_url: z.string().optional(), notes: z.string().optional(), confirm: z.boolean().optional() },
    annotations: { openWorldHint: false },
  }, (args) => run("company_manage", args.action === "get" ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action !== "create" && !args.company_id) throw new Error("company_id is required");
    if (args.action === "delete" && !args.confirm) throw new Error("confirm=true is required for deletion");
    const { action, company_id, confirm: _confirm, ...body } = args; void _confirm;
    if (action === "get") return api(`/api/companies/${enc(company_id!)}`);
    if (action === "create") return api("/api/companies", { method: "POST", body });
    return api(`/api/companies/${enc(company_id!)}`, { method: action === "update" ? "PUT" : "DELETE", body: action === "update" ? body : undefined });
  }));

  server.registerTool("lists_list", {
    title: "List lead lists", description: "List lead lists and member counts.", annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run("lists_list", "mcp:read", {}, () => api("/api/lists")));

  server.registerTool("list_get", {
    title: "Get lead list", description: "Read a lead list and all of its contacts.", inputSchema: { list_id: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ list_id }) => run("list_get", "mcp:read", { list_id }, () => api(`/api/lists/${enc(list_id)}`)));

  server.registerTool("list_create", {
    title: "Create lead list", description: "Create a new lead list.", inputSchema: { name: z.string().min(1), description: z.string().optional() }, annotations: { destructiveHint: false, openWorldHint: false },
  }, (args) => run("list_create", "mcp:write", args, () => api("/api/lists", { method: "POST", body: args })));

  server.registerTool("list_members_update", {
    title: "Update list members", description: "Add contacts to or remove contacts from a lead list.",
    inputSchema: { list_id: z.string(), action: z.enum(["add", "remove"]), contact_ids: z.array(z.string()).min(1) }, annotations: { idempotentHint: true, openWorldHint: false },
  }, ({ list_id, action, contact_ids }) => run("list_members_update", "mcp:write", { list_id, action, contact_ids }, () =>
    api(`/api/lists/${enc(list_id)}/${action === "add" ? "add-members" : "remove-members"}`, { method: "POST", body: { target_ids: contact_ids } })));

  server.registerTool("list_import_csv", {
    title: "Import contacts from CSV",
    description: "Bulk-import contacts into a lead list from CSV text. Map each column to a standard field or to a NEW custom personalization variable ({{key}} merge tag) via `mapping`. Each row needs a linkedin_url or email. Omit `mapping` to use fixed-schema auto-detection.",
    inputSchema: {
      list_id: z.string(),
      csv: z.string().min(1),
      mapping: z.array(z.discriminatedUnion("kind", [
        z.object({ column: z.string(), kind: z.literal("ignore") }),
        z.object({ column: z.string(), kind: z.literal("standard"), field: z.string() }),
        z.object({ column: z.string(), kind: z.literal("custom"), key: z.string(), name: z.string(), fieldType: z.enum(["text", "number", "boolean"]) }),
      ])).optional(),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ list_id, csv, mapping }) => run("list_import_csv", "mcp:write", { list_id, mapping, csv_bytes: csv.length }, () =>
    api(`/api/lists/${enc(list_id)}/import-csv`, { method: "POST", body: { csv, mapping } })));

  server.registerTool("list_verify_emails", {
    title: "Verify list emails",
    description: "Check whether each contact's email address in a list is a live, reachable mailbox (syntax → MX → SMTP probe) before you email them. Definitively dead addresses are added to the do-not-send (suppression) list; catch-all/unverifiable ones are left sendable. Optionally limit to specific contacts.",
    inputSchema: { list_id: z.string(), contact_ids: z.array(z.string()).optional() },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ list_id, contact_ids }) => run("list_verify_emails", "mcp:execute", { list_id, contact_ids }, () =>
    api(`/api/lists/${enc(list_id)}/verify-emails`, { method: "POST", body: { target_ids: contact_ids } })));

  server.registerTool("templates_list", {
    title: "List message templates", description: "List reusable outreach templates.", annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run("templates_list", "mcp:read", {}, () => api("/api/templates")));

  server.registerTool("template_manage", {
    title: "Manage message template", description: "Get, create, update or delete a message template.",
    inputSchema: { action: z.enum(["get", "create", "update", "delete"]), template_id: z.string().optional(), name: z.string().optional(), body: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("template_manage", args.action === "get" ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action !== "create" && !args.template_id) throw new Error("template_id is required");
    if (args.action === "delete" && !args.confirm) throw new Error("confirm=true is required for deletion");
    const { action, template_id, confirm: _confirm, ...body } = args; void _confirm;
    if (action === "get") return api(`/api/templates/${enc(template_id!)}`);
    if (action === "create") return api("/api/templates", { method: "POST", body });
    return api(`/api/templates/${enc(template_id!)}`, { method: action === "update" ? "PUT" : "DELETE", body: action === "update" ? body : undefined });
  }));

  server.registerTool("workflows_list", {
    title: "List workflows", description: "List campaign workflows and their step counts.", annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run("workflows_list", "mcp:read", {}, () => api("/api/workflows")));

  server.registerTool("workflow_get", {
    title: "Get workflow", description: "Read a workflow and all of its LinkedIn and email steps.", inputSchema: { workflow_id: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workflow_id }) => run("workflow_get", "mcp:read", { workflow_id }, () => api(`/api/workflows/${enc(workflow_id)}`)));

  server.registerTool("workflow_create", {
    title: "Create workflow", description: "Create a campaign workflow.", inputSchema: { name: z.string().min(1), description: z.string().optional(), prompt: z.string().optional() }, annotations: { destructiveHint: false, openWorldHint: false },
  }, (args) => run("workflow_create", "mcp:write", args, () => api("/api/workflows", { method: "POST", body: args })));

  server.registerTool("workflow_add_step", {
    title: "Add workflow step", description: "Add a visit, connection, LinkedIn message, Sales Navigator InMail, delay, or email step to a workflow, including delivery and tracking settings.",
    inputSchema: { workflow_id: z.string(), step_type: z.enum(["visit", "connect", "message", "sales_inmail", "delay", "email"]), track: z.enum(["linkedin", "email"]).optional(), template_id: z.string().optional(), template_ids: z.array(z.string()).optional(), delay_seconds: z.number().int().min(0).optional(), connect_note: z.string().optional(), message_body: z.string().optional(), email_subject: z.string().optional(), email_body: z.string().optional(), email_signature: z.string().nullable().optional(), email_delivery_mode: z.enum(["plain", "enhanced"]).optional(), email_track_opens: z.boolean().optional(), email_track_clicks: z.boolean().optional(), ai_enabled: z.boolean().optional(), ai_model: z.string().optional(), ai_prompt: z.string().optional(), ai_max_words: z.number().int().positive().optional(), ai_language: z.string().optional() },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ workflow_id, ...body }) => run("workflow_add_step", "mcp:write", { workflow_id, ...body }, () => api(`/api/workflows/${enc(workflow_id)}/steps`, { method: "POST", body })));

  server.registerTool("workflow_manage", {
    title: "Manage workflow", description: "Update, archive, unarchive, or permanently delete a workflow.",
    inputSchema: { workflow_id: z.string(), action: z.enum(["update", "archive", "unarchive", "delete"]), name: z.string().optional(), description: z.string().optional(), prompt: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("workflow_manage", "mcp:write", args, async () => {
    if (args.action === "delete" && !args.confirm) throw new Error("confirm=true is required for deletion");
    const { workflow_id, action, confirm: _confirm, ...body } = args; void _confirm;
    if (action === "update") return api(`/api/workflows/${enc(workflow_id)}`, { method: "PUT", body });
    if (action === "archive" || action === "unarchive") return api(`/api/workflows/${enc(workflow_id)}`, { method: "PATCH", body: { is_archived: action === "archive" } });
    return api(`/api/workflows/${enc(workflow_id)}`, { method: "DELETE" });
  }));

  server.registerTool("runs_list", {
    title: "List campaign runs", description: "List campaign runs, status and completion counts.", annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run("runs_list", "mcp:read", {}, () => api("/api/runs")));

  server.registerTool("run_get", {
    title: "Get campaign run", description: "Read a campaign run, enrolled contacts, track state and recent logs.",
    inputSchema: { run_id: z.string(), contact_id: z.string().optional(), page: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(50) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ run_id, contact_id, page, limit }) => run("run_get", "mcp:read", { run_id, contact_id, page, limit }, () => api(`/api/runs/${enc(run_id)}`, { query: { target_id: contact_id, page, limit } })));

  server.registerTool("run_create", {
    title: "Create campaign run", description: "Enroll a list or selected contacts into a workflow using sender accounts. This prepares but does not launch the run.",
    inputSchema: { workflow_id: z.string(), list_id: z.string(), account_id: z.string(), email_account_ids: z.array(z.string()).optional(), contact_ids: z.array(z.string()).optional() }, annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ contact_ids, ...args }) => run("run_create", "mcp:write", { ...args, contact_ids }, () => api("/api/runs", { method: "POST", body: { ...args, target_ids: contact_ids } })));

  server.registerTool("run_control", {
    title: "Control campaign run", description: "Start, pause, resume, or delete a campaign run. Starting/resuming permits real external outreach.",
    inputSchema: { run_id: z.string(), action: z.enum(["start", "pause", "resume", "delete"]), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, ({ run_id, action, confirm }) => run("run_control", action === "delete" ? "mcp:write" : "mcp:execute", { run_id, action, confirm }, async () => {
    if ((action === "start" || action === "resume" || action === "delete") && !confirm) throw new Error("confirm=true is required for this action");
    if (action === "start") return api(`/api/runs/${enc(run_id)}/start`, { method: "POST" });
    if (action === "pause" || action === "resume") return api(`/api/runs/${enc(run_id)}`, { method: "PATCH", body: { status: action === "pause" ? "paused" : "running" } });
    return api(`/api/runs/${enc(run_id)}`, { method: "DELETE" });
  }));

  server.registerTool("inbox_list", {
    title: "List inbox replies", description: "Read the unified reply inbox with contact, channel, workflow and classifier context.", inputSchema: { channel: z.enum(["email", "linkedin"]).optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("inbox_list", "mcp:read", args, () => api("/api/inbox", { query: args })));

  server.registerTool("inbox_send_email", {
    title: "Send inbox email", description: "Send a manual email reply through a configured sender account.",
    inputSchema: { email_account_id: z.string(), to: z.string().email(), subject: z.string().min(1), body: z.string().min(1), confirm: z.literal(true) }, annotations: { destructiveHint: false, openWorldHint: true },
  }, (args) => run("inbox_send_email", "mcp:execute", args, () => {
    const { email_account_id, confirm: _confirm, ...body } = args; void _confirm;
    return api("/api/inbox/reply", { method: "POST", body: { emailAccountId: email_account_id, ...body } });
  }));

  server.registerTool("todos_list", {
    title: "List CRM todos", description: "List open, completed, or all CRM tasks.", inputSchema: { status: z.enum(["open", "done"]).optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("todos_list", "mcp:read", args, () => api("/api/todos", { query: args })));

  server.registerTool("todo_manage", {
    title: "Manage CRM todo", description: "Create, update, complete, reopen or delete a CRM task.",
    inputSchema: { action: z.enum(["create", "update", "delete"]), todo_id: z.string().optional(), contact_id: z.string().optional(), title: z.string().optional(), description: z.string().optional(), due_date: z.string().optional(), status: z.enum(["open", "done"]).optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("todo_manage", "mcp:write", args, async () => {
    if (args.action !== "create" && !args.todo_id) throw new Error("todo_id is required");
    if (args.action === "delete" && !args.confirm) throw new Error("confirm=true is required for deletion");
    const { action, todo_id, contact_id, confirm: _confirm, ...body } = args; void _confirm;
    if (action === "create") return api("/api/todos", { method: "POST", body: { target_id: contact_id, ...body } });
    return api(`/api/todos/${enc(todo_id!)}`, { method: action === "update" ? "PATCH" : "DELETE", body: action === "update" ? body : undefined });
  }));

  server.registerTool("activity_manage", {
    title: "Manage CRM activity", description: "Create, update or delete a call, email, meeting, note or other activity record.",
    inputSchema: { action: z.enum(["create", "update", "delete"]), activity_id: z.string().optional(), contact_id: z.string().optional(), type: z.enum(["call", "email", "meeting", "note", "other"]).optional(), body: z.string().optional(), logged_at: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("activity_manage", "mcp:write", args, async () => {
    if (args.action !== "create" && !args.activity_id) throw new Error("activity_id is required");
    if (args.action === "delete" && !args.confirm) throw new Error("confirm=true is required for deletion");
    const { action, activity_id, contact_id, confirm: _confirm, ...body } = args; void _confirm;
    if (action === "create") return api("/api/activity-logs", { method: "POST", body: { target_id: contact_id, ...body } });
    return api(`/api/activity-logs?id=${enc(activity_id!)}`, { method: action === "update" ? "PATCH" : "DELETE", body: action === "update" ? body : undefined });
  }));

  server.registerTool("sender_accounts_list", {
    title: "List sender accounts", description: "List LinkedIn and email sender accounts without returning secrets.", annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run("sender_accounts_list", "mcp:read", {}, async () => ({ linkedin: await api("/api/accounts"), email: await api("/api/email-accounts") })));

  server.registerTool("email_health", {
    title: "Email sender health", description: "Read sender verification, ramp-up, usage and deliverability health.", annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run("email_health", "mcp:read", {}, () => api("/api/email-health")));

  server.registerTool("imports_list", {
    title: "List import jobs", description: "Read active, scheduled and recently completed Sales Navigator import jobs.", annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run("imports_list", "mcp:read", {}, () => api("/api/imports")));

  server.registerTool("sales_nav_import", {
    title: "Import Sales Navigator search", description: "Queue a Sales Navigator search URL into a lead list using an authenticated LinkedIn account.",
    inputSchema: { list_id: z.string(), account_id: z.string(), sales_nav_url: z.string().url(), enrich: z.boolean().default(false), confirm: z.literal(true) }, annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ list_id, account_id, sales_nav_url, enrich }) => run("sales_nav_import", "mcp:execute", { list_id, account_id, sales_nav_url, enrich }, () => api(`/api/lists/${enc(list_id)}/import`, { method: "POST", body: { account_id, sales_nav_url, enrich } })));

  server.registerTool("list_apollo_enrich", {
    title: "Enrich list with Apollo", description: "Enrich selected or unenriched list contacts with email and company data through the configured Apollo integration.",
    inputSchema: { list_id: z.string(), contact_ids: z.array(z.string()).optional(), confirm: z.literal(true) }, annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ list_id, contact_ids }) => run("list_apollo_enrich", "mcp:execute", { list_id, contact_ids }, () => api(`/api/lists/${enc(list_id)}/apollo-enrich`, { method: "POST", body: { target_ids: contact_ids } })));

  server.registerTool("list_linkedin_enrich", {
    title: "Enrich list from LinkedIn", description: "Queue live LinkedIn profile enrichment for contacts in a list.",
    inputSchema: { list_id: z.string(), account_id: z.string(), confirm: z.literal(true) }, annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ list_id, account_id }) => run("list_linkedin_enrich", "mcp:execute", { list_id, account_id }, () => api(`/api/lists/${enc(list_id)}/enrich`, { method: "POST", body: { account_id } })));

  server.registerTool("contact_scrape_profile", {
    title: "Refresh contact profile", description: "Live-scrape and persist a contact's Sales Navigator career data and recent posts.",
    inputSchema: { contact_id: z.string(), account_id: z.string().optional(), confirm: z.literal(true) }, annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ contact_id, account_id }) => run("contact_scrape_profile", "mcp:execute", { contact_id, account_id }, () => api(`/api/targets/${enc(contact_id)}/profile-scrape`, { method: "POST", body: { account_id } })));

  server.registerTool("linkedin_sync_connections", {
    title: "Sync accepted connections", description: "Refresh accepted/pending connection status from a LinkedIn sender account.",
    inputSchema: { account_id: z.string(), confirm: z.literal(true) }, annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ account_id }) => run("linkedin_sync_connections", "mcp:execute", { account_id }, () => api(`/api/accounts/${enc(account_id)}/sync-accepted`, { method: "POST" })));

  server.registerTool("workflow_analytics", {
    title: "Workflow analytics", description: "Read funnel, audience, reply and daily activity analytics for a workflow.",
    inputSchema: { workflow_id: z.string(), days: z.number().int().min(7).max(90).default(30) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workflow_id, days }) => run("workflow_analytics", "mcp:read", { workflow_id, days }, () => api(`/api/workflows/${enc(workflow_id)}/analytics`, { query: { days } })));

  server.registerTool("ai_generate_preview", {
    title: "Generate outreach preview", description: "Generate a personalized email, LinkedIn message, or InMail draft for a contact using the configured OpenRouter model.",
    inputSchema: { contact_id: z.string(), channel: z.enum(["email", "linkedin", "inmail"]), prompt: z.string().optional(), model: z.string().optional(), max_words: z.number().int().positive().max(1000).optional(), language: z.string().optional() }, annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ contact_id, ...args }) => run("ai_generate_preview", "mcp:execute", { contact_id, ...args }, () => api("/api/agent/preview", { method: "POST", body: { target_id: contact_id, ...args } })));

  server.registerTool("outreach_preview", {
    title: "Preview personalized outreach",
    description: "Preview a manual or AI email, LinkedIn message, or InMail for one real workspace contact. This applies the same variables, template, sender signature, delivery mode, and link-removal rules as live sending, but does not send anything.",
    inputSchema: {
      contact_id: z.string(),
      step_type: z.enum(["message", "sales_inmail", "email"]),
      message_body: z.string().optional(),
      email_subject: z.string().optional(),
      email_body: z.string().optional(),
      email_signature: z.string().nullable().optional(),
      email_account_id: z.string().nullable().optional(),
      email_delivery_mode: z.enum(["plain", "enhanced"]).default("plain"),
      email_track_opens: z.boolean().default(false),
      email_track_clicks: z.boolean().default(false),
      template_id: z.string().nullable().optional(),
      ai_enabled: z.boolean().default(false),
      ai_model: z.string().optional(),
      ai_prompt: z.string().optional(),
      ai_max_words: z.number().int().min(1).max(1000).nullable().optional(),
      ai_language: z.string().nullable().optional(),
      campaign_prompt: z.string().nullable().optional(),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ contact_id, ...body }) => run("outreach_preview", "mcp:execute", { contact_id, ...body }, () =>
    api("/api/workflows/preview", { method: "POST", body: { target_id: contact_id, ...body } })));

  server.registerTool("workspace_admin", {
    title: "Workspace and permissions", description: "Read the workspace and members, add/update a member role, rename the workspace, or remove a member.",
    inputSchema: { action: z.enum(["get", "upsert_member", "rename", "remove_member"]), email: z.string().email().optional(), role: z.enum(["owner","admin","manager","member","viewer"]).optional(), name: z.string().optional(), user_id: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("workspace_admin", args.action === "get" ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action === "get") return api("/api/platform/workspace");
    if (args.action === "upsert_member") return api("/api/platform/workspace", { method: "POST", body: { email: args.email, role: args.role } });
    if (args.action === "rename") return api("/api/platform/workspace", { method: "PATCH", body: { name: args.name } });
    if (!args.confirm) throw new Error("confirm=true is required to remove a member");
    return api("/api/platform/workspace", { method: "DELETE", query: { user_id: args.user_id } });
  }));

  server.registerTool("workspace_invitation_manage", {
    title: "Workspace invitations", description: "List, create/email, or revoke single-use workspace invitations. Invitation secrets are returned only when created.",
    inputSchema: { action: z.enum(["list","invite","revoke"]), email: z.string().email().optional(), role: z.enum(["owner","admin","manager","member","viewer"]).optional(), invitation_id: z.string().optional(), send_email: z.boolean().default(true), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("workspace_invitation_manage", args.action === "list" ? "mcp:read" : args.action === "invite" && args.send_email ? "mcp:execute" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/invitations");
    if (args.action === "invite") { if(args.send_email && !args.confirm) throw new Error("confirm=true is required to send the invitation email"); return api("/api/platform/invitations",{method:"POST",body:{email:args.email,role:args.role,send_email:args.send_email}}); }
    if(!args.confirm) throw new Error("confirm=true is required to revoke an invitation");
    return api("/api/platform/invitations",{method:"DELETE",query:{id:args.invitation_id}});
  }));

  server.registerTool("custom_fields_manage", {
    title: "Custom CRM fields", description: "List/create workspace custom-field definitions (the {{key}} personalization variables), read one contact's custom values, and set a field value on a contact.",
    inputSchema: { action:z.enum(["list","get_values","create","set_value"]), name:z.string().optional(), key:z.string().optional(), field_type:z.enum(["text","number","boolean"]).optional(), options:z.array(z.string()).optional(), contact_id:z.string().optional(), field_id:z.string().optional(), value:z.unknown().optional() }, annotations:{openWorldHint:false},
  }, args=>run("custom_fields_manage",args.action==="list"||args.action==="get_values"?"mcp:read":"mcp:write",args,()=>{
    if(args.action==="list")return api("/api/platform/custom-fields");
    if(args.action==="get_values"){if(!args.contact_id)throw new Error("contact_id is required");return api("/api/platform/custom-fields",{query:{target_id:args.contact_id}});}
    if(args.action==="create")return api("/api/platform/custom-fields",{method:"POST",body:args});
    return api("/api/platform/custom-fields",{method:"PUT",body:{target_id:args.contact_id,field_id:args.field_id,value:args.value}});
  }));

  server.registerTool("ai_configuration_manage", {
    title:"AI configuration",description:"Read or update the workspace model, prompts, and approved outreach examples.",inputSchema:{action:z.enum(["get","update"]),default_model:z.string().nullable().optional(),system_prompt:z.string().nullable().optional(),user_prompt:z.string().nullable().optional(),email_examples:z.string().nullable().optional(),linkedin_examples:z.string().nullable().optional()},annotations:{openWorldHint:true},
  },args=>run("ai_configuration_manage",args.action==="get"?"mcp:read":"mcp:write",args,()=>args.action==="get"?api("/api/platform/ai-config"):api("/api/platform/ai-config",{method:"PUT",body:args})));

  server.registerTool("integration_credentials_manage", {
    title:"Integration credentials",description:"List, configure, or remove encrypted provider API credentials used by enrichment and AI features.",inputSchema:{action:z.enum(["list","configure","remove"]),key:z.string().optional(),api_key:z.string().optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("integration_credentials_manage",args.action==="list"?"mcp:read":"mcp:write",args,async()=>{if(args.action==="list")return api("/api/integrations");if(args.action==="configure")return api("/api/integrations",{method:"POST",body:{key:args.key,api_key:args.api_key}});if(!args.confirm)throw new Error("confirm=true is required to remove credentials");return api("/api/integrations",{method:"DELETE",query:{key:args.key}});}));

  server.registerTool("api_keys_manage", {
    title:"Public API keys",description:"List, create, or revoke scoped public API keys. A new secret is returned once and redacted from MCP audit logs.",inputSchema:{action:z.enum(["list","create","revoke"]),name:z.string().optional(),scopes:z.array(z.string()).optional(),expires_at:z.string().optional(),key_id:z.string().optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:false},
  },args=>run("api_keys_manage",args.action==="list"?"mcp:read":"mcp:write",args,async()=>{if(args.action==="list")return api("/api/platform/api-keys");if(args.action==="create")return api("/api/platform/api-keys",{method:"POST",body:args});if(!args.confirm)throw new Error("confirm=true is required to revoke an API key");return api("/api/platform/api-keys",{method:"DELETE",query:{id:args.key_id}});}));

  server.registerTool("audit_logs_search", {
    title:"Workspace audit log",description:"Read tenant-scoped user, configuration, automation, and MCP audit events.",inputSchema:{source:z.enum(["workspace","mcp"]).default("workspace"),limit:z.number().int().min(1).max(500).default(100)},annotations:{readOnlyHint:true,openWorldHint:false},
  },args=>run("audit_logs_search","mcp:read",args,async()=>args.source==="workspace"?api("/api/platform/audit",{query:{limit:args.limit}}):getDb().prepare("SELECT id,client_id,tool_name,success,error,duration_ms,created_at FROM mcp_audit_logs WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?").all(String(input.auth.extra?.workspaceId),args.limit)));

  server.registerTool("domain_events_manage", {
    title:"Domain event stream",description:"Read or emit tenant events and optionally dispatch them to signed webhooks.",inputSchema:{action:z.enum(["list","emit"]),type:z.string().optional(),entity_type:z.string().optional(),entity_id:z.string().optional(),payload:z.record(z.string(),z.unknown()).optional(),limit:z.number().int().min(1).max(500).default(100),deliver:z.boolean().default(true),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("domain_events_manage",args.action==="list"?"mcp:read":args.deliver?"mcp:execute":"mcp:write",args,async()=>{if(args.action==="list")return api("/api/platform/events",{query:{type:args.type,limit:args.limit}});if(args.deliver&&!args.confirm)throw new Error("confirm=true is required to dispatch webhooks");return api("/api/platform/events",{method:"POST",body:args});}));

  server.registerTool("linkedin_account_manage", {
    title:"LinkedIn sender accounts",description:"Fully manage LinkedIn senders: list/get/create/update/delete, authenticate, complete login challenges, refresh statistics, and sync accepted connections.",
    inputSchema:{action:z.enum(["list","get","create","update","delete","authenticate","login","stats","sync_connections"]),account_id:z.string().optional(),body:z.record(z.string(),z.unknown()).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("linkedin_account_manage",["list","get"].includes(args.action)?"mcp:read":["authenticate","login","stats","sync_connections"].includes(args.action)?"mcp:execute":"mcp:write",args,async()=>{
    const id=args.account_id?enc(args.account_id):"";if(!["list","create"].includes(args.action)&&!id)throw new Error("account_id is required");
    if(["delete","authenticate","login","stats","sync_connections"].includes(args.action)&&!args.confirm)throw new Error("confirm=true is required for this account operation");
    if(args.action==="list")return api("/api/accounts");if(args.action==="get")return api(`/api/accounts/${id}`);if(args.action==="create")return api("/api/accounts",{method:"POST",body:args.body});if(args.action==="update")return api(`/api/accounts/${id}`,{method:"PUT",body:args.body});if(args.action==="delete")return api(`/api/accounts/${id}`,{method:"DELETE"});if(args.action==="authenticate")return api(`/api/accounts/${id}/authenticate`,{method:"POST",body:args.body});if(args.action==="login")return api(`/api/accounts/${id}/login`,{method:"POST",body:args.body});if(args.action==="stats")return api(`/api/accounts/${id}/li-stats`,{method:"POST"});return api(`/api/accounts/${id}/sync-accepted`,{method:"POST"});
  }));

  server.registerTool("email_account_manage", {
    title:"Email sender accounts",description:"Fully manage SMTP/IMAP senders: list/get/create/update/delete, verify connectivity, and send a test message.",
    inputSchema:{action:z.enum(["list","get","create","update","delete","test_connection","send_test"]),email_account_id:z.string().optional(),body:z.record(z.string(),z.unknown()).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("email_account_manage",["list","get"].includes(args.action)?"mcp:read":["test_connection","send_test"].includes(args.action)?"mcp:execute":"mcp:write",args,async()=>{
    const id=args.email_account_id?enc(args.email_account_id):"";if(!["list","create"].includes(args.action)&&!id)throw new Error("email_account_id is required");if(["delete","test_connection","send_test"].includes(args.action)&&!args.confirm)throw new Error("confirm=true is required for this email account operation");
    if(args.action==="list")return api("/api/email-accounts");if(args.action==="get")return api(`/api/email-accounts/${id}`);if(args.action==="create")return api("/api/email-accounts",{method:"POST",body:args.body});if(args.action==="update")return api(`/api/email-accounts/${id}`,{method:"PUT",body:args.body});if(args.action==="delete")return api(`/api/email-accounts/${id}`,{method:"DELETE"});return api(`/api/email-accounts/${id}/${args.action==="test_connection"?"test":"send-test"}`,{method:"POST",body:args.body});
  }));

  server.registerTool("gmail_app_password_connect", {
    title: "Connect Gmail with an app password",
    description: "Verify Gmail SMTP and IMAP, then connect a workspace email sender using a Google 16-character app password. The password is encrypted at rest and never returned.",
    inputSchema: {
      email: z.string().email(),
      app_password: z.string().min(16),
      from_name: z.string().max(120).optional(),
      name: z.string().max(120).optional(),
      daily_email_limit: z.number().int().min(1).max(500).default(50),
      timezone: z.string().min(1).max(100).default("UTC"),
      confirm: z.literal(true),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ confirm: _confirm, ...body }) => {
    void _confirm;
    return run("gmail_app_password_connect", "mcp:execute", body, () =>
      api("/api/email-accounts/gmail-app-password", { method: "POST", body }));
  });

  server.registerTool("list_advanced_manage", {
    title:"Advanced list operations",description:"Update/delete lists, inspect targets/conflicts/import state, analyze data, or move members between lists.",
    inputSchema:{action:z.enum(["update","delete","targets","analyze","conflicts","move_targets","import_status","sync_status"]),list_id:z.string(),body:z.record(z.string(),z.unknown()).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:false},
  },args=>run("list_advanced_manage",["targets","conflicts","import_status","sync_status"].includes(args.action)?"mcp:read":args.action==="analyze"?"mcp:execute":"mcp:write",args,async()=>{const base=`/api/lists/${enc(args.list_id)}`;if(args.action==="delete"&&!args.confirm)throw new Error("confirm=true is required to delete a list");if(args.action==="update")return api(base,{method:"PUT",body:args.body});if(args.action==="delete")return api(base,{method:"DELETE"});if(args.action==="targets")return api(`${base}/targets`);if(args.action==="conflicts")return api(`${base}/conflicts`);if(args.action==="import_status")return api(`${base}/import-status`);if(args.action==="sync_status")return api(`${base}/sync-status`);return api(`${base}/${args.action==="move_targets"?"move-targets":"analyze"}`,{method:"POST",body:args.body});}));

  server.registerTool("workflow_advanced_manage", {
    title:"Advanced workflow operations",description:"Duplicate workflows, inspect statistics/enrollments/prospects, and update or delete any workflow step.",
    inputSchema:{action:z.enum(["duplicate","stats","enrollments","prospects","update_step","delete_step"]),workflow_id:z.string(),step_id:z.string().optional(),query:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).optional(),body:z.record(z.string(),z.unknown()).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:false},
  },args=>run("workflow_advanced_manage",["stats","enrollments","prospects"].includes(args.action)?"mcp:read":"mcp:write",args,async()=>{const base=`/api/workflows/${enc(args.workflow_id)}`;if(args.action==="duplicate")return api(`${base}/duplicate`,{method:"POST",body:args.body});if(args.action==="stats")return api(`${base}/stats`);if(args.action==="enrollments")return api(`${base}/enrollments`,{query:args.query});if(args.action==="prospects")return api(`${base}/prospects`,{query:args.query});if(!args.step_id)throw new Error("step_id is required");if(args.action==="delete_step"&&!args.confirm)throw new Error("confirm=true is required to delete a step");return api(`${base}/steps/${enc(args.step_id)}`,{method:args.action==="update_step"?"PUT":"DELETE",body:args.action==="update_step"?args.body:undefined});}));

  server.registerTool("reply_intelligence_manage", {
    title:"Reply intelligence operations",description:"Fetch new email replies from the mailbox now (sync), read a contact email thread, reclassify one reply, bulk-classify pending replies, or cancel a scheduled follow-up.",
    inputSchema:{action:z.enum(["sync","thread","reclassify","reclassify_all","cancel_followup"]),reply_id:z.string().optional(),contact_id:z.string().optional(),email_account_id:z.string().optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("reply_intelligence_manage",args.action==="thread"?"mcp:read":"mcp:execute",args,async()=>{if(args.action!=="thread"&&!args.confirm)throw new Error("confirm=true is required to alter reply processing");if(args.action==="sync")return api("/api/inbox/sync",{method:"POST"});if(args.action==="thread")return api("/api/inbox/thread",{query:{targetId:args.contact_id,emailAccountId:args.email_account_id}});if(args.action==="reclassify_all")return api("/api/inbox/reclassify-all",{method:"POST"});if(!args.reply_id)throw new Error("reply_id is required");return api(`/api/inbox/${enc(args.reply_id)}/${args.action==="reclassify"?"reclassify":"cancel-followup"}`,{method:"POST"});}));

  server.registerTool("import_jobs_manage", {
    title:"Import jobs",description:"List or cancel scheduled and active lead import jobs.",inputSchema:{action:z.enum(["list","cancel"]),import_id:z.string().optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:false},
  },args=>run("import_jobs_manage",args.action==="list"?"mcp:read":"mcp:write",args,async()=>{if(args.action==="list")return api("/api/imports");if(!args.import_id||!args.confirm)throw new Error("import_id and confirm=true are required");return api(`/api/imports/${enc(args.import_id)}/cancel`,{method:"POST"});}));

  server.registerTool("application_settings_manage", {
    title:"Application settings",description:"Read/update import limits and read/mark onboarding tour state.",inputSchema:{action:z.enum(["get_import_cap","set_import_cap","get_tours","mark_tour_seen"]),cap:z.number().int().positive().optional(),page:z.string().optional()},annotations:{openWorldHint:false},
  },args=>run("application_settings_manage",["get_import_cap","get_tours"].includes(args.action)?"mcp:read":"mcp:write",args,()=>args.action==="get_import_cap"?api("/api/settings/import-cap"):args.action==="set_import_cap"?api("/api/settings/import-cap",{method:"PUT",body:{cap:args.cap}}):args.action==="get_tours"?api("/api/tour"):api("/api/tour",{method:"POST",body:{page:args.page}})));

  server.registerTool("mcp_capability_audit", {
    title:"MCP capability audit",description:"Return the complete MCP-native domain and REST route-family coverage map, plus intentionally excluded security/bootstrap surfaces.",annotations:{readOnlyHint:true,openWorldHint:false},
  },()=>run("mcp_capability_audit","mcp:read",{},async()=>({coverage:"all authenticated workspace platform operations",features:MCP_FEATURES,domains:MCP_DOMAINS,route_families:MCP_ROUTE_FAMILIES,intentionally_excluded:MCP_EXCLUSIONS,escape_hatch:"linki_api_request",tenant_bound_workspace:String(input.auth.extra?.workspaceId),role:String(input.auth.extra?.workspaceRole)})));

  server.registerTool("suppression_manage", {
    title: "Global suppression and DNC", description: "List, add, check or remove email, domain, LinkedIn and phone suppressions.",
    inputSchema: { action: z.enum(["list","add","check","remove"]), kind: z.enum(["email","domain","linkedin","phone"]).optional(), value: z.string().optional(), reason: z.string().optional(), target_id: z.string().optional(), suppression_id: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("suppression_manage", ["list","check"].includes(args.action) ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/suppressions");
    if (args.action === "check") return api("/api/platform/suppressions", { method: "PUT", body: { target_id: args.target_id, kind: args.kind, value: args.value } });
    if (args.action === "add") return api("/api/platform/suppressions", { method: "POST", body: { kind: args.kind, value: args.value, reason: args.reason ?? "manual" } });
    if (!args.confirm) throw new Error("confirm=true is required to remove a suppression");
    return api("/api/platform/suppressions", { method: "DELETE", query: { id: args.suppression_id } });
  }));

  server.registerTool("workflow_branch_manage", {
    title: "Conditional workflow branches", description: "Read, create/update, or remove forward-only workflow branches driven by reply, connection, email, intent, signal, target, or custom-field conditions.",
    inputSchema: { action: z.enum(["list","upsert","remove"]), workflow_id: z.string().optional(), branch_id: z.string().optional(), source_step_id: z.string().optional(), conditions: z.record(z.string(), z.unknown()).optional(), true_step_id: z.string().optional(), false_step_id: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("workflow_branch_manage", args.action === "list" ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/workflow-branches", { query: { workflow_id: args.workflow_id } });
    if (args.action === "upsert") return api("/api/platform/workflow-branches", { method: "POST", body: args });
    if (!args.confirm) throw new Error("confirm=true is required to remove a branch");
    return api("/api/platform/workflow-branches", { method: "DELETE", query: { id: args.branch_id } });
  }));

  server.registerTool("deliverability_center", {
    title: "Deliverability center", description: "Read sender health, check SPF/DKIM/DMARC/MX, configure warmup, send placement tests, and record placement.",
    inputSchema: { action: z.enum(["get","check_domain","configure_warmup","placement_test","mark_placement"]), domain: z.string().optional(), selector: z.string().optional(), email_account_id: z.string().optional(), enabled: z.boolean().optional(), daily_target: z.number().int().min(1).max(50).optional(), reply_rate: z.number().int().min(0).max(100).optional(), seed_email: z.string().email().optional(), test_id: z.string().optional(), placement: z.enum(["inbox","promotions","spam","missing"]).optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("deliverability_center", args.action === "get" || args.action === "check_domain" ? "mcp:read" : "mcp:execute", args, async () => {
    if (args.action === "get") return api("/api/platform/deliverability");
    if (args.action === "placement_test" && !args.confirm) throw new Error("confirm=true is required to send a placement test");
    const { test_id, ...body } = args;
    return api("/api/platform/deliverability", { method: "POST", body: { ...body, id: test_id } });
  }));

  server.registerTool("signals_manage", {
    title: "Prospecting signals and rules", description: "List/ingest buyer signals or list/create signal-triggered campaign rules.",
    inputSchema: { action: z.enum(["list","ingest","list_rules","create_rule"]), type: z.enum(["job_change","funding","hiring","technology","product_intent","custom"]).optional(), title: z.string().optional(), description: z.string().optional(), score: z.number().optional(), source: z.string().optional(), target_id: z.string().optional(), company_id: z.string().optional(), name: z.string().optional(), min_score: z.number().optional(), list_id: z.string().optional(), workflow_id: z.string().optional(), account_id: z.string().optional(), auto_start: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("signals_manage", ["list","list_rules"].includes(args.action) ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/signals");
    if (args.action === "list_rules") return api("/api/platform/signal-rules");
    if (args.action === "ingest") return api("/api/platform/signals", { method: "POST", body: args });
    return api("/api/platform/signal-rules", { method: "POST", body: { ...args, signal_type: args.type } });
  }));

  server.registerTool("pipeline_manage", {
    title: "Pipeline, meetings and revenue", description: "Read pipeline/revenue/meeting attribution, create opportunities or stages, and update opportunity ownership/stage/value.",
    inputSchema: { action: z.enum(["get","create_opportunity","create_stage","update_opportunity"]), id: z.string().optional(), name: z.string().optional(), target_id: z.string().optional(), company_id: z.string().optional(), stage_id: z.string().optional(), owner_id: z.string().optional(), amount: z.number().optional(), currency: z.string().optional(), expected_close_date: z.string().optional(), source: z.string().optional(), position: z.number().int().optional(), probability: z.number().int().min(0).max(100).optional(), is_won: z.boolean().optional(), is_lost: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("pipeline_manage", args.action === "get" ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action === "get") return api("/api/platform/pipeline");
    if (args.action === "update_opportunity") return api("/api/platform/pipeline", { method: "PATCH", body: args });
    return api("/api/platform/pipeline", { method: "POST", body: { ...args, entity: args.action === "create_stage" ? "stage" : "opportunity" } });
  }));

  server.registerTool("external_connection_manage", {
    title: "CRM and calendar synchronization", description: "List, create, update, sync, or remove HubSpot, Salesforce, Google Calendar, Microsoft Calendar, and iCal connections.",
    inputSchema: { action: z.enum(["list","create","update","sync","remove"]), id: z.string().optional(), provider: z.enum(["hubspot","salesforce","google_calendar","microsoft_calendar","ical"]).optional(), name: z.string().optional(), config: z.record(z.string(), z.unknown()).optional(), secret: z.string().optional(), enabled: z.boolean().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("external_connection_manage", args.action === "list" ? "mcp:read" : args.action === "sync" ? "mcp:execute" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/connections");
    if (args.action === "create") return api("/api/platform/connections", { method: "POST", body: args });
    if (args.action === "update") return api("/api/platform/connections", { method: "PATCH", body: args });
    if (args.action === "sync") { if(!args.confirm) throw new Error("confirm=true is required to run an external sync"); return api("/api/platform/connections", { method: "PUT", body: { id: args.id } }); }
    if (!args.confirm) throw new Error("confirm=true is required to remove a connection");
    return api("/api/platform/connections", { method: "DELETE", query: { id: args.id } });
  }));

  server.registerTool("team_inbox_manage", {
    title: "Collaborative team inbox", description: "Read team inbox metadata or assign, tag, lock, set SLA/status, and create shared tags or saved replies.",
    inputSchema: { action: z.enum(["get","create_tag","create_saved_reply","lock","unlock","assign","status","set_sla","tag","untag"]), reply_id: z.string().optional(), reply_ids: z.array(z.string()).optional(), name: z.string().optional(), body: z.string().optional(), color: z.string().optional(), assigned_to: z.string().nullable().optional(), status: z.enum(["open","pending","resolved","closed"]).optional(), sla_due_at: z.string().nullable().optional(), tag_id: z.string().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("team_inbox_manage", args.action === "get" ? "mcp:read" : "mcp:write", args, () => args.action === "get" ? api("/api/platform/inbox") : api("/api/platform/inbox", { method: "POST", body: args })));

  server.registerTool("webhook_manage", {
    title: "Public webhooks", description: "List, create, update, test, or remove signed event webhook endpoints with durable delivery state.",
    inputSchema: { action: z.enum(["list","create","update","test","remove"]), id: z.string().optional(), url: z.string().url().optional(), event_types: z.union([z.string(),z.array(z.string())]).optional(), enabled: z.boolean().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("webhook_manage", args.action === "list" ? "mcp:read" : "mcp:write", args, async () => {
    if(args.action==="list") return api("/api/platform/webhooks");
    if(args.action==="create") return api("/api/platform/webhooks",{method:"POST",body:args});
    if(args.action==="update") return api("/api/platform/webhooks",{method:"PATCH",body:args});
    if(args.action==="test") return api("/api/platform/webhooks",{method:"PUT"});
    if(!args.confirm) throw new Error("confirm=true is required to remove a webhook");
    return api("/api/platform/webhooks",{method:"DELETE",query:{id:args.id}});
  }));

  server.registerTool("linki_api_request", {
    title: "Advanced Linki API request", description: "Controlled escape hatch for newly added Linki application endpoints not yet represented by a dedicated MCP tool. Authentication, OAuth, integration secrets and system-update routes are forbidden.",
    inputSchema: { method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().startsWith("/api/"), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.record(z.string(), z.unknown()).optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => {
    const execute = /\/(start|retry|import|enrich|reply|authenticate|login|profile-scrape|sync-accepted|li-stats|send-test|test|cancel|reclassify|analyze|preview)(\/|$)/.test(args.path);
    const scope: McpScope = execute ? "mcp:execute" : args.method === "GET" ? "mcp:read" : "mcp:write";
    return run("linki_api_request", scope, args, async () => {
      if (!/^\/api\/(accounts|activity-logs|agent\/preview|companies|dashboard|email-accounts|email-health|imports|inbox|integrations|lists|openrouter\/models|platform|premium-status|runs|settings\/import-cap|targets|templates|todos|tour|workflows)(\/|$|\?)/.test(args.path) || args.path.includes("..") || args.path.includes("://")) throw new Error("That API path is not exposed through MCP");
      if (args.method !== "GET" && !args.confirm) throw new Error("confirm=true is required for all mutations through the generic API tool; dedicated tools provide operation-specific confirmation rules");
      return api(args.path, { method: args.method, query: args.query, body: args.body });
    });
  });

  registerResources(server, api);
  registerPrompts(server);
  return server;
}

function registerResources(server: McpServer, api: (path: string, options?: ApiOptions) => Promise<unknown>) {
  server.registerResource("workspace-overview", "linki://workspace/overview", { title: "Linki workspace overview", description: "Live sales workspace metrics and campaign state", mimeType: "application/json" }, async (uri) => resource(uri, await api("/api/dashboard/stats")));
  server.registerResource("capability-manifest", "linki://workspace/capabilities", { title: "Linki MCP capability manifest", description: "Complete application and MCP capability coverage", mimeType: "application/json" }, async (uri) => resource(uri, { protocol: "MCP Streamable HTTP", primitives: ["tools", "resources", "prompts"], scopes: ["mcp:read", "mcp:write", "mcp:execute"], coverage:"all authenticated workspace platform operations",features:MCP_FEATURES,domains:MCP_DOMAINS,route_families:MCP_ROUTE_FAMILIES,intentionally_excluded:MCP_EXCLUSIONS }));
  server.registerResource("platform-overview", "linki://workspace/platform", { title: "Revenue platform overview", description: "Workspace, deliverability, pipeline, meetings, signals, webhooks and inbox collaboration state", mimeType: "application/json" }, async (uri) => resource(uri, {
    workspace: await api("/api/platform/workspace"), deliverability: await api("/api/platform/deliverability"), pipeline: await api("/api/platform/pipeline"), signals: await api("/api/platform/signals"), inbox: await api("/api/platform/inbox"), webhooks: await api("/api/platform/webhooks"),
  }));
  const collections: Array<[string,string,string,string]> = [
    ["workspace-invitations","linki://workspace/invitations","Workspace invitations","/api/platform/invitations"],
    ["domain-events","linki://workspace/events","Domain events","/api/platform/events"],
    ["deliverability","linki://workspace/deliverability","Deliverability center","/api/platform/deliverability"],
    ["pipeline","linki://workspace/pipeline","Pipeline and meetings","/api/platform/pipeline"],
    ["team-inbox","linki://workspace/inbox","Team inbox","/api/platform/inbox"],
    ["custom-fields","linki://workspace/custom-fields","Custom fields","/api/platform/custom-fields"],
    ["external-connections","linki://workspace/connections","External connections","/api/platform/connections"],
    ["ai-configuration","linki://workspace/ai-configuration","AI configuration","/api/platform/ai-config"],
  ];
  for(const [name,uriValue,title,path] of collections) server.registerResource(name,uriValue,{title,description:`Live ${title.toLowerCase()} for the authorized workspace`,mimeType:"application/json"},async uri=>resource(uri,await api(path)));
  const templates: Array<[string, string, string, string]> = [
    ["contact", "linki://contacts/{id}", "Contact", "/api/targets/"],
    ["list", "linki://lists/{id}", "Lead list", "/api/lists/"],
    ["workflow", "linki://workflows/{id}", "Workflow", "/api/workflows/"],
    ["run", "linki://runs/{id}", "Campaign run", "/api/runs/"],
  ];
  for (const [name, pattern, title, path] of templates) {
    server.registerResource(name, new ResourceTemplate(pattern, { list: undefined }), { title, description: `Live ${title.toLowerCase()} data`, mimeType: "application/json" }, async (uri, vars) => resource(uri, await api(`${path}${enc(String(vars.id))}`)));
  }
}

function registerPrompts(server: McpServer) {
  server.registerPrompt("campaign_plan", { title: "Plan a multichannel campaign", description: "Build a safe LinkedIn and email campaign plan before creating it.", argsSchema: { objective: z.string(), audience: z.string(), offer: z.string(), constraints: z.string().optional() } }, ({ objective, audience, offer, constraints }) => prompt(`Plan a Linki multichannel campaign. Objective: ${objective}. Audience: ${audience}. Offer: ${offer}. Constraints: ${constraints || "none"}. Inspect existing lists, templates, sender accounts and workflows first. Propose the sequence and wait for confirmation before creating or launching anything.`));
  server.registerPrompt("personalize_outreach", { title: "Personalize outreach", description: "Research one Linki contact and draft channel-appropriate outreach.", argsSchema: { contact_id: z.string(), channel: z.enum(["email", "linkedin", "inmail"]), goal: z.string() } }, ({ contact_id, channel, goal }) => prompt(`Read linki://contacts/${contact_id}, then draft a concise ${channel} message for this goal: ${goal}. Ground every personalization in stored contact/company facts and do not invent facts.`));
  server.registerPrompt("inbox_triage", { title: "Triage sales inbox", description: "Review replies and propose safe next actions." }, () => prompt("Read the Linki inbox. Group replies into positive, objection, not interested, out of office, unsubscribe, and unclear. Recommend actions, but do not send messages or launch automation without explicit confirmation."));
  server.registerPrompt("daily_sales_brief", { title: "Daily sales brief", description: "Summarize pipeline, campaign health, inbox and overdue tasks." }, () => prompt("Use the workspace overview, running campaigns, unified inbox, and open todos to produce a concise daily sales brief with urgent actions first."));
}

function success(data: unknown) {
  const normalized = data === undefined ? null : data;
  return { content: [{ type: "text" as const, text: JSON.stringify(normalized, null, 2) }], structuredContent: isObject(normalized) ? normalized : { result: normalized } };
}
function failure(message: string) { return { isError: true, content: [{ type: "text" as const, text: message }] }; }
function resource(uri: URL, data: unknown) { return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(data, null, 2) }] }; }
function prompt(text: string) { return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] }; }
function enc(value: string) { return encodeURIComponent(value); }
function isObject(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }

function audit(auth: AuthInfo, tool: string, args: unknown, successValue: boolean, error: string | null, durationMs: number) {
  try {
    getDb().prepare(`INSERT INTO mcp_audit_logs (id, workspace_id, user_id, client_id, tool_name, request_json, success, error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), String(auth.extra?.workspaceId ?? ""), String(auth.extra?.userId ?? "unknown"), auth.clientId, tool, truncateJson(args), successValue ? 1 : 0, error, durationMs);
  } catch (auditError) { console.warn("[mcp] Failed to record audit log", auditError); }
}
function truncateJson(value: unknown) { const text = JSON.stringify(value,(key,item)=>/(password|secret|token|cookie|api[_-]?key|li_at|authorization)/i.test(key)?"[REDACTED]":item); return text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text; }
