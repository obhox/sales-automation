import { randomUUID } from "crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { getDb } from "@/lib/db";
import type { McpScope } from "@/lib/mcp/auth";
import { CLIENT_IP_HEADER, SOURCE_HEADER, VIA_HEADER, getMemberships, getMembership, recordAudit, type WorkspaceRole } from "@/lib/workspace";

type JsonObject = Record<string, unknown>;
type ApiOptions = { method?: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown };

const MCP_DOMAINS = ["contacts","companies","lists","imports","templates","workflows","workflow-steps","outreach-previews","conditional-branches","runs","enrollments","LinkedIn-senders","email-senders","reply-intelligence","team-inbox","todos","activities","suppression","deliverability","signals","custom-fields","pipeline","meetings","CRM-sync","calendar-sync","integration-credentials","AI-configuration","domain-events","webhooks","API-keys","workspaces","invitations","members","RBAC","audit","settings","contact-tags","conversations"];
const MCP_ROUTE_FAMILIES = ["accounts","activity-logs","agent/preview","ai/*","companies","dashboard","email-accounts","email-accounts/gmail-app-password","email-health","imports","inbox","integrations","lists","openrouter/models","platform/*","premium-status","runs","settings/import-cap","targets","templates","todos","tour","workflows","workflows/preview","conversations","deliverability/*","csv-imports/*"];
const MCP_FEATURES = ["campaign overview with period comparison, funnel by channel and A/B confidence; prospect retry/unenrol/remove across runs; adding prospects to a running campaign; campaign settings; revocable report links","contact-specific manual and AI outreach previews","Gmail sender connection using an app password","plain or enhanced email delivery with open/click tracking controls","switching the active workspace within a connection","AI spend and token analytics, with the monthly budget and spend by step type and model","fallback model, tone and monthly budget for AI writing","granular run enrollment, removal and retry","live per-contact email thread and direct send","email step A/B testing (up to 4 variants, random per send) with per-variant sent/open/click analytics","AI spend and token analytics","per-contact email thread (read from stored messages) and direct send","conversations: one per contact, holding who has it, status, temperature, due time, tags, read state and drafts across email and LinkedIn","a requests-a-minute limit on a public API key","webhook endpoint names, success rate and health, pausing, and the dead-letter queue","changing one setting of a CRM or calendar connection without replacing the rest","company look-ups on Apollo with the cost first, suggested people, target accounts, clearing a bounce flag, signals marked as handled, and a CSV import of companies"];
const MCP_EXCLUSIONS = ["password authentication and signup","OAuth token issuance/revocation","the MCP endpoint itself","host software update","public invitation acceptance","the versioned public-API façade (its underlying workspace operations are exposed directly)","the diagnostic hello endpoint"];

