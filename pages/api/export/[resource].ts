// CSV downloads of what the app's lists show. Each takes the query string its screen sends
// to its own list route, so the file holds the rows that were on screen, all of them rather
// than one page.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { recordAudit, requireWorkspace, type WorkspaceContext } from "@/lib/workspace";
import { sendCsv, type CsvColumn } from "@/lib/export/csv";
import { contactsQuery, type Query } from "@/lib/contacts/filters";
import { PROSPECTS_FROM, PROSPECTS_ORDER, PROSPECT_STATE, prospectsWhere } from "@/lib/outreach/prospects-query";
import { campaignAnalytics } from "@/lib/reporting/campaign-analytics";
import { parseRange } from "@/lib/reporting/range";

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
const CONTACT_SELECT = `t.id, ${CONTACT_FIELDS.map(([, field]) => `t.${field}`).join(", ")}`;

/** Contacts as the contacts page selects them: `list_id`, `search` and the filter bar. With `listOnly`, a list is required. */
const contacts = (listOnly: boolean): Builder => (db, ctx, query) => {
  const listId = text(query.list_id);
  const list = named(db, "lists", listId, ctx.workspaceId);
  if (listOnly && !listId) return { status: 400, error: "list_id is required" };
  if (listId && !list) return { status: 404, error: "List not found" };
  const { from, where, params } = contactsQuery(query, ctx.workspaceId);

  // The workspace's own fields follow the standard ones, a column each.
  const fields = db.prepare("SELECT id, name FROM custom_field_definitions WHERE workspace_id = ? ORDER BY name, id").all(ctx.workspaceId) as Array<{ id: string; name: string }>;
  const custom = fields.map((field): CsvColumn<Row> => ({ header: field.name, value: (row) => (row.custom as Record<string, unknown> | undefined)?.[field.id] }));

  return {
    filename: `linki-${list ? `list-${list.name}` : "contacts"}-${today()}`,
    columns: [...CONTACT_COLUMNS, ...custom],
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
 * Every reply received, one row each, newest first. Takes the inbox's filters. A contact
 * who answered on LinkedIn is a row too, without a message: LinkedIn replies are noticed,
 * not yet read.
 */
const replies: Builder = (db, ctx, query) => {
  const channel = text(query.channel);
  const clauses: string[] = [];
  const filterParams: unknown[] = [];
  if (text(query.status)) { clauses.push("AND COALESCE(er.inbox_status, 'open') = ?"); filterParams.push(query.status); }
  if (text(query.sentiment)) { clauses.push("AND er.sentiment = ?"); filterParams.push(query.sentiment); }
  if (text(query.assigned_to)) { clauses.push("AND er.assigned_to = ?"); filterParams.push(query.assigned_to); }
  if (query.sla === "overdue") clauses.push("AND er.sla_due_at < datetime('now') AND COALESCE(er.inbox_status, 'open') NOT IN ('resolved','closed')");
  if (text(query.tag_id)) { clauses.push("AND EXISTS (SELECT 1 FROM email_reply_tags ertf WHERE ertf.reply_id = er.id AND ertf.tag_id = ?)"); filterParams.push(query.tag_id); }

  const parts: string[] = [];
  const params: unknown[] = [];
  if (channel !== "linkedin") {
    parts.push(`SELECT er.id, 'email' channel, er.received_at, er.from_email, t.full_name, t.title, t.company, t.linkedin_url, er.subject, er.body_text,
        er.classification_json, er.sentiment, COALESCE(er.inbox_status, 'open') status, assignee.email assignee, er.sla_due_at, w.name campaign, ea.from_email mailbox,
        (SELECT group_concat(it.name, ', ') FROM email_reply_tags ert JOIN inbox_tags it ON it.id = ert.tag_id WHERE ert.reply_id = er.id) tags
      FROM email_replies er LEFT JOIN targets t ON t.id = er.target_id LEFT JOIN runs r ON r.id = er.run_id LEFT JOIN workflows w ON w.id = r.workflow_id
        LEFT JOIN email_accounts ea ON ea.id = er.email_account_id LEFT JOIN users assignee ON assignee.id = er.assigned_to
      WHERE er.workspace_id = ? ${clauses.join(" ")}`);
    params.push(ctx.workspaceId, ...filterParams);
  }
  // The triage filters describe an email reply, so they leave LinkedIn rows out.
  if (channel !== "email" && clauses.length === 0) {
    // Named column for column, since this half stands alone when only LinkedIn is asked for.
    parts.push(`SELECT t.id, 'linkedin' channel, t.last_replied_at received_at, NULL from_email, t.full_name, t.title, t.company, t.linkedin_url, NULL subject, NULL body_text,
        NULL classification_json, NULL sentiment, NULL status, NULL assignee, NULL sla_due_at, NULL campaign, NULL mailbox, NULL tags
      FROM targets t WHERE t.workspace_id = ? AND t.last_replied_at IS NOT NULL`);
    params.push(ctx.workspaceId);
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
  const { where, params } = prospectsWhere(query, workflowId);
  return {
    filename: `linki-prospects-${workflow.name}-${today()}`,
    columns: [
      col("Name", "full_name"), col("Title", "title"), col("Company", "company"), col("Email", "email"), col("LinkedIn URL", "linkedin_url"), col("State", "state"),
      col("LinkedIn track", "linkedin_state"), col("LinkedIn steps done", "linkedin_steps_done"), col("Email track", "email_state"), col("Email steps done", "email_steps_done"),
      col("Next step due", "next_step_at"), col("Problem", "error_message"), col("Connection requested", "connection_requested_at"), col("Connected", "connected_at"),
      col("LinkedIn message sent", "message_sent_at"), col("Replied on LinkedIn", "last_replied_at"), col("Replied by email", "email_replied_at"),
    ],
    total: (db.prepare(`SELECT COUNT(*) c ${PROSPECTS_FROM} WHERE ${where}`).get(...params) as { c: number }).c,
    page: (limit, offset) => db.prepare(`SELECT rp.id, ${PROSPECT_STATE} state, t.full_name, t.title, t.company, t.email, t.linkedin_url,
        rt_li.state linkedin_state, rt_li.current_step linkedin_steps_done, rt_em.state email_state, rt_em.current_step email_steps_done,
        COALESCE(rt_li.next_step_at, rt_em.next_step_at) next_step_at, COALESCE(rt_li.error_message, rt_em.error_message) error_message,
        t.connection_requested_at, t.connected_at, t.message_sent_at, t.last_replied_at, t.email_replied_at
      ${PROSPECTS_FROM} WHERE ${where} ${PROSPECTS_ORDER}, rp.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[],
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

const EXPORTS: Record<string, Builder> = { contacts: contacts(false), list_members: contacts(true), replies, prospects, analytics, suppressions };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") { res.setHeader("Allow", ["GET"]); return res.status(405).end(); }
  // Taking a whole table out of the workspace is a manager's call, and is written down.
  const ctx = requireWorkspace(req, res, "manager");
  if (!ctx) return;
  const { resource, ...filters } = req.query;
  const build = EXPORTS[String(resource)];
  if (!build) return res.status(404).json({ error: "There is no export by that name" });
  const plan = build(getDb(), ctx, filters);
  if ("error" in plan) return res.status(plan.status).json({ error: plan.error });
  // Recorded before the first byte leaves, so an export cut short is still on the record.
  recordAudit(ctx, "export.created", "export", undefined, { resource, rows: plan.total, filters });
  await sendCsv(res, plan.filename, plan.columns, plan.page);
}
