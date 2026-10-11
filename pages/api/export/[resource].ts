// CSV downloads of what the app's lists show. Each takes the query string its screen sends
// to its own list route, so the file holds the rows that were on screen, all of them rather
// than one page.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { recordAudit, requireWorkspace, type WorkspaceContext } from "@/lib/workspace";
import { sendCsv, type CsvColumn } from "@/lib/export/csv";
import { contactsQuery, type Query } from "@/lib/contacts/filters";
import { PROSPECTS_FROM, PROSPECT_STATE, PROSPECT_STATUS, prospectsWhere } from "@/lib/outreach/prospects-query";
import { prospectsOrder, stepPlace } from "@/lib/campaigns/prospects";
import { DASHBOARD_RANGES, isDashboardRange, workspaceDashboard } from "@/lib/reporting/dashboard";
import { campaignAnalytics } from "@/lib/reporting/campaign-analytics";
import { parseRange } from "@/lib/reporting/range";
import { CAMPAIGN_SORTS, campaignList, type CampaignSort } from "@/lib/campaigns/summary";
import { settleConversations } from "@/lib/conversations/store";
import { statusFrom, temperatureFrom } from "@/lib/conversations/vocabulary";

// A file can run to many megabytes; Next's default caps an API response at four.
export const config = { api: { responseLimit: false } };

type DB = ReturnType<typeof getDb>;
type Row = Record<string, unknown>;
interface Plan { filename: string; columns: CsvColumn<Row>[]; total: number; page: (limit: number, offset: number) => Row[] }
type Refusal = { status: number; error: string };
type Builder = (db: DB, ctx: WorkspaceContext, query: Query) => Plan | Refusal;

const col = (header: string, field: string): CsvColumn<Row> => ({ header, value: (row) => row[field] });
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
const today = () => new Date().toISOString().slice(0, 10);
const named = (db: DB, table: "lists" | "workflows", id: string | null, workspaceId: string) =>
  id ? (db.prepare(`SELECT name FROM ${table} WHERE id = ? AND workspace_id = ?`).get(id, workspaceId) as { name: string } | undefined) : undefined;

// Heading, then the targets column it comes from. Only these are read: a contact row also
// carries scraped profile data many times their size.
const CONTACT_FIELDS: Array<[string, string]> = [
  ["Name", "full_name"], ["First name", "first_name"], ["Last name", "last_name"], ["Title", "title"], ["Company", "company"],
  ["Email", "email"], ["Email status", "email_status"], ["Phone", "phone"], ["LinkedIn URL", "linkedin_url"],
  ["Location", "location"], ["City", "city"], ["Country", "country"], ["Time zone", "time_zone"],
  ["Seniority", "seniority"], ["Industry", "company_industry"], ["Company size", "company_size"],
  ["Connection degree", "degree"], ["Connection requested", "connection_requested_at"], ["Connected", "connected_at"],
  ["LinkedIn message sent", "message_sent_at"], ["Replied on LinkedIn", "last_replied_at"], ["Replied by email", "email_replied_at"],
  ["Reply kind", "reply_kind"], ["Unsubscribed", "unsubscribed_at"], ["Intent score", "intent_score"], ["Notes", "notes"], ["Added", "created_at"],
];
const CONTACT_COLUMNS = CONTACT_FIELDS.map(([header, field]) => col(header, field));
const CONTACT_SELECT = `t.id, ${CONTACT_FIELDS.map(([, field]) => `t.${field}`).join(", ")},
  (SELECT COALESCE(NULLIF(TRIM(u.name), ''), u.email) FROM users u WHERE u.id = t.owner_id) AS owner,
  (SELECT group_concat(ct.name, ', ') FROM target_tags tt JOIN contact_tags ct ON ct.id = tt.tag_id WHERE tt.target_id = t.id) AS tags`;

/**
 * Contacts as the contacts page selects them: `list_id`, `search`, the filter bar, the named
 * filters, and `ids` for a hand-picked selection. With `listOnly`, a list is required.
 */