export function createLinkiMcpServer(input: { origin: string; auth: AuthInfo; ip?: string; onTool?: (name: string, tool: { title?: string; description?: string; annotations?: { readOnlyHint?: boolean } }) => void }) {
  const server = new McpServer({
    name: "linki-sales-automation",
    version: "1.1.0",
    description: "MCP-native sales automation, CRM, campaigns, inbox and analytics",
  }, { capabilities: { logging: {} } });

  // lib/mcp/catalogue.ts lists the tools for the Developer page by being told of each as it is registered.
  if (input.onTool) {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (...args: unknown[]) => {
      input.onTool!(String(args[0]), (args[1] ?? {}) as { title?: string; description?: string; annotations?: { readOnlyHint?: boolean } });
      return register(...args);
    };
  }

  const clientLabel = String(input.auth.extra?.clientName || input.auth.clientId || "MCP client").slice(0, 80);

  const api = async (path: string, options: ApiOptions = {}) => {
    const url = new URL(path, input.origin);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (process.env.INTERNAL_API_SECRET) headers["x-internal-secret"] = process.env.INTERNAL_API_SECRET;
    if (input.auth.extra?.workspaceId) headers["x-workspace-id"] = String(input.auth.extra.workspaceId);
    if (input.auth.extra?.userId) headers["x-user-id"] = String(input.auth.extra.userId);
    if (input.auth.extra?.workspaceRole) headers["x-workspace-role"] = String(input.auth.extra.workspaceRole);
    // So the audit entries these calls make say they came through MCP, from which client and where.
    headers[SOURCE_HEADER] = "mcp";
    headers[VIA_HEADER] = clientLabel;
    if (input.ip && input.ip !== "unknown") headers[CLIENT_IP_HEADER] = input.ip;
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
      const mark = scope === "mcp:read" ? null : latestAuditRow();
      const data = await work();
      audit(input.auth, name, args, true, null, Date.now() - started);
      if (mark !== null) noteWrite(name, mark);
      return success(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown MCP tool error";
      audit(input.auth, name, args, false, message, Date.now() - started);
      return failure(message);
    }
  };

  // A tool that changes something leaves at least one entry in the workspace's audit log.
  // Most do so through the routes they call; for one that did not, the tool itself is noted.
  const latestAuditRow = () => (getDb().prepare("SELECT COALESCE(MAX(rowid), 0) AS id FROM audit_logs").get() as { id: number }).id;
  const noteWrite = (tool: string, since: number) => {
    try {
      const workspaceId = String(input.auth.extra?.workspaceId ?? "");
      if (!workspaceId) return;
      if (getDb().prepare("SELECT 1 FROM audit_logs WHERE rowid > ? AND workspace_id = ? AND source = 'mcp' LIMIT 1").get(since, workspaceId)) return;
      recordAudit(
        { workspaceId, userId: input.auth.extra?.userId ? String(input.auth.extra.userId) : null, role: String(input.auth.extra?.workspaceRole ?? "viewer") as WorkspaceRole, source: "mcp", via: clientLabel, ip: input.ip && input.ip !== "unknown" ? input.ip : null },
        "mcp.tool_used", "mcp_tool", tool,
      );
    } catch (error) { console.warn("[mcp] Failed to note a write in the audit log", error); }
  };

  server.registerTool("system_overview", {
    title: "Sales workspace overview", description: "Read the dashboard, what needs attention, campaign state, and current system capabilities. `overview` is the dashboard for the last 7, 30 or 90 days (optionally one campaign, one list or one member's campaigns): emails sent, LinkedIn actions, reply rate, positive replies and meetings booked beside the period before, activity by day, the funnel over the campaigns in flight, today's sends against the senders' allowances, and each campaign's rates. `alerts` is what is wrong or close to it right now (a mailbox that paused itself, a LinkedIn account signed out or near its weekly limit, stalled background work, an AI budget used up, failing DNS, prospects stuck on a failed step), each with where to deal with it. `dashboard` is the older all-time totals.",
    inputSchema: { range: z.enum(["7d", "30d", "90d"]).optional(), workflow_id: z.string().optional(), list_id: z.string().optional(), owner_id: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("system_overview", "mcp:read", args, async () => {
    const current = await api("/api/dashboard/overview", { query: args }) as { dashboard?: unknown; alerts?: unknown };
    return {
      overview: current.dashboard ?? null,
      alerts: current.alerts ?? [],
      dashboard: await api("/api/dashboard/stats"),
      capabilities: await api("/api/premium-status"),
    };
  }));

  server.registerTool("ai_usage_analytics", {
    title: "AI usage and cost", description: "Read daily AI spend (USD) and input/output token totals for the workspace over a window of days, plus this calendar month: spend against the monthly budget (and whether AI writing is paused because it is used up), and spend by what requests were for and by model.",
    inputSchema: { days: z.number().int().min(7).max(90).default(7) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("ai_usage_analytics", "mcp:read", args, async () => {
    const daily = await api("/api/dashboard/agent-stats", { query: args }) as JsonObject;
    const overview = await api("/api/ai/overview") as { usage?: unknown };
    return { ...daily, month: overview.usage ?? null };
  }));

  server.registerTool("contacts_search", {
    title: "Search contacts", description: "Search and page through CRM contacts, optionally limited to a list (list_id \"none\" for contacts in no list) and narrowed by email state, LinkedIn state, campaign, intent score, owner, tag, seniority, country, replies or enrichment.",
    inputSchema: {
      search: z.string().optional(), list_id: z.string().optional(), page: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(50),
      email: z.enum(["any", "none", "verified", "checked", "catchall", "unverified", "invalid", "unchecked"]).optional(),
      linkedin: z.enum(["connected", "invite_sent", "inmail_sent", "withdrawn", "not_connected"]).optional(),
      campaign: z.string().optional().describe("A campaign (workflow) id, or \"any\" / \"none\""), intent: z.number().min(0).max(100).optional().describe("Minimum intent score"),
      owner: z.string().optional().describe("A member's user id, or \"none\""), tag: z.string().optional().describe("A contact tag id, or \"none\""),
      seniority: z.string().optional(), country: z.string().optional(), replied: z.enum(["yes", "no"]).optional(), enriched: z.enum(["yes", "no"]).optional(),
    },
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
    title: "Create contact", description: "Create a CRM contact and optionally add it to a list. company_id links the contact to a company record (and names the contact's company after it when company is not given).",
    inputSchema: { full_name: z.string().min(1), linkedin_url: z.string().url(), title: z.string().optional(), company: z.string().optional(), location: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional(), list_id: z.string().optional(), company_id: z.string().optional() },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, (args) => run("contact_create", "mcp:write", args, () => api("/api/targets", { method: "POST", body: args })));

  server.registerTool("contact_update", {
    title: "Update contact", description: "Update editable CRM fields on a contact, including its owner (a workspace member's user id, or null for nobody) and its time zone.",
    inputSchema: { contact_id: z.string(), full_name: z.string().optional(), first_name: z.string().optional(), last_name: z.string().optional(), title: z.string().optional(), company: z.string().optional(), location: z.string().optional(), email: z.string().email().nullable().optional(), phone: z.string().nullable().optional(), headline: z.string().optional(), summary: z.string().optional(), notes: z.string().optional(), owner_id: z.string().nullable().optional(), time_zone: z.string().optional() },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ contact_id, ...body }) => run("contact_update", "mcp:write", { contact_id, ...body }, () => api(`/api/targets/${enc(contact_id)}`, { method: "PATCH", body })));

  server.registerTool("contact_timeline", {
    title: "Contact timeline", description: "Everything that has happened with one contact, newest first: campaign steps sent on either channel (with step number and campaign), email opens and clicks, invitations accepted, replies with their verdict, messages sent by hand, logged activities and notes with their author, meetings, and joining or leaving lists. Optionally one channel only. For the contact's campaigns step by step, lists, custom fields and tasks in one read, use linki_api_request on /api/targets/{id}?view=profile.",
    inputSchema: { contact_id: z.string(), channel: z.enum(["all", "email", "linkedin"]).default("all"), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ contact_id, ...query }) => run("contact_timeline", "mcp:read", { contact_id, ...query }, () => api(`/api/targets/${enc(contact_id)}`, { query: { view: "timeline", ...query } })));

  server.registerTool("contact_delete", {
    title: "Delete contact", description: "Permanently delete a contact and its automation history.",
    inputSchema: { contact_id: z.string(), confirm: z.literal(true) }, annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ contact_id, confirm }) => run("contact_delete", "mcp:write", { contact_id, confirm }, () => api(`/api/targets/${enc(contact_id)}`, { method: "DELETE" })));

  server.registerTool("companies_list", {
    title: "List companies",
    description: "List and search CRM companies. With no view: { companies, total } with each company's contact count (search by name; page is 0-based). view=table is the list the Companies screen shows: each company's intent (the higher of its own score and its contacts'), contact count, whether its email is bouncing and whether it is a target account; search names and domains with q, filter with filter (all, contacts, bouncing, campaign, target), sort with sort=key:direction (intent, name, contacts, employees, created); page is 1-based there. view=summary gives the figures across every company.",
    inputSchema: {
      search: z.string().optional(), page: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100),
      view: z.enum(["table", "summary"]).optional(), q: z.string().optional(), filter: z.enum(["all", "contacts", "bouncing", "campaign", "target"]).optional(), sort: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("companies_list", "mcp:read", args, () => api("/api/companies", { query: args.view === "table" ? { ...args, page: Math.max(1, args.page) } : args })));

  server.registerTool("company_manage", {
    title: "Manage company",
    description: "Get, create, update or delete a CRM company. action=detail reads what the company's page shows: enrichment (funding, people per department, technologies, keywords), its contacts with their intent, the campaigns they are in, the people Apollo suggested, its signals and what is behind a bounce flag. update changes only the fields given (send null to empty one); is_target marks or unmarks a target account. A domain is kept bare and lower case, and two companies cannot share one.",
    inputSchema: {
      action: z.enum(["get", "detail", "create", "update", "delete"]), company_id: z.string().optional(), name: z.string().optional(), domain: z.string().nullable().optional(), industry: z.string().nullable().optional(),
      location: z.string().nullable().optional(), website: z.string().nullable().optional(), linkedin_url: z.string().nullable().optional(), notes: z.string().nullable().optional(), is_target: z.boolean().optional(), confirm: z.boolean().optional(),
    },
    annotations: { openWorldHint: false },
  }, (args) => run("company_manage", args.action === "get" || args.action === "detail" ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action !== "create" && !args.company_id) throw new Error("company_id is required");
    if (args.action === "delete" && !args.confirm) throw new Error("confirm=true is required for deletion");
    const { action, company_id, confirm: _confirm, ...body } = args; void _confirm;
    if (action === "get") return api(`/api/companies/${enc(company_id!)}`);
    if (action === "detail") return api(`/api/companies/${enc(company_id!)}`, { query: { view: "detail" } });
    if (action === "create") return api("/api/companies", { method: "POST", body });
    return api(`/api/companies/${enc(company_id!)}`, { method: action === "update" ? "PUT" : "DELETE", body: action === "update" ? body : undefined });
  }));

  server.registerTool("company_enrich", {
    title: "Look companies up on Apollo",
    description: "Look companies up on Apollo by their domain: size, funding, people per department, technologies, keywords. EACH LOOK-UP SPENDS ONE APOLLO CREDIT. Without confirm=true this only reports the cost (how many can be looked up, how many have no domain, how many were looked up before) and asks Apollo nothing. Name the companies with company_ids, or leave it out with q/filter to price every company the list shows. With confirm=true it looks up the company_ids given, at most 10 in one call.",
    inputSchema: { company_ids: z.array(z.string()).max(2000).optional(), q: z.string().optional(), filter: z.enum(["all", "contacts", "bouncing", "campaign", "target"]).optional(), confirm: z.boolean().optional() },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ company_ids, q, filter, confirm }) => run("company_enrich", confirm ? "mcp:execute" : "mcp:read", { company_ids, q, filter, confirm }, () => {
    if (!confirm) return api("/api/companies/enrich", { method: "POST", body: { ids: company_ids, q, filter, dry_run: true } });
    if (!company_ids?.length) throw new Error("company_ids is required to look companies up: run without confirm first and pass the eligible_ids it returns, 10 at a time");
    return api("/api/companies/enrich", { method: "POST", body: { ids: company_ids } });
  }));

  server.registerTool("company_people", {
    title: "People Apollo suggests for a company",
    description: "People Apollo says work at a company and who are not contacts yet (read them with company_manage action=detail). action=find asks Apollo for senior people at the company's domain: a search, which returns names and titles, reveals no email address and by Apollo's documentation spends no credits. action=add turns suggestions into contacts: it LOOKS EACH PERSON UP, ONE APOLLO CREDIT EACH, at most 10 in one call. action=dismiss puts suggestions aside and asks Apollo nothing. find and add only report what they would do and cost unless confirm=true.",
    inputSchema: { action: z.enum(["find", "add", "dismiss"]), company_id: z.string(), suggestion_ids: z.array(z.string()).max(10).optional(), confirm: z.boolean().optional() },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ action, company_id, suggestion_ids, confirm }) => run("company_people", action === "dismiss" ? "mcp:write" : confirm ? "mcp:execute" : "mcp:read", { action, company_id, suggestion_ids, confirm }, () =>
    api(`/api/companies/${enc(company_id)}/suggestions`, { method: "POST", body: { action, ids: suggestion_ids, ...(action !== "dismiss" && !confirm ? { dry_run: true } : {}) } })));

  server.registerTool("company_bounces", {
    title: "A company's bounce flag",
    description: "When an address at a company hard-bounces, the company is flagged and every email step for its contacts is skipped; LinkedIn steps carry on. action=review lists the bounces behind the flag and the figures. action=reverify queues the company's addresses for a check (not the ones that bounced themselves) and leaves the flag set. action=clear clears the flag so email is sent again: colleagues marked invalid because of the bounce go back to unchecked, the address that bounced stays on the do-not-send list, and steps skipped meanwhile are not sent later. clear needs confirm=true.",
    inputSchema: { action: z.enum(["review", "reverify", "clear"]), company_id: z.string(), confirm: z.boolean().optional() },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ action, company_id, confirm }) => run("company_bounces", action === "review" ? "mcp:read" : "mcp:write", { action, company_id, confirm }, () => {
    if (action === "review") return api(`/api/companies/${enc(company_id)}/bounces`);
    if (action === "clear" && !confirm) throw new Error("confirm=true is required to clear a bounce flag: email to the company is sent again");
    return api(`/api/companies/${enc(company_id)}/bounces`, { method: "POST", body: { action } });
  }));

  server.registerTool("companies_import_csv", {
    title: "Import companies from CSV",
    description: "Import companies from CSV text, one company a row. A row needs a name (columns: name, domain, website, industry, location, linkedin_url, notes; common other spellings are recognised). A row whose domain, or whose name when it has no domain, matches a company already there fills that company's empty fields; nothing already there is overwritten.",
    inputSchema: { csv: z.string().min(1) }, annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ csv }) => run("companies_import_csv", "mcp:write", { csv_bytes: csv.length }, () => api("/api/companies/import", { method: "POST", body: { csv } })));

  server.registerTool("lists_list", {
    title: "List lead lists",
    description: "List lead lists and member counts. With no view, every list as a plain array. view=table reads a page of lists with each one's owner, source (sales_navigator, csv or manual), last sync, how many contacts are enriched and how many emails are valid, risky or invalid, its state and the campaign using it; filter with q, source, state (active, paused, importing, verifying, needs_enrichment, ready, empty, archived) and owner (a user id, or none), and sort with sort=key:direction (updated, name, contacts, created, enriched, verified). view=summary gives the figures across every list, each contact counted once. view=overlap with ids (comma-separated list ids) adds a selection of lists up and says how many contacts are in more than one of them.",
    inputSchema: {
      view: z.enum(["table", "summary", "overlap"]).optional(), q: z.string().optional(), source: z.string().optional(), state: z.string().optional(), owner: z.string().optional(),
      sort: z.string().optional(), page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional(), ids: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("lists_list", "mcp:read", args, () => api("/api/lists", { query: args })));

  server.registerTool("list_get", {
    title: "Get lead list",
    description: "Read a lead list and all of its contacts. view=detail leaves the contacts out and gives the list's figures instead: how many are connected, have replied or are in a campaign now, every campaign run that used the list, the LinkedIn accounts an import could run from, and today's count against the daily import cap. Read the contacts a page at a time with contacts_search and list_id.",
    inputSchema: { list_id: z.string(), view: z.enum(["detail"]).optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ list_id, view }) => run("list_get", "mcp:read", { list_id, view }, () => api(`/api/lists/${enc(list_id)}`, { query: { view } })));

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
    description: "Bulk-import contacts into a lead list from CSV text. Map each column to a standard field or to a NEW custom personalization variable ({{key}} merge tag) via `mapping`. Each row needs a linkedin_url or email. Omit `mapping` to use fixed-schema auto-detection. Three optional settings turn on the importer the import page uses: dry_run=true changes nothing and answers with what the import would do (rows that become a contact, change one, are duplicates and by which detail, or are left out and why); on_duplicate says what happens to a row that is already a contact (skip leaves the contact as it is and out of the list, update is the default, import makes a second contact unless the match is by LinkedIn profile); match says which details make a row the same person (email, default true; name_company, default false; a LinkedIn profile always does). Without them the import behaves as it always has.",
    inputSchema: {
      list_id: z.string(),
      csv: z.string().min(1),
      mapping: z.array(z.discriminatedUnion("kind", [
        z.object({ column: z.string(), kind: z.literal("ignore") }),
        z.object({ column: z.string(), kind: z.literal("standard"), field: z.string() }),
        z.object({ column: z.string(), kind: z.literal("custom"), key: z.string(), name: z.string(), fieldType: z.enum(["text", "number", "boolean"]) }),
      ])).optional(),
      filename: z.string().max(200).optional().describe("The file's name, kept on the list as where it was last filled from."),
      dry_run: z.boolean().optional().describe("true: import nothing and say what would happen."),
      on_duplicate: z.enum(["skip", "update", "import"]).optional(),
      match: z.object({ email: z.boolean().optional(), name_company: z.boolean().optional() }).optional(),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ list_id, csv, mapping, filename, dry_run, on_duplicate, match }) => run("list_import_csv", dry_run ? "mcp:read" : "mcp:write", { list_id, mapping, filename, dry_run, on_duplicate, match, csv_bytes: csv.length }, () =>
    api(`/api/lists/${enc(list_id)}/import-csv`, { method: "POST", body: { csv, mapping, filename, dry_run, on_duplicate, match } })));

  server.registerTool("list_verify_emails", {
    title: "Verify list emails",
    description: "Check whether each contact's email address in a list is a live, reachable mailbox (syntax, domain/MX, disposable-address check via an email verification API, falling back to a DNS+SMTP probe if that API is unreachable) before you email them. Definitively dead addresses are added to the do-not-send (suppression) list; unverifiable ones are left sendable. Optionally limit to specific contacts.",
    inputSchema: { list_id: z.string(), contact_ids: z.array(z.string()).optional(), unchecked_only: z.boolean().optional().describe("Queue only addresses with no result yet, leaving checked ones alone. The list's `verifiable` figure is how many that is.") },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ list_id, contact_ids, unchecked_only }) => run("list_verify_emails", "mcp:execute", { list_id, contact_ids, unchecked_only }, () =>
    api(`/api/lists/${enc(list_id)}/verify-emails`, { method: "POST", body: { target_ids: contact_ids, unchecked_only } })));

  server.registerTool("templates_list", {
    title: "List message templates", description: "List reusable outreach templates. Each says which channel it is written for (linkedin or email); an email template also has a subject. A category groups templates so a step can take a set as its pool. channel keeps one channel. with_figures=true answers { templates, categories } instead of the plain list, each template with figures (sent, contacts, replied, positive across every campaign, and how many steps and campaigns offer it now), or figures null for one never sent and in no step.",
    inputSchema: { channel: z.enum(["linkedin", "email"]).optional(), with_figures: z.boolean().optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("templates_list", "mcp:read", args, () => api("/api/templates", { query: { channel: args.channel, view: args.with_figures ? "library" : undefined } })));

  server.registerTool("template_manage", {
    title: "Manage message template", description: "Get, create, update or delete a message template. channel is linkedin (the default) or email; subject is an email template's subject line; category groups templates. On update, an empty subject or category clears it.",
    inputSchema: { action: z.enum(["get", "create", "update", "delete"]), template_id: z.string().optional(), name: z.string().optional(), body: z.string().optional(), channel: z.enum(["linkedin", "email"]).optional(), subject: z.string().optional(), category: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
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
    title: "Add workflow step", description: "Add a visit, connection, LinkedIn message, Sales Navigator InMail, delay, or email step to a workflow, including delivery and tracking settings. For email steps, email_subject/email_body is Variant A (control); pass email_variants (up to 3 more) to A/B test — the runner randomly picks one candidate per send and campaign analytics reports sent/open/click per variant. On a follow-up email step, email_in_thread=true sends it as a reply in the same conversation as the campaign's earlier emails to that contact (subject becomes \"Re: <first subject>\").",
    inputSchema: { workflow_id: z.string(), step_type: z.enum(["visit", "connect", "message", "sales_inmail", "delay", "email"]), track: z.enum(["linkedin", "email"]).optional(), template_id: z.string().optional(), template_ids: z.array(z.string()).optional(), delay_seconds: z.number().int().min(0).optional(), connect_note: z.string().optional(), message_body: z.string().optional(), email_subject: z.string().optional(), email_body: z.string().optional(), email_variants: z.array(z.object({ subject: z.string(), body: z.string() })).max(3).optional(), email_signature: z.string().nullable().optional(), email_delivery_mode: z.enum(["plain", "enhanced"]).optional(), email_track_opens: z.boolean().optional(), email_track_clicks: z.boolean().optional(), email_in_thread: z.boolean().optional(), ai_enabled: z.boolean().optional(), ai_model: z.string().optional(), ai_prompt: z.string().optional(), ai_max_words: z.number().int().positive().optional(), ai_language: z.string().optional() },
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
    title: "Create campaign run", description: "Enroll a list or selected contacts into a workflow using sender accounts. account_id (a LinkedIn account) is needed only when the workflow has LinkedIn steps; an email-only workflow needs email_account_ids instead. To run the LinkedIn steps from several accounts pass account_ids instead of account_id: each contact is given one account and stays with it, a company stays with one account, and linkedin_rotation says how the rest are shared out (round_robin, the default, or capacity: in proportion to each account's daily invitation limit). exclude leaves out customers (a won deal) and/or contacts with an open deal, by their own deals or their company's. A contact part-way through another campaign is skipped unless overlap is take_over, which enrols them here and holds their steps in the other campaign until they are done here. This prepares but does not launch the run.",
    inputSchema: { workflow_id: z.string(), list_id: z.string(), account_id: z.string().optional(), account_ids: z.array(z.string()).max(25).optional(), linkedin_rotation: z.enum(["round_robin", "capacity"]).optional(), email_account_ids: z.array(z.string()).optional(), contact_ids: z.array(z.string()).optional(), exclude: z.object({ customers: z.boolean().optional(), open_deals: z.boolean().optional() }).optional(), overlap: z.enum(["skip", "take_over"]).optional() }, annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ contact_ids, ...args }) => run("run_create", "mcp:write", { ...args, contact_ids }, () => api("/api/runs", { method: "POST", body: { ...args, target_ids: contact_ids } })));

  server.registerTool("run_control", {
    title: "Control campaign run", description: "Start, pause, resume, or delete a campaign run. Starting/resuming permits real external outreach. action=accounts reads the LinkedIn accounts the run uses and how many contacts each works; action=set_accounts with account_ids (and optionally linkedin_rotation) changes them: contacts whose LinkedIn steps have started stay with their account, the rest are shared out again.",
    inputSchema: { run_id: z.string(), action: z.enum(["start", "pause", "resume", "delete", "accounts", "set_accounts"]), account_ids: z.array(z.string()).max(25).optional(), linkedin_rotation: z.enum(["round_robin", "capacity"]).optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, ({ run_id, action, confirm, account_ids, linkedin_rotation }) => run("run_control", action === "accounts" ? "mcp:read" : action === "delete" || action === "set_accounts" ? "mcp:write" : "mcp:execute", { run_id, action, confirm, account_ids, linkedin_rotation }, async () => {
    if (action === "accounts") return api(`/api/runs/${enc(run_id)}/accounts`);
    if (action === "set_accounts") return api(`/api/runs/${enc(run_id)}/accounts`, { method: "PUT", body: { account_ids, linkedin_rotation } });
    if ((action === "start" || action === "resume" || action === "delete") && !confirm) throw new Error("confirm=true is required for this action");
    if (action === "start") return api(`/api/runs/${enc(run_id)}/start`, { method: "POST" });
    if (action === "pause" || action === "resume") return api(`/api/runs/${enc(run_id)}`, { method: "PATCH", body: { status: action === "pause" ? "paused" : "running" } });
    return api(`/api/runs/${enc(run_id)}`, { method: "DELETE" });
  }));

  server.registerTool("run_membership_manage", {
    title: "Manage run membership", description: "Add or remove individual contacts in an existing campaign run, or retry failed sends. enroll/remove/retry take contact_ids; unenroll takes one contact_id. Requires the manager role. retry re-activates failed steps and can cause real outreach, so it needs confirm=true.",
    inputSchema: { run_id: z.string(), action: z.enum(["enroll", "unenroll", "remove", "retry"]), contact_ids: z.array(z.string()).optional(), contact_id: z.string().optional(), confirm: z.boolean().optional() },
    annotations: { openWorldHint: true },
  }, (args) => run("run_membership_manage", args.action === "retry" ? "mcp:execute" : "mcp:write", args, async () => {
    const base = `/api/runs/${enc(args.run_id)}`;
    if (args.action === "unenroll") {
      if (!args.contact_id) throw new Error("contact_id is required for unenroll");
      return api(`${base}/unenroll`, { method: "POST", body: { target_id: args.contact_id } });
    }
    if (!args.contact_ids?.length) throw new Error("contact_ids is required for this action");
    if (args.action === "enroll") return api(`${base}/enroll`, { method: "POST", body: { target_ids: args.contact_ids } });
    if (args.action === "remove") return api(`${base}/remove`, { method: "POST", body: { target_ids: args.contact_ids } });
    if (!args.confirm) throw new Error("confirm=true is required to retry failed sends");
    return api(`${base}/retry`, { method: "POST", body: { target_ids: args.contact_ids } });
  }));

  server.registerTool("inbox_list", {
    title: "List inbox replies", description: "Read the unified reply inbox, one row per contact, with contact, channel, workflow and classifier context. Who has it, its status (open, snoozed, closed), sentiment (hot, warm, cold), due time and tags are the conversation's (conversation_id), so they no longer change when the contact writes again. Filters take the old words too (pending, resolved; positive, neutral, negative). For paging, counts and the full thread use conversation_manage.",
    inputSchema: { channel: z.enum(["email", "linkedin"]).optional(), status: z.string().optional(), sentiment: z.string().optional(), assigned_to: z.string().optional(), sla: z.enum(["overdue"]).optional(), tag_id: z.string().optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("inbox_list", "mcp:read", args, () => api("/api/inbox", { query: args })));

  server.registerTool("inbox_send_email", {
    title: "Send inbox email", description: "Send a manual email reply through a configured sender account.",
    inputSchema: { email_account_id: z.string(), to: z.string().email(), subject: z.string().min(1), body: z.string().min(1), confirm: z.literal(true) }, annotations: { destructiveHint: false, openWorldHint: true },
  }, (args) => run("inbox_send_email", "mcp:execute", args, () => {
    const { email_account_id, confirm: _confirm, ...body } = args; void _confirm;
    return api("/api/inbox/reply", { method: "POST", body: { emailAccountId: email_account_id, ...body } });
  }));

  server.registerTool("contact_email_thread", {
    title: "Contact email thread", description: "Read the email conversation with one contact (the replies captured from the mailbox and the emails Linki sent, from stored rows; no mailbox is opened), or send an email to that contact. The sending account is resolved automatically. Omit subject to send as a reply. Sending requires confirm=true.",
    inputSchema: { contact_id: z.string(), action: z.enum(["get_thread", "send"]), subject: z.string().optional(), body: z.string().optional(), email_account_id: z.string().optional(), confirm: z.boolean().optional() },
    annotations: { openWorldHint: true },
  }, (args) => run("contact_email_thread", args.action === "send" ? "mcp:execute" : "mcp:read", args, async () => {
    const base = `/api/targets/${enc(args.contact_id)}/emails`;
    if (args.action === "get_thread") return api(base, { query: { email_account_id: args.email_account_id } });
    if (!args.body?.trim()) throw new Error("body is required to send an email");
    if (!args.confirm) throw new Error("confirm=true is required to send an email");
    return api(base, { method: "POST", body: { subject: args.subject, body: args.body, email_account_id: args.email_account_id } });
  }));

  server.registerTool("contact_mark_replied", {
    title: "Mark contact as replied",
    description: "Record that a contact replied on LinkedIn or email and immediately stop all of their campaign automation. Use this when a LinkedIn reply is noticed manually or reported by an external tool, since automatic LinkedIn reply detection is a premium capability. Performs no LinkedIn or IMAP traffic.",
    inputSchema: { contact_id: z.string(), channel: z.enum(["linkedin", "email"]).default("linkedin"), replied_at: z.string().optional() },
    annotations: { openWorldHint: false },
  }, (args) => run("contact_mark_replied", "mcp:write", args, () =>
    api(`/api/targets/${enc(args.contact_id)}/mark-replied`, { method: "POST", body: { channel: args.channel, replied_at: args.replied_at } })));

  server.registerTool("todos_list", {
    title: "List CRM todos", description: "List open, completed, or all CRM tasks, optionally only those about one contact, company or opportunity, or assigned to one member. Each task has its day (due_date) and, when a time was given, its moment (due_at), a priority (high, medium, low), who it is assigned to, and automatic=1 when Linki made it by itself.",
    inputSchema: { status: z.enum(["open", "done"]).optional(), contact_id: z.string().optional(), company_id: z.string().optional(), opportunity_id: z.string().optional(), assigned_to: z.string().optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => run("todos_list", "mcp:read", args, () => {
    const { contact_id, ...query } = args;
    return api("/api/todos", { query: { ...query, target_id: contact_id } });
  }));

  server.registerTool("todo_manage", {
    title: "Manage CRM todo", description: "Create, update, complete, reopen or delete a CRM task. A task needs only a title; it can be about a contact (contact_id), a company (company_id), an opportunity (opportunity_id), any of them together, or none. due_date is the day (YYYY-MM-DD); due_at adds a time (an ISO date and time). priority is high, medium or low. assigned_to is a workspace member's id. On update, null clears a link, the assignee or the date.",
    inputSchema: { action: z.enum(["create", "update", "delete"]), todo_id: z.string().optional(), contact_id: z.string().nullable().optional(), company_id: z.string().nullable().optional(), opportunity_id: z.string().nullable().optional(), title: z.string().optional(), description: z.string().nullable().optional(), due_date: z.string().nullable().optional(), due_at: z.string().nullable().optional(), priority: z.enum(["high", "medium", "low"]).optional(), assigned_to: z.string().nullable().optional(), status: z.enum(["open", "done"]).optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("todo_manage", "mcp:write", args, async () => {
    if (args.action !== "create" && !args.todo_id) throw new Error("todo_id is required");
    if (args.action === "delete" && !args.confirm) throw new Error("confirm=true is required for deletion");
    const { action, todo_id, contact_id, confirm: _confirm, ...body } = args; void _confirm;
    if (action === "create") return api("/api/todos", { method: "POST", body: { target_id: contact_id, ...body } });
    // The contact is changed only when it is named; leaving it out leaves it as it is.
    return api(`/api/todos/${enc(todo_id!)}`, { method: action === "update" ? "PATCH" : "DELETE", body: action === "update" ? { ...body, ...(contact_id === undefined ? {} : { target_id: contact_id }) } : undefined });
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
    title: "Sync accepted connections", description: "Reconcile contacts against the sender account's real LinkedIn connections list: marks accepted invitations with LinkedIn's own date and, when the whole list was read, un-marks contacts wrongly recorded as connected.",
    inputSchema: { account_id: z.string(), confirm: z.literal(true) }, annotations: { destructiveHint: false, openWorldHint: true },
  }, ({ account_id }) => run("linkedin_sync_connections", "mcp:execute", { account_id }, () => api(`/api/accounts/${enc(account_id)}/sync-accepted`, { method: "POST" })));

  server.registerTool("workflow_analytics", {
    title: "Workflow analytics", description: "Read funnel, audience, reply, engagement, daily activity, and per-step email A/B version analytics for a workflow. With no period the funnel covers all time and `days` sets how far back the daily series goes. With `from` (and optionally `to`, both YYYY-MM-DD, at most 366 days) the funnel and rates follow the contacts FIRST contacted in the period, whenever they answered, and the daily series and breakdown count what was sent in it. `breakdown` adds the sends split by step, sender (mailbox), linkedin_account, template or variant, each row with sent, contacts, opened, clicked, accepted and replied; a reply is credited to the send it answers, else the last send before it. Each A/B step lists every version with its replies and whether it is paused, and `likely_winner` once one is ahead by more than chance. Open and click counts come in two forms: verified (security-gateway prefetches excluded) and raw pixel hits. Open rates are measured against tracked sends only, since a step with tracking off can never produce an open.",
    inputSchema: { workflow_id: z.string(), days: z.number().int().min(7).max(90).default(30), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), breakdown: z.enum(["step", "sender", "linkedin_account", "template", "variant"]).optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workflow_id, ...query }) => run("workflow_analytics", "mcp:read", { workflow_id, ...query }, () => api(`/api/workflows/${enc(workflow_id)}/analytics`, { query })));

  server.registerTool("workflow_ab_winner", {
    title: "End or reopen an email A/B test", description: "For an email step with A/B versions: action=choose keeps one version sending and pauses the rest (variant_id is the winning version's id from workflow_analytics, or null for the step's original wording, version A); action=reopen sends every version again. Paused versions keep their results. This changes what a running campaign sends from its next email, so choose needs confirm=true.",
    inputSchema: { workflow_id: z.string(), step_id: z.string(), action: z.enum(["choose", "reopen"]), variant_id: z.string().nullable().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("workflow_ab_winner", "mcp:write", args, async () => {
    if (args.action === "choose") {
      if (args.variant_id === undefined) throw new Error("variant_id is required to choose a winner (null for the step's original wording)");
      if (!args.confirm) throw new Error("confirm=true is required to choose a winner");
    }
    return api(`/api/workflows/${enc(args.workflow_id)}/steps/${enc(args.step_id)}/winner`, { method: "POST", body: args.action === "reopen" ? { clear: true } : { variant_id: args.variant_id } });
  }));

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
    title: "Workspace and permissions", description: "Read the workspace and members (action \"members\" adds each member's name, last activity, campaigns and whether they are suspended, plus pending invitations), add/update a member role, change a member's role by id, suspend or restore a member (a suspended member is refused everywhere in this workspace until restored; API keys they created keep working), rename the workspace, or remove a member.",
    inputSchema: { action: z.enum(["get", "members", "upsert_member", "set_role", "suspend_member", "restore_member", "rename", "remove_member"]), email: z.string().email().optional(), role: z.enum(["owner","admin","manager","member","viewer"]).optional(), name: z.string().optional(), user_id: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("workspace_admin", args.action === "get" || args.action === "members" ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action === "get") return api("/api/platform/workspace");
    if (args.action === "members") return api("/api/platform/members");
    if (args.action === "upsert_member") return api("/api/platform/workspace", { method: "POST", body: { email: args.email, role: args.role } });
    if (args.action === "set_role") return api("/api/platform/members", { method: "PATCH", body: { user_id: args.user_id, role: args.role } });
    if (args.action === "suspend_member") { if (!args.confirm) throw new Error("confirm=true is required to suspend a member"); return api("/api/platform/members", { method: "PATCH", body: { user_id: args.user_id, suspended: true } }); }
    if (args.action === "restore_member") return api("/api/platform/members", { method: "PATCH", body: { user_id: args.user_id, suspended: false } });
    if (args.action === "rename") return api("/api/platform/workspace", { method: "PATCH", body: { name: args.name } });
    if (!args.confirm) throw new Error("confirm=true is required to remove a member");
    return api("/api/platform/workspace", { method: "DELETE", query: { user_id: args.user_id } });
  }));

  server.registerTool("workspaces_list", {
    title: "List my workspaces",
    description: "List every workspace the authenticated user belongs to, with the member role and which one is currently active for this MCP connection. Call this before workspace_switch to find the target workspace id.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run("workspaces_list", "mcp:read", {}, async () => {
    const userId = String(input.auth.extra?.userId ?? "");
    const activeId = String(input.auth.extra?.workspaceId ?? "");
    const rows = getMemberships(userId) as Array<{ id: string; name: string; slug: string; role: string; suspended: number }>;
    return {
      active_workspace_id: activeId,
      workspaces: rows.map((w) => ({ id: w.id, name: w.name, slug: w.slug, role: w.role, active: w.id === activeId, suspended: Boolean(w.suspended) })),
    };
  }));

  server.registerTool("workspace_switch", {
    title: "Switch active workspace",
    description: "Change which workspace this MCP connection operates on. Accepts a workspace id or slug (see workspaces_list). The switch persists on the access token and applies to every subsequent tool call. You must already be a member of the target workspace.",
    inputSchema: { workspace_id: z.string().optional(), slug: z.string().optional() },
    annotations: { openWorldHint: false },
  }, (args) => run("workspace_switch", "mcp:write", args, async () => {
    const userId = String(input.auth.extra?.userId ?? "");
    const tokenId = String(input.auth.extra?.tokenId ?? "");
    if (!tokenId) throw new Error("This connection has no persistable token; re-authenticate to switch workspaces.");
    let targetId = args.workspace_id?.trim();
    if (!targetId && args.slug?.trim()) {
      const row = getDb().prepare("SELECT id FROM workspaces WHERE slug = ?").get(args.slug.trim()) as { id: string } | undefined;
      targetId = row?.id;
    }
    if (!targetId) throw new Error("Provide workspace_id or a valid slug. Call workspaces_list to see the options.");
    const membership = getMembership(userId, targetId, { includeSuspended: true });
    if (!membership) throw new Error("You are not a member of that workspace, so it cannot be selected.");
    if (membership.suspended) throw new Error("Your access to that workspace is suspended, so it cannot be selected.");
    getDb().prepare("UPDATE oauth_tokens SET workspace_id = ? WHERE id = ?").run(targetId, tokenId);
    return {
      switched: true,
      active_workspace: { id: membership.workspaceId, name: membership.workspaceName, role: membership.role },
      note: "This applies to every subsequent tool call on this connection.",
    };
  }));

  server.registerTool("workspace_invitation_manage", {
    title: "Workspace invitations", description: "List, create/email, renew or revoke single-use workspace invitations. An invitation's link is returned only when it is created or renewed; renewing (action \"renew\") makes a new link for an invitation still waiting, emails it when send_email is true, and stops the earlier link working.",
    inputSchema: { action: z.enum(["list","invite","renew","revoke"]), email: z.string().email().optional(), role: z.enum(["owner","admin","manager","member","viewer"]).optional(), invitation_id: z.string().optional(), send_email: z.boolean().default(true), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("workspace_invitation_manage", args.action === "list" ? "mcp:read" : (args.action === "invite" || args.action === "renew") && args.send_email ? "mcp:execute" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/invitations");
    if (args.action === "renew") { if(args.send_email && !args.confirm) throw new Error("confirm=true is required to send the invitation email"); return api("/api/platform/invitations",{method:"PUT",body:{id:args.invitation_id,send_email:args.send_email}}); }
    if (args.action === "invite") { if(args.send_email && !args.confirm) throw new Error("confirm=true is required to send the invitation email"); return api("/api/platform/invitations",{method:"POST",body:{email:args.email,role:args.role,send_email:args.send_email}}); }
    if(!args.confirm) throw new Error("confirm=true is required to revoke an invitation");
    return api("/api/platform/invitations",{method:"DELETE",query:{id:args.invitation_id}});
  }));

  server.registerTool("contact_tags_manage", {
    title: "Contact tags", description: "List the workspace's contact tags with how many contacts carry each, create or rename one, delete one (it comes off every contact), and add tags to or remove them from contacts. To tag by name in one step, use action \"assign\" with create.",
    inputSchema: { action:z.enum(["list","create","rename","delete","assign"]), tag_id:z.string().optional(), name:z.string().optional(), color:z.enum(["neutral","brand","good","warn","bad","li","mail"]).optional(), contact_ids:z.array(z.string()).max(5000).optional(), add:z.array(z.string()).optional(), remove:z.array(z.string()).optional(), create:z.string().optional().describe("With assign: a tag name to make if needed and add"), confirm:z.boolean().optional() }, annotations:{openWorldHint:false},
  }, args=>run("contact_tags_manage",args.action==="list"?"mcp:read":"mcp:write",args,()=>{
    if(args.action==="list")return api("/api/targets/tags");
    if(args.action==="create")return api("/api/targets/tags",{method:"POST",body:{name:args.name,color:args.color}});
    if(args.action==="rename"){if(!args.tag_id)throw new Error("tag_id is required");return api("/api/targets/tags",{method:"PATCH",body:{id:args.tag_id,name:args.name,color:args.color}});}
    if(args.action==="delete"){if(!args.tag_id)throw new Error("tag_id is required");if(!args.confirm)throw new Error("confirm=true is required to delete a tag");return api("/api/targets/tags",{method:"DELETE",query:{id:args.tag_id}});}
    return api("/api/targets/tags",{method:"PUT",body:{target_ids:args.contact_ids,add:args.add,remove:args.remove,create:args.create,color:args.color}});
  }));

  server.registerTool("custom_fields_manage", {
    title: "Custom CRM fields", description: "List/create/rename/delete workspace custom-field definitions (the {{key}} personalization variables), read one contact's custom values, and set a field value on a contact (a date is written YYYY-MM-DD; an empty value clears it). Deleting a field removes every contact's value for it.",
    inputSchema: { action:z.enum(["list","get_values","create","rename","delete","set_value"]), name:z.string().optional(), key:z.string().optional(), field_type:z.enum(["text","number","boolean","date"]).optional(), options:z.array(z.string()).optional(), contact_id:z.string().optional(), field_id:z.string().optional(), value:z.unknown().optional(), confirm:z.boolean().optional() }, annotations:{openWorldHint:false},
  }, args=>run("custom_fields_manage",args.action==="list"||args.action==="get_values"?"mcp:read":"mcp:write",args,()=>{
    if(args.action==="list")return api("/api/platform/custom-fields");
    if(args.action==="get_values"){if(!args.contact_id)throw new Error("contact_id is required");return api("/api/platform/custom-fields",{query:{target_id:args.contact_id}});}
    if(args.action==="create")return api("/api/platform/custom-fields",{method:"POST",body:args});
    if(args.action==="rename"){if(!args.field_id||!args.name)throw new Error("field_id and name are required");return api("/api/platform/custom-fields",{method:"PATCH",body:{id:args.field_id,name:args.name}});}
    if(args.action==="delete"){if(!args.field_id)throw new Error("field_id is required");if(!args.confirm)throw new Error("confirm=true is required to delete a field and its values");return api("/api/platform/custom-fields",{method:"DELETE",query:{id:args.field_id}});}
    return api("/api/platform/custom-fields",{method:"PUT",body:{target_id:args.contact_id,field_id:args.field_id,value:args.value}});
  }));

  server.registerTool("ai_configuration_manage", {
    title:"AI configuration",description:"Read or update the workspace's AI settings: default and fallback model, tone, prompts, approved outreach examples, and the monthly budget in US dollars (AI writing pauses for the rest of the calendar month once it is spent). An update changes only the fields it names; send null to clear one.",inputSchema:{action:z.enum(["get","update"]),default_model:z.string().nullable().optional(),fallback_model:z.string().nullable().optional(),tone:z.enum(["direct","warm","formal"]).nullable().optional(),system_prompt:z.string().nullable().optional(),user_prompt:z.string().nullable().optional(),email_examples:z.union([z.string(),z.array(z.object({title:z.string().optional(),body:z.string()}))]).nullable().optional(),linkedin_examples:z.union([z.string(),z.array(z.object({title:z.string().optional(),body:z.string()}))]).nullable().optional(),monthly_budget_usd:z.number().positive().nullable().optional()},annotations:{openWorldHint:true},
  },args=>run("ai_configuration_manage",args.action==="get"?"mcp:read":"mcp:write",args,()=>args.action==="get"?api("/api/platform/ai-config"):api("/api/platform/ai-config",{method:"PUT",body:args})));

  server.registerTool("integration_credentials_manage", {
    title:"Integration credentials",description:"List, configure, or remove encrypted provider API credentials used by enrichment and AI features.",inputSchema:{action:z.enum(["list","configure","remove"]),key:z.string().optional(),api_key:z.string().optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("integration_credentials_manage",args.action==="list"?"mcp:read":"mcp:write",args,async()=>{if(args.action==="list")return api("/api/integrations");if(args.action==="configure")return api("/api/integrations",{method:"POST",body:{key:args.key,api_key:args.api_key}});if(!args.confirm)throw new Error("confirm=true is required to remove credentials");return api("/api/integrations",{method:"DELETE",query:{key:args.key}});}));

  server.registerTool("api_keys_manage", {
    title:"Public API keys",description:"List, create, update, or revoke scoped public API keys. A new secret is returned once and redacted from MCP audit logs. rate_limit_per_minute caps how many requests a key may make each minute (1 to 10000); leave it out, or send null on update, for no limit. update (with key_id) changes a key's name or its rate limit; scopes cannot be changed.",inputSchema:{action:z.enum(["list","create","update","revoke"]),name:z.string().optional(),scopes:z.array(z.string()).optional(),expires_at:z.string().optional(),rate_limit_per_minute:z.number().int().min(1).max(10000).nullable().optional(),key_id:z.string().optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:false},
  },args=>run("api_keys_manage",args.action==="list"?"mcp:read":"mcp:write",args,async()=>{if(args.action==="list")return api("/api/platform/api-keys");if(args.action==="create")return api("/api/platform/api-keys",{method:"POST",body:{name:args.name,scopes:args.scopes,expires_at:args.expires_at,rate_limit_per_minute:args.rate_limit_per_minute}});if(args.action==="update"){if(!args.key_id)throw new Error("key_id is required");return api("/api/platform/api-keys",{method:"PATCH",body:{id:args.key_id,...(args.name!==undefined?{name:args.name}:{}),...(args.rate_limit_per_minute!==undefined?{rate_limit_per_minute:args.rate_limit_per_minute}:{})}});}if(!args.confirm)throw new Error("confirm=true is required to revoke an API key");return api("/api/platform/api-keys",{method:"DELETE",query:{id:args.key_id}});}));

  server.registerTool("audit_logs_search", {
    title:"Workspace audit log",description:"Read the workspace's audit log (source \"workspace\": every change, by whom, with where it came from; kept for 12 months) or the log of MCP tool calls (source \"mcp\"). The workspace log can be narrowed by origin (web, api or mcp), by text, by member, and by date.",inputSchema:{source:z.enum(["workspace","mcp"]).default("workspace"),origin:z.enum(["web","api","mcp"]).optional(),q:z.string().optional(),user_id:z.string().optional(),from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),limit:z.number().int().min(1).max(500).default(100)},annotations:{readOnlyHint:true,openWorldHint:false},
  },args=>run("audit_logs_search","mcp:read",args,async()=>args.source==="workspace"?api("/api/platform/audit",{query:{limit:args.limit,source:args.origin,q:args.q,user_id:args.user_id,from:args.from,to:args.to}}):getDb().prepare("SELECT id,client_id,tool_name,success,error,duration_ms,created_at FROM mcp_audit_logs WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?").all(String(input.auth.extra?.workspaceId),args.limit)));

  server.registerTool("domain_events_manage", {
    title:"Domain event stream",description:"Read or emit tenant events and optionally dispatch them to signed webhooks.",inputSchema:{action:z.enum(["list","emit"]),type:z.string().optional(),entity_type:z.string().optional(),entity_id:z.string().optional(),payload:z.record(z.string(),z.unknown()).optional(),limit:z.number().int().min(1).max(500).default(100),deliver:z.boolean().default(true),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("domain_events_manage",args.action==="list"?"mcp:read":args.deliver?"mcp:execute":"mcp:write",args,async()=>{if(args.action==="list")return api("/api/platform/events",{query:{type:args.type,limit:args.limit}});if(args.deliver&&!args.confirm)throw new Error("confirm=true is required to dispatch webhooks");return api("/api/platform/events",{method:"POST",body:args});}));

  server.registerTool("linkedin_account_manage", {
    title:"LinkedIn sender accounts",description:"Fully manage LinkedIn senders: list/get/create/update/delete, disconnect (sign out but keep the account), authenticate, complete login challenges, refresh statistics, and sync accepted connections. action=test runs ONE action through the real automation and reports what LinkedIn showed: body {action:'session'} checks the session is signed in; {action:'inspect', url|contact_id} reads a profile (connected / pending / connectable); {action:'visit', ...}; {action:'connect', url|contact_id, note?, confirm:true} and {action:'message', url|contact_id, text, confirm:true} REALLY send from the account; {action:'withdraw', url|contact_id, confirm:true} REALLY withdraws the pending invitation to that member (LinkedIn then blocks re-inviting them for about three weeks). {action:'inbox'} reports what a read of the account's LinkedIn inbox would find and stores nothing ({action:'inbox', apply:true} reads it now as the scheduled read does); {action:'thread', contact_id} reads one contact's conversation live. Both only read, never mark anything read, and report only conversations with contacts of this workspace. action=update with body {sync_inbox:true|false} switches the scheduled reading of replies on or off (on by default). action=update with body {withdraw_stale_invites:true|false} switches the account's clean-up of old unanswered invitations on or off (off by default); GET /api/accounts/{id}/stale-invitations via linki_api_request shows what is waiting. action=overview returns every account with today's usage against its limits, session state, warm-up, weekly limit and proxy, plus the workspace preset. action=pause (body {reason?}) stops everything an account does on LinkedIn while keeping it signed in and its contacts where they are; action=resume lets it carry on. action=update also takes weekly_connection_limit, daily_withdraw_limit, invite_max_wait_days (null clears each back to the default), ramp_start_date + ramp_days + ramp_start_limit (a warm-up), plan, owner_id, and proxy_url + proxy_username + proxy_password + proxy_label (a proxy you supply; an empty proxy_url removes it; the password is never returned; a proxy change applies at the account's next sign-in). action=preset reads the limits a new account starts with; with a body it changes them; with body {account_ids:[...]} it copies them onto those accounts.",
    inputSchema:{action:z.enum(["list","overview","get","create","update","delete","disconnect","pause","resume","preset","authenticate","login","stats","sync_connections","test"]),account_id:z.string().optional(),body:z.record(z.string(),z.unknown()).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("linkedin_account_manage",["list","overview","get"].includes(args.action)||(args.action==="preset"&&!args.body)?"mcp:read":["authenticate","login","stats","sync_connections","test"].includes(args.action)?"mcp:execute":"mcp:write",args,async()=>{
    const id=args.account_id?enc(args.account_id):"";if(!["list","overview","create","preset"].includes(args.action)&&!id)throw new Error("account_id is required");
    if(args.action==="overview")return api("/api/accounts",{query:{view:"overview"}});
    if(args.action==="pause")return api(`/api/accounts/${id}/pause`,{method:"POST",body:{paused:true,reason:args.body?.reason}});
    if(args.action==="resume")return api(`/api/accounts/${id}/pause`,{method:"POST",body:{paused:false}});
    if(args.action==="preset")return !args.body?api("/api/accounts/preset"):api("/api/accounts/preset",{method:Array.isArray(args.body.account_ids)?"POST":"PUT",body:args.body});
    if(["delete","disconnect","authenticate","login","stats","sync_connections","test"].includes(args.action)&&!args.confirm)throw new Error("confirm=true is required for this account operation");
    if(args.action==="list")return api("/api/accounts");if(args.action==="get")return api(`/api/accounts/${id}`);if(args.action==="create")return api("/api/accounts",{method:"POST",body:args.body});if(args.action==="update")return api(`/api/accounts/${id}`,{method:"PUT",body:args.body});if(args.action==="delete")return api(`/api/accounts/${id}`,{method:"DELETE"});if(args.action==="disconnect")return api(`/api/accounts/${id}/disconnect`,{method:"POST"});if(args.action==="authenticate")return api(`/api/accounts/${id}/authenticate`,{method:"POST",body:args.body});if(args.action==="login")return api(`/api/accounts/${id}/login`,{method:"POST",body:args.body});if(args.action==="stats")return api(`/api/accounts/${id}/li-stats`,{method:"POST"});if(args.action==="test")return api(`/api/accounts/${id}/test`,{method:"POST",body:args.body});return api(`/api/accounts/${id}/sync-accepted`,{method:"POST"});
  }));

  server.registerTool("email_account_manage", {
    title:"Email sender accounts",description:"Fully manage SMTP/IMAP senders (mailboxes). list/get/create/update/delete; pause or activate (a paused mailbox stays connected and sends nothing); test_connection (a refused sign-in marks the mailbox disconnected, which holds its sending until it signs in again); send_test (body.to; sent to one of the workspace's own mailboxes, where it landed can be read back), test_result (the latest test) and check_test (look for it now). overview is what the Mailboxes screen reads: mailboxes grouped by sending domain with status, today's sends against today's limit, ramp, warm-up, reputation and the domain's DNS. queue is a mailbox's sends today and what is due next (the times are estimates). settings / update_settings are the workspace's choices: body.rotation (round_robin or capacity), body.failover (move a guard-paused mailbox's not-yet-emailed contacts to the campaign's other mailboxes), body.shared_pool. update accepts, besides the connection and schedule fields: ramp_up_enabled, ramp_days and ramp_start_limit (null for the original ramp of two more emails a day), signature, signature_first_only, bounce_threshold, complaint_threshold, min_health_sample. create with body.verify=true tries the sign-in first and saves nothing if it is refused. Passwords are never returned.",
    inputSchema:{action:z.enum(["list","get","overview","queue","settings","test_result","create","update","update_settings","delete","pause","activate","test_connection","send_test","check_test"]),email_account_id:z.string().optional(),body:z.record(z.string(),z.unknown()).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("email_account_manage",["list","get","overview","queue","settings","test_result"].includes(args.action)?"mcp:read":["test_connection","send_test","check_test"].includes(args.action)?"mcp:execute":"mcp:write",args,async()=>{
    const id=args.email_account_id?enc(args.email_account_id):"";if(!["list","create","overview","settings","update_settings"].includes(args.action)&&!id)throw new Error("email_account_id is required");if(["delete","test_connection","send_test"].includes(args.action)&&!args.confirm)throw new Error("confirm=true is required for this email account operation");
    if(args.action==="overview")return api("/api/email-accounts",{query:{view:"overview"}});if(args.action==="queue")return api(`/api/email-accounts/${id}/queue`);
    if(args.action==="settings")return api("/api/email-accounts/settings");if(args.action==="update_settings")return api("/api/email-accounts/settings",{method:"PUT",body:args.body});
    if(args.action==="test_result")return api(`/api/email-accounts/${id}/send-test`);if(args.action==="check_test")return api(`/api/email-accounts/${id}/send-test`,{method:"PUT",body:args.body??{}});
    if(args.action==="list")return api("/api/email-accounts");if(args.action==="get")return api(`/api/email-accounts/${id}`);if(args.action==="create")return api("/api/email-accounts",{method:"POST",body:args.body});if(args.action==="update")return api(`/api/email-accounts/${id}`,{method:"PUT",body:args.body});if(args.action==="delete")return api(`/api/email-accounts/${id}`,{method:"DELETE"});if(args.action==="pause")return api(`/api/email-accounts/${id}`,{method:"PATCH",body:{paused:true}});if(args.action==="activate")return api(`/api/email-accounts/${id}`,{method:"PATCH",body:{paused:false}});return api(`/api/email-accounts/${id}/${args.action==="test_connection"?"test":"send-test"}`,{method:"POST",body:args.body});
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
    title:"Advanced list operations",description:"Update/delete lists, inspect targets/conflicts/import state, analyze data, or move members between lists. action=update takes body {name, description, owner_id (a workspace member's user id, or null for nobody), archived (true puts the list out of use and keeps its contacts and history; false brings it back)}; send only what changes.",
    inputSchema:{action:z.enum(["update","delete","targets","analyze","conflicts","move_targets","import_status","sync_status"]),list_id:z.string(),body:z.record(z.string(),z.unknown()).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:false},
  },args=>run("list_advanced_manage",["targets","analyze","conflicts","import_status","sync_status"].includes(args.action)?"mcp:read":"mcp:write",args,async()=>{const base=`/api/lists/${enc(args.list_id)}`;if(args.action==="delete"&&!args.confirm)throw new Error("confirm=true is required to delete a list");if(args.action==="update")return api(base,{method:"PUT",body:args.body});if(args.action==="delete")return api(base,{method:"DELETE"});if(args.action==="targets")return api(`${base}/targets`);if(args.action==="conflicts")return api(`${base}/conflicts`);if(args.action==="import_status")return api(`${base}/import-status`);if(args.action==="sync_status")return api(`${base}/sync-status`);if(args.action==="analyze")return api(`${base}/analyze`);return api(`${base}/move-targets`,{method:"POST",body:args.body});}));

  server.registerTool("workflow_advanced_manage", {
    title:"Advanced workflow operations",description:"Duplicate workflows (steps, A/B versions, gates and settings are all copied), inspect statistics/enrollments/prospects, and update or delete any workflow step. action=prospects takes query {page (from 1), limit (up to 100), sort: status|name|enrolled|next[:asc|desc], q, status: active|held|failed|replied|completed|skipped (comma-separated), step_id, run_id} and returns each prospect's standing and place on each track, with counts for the whole campaign; campaign_manage acts on them. action=sequence reads the published sequence with how many contacts stand on each step and each gate's two counts. action=sequence_settings with body {email_start: enrolment|handover, linkedin_track_enabled, email_track_enabled} changes when email starts or switches a track off (a switched-off track holds its contacts; it drops nobody). Drafts: draft_get, draft_save (body {steps, gates?, settings?}; nothing running changes), draft_discard, and publish (publishes the stored draft, or body {steps, gates?, settings?} directly; force:true publishes over a sequence that changed since the draft was started). Publishing keeps each step's id, so its statistics and gates stay with it and contacts part-way through stay on their own step; give a new step a `key` so a gate in the same request can point at it. update_step with body {step_order} moves a step; delete_step closes the gap; both keep contacts on their own steps. action=preview (body {target_id, steps?, email_account_id?, account_id?}) returns every step as that contact would receive it, with the day it falls on; nothing is sent. Publishing needs a manager once contacts are part-way through the sequence, a member before that. Setting a campaign up: action=setup_get reads its setup (list, exclusions, LinkedIn accounts and rotation, mailboxes, what to do with contacts in another campaign), its AI brief (angle, tone, triggers, model) and what there is to choose from; setup_save (body {name?, description?, prompt?, setup?, ai?}) changes any of it; prelaunch says whether it is ready (six checks, the audience, capacity and an AI cost estimate; query {overlaps:'1'} adds the contacts in another campaign); launch (confirm required, manager) enrols the audience and starts sending.",
    inputSchema:{action:z.enum(["duplicate","stats","enrollments","prospects","update_step","delete_step","sequence","sequence_settings","draft_get","draft_save","draft_discard","publish","preview","setup_get","setup_save","prelaunch","launch"]),workflow_id:z.string(),step_id:z.string().optional(),query:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).optional(),body:z.record(z.string(),z.unknown()).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:false},
  },args=>run("workflow_advanced_manage",["stats","enrollments","prospects","sequence","draft_get","preview","setup_get","prelaunch"].includes(args.action)?"mcp:read":"mcp:write",args,async()=>{const base=`/api/workflows/${enc(args.workflow_id)}`;if(args.action==="duplicate")return api(`${base}/duplicate`,{method:"POST",body:args.body});
    if(args.action==="sequence")return api(`${base}/sequence`);if(args.action==="sequence_settings")return api(`${base}/sequence`,{method:"PATCH",body:args.body});
    if(args.action==="preview")return api(`${base}/preview`,{method:"POST",body:args.body});if(args.action==="setup_get")return api(`${base}/setup`);if(args.action==="setup_save")return api(`${base}/setup`,{method:"PUT",body:args.body});if(args.action==="prelaunch")return api(`${base}/prelaunch`,{query:args.query});if(args.action==="launch"){if(!args.confirm)throw new Error("confirm=true is required to launch a campaign: it enrols the audience and permits real external outreach");return api(`${base}/launch`,{method:"POST",body:{}});}if(args.action==="draft_get")return api(`${base}/draft`);if(args.action==="draft_save")return api(`${base}/draft`,{method:"PUT",body:args.body});if(args.action==="draft_discard")return api(`${base}/draft`,{method:"DELETE"});
    if(args.action==="publish"){if(!args.confirm)throw new Error("confirm=true is required to publish a sequence: it changes what a running campaign does next");return api(`${base}/publish`,{method:"POST",body:args.body??{}});}if(args.action==="stats")return api(`${base}/stats`);if(args.action==="enrollments")return api(`${base}/enrollments`,{query:args.query});if(args.action==="prospects")return api(`${base}/prospects`,{query:args.query});if(!args.step_id)throw new Error("step_id is required");if(args.action==="delete_step"&&!args.confirm)throw new Error("confirm=true is required to delete a step");return api(`${base}/steps/${enc(args.step_id)}`,{method:args.action==="update_step"?"PUT":"DELETE",body:args.action==="update_step"?args.body:undefined});}));

  server.registerTool("campaign_manage", {
    title:"Campaign overview, prospects, settings and report links",description:"What a campaign's own pages do. action=overview (query {range: 7d|14d|30d|all, channel: both|linkedin|email}) returns five rates for the contacts enrolled in the period beside the same rate for the period before, sends and replies by day, the funnel for both channels and each with why contacts dropped out, every email's A/B versions with how sure the gap is and how many sends it still needs, and opens split into people and machines. action=log (query {limit, before, level: warn|error}) reads what the campaign has done, newest first. action=prospects_act with body {action: retry|unenroll|remove, ids: [enrolment ids from workflow_advanced_manage action=prospects]} retries failed steps, stops a prospect's remaining steps, or deletes the enrolment (remove needs confirm=true). action=prospects_add with body {list_id} or {target_ids} enrols more contacts in the run in flight with the campaign's own exclusions (needs confirm=true: they will be contacted). action=settings_get reads name, owner, time zone, senders, exclusions, per-email tracking and automatic A/B promotion; action=settings_save with body {name?, description?, owner_id?, send_in_recipient_tz?, ab_auto_promote?, setup?: {exclude?, account_ids?, rotation?, email_account_ids?}, tracking?: [{step_id, opens, clicks}]} changes them (changing how a campaign sends while contacts are part-way through needs a manager; new LinkedIn accounts reach the run in flight). Report links show the campaign's figures to someone with no account: share_list, share_create (returns the link's path once), share_revoke with query {share_id}.",
    inputSchema:{action:z.enum(["overview","log","prospects_act","prospects_add","settings_get","settings_save","share_list","share_create","share_revoke"]),workflow_id:z.string(),query:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).optional(),body:z.record(z.string(),z.unknown()).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:false},
  },args=>run("campaign_manage",["overview","log","settings_get","share_list"].includes(args.action)?"mcp:read":"mcp:write",args,async()=>{const base=`/api/workflows/${enc(args.workflow_id)}`;
    if(args.action==="overview")return api(`${base}/overview`,{query:args.query});if(args.action==="log")return api(`${base}/log`,{query:args.query});
    if(args.action==="settings_get")return api(`${base}/settings`);if(args.action==="settings_save")return api(`${base}/settings`,{method:"PUT",body:args.body??{}});
    if(args.action==="share_list")return api(`${base}/share`);if(args.action==="share_create")return api(`${base}/share`,{method:"POST"});if(args.action==="share_revoke")return api(`${base}/share`,{method:"DELETE",query:args.query});
    if(args.action==="prospects_add"){if(!args.confirm)throw new Error("confirm=true is required to add prospects: they are enrolled in a running campaign and will be contacted");return api(`${base}/prospects`,{method:"POST",body:{...(args.body??{}),action:"add"}});}
    if(args.body?.action==="remove"&&!args.confirm)throw new Error("confirm=true is required to remove prospects: the enrolment is deleted");return api(`${base}/prospects`,{method:"POST",body:args.body??{}});}));

  server.registerTool("linkedin_conversation", {
    title: "LinkedIn conversation with a contact", description: "Read a contact's LinkedIn conversation as stored (action=thread: both sides, including what a campaign sent, plus any reply still queued, failed or unconfirmed), ask for the account's inbox to be read now (refresh), or answer on LinkedIn (reply). A reply REALLY sends a LinkedIn message from the signed-in account to that contact, so it needs confirm=true; it is queued and sent within about a minute, and thread shows what became of it. A reply that ends `uncertain` may have been delivered: it is never retried automatically, and retry on it needs confirm=true after the conversation has been checked on LinkedIn. discard removes a reply that has not gone.",
    inputSchema: { action: z.enum(["thread", "refresh", "reply", "retry", "discard"]), contact_id: z.string().optional(), text: z.string().max(8000).optional(), account_id: z.string().optional(), reply_id: z.string().optional(), message_id: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("linkedin_conversation", args.action === "thread" ? "mcp:read" : args.action === "discard" ? "mcp:write" : "mcp:execute", args, async () => {
    if (args.action === "thread") return api("/api/inbox/linkedin-thread", { query: { target_id: args.contact_id } });
    if (args.action === "refresh") return api("/api/inbox/linkedin-thread", { method: "POST", body: { target_id: args.contact_id } });
    if (args.action === "discard") return api("/api/inbox/linkedin-reply", { method: "DELETE", query: { id: args.message_id } });
    if (args.action === "retry") return api("/api/inbox/linkedin-reply", { method: "POST", body: { retry_id: args.message_id, confirm: args.confirm } });
    if (!args.confirm) throw new Error("confirm=true is required: this sends a real LinkedIn message from the account");
    return api("/api/inbox/linkedin-reply", { method: "POST", body: { target_id: args.contact_id, text: args.text, account_id: args.account_id, reply_id: args.reply_id } });
  }));

  server.registerTool("reply_intelligence_manage", {
    title:"Reply intelligence operations",description:"Start an immediate mailbox fetch for new replies and bounces (sync — returns straight away; poll sync_status for the result), read a contact email thread (from stored messages; email_account_id is no longer needed), reclassify one reply (optionally with override_kind to force the label and lift a false-positive suppression), bulk-classify pending replies, or cancel a scheduled follow-up.",
    inputSchema:{action:z.enum(["sync","sync_status","thread","reclassify","reclassify_all","cancel_followup"]),reply_id:z.string().optional(),contact_id:z.string().optional(),email_account_id:z.string().optional(),override_kind:z.enum(["positive","negative","out_of_office","unsubscribe","human_review"]).optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:true},
  },args=>run("reply_intelligence_manage",["thread","sync_status"].includes(args.action)?"mcp:read":"mcp:execute",args,async()=>{if(!["thread","sync_status"].includes(args.action)&&!args.confirm)throw new Error("confirm=true is required to alter reply processing");
    // 'sync' starts the IMAP sweep and returns immediately — it is minutes of work on a busy
    // workspace and awaiting it here timed the call out at -32001, losing a result that had
    // in fact been produced. Poll 'sync_status' for the outcome.
    if(args.action==="sync")return api("/api/inbox/sync",{method:"POST"});
    if(args.action==="sync_status")return api("/api/inbox/sync");if(args.action==="thread")return api("/api/inbox/thread",{query:{targetId:args.contact_id,emailAccountId:args.email_account_id}});if(args.action==="reclassify_all")return api("/api/inbox/reclassify-all",{method:"POST"});if(!args.reply_id)throw new Error("reply_id is required");return api(`/api/inbox/${enc(args.reply_id)}/${args.action==="reclassify"?"reclassify":"cancel-followup"}`,{method:"POST",body:args.action==="reclassify"?{override_kind:args.override_kind}:undefined});}));

  server.registerTool("import_jobs_manage", {
    title:"Import jobs",description:"List or cancel scheduled and active lead import jobs.",inputSchema:{action:z.enum(["list","cancel"]),import_id:z.string().optional(),confirm:z.boolean().optional()},annotations:{openWorldHint:false},
  },args=>run("import_jobs_manage",args.action==="list"?"mcp:read":"mcp:write",args,async()=>{if(args.action==="list")return api("/api/imports");if(!args.import_id||!args.confirm)throw new Error("import_id and confirm=true are required");return api(`/api/imports/${enc(args.import_id)}/cancel`,{method:"POST"});}));

  server.registerTool("application_settings_manage", {
    title:"Application settings",description:"Read/update this workspace's daily import cap and its on/off settings (warmup_shared_pool: exchange warmup mail with other workspaces' inboxes), and read/mark the signed-in user's onboarding tour state.",inputSchema:{action:z.enum(["get_import_cap","set_import_cap","get_workspace_settings","set_workspace_settings","get_tours","mark_tour_seen"]),cap:z.number().int().positive().optional(),settings:z.record(z.string(),z.boolean()).optional(),page:z.string().optional()},annotations:{openWorldHint:false},
  },args=>run("application_settings_manage",["get_import_cap","get_workspace_settings","get_tours"].includes(args.action)?"mcp:read":"mcp:write",args,()=>args.action==="get_import_cap"?api("/api/settings/import-cap"):args.action==="set_import_cap"?api("/api/settings/import-cap",{method:"PUT",body:{cap:args.cap}}):args.action==="get_workspace_settings"?api("/api/platform/settings"):args.action==="set_workspace_settings"?api("/api/platform/settings",{method:"PUT",body:args.settings??{}}):args.action==="get_tours"?api("/api/tour"):api("/api/tour",{method:"POST",body:{page:args.page}})));

  server.registerTool("mcp_capability_audit", {
    title:"MCP capability audit",description:"Return the complete MCP-native domain and REST route-family coverage map, plus intentionally excluded security/bootstrap surfaces.",annotations:{readOnlyHint:true,openWorldHint:false},
  },()=>run("mcp_capability_audit","mcp:read",{},async()=>({coverage:"all authenticated workspace platform operations",features:MCP_FEATURES,domains:MCP_DOMAINS,route_families:MCP_ROUTE_FAMILIES,intentionally_excluded:MCP_EXCLUSIONS,escape_hatch:"linki_api_request",tenant_bound_workspace:String(input.auth.extra?.workspaceId),role:String(input.auth.extra?.workspaceRole)})));

  server.registerTool("suppression_manage", {
    title: "Global suppression and DNC", description: "List (optionally filtered by q and kind), add, bulk import, check or remove email, domain, LinkedIn and phone suppressions. import takes entries (a list, or text with one per line); without kind each entry's kind is worked out from what it looks like. Removing an entry that came from an unsubscribe, complaint or bounce needs a workspace admin.",
    inputSchema: { action: z.enum(["list","add","import","check","remove"]), kind: z.enum(["email","domain","linkedin","phone"]).optional(), value: z.string().optional(), q: z.string().optional(), entries: z.union([z.string(), z.array(z.string())]).optional(), reason: z.string().optional(), target_id: z.string().optional(), suppression_id: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("suppression_manage", ["list","check"].includes(args.action) ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/suppressions", { query: { q: args.q, kind: args.kind } });
    if (args.action === "import") return api("/api/platform/suppressions/import", { method: "POST", body: { entries: args.entries, kind: args.kind, reason: args.reason } });
    if (args.action === "check") return api("/api/platform/suppressions", { method: "PUT", body: { target_id: args.target_id, kind: args.kind, value: args.value } });
    if (args.action === "add") return api("/api/platform/suppressions", { method: "POST", body: { kind: args.kind, value: args.value, reason: args.reason ?? "manual" } });
    if (!args.confirm) throw new Error("confirm=true is required to remove a suppression");
    return api("/api/platform/suppressions", { method: "DELETE", query: { id: args.suppression_id } });
  }));

  server.registerTool("workflow_branch_manage", {
    title: "Conditional workflow branches", description: "Read, create/update, or remove the gates on a workflow's steps. The default kind, conditions, is the forward-only branch driven by reply, connection, email, intent, signal, target, or custom-field conditions, with true_step_id / false_step_id. Other kinds: connected (on a connect step: was the invitation accepted), no_reply (has the contact not replied when its step is done), verified_email (on an email step: is there an address that can be sent to). Each side can be given an outcome with on_true / on_false: {then: continue | jump | end_track | leave | handover_email, step?, effects?: [{type:'add_to_list', list_id} | {type:'create_task', title, due_in_days?}]}. handover_email stops the LinkedIn track and starts the contact's email track (for a workflow whose email_start is handover). A step has one gate; upsert on the same step replaces it. list returns each row with `gate`, its kind and both outcomes.",
    inputSchema: { action: z.enum(["list","upsert","remove"]), workflow_id: z.string().optional(), branch_id: z.string().optional(), source_step_id: z.string().optional(), kind: z.enum(["conditions","connected","no_reply","verified_email"]).optional(), conditions: z.record(z.string(), z.unknown()).optional(), true_step_id: z.string().optional(), false_step_id: z.string().optional(), on_true: z.record(z.string(), z.unknown()).optional(), on_false: z.record(z.string(), z.unknown()).optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("workflow_branch_manage", args.action === "list" ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/workflow-branches", { query: { workflow_id: args.workflow_id } });
    if (args.action === "upsert") return api("/api/platform/workflow-branches", { method: "POST", body: args });
    if (!args.confirm) throw new Error("confirm=true is required to remove a branch");
    return api("/api/platform/workflow-branches", { method: "DELETE", query: { id: args.branch_id } });
  }));

  server.registerTool("deliverability_center", {
    title: "Deliverability center", description: "Everything on the Deliverability screen. overview is the screen itself for one sending domain (domain, range of 7/30/90 days): the four figures, each mailbox's health, the guard log's last day, the DNS records with the domain's score and what would raise it, warm-up, do-not-contact counts, seeds and placement runs. events pages through the guard log (auto-pauses, sign-ins lost and regained, daily limits reached, DNS changes, warm-up days, complaints, placement tests; filter with domain and kind). check_domain looks a domain's SPF/DKIM/DMARC/MX up now; set_dkim_selector keeps a selector for the domain and checks it again (an empty selector forgets it). domain_warmup puts every mailbox on a domain into the warm-up pool or takes them out (enabled); configure_warmup sets one mailbox's own warm-up. seeds / add_seed / remove_seed manage the addresses a placement test goes to. run_placement sends one email from email_account_id to every seed (or seed_ids); copies sent to the workspace's own connected mailboxes are read back by Linki, check_placement looks for them now, and mark_placement enters by hand where any other copy landed (test_id, placement). placement_runs lists a domain's runs and placement_run reads one. report returns the CSV the screen exports. get and placement_test are the older single-address forms and still work.",
    inputSchema: {
      action: z.enum(["get","overview","events","report","seeds","placement_runs","placement_run","check_domain","set_dkim_selector","configure_warmup","domain_warmup","add_seed","remove_seed","placement_test","run_placement","check_placement","mark_placement"]),
      domain: z.string().optional(), range: z.enum(["7","30","90"]).optional(), selector: z.string().optional(), email_account_id: z.string().optional(), enabled: z.boolean().optional(),
      daily_target: z.number().int().min(1).max(50).optional(), reply_rate: z.number().int().min(0).max(100).optional(),
      kind: z.enum(["auto_pause","disconnected","reconnected","daily_limit","dns_change","warmup_cycle","complaint","placement_test"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(),
      seed_email: z.string().email().optional(), seed_id: z.string().optional(), seed_ids: z.array(z.string()).optional(), run_id: z.string().optional(), test_id: z.string().optional(),
      placement: z.enum(["inbox","primary","promotions","social","updates","forums","spam","other","missing"]).optional(), confirm: z.boolean().optional(),
    }, annotations: { openWorldHint: true },
  }, (args) => run("deliverability_center", ["get","overview","events","report","seeds","placement_runs","placement_run","check_domain"].includes(args.action) ? "mcp:read" : ["configure_warmup","placement_test","run_placement","check_placement","mark_placement"].includes(args.action) ? "mcp:execute" : "mcp:write", args, async () => {
    if (args.action === "get") return api("/api/platform/deliverability");
    if (args.action === "overview") return api("/api/deliverability", { query: { domain: args.domain, range: args.range } });
    if (args.action === "events") return api("/api/deliverability/events", { query: { domain: args.domain, kind: args.kind, limit: args.limit, offset: args.offset } });
    if (args.action === "report") return api("/api/deliverability/report", { query: { domain: args.domain, range: args.range } });
    if (args.action === "seeds") return api("/api/deliverability/seeds");
    if (args.action === "placement_runs") return api("/api/deliverability/placement", { query: { domain: args.domain, limit: args.limit } });
    if (args.action === "placement_run") { if (!args.run_id) throw new Error("run_id is required"); return api("/api/deliverability/placement", { query: { run_id: args.run_id } }); }
    if (args.action === "set_dkim_selector") { if (!args.domain) throw new Error("domain is required"); return api("/api/deliverability/dns", { method: "POST", body: { domain: args.domain, selector: args.selector ?? "" } }); }
    if (args.action === "domain_warmup") {
      if (!args.domain || args.enabled === undefined) throw new Error("domain and enabled are required");
      if (!args.enabled && !args.confirm) throw new Error("confirm=true is required to take a domain's mailboxes out of the warm-up pool");
      return api("/api/deliverability/warmup", { method: "POST", body: { domain: args.domain, enabled: args.enabled } });
    }
    if (args.action === "add_seed") return api("/api/deliverability/seeds", { method: "POST", body: { email: args.seed_email } });
    if (args.action === "remove_seed") { if (!args.seed_id) throw new Error("seed_id is required"); return api("/api/deliverability/seeds", { method: "DELETE", query: { id: args.seed_id } }); }
    if ((args.action === "placement_test" || args.action === "run_placement") && !args.confirm) throw new Error("confirm=true is required to send a placement test");
    if (args.action === "run_placement") return api("/api/deliverability/placement", { method: "POST", body: { email_account_id: args.email_account_id, seed_ids: args.seed_ids } });
    if (args.action === "check_placement") { if (!args.run_id) throw new Error("run_id is required"); return api("/api/deliverability/placement", { method: "PUT", body: { run_id: args.run_id } }); }
    if (args.action === "mark_placement") return api("/api/deliverability/placement", { method: "PATCH", body: { test_id: args.test_id, placement: args.placement } });
    const { test_id, ...body } = args;
    return api("/api/platform/deliverability", { method: "POST", body: { ...body, id: test_id } });
  }));

  server.registerTool("signals_manage", {
    title: "Prospecting signals, rules and detection", description: "List/ingest buyer signals, and list, create, update or delete the rules that add a contact to a list or enrol them in a campaign when a signal arrives. A rule that enrols needs a list, plus a LinkedIn account when the campaign has LinkedIn steps or a mailbox when it only sends email. update_rule changes only the fields given; pass null to clear a list, campaign or account. feed lists signals newest first with who each is about and how many nobody has seen (filters: type, source, state=new, q, limit, offset). mark_seen marks signals seen, which is the same as dealt with and is what the sidebar's count of new signals follows (ids, company_id for every signal of one company, or all=true); with seen=false it puts the named ones, or one company's, back among the new. A signal ingested with a company_id raises that company's intent by the same sum a contact's does; rules are written for a contact, so a company-only signal enrols nobody. Detection asks Apollo about watched accounts for funding, hiring and technology changes, and spends the workspace's Apollo credits: detection reads its settings, what a run would cost (estimate), the accounts watched and recent runs; detection_configure changes enabled, kinds, interval_days (1, 7, 14 or 30) and monthly_credit_cap, and refuses to enable without Apollo connected, a cap, and a watched account that has a website; watch and unwatch take company_ids (watch also takes list_id, for every company the contacts of a list work at); detection_run checks the accounts now, needs confirm=true, and can spend up to the estimate's credits_per_run.",
    inputSchema: { action: z.enum(["list","ingest","list_rules","create_rule","update_rule","delete_rule","feed","mark_seen","detection","detection_configure","watch","unwatch","detection_run"]), id: z.string().optional(), type: z.enum(["job_change","funding","hiring","technology","product_intent","custom"]).optional(), title: z.string().optional(), description: z.string().optional(), score: z.number().optional(), source: z.string().optional(), target_id: z.string().optional(), company_id: z.string().optional(), name: z.string().optional(), min_score: z.number().optional(), list_id: z.string().nullable().optional(), workflow_id: z.string().nullable().optional(), account_id: z.string().nullable().optional(), email_account_id: z.string().nullable().optional(), enabled: z.boolean().optional(), auto_start: z.boolean().optional(), state: z.enum(["new","all"]).optional(), q: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional(), ids: z.array(z.string()).max(500).optional(), all: z.boolean().optional(), seen: z.boolean().optional(), kinds: z.array(z.enum(["funding","hiring","technology"])).optional(), interval_days: z.number().int().optional(), monthly_credit_cap: z.number().int().min(0).optional(), company_ids: z.array(z.string()).optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("signals_manage", ["list","list_rules","feed","detection"].includes(args.action) ? "mcp:read" : args.action === "detection_run" ? "mcp:execute" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/signals");
    if (args.action === "feed") return api("/api/platform/signals", { query: { view: "feed", type: args.type, source: args.source, state: args.state, q: args.q, limit: args.limit, offset: args.offset } });
    if (args.action === "mark_seen") return api("/api/platform/signals", { method: "PATCH", body: { ids: args.ids, company_id: args.ids?.length ? undefined : args.company_id, all: args.all, seen: args.seen } });
    if (args.action === "list_rules") return api("/api/platform/signal-rules");
    if (args.action === "ingest") return api("/api/platform/signals", { method: "POST", body: { type: args.type, title: args.title, description: args.description, score: args.score, source: args.source, target_id: args.target_id, company_id: args.company_id } });
    if (args.action === "delete_rule") { if (!args.confirm) throw new Error("confirm=true is required to delete a signal rule"); return api("/api/platform/signal-rules", { method: "DELETE", query: { id: args.id } }); }
    if (args.action === "detection") return api("/api/platform/signal-detection");
    if (args.action === "detection_configure") return api("/api/platform/signal-detection", { method: "PUT", body: { enabled: args.enabled, kinds: args.kinds, interval_days: args.interval_days, monthly_credit_cap: args.monthly_credit_cap } });
    if (args.action === "watch" || args.action === "unwatch") return api("/api/platform/signal-detection", { method: "POST", body: { action: args.action, company_ids: args.company_ids, ...(args.action === "watch" && args.list_id ? { list_id: args.list_id } : {}) } });
    if (args.action === "detection_run") { if (!args.confirm) throw new Error("confirm=true is required: a run spends Apollo credits. Read action=detection first for what it would cost."); return api("/api/platform/signal-detection", { method: "POST", body: { action: "run" } }); }
    // A rule: only a rule's own fields are sent.
    const rule = { id: args.id, name: args.name, min_score: args.min_score, list_id: args.list_id, workflow_id: args.workflow_id, account_id: args.account_id, email_account_id: args.email_account_id, enabled: args.enabled, auto_start: args.auto_start, ...(args.type ? { signal_type: args.type } : {}) };
    return api("/api/platform/signal-rules", { method: args.action === "update_rule" ? "PATCH" : "POST", body: rule });
  }));

  server.registerTool("pipeline_manage", {
    title: "Pipeline, meetings and revenue", description: "Read pipeline/revenue/meeting attribution; create, update or delete opportunities; and create, update, reorder or delete stages. get also returns summary (weighted pipeline, won this quarter, average deal size, sales cycle, win rate) and settings; owner narrows the opportunities and the summary to one member's (an id, or none for those nobody owns). get_meetings lists meetings read from connected calendars (when: upcoming or past; match: matched, unmatched or all) with the calendars themselves; link_meeting says which contact (target_id) a meeting (id) is with. get_activity lists what has happened in the pipeline, newest first, with who did it (group: deals, tasks, meetings or notes). update_settings sets auto_opportunity_on_reply: whether a positive reply opens an opportunity for the contact. Moving an opportunity (update_opportunity with stage_id) stamps or clears its closed date and emits opportunity.stage_changed. delete_stage needs move_to when the stage still holds opportunities. reorder_stages takes stage_ids listing every stage once, in the order wanted.",
    inputSchema: { action: z.enum(["get","get_meetings","get_activity","link_meeting","update_settings","create_opportunity","update_opportunity","delete_opportunity","create_stage","update_stage","reorder_stages","delete_stage"]), id: z.string().optional(), owner: z.string().optional(), when: z.enum(["upcoming","past"]).optional(), match: z.enum(["matched","unmatched","all"]).optional(), group: z.enum(["deals","tasks","meetings","notes"]).optional(), page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(100).optional(), auto_opportunity_on_reply: z.boolean().optional(), name: z.string().optional(), target_id: z.string().nullable().optional(), company_id: z.string().nullable().optional(), stage_id: z.string().nullable().optional(), owner_id: z.string().nullable().optional(), amount: z.number().nullable().optional(), currency: z.string().optional(), expected_close_date: z.string().nullable().optional(), source: z.string().optional(), position: z.number().int().optional(), probability: z.number().int().min(0).max(100).optional(), is_won: z.boolean().optional(), is_lost: z.boolean().optional(), stage_ids: z.array(z.string()).optional(), move_to: z.string().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("pipeline_manage", args.action.startsWith("get") ? "mcp:read" : "mcp:write", args, async () => {
    if (args.action === "get") return api("/api/platform/pipeline", { query: { owner: args.owner } });
    if (args.action === "get_meetings") return api("/api/pipeline/meetings", { query: { when: args.when, match: args.match, page: args.page, limit: args.limit } });
    if (args.action === "get_activity") return api("/api/pipeline/activity", { query: { group: args.group, actor: args.owner, target_id: args.target_id ?? undefined, page: args.page, limit: args.limit } });
    if (args.action === "link_meeting") return api("/api/pipeline/meetings", { method: "PATCH", body: { id: args.id, target_id: args.target_id } });
    if (args.action === "update_settings") return api("/api/platform/pipeline", { method: "PATCH", body: { entity: "settings", auto_opportunity_on_reply: args.auto_opportunity_on_reply } });
    const { action, stage_ids, move_to, confirm: confirmed, owner: _owner, when: _when, match: _match, group: _group, page: _page, limit: _limit, auto_opportunity_on_reply: _auto, ...fields } = args;
    void _owner; void _when; void _match; void _group; void _page; void _limit; void _auto;
    if (action === "delete_opportunity" || action === "delete_stage") {
      if (!confirmed) throw new Error(`confirm=true is required to delete ${action === "delete_stage" ? "a pipeline stage" : "an opportunity"}`);
      return api("/api/platform/pipeline", { method: "DELETE", query: action === "delete_stage" ? { stage_id: args.id, move_to } : { id: args.id } });
    }
    if (action === "reorder_stages") return api("/api/platform/pipeline", { method: "PATCH", body: { entity: "stage_order", ids: stage_ids } });
    if (action === "update_opportunity") return api("/api/platform/pipeline", { method: "PATCH", body: fields });
    if (action === "update_stage") return api("/api/platform/pipeline", { method: "PATCH", body: { ...fields, entity: "stage" } });
    return api("/api/platform/pipeline", { method: "POST", body: { ...fields, entity: action === "create_stage" ? "stage" : "opportunity" } });
  }));

  server.registerTool("external_connection_manage", {
    title: "CRM and calendar synchronization", description: "List, create, update, sync, or remove HubSpot, Salesforce, Google Calendar, Microsoft Calendar, and iCal connections. config holds a provider's settings: Salesforce takes instance_url, external_id_field and api_version; Google Calendar takes calendar_id; iCal takes url. On update, config replaces every setting, while config_merge changes only the settings it names. list never returns a token, and shows only the host of an iCal address. An iCal url or a Salesforce instance_url on a private or local address is refused, when it is saved and when it syncs.",
    inputSchema: { action: z.enum(["list","create","update","sync","remove"]), id: z.string().optional(), provider: z.enum(["hubspot","salesforce","google_calendar","microsoft_calendar","ical"]).optional(), name: z.string().optional(), config: z.record(z.string(), z.unknown()).optional(), config_merge: z.record(z.string(), z.unknown()).optional(), secret: z.string().optional(), enabled: z.boolean().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("external_connection_manage", args.action === "list" ? "mcp:read" : args.action === "sync" ? "mcp:execute" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/platform/connections");
    if (args.action === "create") return api("/api/platform/connections", { method: "POST", body: args });
    if (args.action === "update") return api("/api/platform/connections", { method: "PATCH", body: args });
    if (args.action === "sync") { if(!args.confirm) throw new Error("confirm=true is required to run an external sync"); return api("/api/platform/connections", { method: "PUT", body: { id: args.id } }); }
    if (!args.confirm) throw new Error("confirm=true is required to remove a connection");
    return api("/api/platform/connections", { method: "DELETE", query: { id: args.id } });
  }));

  server.registerTool("team_inbox_manage", {
    title: "Collaborative team inbox", description: "Read team inbox metadata or assign, tag, lock, snooze, set SLA/status/sentiment, mark read or unread, and create, rename, recolour or delete shared tags and saved replies. Each change lands on the conversation (one per contact), named by one of its replies (reply_id, reply_ids) or directly (conversation_id, conversation_ids). status is open, snoozed or closed (pending and resolved are read as snoozed and closed); snooze takes snoozed_until, or none to wait until the contact next writes. sentiment is hot, warm or cold (positive, neutral and negative are read as those). update_tag/delete_tag/update_saved_reply/delete_saved_reply take id.",
    inputSchema: { action: z.enum(["get","create_tag","update_tag","delete_tag","create_saved_reply","update_saved_reply","delete_saved_reply","lock","unlock","assign","status","snooze","set_sla","set_sentiment","tag","untag","mark_read","mark_unread"]), id: z.string().optional(), reply_id: z.string().optional(), reply_ids: z.array(z.string()).optional(), conversation_id: z.string().optional(), conversation_ids: z.array(z.string()).optional(), name: z.string().optional(), body: z.string().optional(), color: z.string().optional(), assigned_to: z.string().nullable().optional(), status: z.enum(["open","snoozed","closed","pending","resolved"]).optional(), snoozed_until: z.string().nullable().optional(), sla_due_at: z.string().nullable().optional(), sentiment: z.enum(["hot","warm","cold","positive","neutral","negative"]).nullable().optional(), tag_id: z.string().optional() }, annotations: { openWorldHint: false },
  }, (args) => run("team_inbox_manage", args.action === "get" ? "mcp:read" : "mcp:write", args, () => args.action === "get" ? api("/api/platform/inbox") : api("/api/platform/inbox", { method: "POST", body: args })));

  server.registerTool("conversation_manage", {
    title: "Conversations", description: "The inbox as conversations, one per contact who has written back. list: a page with filters (view all/unread/mine; verdict, status, temperature and assignee take comma-separated values; sla overdue/today; tag, channel, campaign, q, sort, page, per) and the count beside each filter. get: one conversation with every stored message on both channels, the caller's draft and how it can be answered. update: status (with snoozed_until), assigned_to, temperature, sla_due_at, add_tags, remove_tags, read. mark_all_read: for the calling member. send REALLY sends: an email goes now, a LinkedIn message is queued and sent within about a minute; it needs confirm=true, and close=true closes the conversation as it goes.",
    inputSchema: { action: z.enum(["list","get","update","mark_all_read","send"]), conversation_id: z.string().optional(), query: z.record(z.string(), z.union([z.string(), z.number()])).optional(), changes: z.record(z.string(), z.unknown()).optional(), channel: z.enum(["email","linkedin"]).optional(), body: z.string().optional(), subject: z.string().optional(), email_account_id: z.string().optional(), linkedin_account_id: z.string().optional(), close: z.boolean().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("conversation_manage", ["list","get"].includes(args.action) ? "mcp:read" : args.action === "send" ? "mcp:execute" : "mcp:write", args, async () => {
    if (args.action === "list") return api("/api/conversations", { query: args.query });
    if (args.action === "mark_all_read") return api("/api/conversations/read", { method: "POST", body: {} });
    if (!args.conversation_id) throw new Error("conversation_id is required");
    const base = `/api/conversations/${enc(args.conversation_id)}`;
    if (args.action === "get") return api(base);
    if (args.action === "update") return api(base, { method: "PATCH", body: args.changes ?? {} });
    if (!args.confirm) throw new Error("confirm=true is required: this sends a real message to the contact");
    return api(`${base}/send`, { method: "POST", body: { channel: args.channel, body: args.body, subject: args.subject, email_account_id: args.email_account_id, linkedin_account_id: args.linkedin_account_id, close: args.close } });
  }));

  server.registerTool("webhook_manage", {
    title: "Public webhooks", description: "List, create, update, test, or remove signed event webhook endpoints, read one endpoint's delivery log (deliveries, with id), list every delivery that was given up on (dead_letters), or send a past delivery again (redeliver, with delivery_id). list gives each endpoint's name, success rate, last delivery and health (healthy, retrying, failing, paused or idle). An endpoint can be given a name; update with enabled=false pauses it (events that happen while it is paused are not queued for it) and enabled=true resumes it. test with id tests that endpoint; without, every enabled one. The signing secret is returned once, on create.",
    inputSchema: { action: z.enum(["list","create","update","test","deliveries","dead_letters","redeliver","remove"]), id: z.string().optional(), delivery_id: z.string().optional(), name: z.string().max(80).nullable().optional(), url: z.string().url().optional(), event_types: z.union([z.string(),z.array(z.string())]).optional(), enabled: z.boolean().optional(), confirm: z.boolean().optional() }, annotations: { openWorldHint: true },
  }, (args) => run("webhook_manage", ["list","deliveries","dead_letters"].includes(args.action) ? "mcp:read" : "mcp:write", args, async () => {
    if(args.action==="list") return api("/api/platform/webhooks");
    if(args.action==="dead_letters") return api("/api/platform/webhooks",{query:{dead_letters:1}});
    if(args.action==="create") return api("/api/platform/webhooks",{method:"POST",body:args});
    if(args.action==="update") return api("/api/platform/webhooks",{method:"PATCH",body:args});
    if(args.action==="test") return api("/api/platform/webhooks",{method:"PUT",body:{id:args.id}});
    if(args.action==="deliveries") return api("/api/platform/webhooks",{query:{deliveries:args.id}});
    if(args.action==="redeliver") return api("/api/platform/webhooks",{method:"PUT",body:{delivery_id:args.delivery_id}});
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
      if (!/^\/api\/(accounts|activity-logs|agent\/preview|ai|companies|dashboard|email-accounts|email-health|imports|inbox|integrations|lists|openrouter\/models|platform|premium-status|runs|settings\/import-cap|targets|templates|todos|tour|workflows)(\/|$|\?)/.test(args.path) || args.path.includes("..") || args.path.includes("://")) throw new Error("That API path is not exposed through MCP");
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