const contacts = (listOnly: boolean): Builder => (db, ctx, query) => {
  // `list_id=none` means contacts in no list; it names no list to look up.
  const listId = text(query.list_id) === "none" && !listOnly ? null : text(query.list_id);
  const list = named(db, "lists", listId, ctx.workspaceId);
  if (listOnly && !listId) return { status: 400, error: "list_id is required" };
  if (listId && !list) return { status: 404, error: "List not found" };
  const { from, where, params } = contactsQuery(query, ctx.workspaceId);

  // The workspace's own fields follow the standard ones, a column each.
  const fields = db.prepare("SELECT id, name FROM custom_field_definitions WHERE workspace_id = ? ORDER BY name, id").all(ctx.workspaceId) as Array<{ id: string; name: string }>;
  const custom = fields.map((field): CsvColumn<Row> => ({ header: field.name, value: (row) => (row.custom as Record<string, unknown> | undefined)?.[field.id] }));

  return {
    filename: `linki-${list ? `list-${list.name}` : "contacts"}-${today()}`,
    columns: [...CONTACT_COLUMNS, col("Owner", "owner"), col("Tags", "tags"), ...custom],
    total: (db.prepare(`SELECT COUNT(*) c ${from} ${where}`).get(...params) as { c: number }).c,
    page: (limit, offset) => {
      const rows = db.prepare(`SELECT ${CONTACT_SELECT} ${from} ${where} ORDER BY t.full_name ASC, t.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
      if (!fields.length || !rows.length) return rows;
      const values = db.prepare(`SELECT target_id, field_id, value_text, value_number, value_boolean FROM contact_custom_values
        WHERE workspace_id = ? AND target_id IN (${rows.map(() => "?").join(",")})`).all(ctx.workspaceId, ...rows.map((row) => row.id)) as Array<{ target_id: string; field_id: string; value_text: string | null; value_number: number | null; value_boolean: number | null }>;
      const byContact = new Map<string, Record<string, unknown>>();
      for (const value of values) {
        const held = byContact.get(value.target_id) ?? {};
        held[value.field_id] = value.value_text ?? value.value_number ?? (value.value_boolean === null ? null : value.value_boolean ? "yes" : "no");
        byContact.set(value.target_id, held);
      }
      return rows.map((row) => ({ ...row, custom: byContact.get(String(row.id)) }));
    },
  };
};

function verdict(row: Row, key: "kind" | "summary"): unknown {
  try { return (JSON.parse(String(row.classification_json ?? "{}")) as Record<string, unknown>)[key] ?? null; } catch { return null; }
}

/**
 * Every reply received, one row each, newest first. Takes the inbox's filters. LinkedIn
 * replies read from an account's inbox are rows like any other. A contact only known to
 * have answered on LinkedIn (marked by hand, or noticed when a campaign went to message
 * them) is a row too, without a message.
 */
const replies: Builder = (db, ctx, query) => {
  // Who has it, where it stands, how warm it is, when an answer is due and its tags are
  // kept per conversation, so every reply from one contact shows the same. The filters
  // take the words used before conversations as well (pending, resolved; positive,
  // neutral, negative), read as snoozed, closed; hot, warm, cold.
  settleConversations(db, ctx.workspaceId, { force: true });
  const channel = text(query.channel);
  const clauses: string[] = [];
  const filterParams: unknown[] = [];
  if (text(query.status)) { clauses.push("AND COALESCE(c.status, 'open') = ?"); filterParams.push(statusFrom(query.status) ?? query.status); }
  if (text(query.sentiment)) { clauses.push("AND c.temperature = ?"); filterParams.push(temperatureFrom(query.sentiment) ?? query.sentiment); }
  if (text(query.assigned_to)) { clauses.push("AND c.assigned_to = ?"); filterParams.push(query.assigned_to); }
  if (query.sla === "overdue") { clauses.push("AND c.sla_due_at < ? AND c.status = 'open'"); filterParams.push(new Date().toISOString()); }
  if (text(query.tag_id)) { clauses.push("AND EXISTS (SELECT 1 FROM conversation_tags ctf WHERE ctf.conversation_id = c.id AND ctf.tag_id = ?)"); filterParams.push(query.tag_id); }
  const triage = `c.temperature sentiment, COALESCE(c.status, 'open') status, assignee.email assignee, replace(substr(c.sla_due_at, 1, 19), 'T', ' ') sla_due_at`;
  const tags = "(SELECT group_concat(it.name, ', ') FROM conversation_tags ct JOIN inbox_tags it ON it.id = ct.tag_id WHERE ct.conversation_id = c.id) tags";

  const parts: string[] = [];
  const params: unknown[] = [];
  {
    parts.push(`SELECT er.id, er.channel, er.received_at, er.from_email, t.full_name, t.title, t.company, t.linkedin_url, er.subject, er.body_text,
        er.classification_json, ${triage}, w.name campaign, ea.from_email mailbox, ${tags}
      FROM email_replies er LEFT JOIN conversations c ON c.id = er.conversation_id LEFT JOIN targets t ON t.id = er.target_id LEFT JOIN runs r ON r.id = er.run_id LEFT JOIN workflows w ON w.id = r.workflow_id
        LEFT JOIN email_accounts ea ON ea.id = er.email_account_id LEFT JOIN users assignee ON assignee.id = c.assigned_to
      WHERE er.workspace_id = ? ${channel === "email" || channel === "linkedin" ? `AND er.channel = '${channel}'` : ""} ${clauses.join(" ")}`);
    params.push(ctx.workspaceId, ...filterParams);
  }
  if (channel !== "email") {
    // A contact known to have answered on LinkedIn with no message on record. Named
    // column for column, since this half stands alone when only LinkedIn is asked for.
    parts.push(`SELECT t.id, 'linkedin' channel, t.last_replied_at received_at, NULL from_email, t.full_name, t.title, t.company, t.linkedin_url, NULL subject, NULL body_text,
        NULL classification_json, ${triage}, NULL campaign, NULL mailbox, ${tags}
      FROM targets t LEFT JOIN conversations c ON c.target_id = t.id LEFT JOIN users assignee ON assignee.id = c.assigned_to
      WHERE t.workspace_id = ? AND t.last_replied_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM email_replies seen WHERE seen.target_id = t.id AND seen.channel = 'linkedin') ${clauses.join(" ")}`);
    params.push(ctx.workspaceId, ...filterParams);
  }
  const all = parts.join(" UNION ALL ");
  return {
    filename: `linki-replies-${today()}`,
    columns: [
      col("Received", "received_at"), col("Channel", "channel"), col("From", "from_email"), col("Contact", "full_name"), col("Title", "title"), col("Company", "company"),
      col("LinkedIn URL", "linkedin_url"), col("Campaign", "campaign"), col("Mailbox", "mailbox"), col("Subject", "subject"),
      { header: "Verdict", value: (row) => verdict(row, "kind") }, { header: "Summary", value: (row) => verdict(row, "summary") },
      col("Sentiment", "sentiment"), col("Status", "status"), col("Assigned to", "assignee"), col("Answer due", "sla_due_at"), col("Tags", "tags"), col("Message", "body_text"),
    ],
    total: (db.prepare(`SELECT COUNT(*) c FROM (${all})`).get(...params) as { c: number }).c,
    page: (limit, offset) => db.prepare(`SELECT * FROM (${all}) ORDER BY received_at DESC, id LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[],
  };
};

/** A campaign's prospects as its prospects table selects them: `step`, `track`, `state`, `search` and the filter bar. */
const prospects: Builder = (db, ctx, query) => {
  const workflowId = text(query.workflow_id);
  if (!workflowId) return { status: 400, error: "workflow_id is required" };
  const workflow = named(db, "workflows", workflowId, ctx.workspaceId);
  if (!workflow) return { status: 404, error: "Campaign not found" };
  // The Prospects tab filters by the step someone is standing on; the file holds the same people.
  const stepId = text(query.step_id);
  const place = stepId ? stepPlace(db, workflowId, stepId) : null;
  const { where, params } = prospectsWhere(query, workflowId, { place, noStep: Boolean(stepId) && !place });
  return {
    filename: `linki-prospects-${workflow.name}-${today()}`,
    columns: [
      col("Name", "full_name"), col("Title", "title"), col("Company", "company"), col("Email", "email"), col("LinkedIn URL", "linkedin_url"), col("Status", "status"), col("State", "state"),
      col("LinkedIn track", "linkedin_state"), col("LinkedIn steps done", "linkedin_steps_done"), col("Email track", "email_state"), col("Email steps done", "email_steps_done"),
      col("Next step due", "next_step_at"), col("Problem", "error_message"), col("Connection requested", "connection_requested_at"), col("Connected", "connected_at"),
      col("LinkedIn message sent", "message_sent_at"), col("Replied on LinkedIn", "last_replied_at"), col("Replied by email", "email_replied_at"),
    ],
    total: (db.prepare(`SELECT COUNT(*) c ${PROSPECTS_FROM} WHERE ${where}`).get(...params) as { c: number }).c,
    page: (limit, offset) => db.prepare(`SELECT rp.id, ${PROSPECT_STATUS} status, ${PROSPECT_STATE} state, t.full_name, t.title, t.company, t.email, t.linkedin_url,
        rt_li.state linkedin_state, rt_li.current_step linkedin_steps_done, rt_em.state email_state, rt_em.current_step email_steps_done,
        COALESCE(rt_li.next_step_at, rt_em.next_step_at) next_step_at, COALESCE(rt_li.error_message, rt_em.error_message) error_message,
        t.connection_requested_at, t.connected_at, t.message_sent_at, t.last_replied_at, t.email_replied_at
      ${PROSPECTS_FROM} WHERE ${where} ${prospectsOrder(query)} LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[],
  };
};

/**
 * A campaign's analytics as one tidy table: a row per figure, saying which part of the
 * panel it is from, the day or item it is about, what it measures and its value.
 */
const analytics: Builder = (db, ctx, query) => {
  const workflowId = text(query.workflow_id);
  if (!workflowId) return { status: 400, error: "workflow_id is required" };
  const workflow = named(db, "workflows", workflowId, ctx.workspaceId);
  if (!workflow) return { status: 404, error: "Campaign not found" };
  const range = parseRange(query);
  if (typeof range === "string") return { status: 400, error: range };
  const data = campaignAnalytics(db, workflowId, range);
  const rows: Row[] = [];
  const figures = (section: string, record: Record<string, unknown>, about: { date?: string; item?: string } = {}, skip: string[] = []) => {
    for (const [metric, value] of Object.entries(record)) if (!skip.includes(metric)) rows.push({ section, date: about.date ?? null, item: about.item ?? null, metric, value });
  };
  figures("Period", data.range);
  figures("Funnel", data.funnel);
  figures("Audience", data.audience);
  figures("Engagement", data.engagement);
  for (const day of data.activity) figures("Daily activity", day, { date: day.day }, ["day"]);
  for (const day of data.aiDaily) figures("AI usage by day", day, { date: day.day }, ["day"]);
  for (const step of data.aiByStep as Array<Record<string, unknown>>) figures("AI usage by step", step, { item: `Step ${String(step.step_order)} (${String(step.step_type)})` }, ["step_order", "step_type"]);
  for (const step of data.emailVariants) {
    for (const variant of step.variants) figures("Email variants", variant, { item: `Step ${step.step_order} ${variant.label}: ${variant.subject}` }, ["variant_id", "subject", "label"]);
  }
  return {
    filename: `linki-analytics-${workflow.name}-${today()}`,
    columns: [col("Section", "section"), col("Date", "date"), col("Item", "item"), col("Metric", "metric"), col("Value", "value")],
    total: rows.length,
    page: (limit, offset) => rows.slice(offset, offset + limit),
  };
};

const KINDS = new Set(["email", "domain", "linkedin", "phone"]);

/** The do-not-contact list, with the Platform page's `q` and `kind` filters. */
const suppressions: Builder = (db, ctx, query) => {
  const q = typeof query.q === "string" ? query.q.trim().toLowerCase() : "";
  const kind = typeof query.kind === "string" && KINDS.has(query.kind) ? query.kind : null;
  const where = "WHERE workspace_id = ? AND (? = '' OR instr(lower(value), ?) > 0) AND (? IS NULL OR kind = ?)";
  const params = [ctx.workspaceId, q, q, kind, kind];
  return {
    filename: `linki-do-not-contact-${today()}`,
    columns: [col("Kind", "kind"), col("Value", "value"), col("Reason", "reason"), col("Source", "source"), col("Added", "created_at")],
    total: (db.prepare(`SELECT COUNT(*) c FROM suppressions ${where}`).get(...params) as { c: number }).c,
    page: (limit, offset) => db.prepare(`SELECT kind, value, reason, source, created_at FROM suppressions ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[],
  };
};

/** The campaigns list as its screen shows it: the same filters and sort, every row. */
const campaigns: Builder = (db, ctx, query) => {
  const [sortKey, sortDirection] = (text(query.sort) ?? "").split(":");
  const rows = campaignList(db, ctx.workspaceId, {
    status: text(query.status) ?? undefined, q: text(query.q) ?? undefined, channel: text(query.channel) ?? undefined, owner: text(query.owner) ?? undefined,
    sort: (CAMPAIGN_SORTS as readonly string[]).includes(sortKey) ? { key: sortKey as CampaignSort, direction: sortDirection === "asc" ? "asc" : "desc" } : undefined,
    page: 1, limit: 100_000,
  }).items as unknown as Row[];
  const percent = (field: string): CsvColumn<Row> => ({ header: field === "reply_rate" ? "Reply rate %" : "Acceptance %", value: (row) => (typeof row[field] === "number" ? Math.round((row[field] as number) * 1000) / 10 : null) });
  return {
    filename: `linki-campaigns-${today()}`,
    columns: [
      col("Campaign", "name"), col("Status", "status"), { header: "Channels", value: (row) => (row.channels as string[]).join(" + ") },
      { header: "List", value: (row) => (row.list as { name: string } | null)?.name ?? null }, col("Enrolled", "enrolled"), col("Done", "done"),
      col("Contacted", "contacted"), col("Replied", "replied"), percent("reply_rate"), col("Invited", "invited"), col("Accepted", "accepted"), percent("acceptance_rate"),
      { header: "Owner", value: (row) => (row.owner as { name: string } | null)?.name ?? null }, col("Last activity", "last_activity_at"), col("Created", "created_at"),
    ],
    total: rows.length,
    page: (limit, offset) => rows.slice(offset, offset + limit),
  };
};

/**
 * The dashboard as one tidy table, a row per figure, for the period and filters on screen.
 */
const dashboard: Builder = (db, ctx, query) => {
  const range = text(query.range) ?? "7d";
  if (!isDashboardRange(range)) return { status: 400, error: `range must be one of ${DASHBOARD_RANGES.join(", ")}` };
  const workflowId = text(query.workflow_id);
  const listId = text(query.list_id);
  const ownerId = text(query.owner_id);
  if (workflowId && !named(db, "workflows", workflowId, ctx.workspaceId)) return { status: 404, error: "Campaign not found" };
  if (listId && !named(db, "lists", listId, ctx.workspaceId)) return { status: 404, error: "List not found" };
  if (ownerId && !db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ctx.workspaceId, ownerId)) return { status: 404, error: "Member not found" };
  const data = workspaceDashboard(db, ctx.workspaceId, { range, workflow_id: workflowId, list_id: listId, owner_id: ownerId });
  const rows: Row[] = [];
  const add = (section: string, metric: string, value: unknown, about: { date?: string; item?: string } = {}) => rows.push({ section, date: about.date ?? null, item: about.item ?? null, metric, value: value as Row[string] });
  add("Period", "range", data.range);
  for (const [key, tally] of [["Emails sent", data.kpis.emails], ["LinkedIn actions", data.kpis.linkedin], ["Positive replies", data.kpis.positive], ["Meetings booked", data.kpis.meetings]] as const) {
    add("Totals", key, tally.value);
    add("Totals", `${key}, period before`, tally.previous);
  }
  add("Totals", "People written to", data.kpis.reply.whole);
  add("Totals", "Of whom replied", data.kpis.reply.part);
  add("Totals", "Reply rate %", data.kpis.reply.value === null ? null : Math.round(data.kpis.reply.value * 1000) / 10);
  add("Totals", "Reply rate %, period before", data.kpis.reply.previous === null ? null : Math.round(data.kpis.reply.previous * 1000) / 10);
  for (const point of data.activity.points) {
    const about = { date: point.start, item: data.activity.unit === "week" ? "Week starting" : undefined };
    add("Activity", "Emails", point.email, about);
    add("Activity", "LinkedIn actions", point.linkedin, about);
    add("Activity", "Replies", point.replies, about);
  }
  for (const channel of ["both", "linkedin", "email"] as const) for (const stage of data.funnel.stages[channel]) add("Funnel", stage.key, stage.count, { item: channel === "both" ? "Both channels" : channel === "linkedin" ? "LinkedIn" : "Email" });
  for (const campaign of data.campaigns) {
    add("Campaigns", "Enrolled", campaign.enrolled, { item: campaign.name });
    add("Campaigns", "Written to", campaign.contacted, { item: campaign.name });
    add("Campaigns", "Replied", campaign.replied, { item: campaign.name });
    add("Campaigns", "Reply rate %", campaign.reply_rate === null ? null : Math.round(campaign.reply_rate * 1000) / 10, { item: campaign.name });
    add("Campaigns", "Invited", campaign.invited, { item: campaign.name });
    add("Campaigns", "Accepted", campaign.accepted, { item: campaign.name });
  }
  return {
    filename: `linki-dashboard-${data.range}-${today()}`,
    columns: [col("Section", "section"), col("Date", "date"), col("Item", "item"), col("Metric", "metric"), col("Value", "value")],
    total: rows.length,
    page: (limit, offset) => rows.slice(offset, offset + limit),
  };
};

const EXPORTS: Record<string, Builder> = { contacts: contacts(false), list_members: contacts(true), replies, prospects, analytics, suppressions, campaigns, dashboard };

/**
 * Filters sent in a POST body, as the strings a query string would carry. A hand-picked
 * selection of contacts (`ids`) can be longer than an address may be, so a screen may send
 * its filters this way instead; the file is the same.
 */
function bodyFilters(body: unknown): Query {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const out: Query = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === "resource" || value === null || value === undefined) continue;
    if (Array.isArray(value)) out[key] = value.map(String).join(",");
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", ["GET", "POST"]); return res.status(405).end(); }
  // Taking a whole table out of the workspace is a manager's call, and is written down.
  const ctx = requireWorkspace(req, res, "manager");
  if (!ctx) return;
  const { resource, ...asked } = req.query;
  const filters: Query = req.method === "POST" ? { ...asked, ...bodyFilters(req.body) } : asked;
  const build = EXPORTS[String(resource)];
  if (!build) return res.status(404).json({ error: "There is no export by that name" });
  const plan = build(getDb(), ctx, filters);
  if ("error" in plan) return res.status(plan.status).json({ error: plan.error });
  // Recorded before the first byte leaves, so an export cut short is still on the record.
  // A long selection is recorded by its size, not by listing every id.
  const recorded = typeof filters.ids === "string" && filters.ids.length > 400 ? { ...filters, ids: `${filters.ids.split(",").length} contacts` } : filters;
  recordAudit(ctx, "export.created", "export", undefined, { resource, rows: plan.total, filters: recorded });
  await sendCsv(res, plan.filename, plan.columns, plan.page);
}
