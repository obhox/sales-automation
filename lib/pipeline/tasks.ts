// Tasks: something a person has to do, about a contact, a company, an opportunity, or
// nothing in particular. One writer for them, so a task made by a person, by a positive
// reply or by a campaign step is the same kind of row and shows in the same lists.
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { recordPipelineEvent } from "@/lib/platform/pipeline";

type DB = DatabaseType.Database;

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const isPriority = (value: unknown): value is Priority => (PRIORITIES as readonly unknown[]).includes(value);

/** A value the caller sent that cannot be used, as the sentence to send back. */
export class TaskRefused extends Error {}

export interface TaskFields {
  title?: string;
  description?: string | null;
  /** The day it is due ("2026-11-14"), and optionally the moment (ISO) when a time was given. */
  due_date?: string | null;
  due_at?: string | null;
  priority?: Priority;
  assigned_to?: string | null;
  target_id?: string | null;
  company_id?: string | null;
  opportunity_id?: string | null;
}

const has = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

/**
 * Read a task's fields out of a request, checking each against the workspace. Only the
 * fields that were sent come back, so an update changes those and nothing else.
 */
export function taskFieldsFrom(db: DB, workspaceId: string, body: Record<string, unknown>): TaskFields {
  const out: TaskFields = {};
  if (has(body, "title")) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) throw new TaskRefused("A task needs a title");
    out.title = title.slice(0, 300);
  }
  if (has(body, "description")) out.description = typeof body.description === "string" && body.description.trim() ? body.description.trim().slice(0, 4000) : null;
  if (has(body, "due_date")) {
    if (body.due_date === null || body.due_date === "") out.due_date = null;
    else if (typeof body.due_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(body.due_date) && !Number.isNaN(Date.parse(body.due_date.slice(0, 10)))) out.due_date = body.due_date.slice(0, 10);
    // Another way of writing a date is read if it can be; what cannot be read as a date is refused rather than kept as text.
    else if (typeof body.due_date === "string" && !Number.isNaN(Date.parse(body.due_date))) out.due_date = new Date(Date.parse(body.due_date)).toISOString().slice(0, 10);
    else throw new TaskRefused("due_date must be a date (YYYY-MM-DD)");
  }
  if (has(body, "due_at")) {
    if (body.due_at === null || body.due_at === "") out.due_at = null;
    else {
      const at = Date.parse(String(body.due_at));
      if (Number.isNaN(at)) throw new TaskRefused("due_at must be a date and time");
      out.due_at = new Date(at).toISOString();
      // The day follows the moment unless the caller said which day it is where they are.
      if (!has(body, "due_date")) out.due_date = out.due_at.slice(0, 10);
    }
  }
  // Clearing the day clears the time with it; a day on its own has no time.
  if (out.due_date === null) out.due_at = null;
  else if (out.due_date !== undefined && out.due_at === undefined) out.due_at = null;
  if (has(body, "priority")) {
    if (!isPriority(body.priority)) throw new TaskRefused("priority must be high, medium or low");
    out.priority = body.priority;
  }
  const ref = (key: "assigned_to" | "target_id" | "company_id" | "opportunity_id", sql: string, missing: string) => {
    if (!has(body, key)) return;
    if (body[key] === null || body[key] === "") { out[key] = null; return; }
    const id = String(body[key]);
    if (!db.prepare(sql).get(id, workspaceId)) throw new TaskRefused(missing);
    out[key] = id;
  };
  ref("assigned_to", "SELECT 1 FROM workspace_members WHERE user_id = ? AND workspace_id = ?", "That person is not a member of this workspace");
  ref("target_id", "SELECT 1 FROM targets WHERE id = ? AND workspace_id = ?", "Contact not found");
  ref("company_id", "SELECT 1 FROM companies WHERE id = ? AND workspace_id = ?", "Company not found");
  ref("opportunity_id", "SELECT 1 FROM opportunities WHERE id = ? AND workspace_id = ?", "Opportunity not found");
  return out;
}

/**
 * Make a task. `automatic` marks one Linki made by itself; `createdBy` is the member who
 * made it, when one did. Returns its id.
 */
export function createTask(db: DB, input: { workspaceId: string; title: string; automatic?: boolean; createdBy?: string | null } & Omit<TaskFields, "title">): string {
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO todos (id, workspace_id, target_id, company_id, opportunity_id, title, description, due_date, due_at, priority, assigned_to, automatic, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.workspaceId, input.target_id ?? null, input.company_id ?? null, input.opportunity_id ?? null, input.title.slice(0, 300), input.description ?? null,
      input.due_date ?? null, input.due_at ?? null, input.priority ?? "medium", input.assigned_to ?? null, input.automatic ? 1 : 0, input.createdBy ?? null,
    );
  } catch (error) {
    // A database whose tasks table has not been rebuilt yet (the copy before it could not be made) still needs a contact on every task.
    if (!input.target_id && /NOT NULL constraint failed: todos\.target_id/.test(String(error))) throw new TaskRefused("On this database a task still needs a contact. Restart Linki so it can finish upgrading its tasks, then try again.");
    throw error;
  }
  recordPipelineEvent(db, {
    workspaceId: input.workspaceId, kind: "task_created", subject: input.title, actorId: input.automatic ? null : input.createdBy ?? null,
    targetId: input.target_id, companyId: input.company_id, opportunityId: input.opportunity_id,
  });
  return id;
}

/** Change a task. Marking it done stamps when and notes who; opening it again clears that. */
export function updateTask(db: DB, workspaceId: string, id: string, fields: TaskFields & { status?: "open" | "done" }, actorId?: string | null): boolean {
  const before = db.prepare("SELECT title, status, target_id, company_id, opportunity_id FROM todos WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as
    | { title: string; status: string; target_id: string | null; company_id: string | null; opportunity_id: string | null } | undefined;
  if (!before) return false;
  const set: Record<string, unknown> = { ...fields };
  if (fields.status && fields.status !== before.status) set.completed_at = fields.status === "done" ? new Date().toISOString() : null;
  const keys = Object.keys(set).filter((key) => set[key] !== undefined);
  if (keys.length === 0) return true;
  try {
    db.prepare(`UPDATE todos SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ? AND workspace_id = ?`).run(...keys.map((key) => set[key]), id, workspaceId);
  } catch (error) {
    if (/NOT NULL constraint failed: todos\.target_id/.test(String(error))) throw new TaskRefused("On this database a task still needs a contact. Restart Linki so it can finish upgrading its tasks, then try again.");
    throw error;
  }
  if (fields.status === "done" && before.status !== "done") {
    recordPipelineEvent(db, { workspaceId, kind: "task_completed", subject: fields.title ?? before.title, actorId, targetId: before.target_id, companyId: before.company_id, opportunityId: before.opportunity_id });
  }
  return true;
}

// ── Reading them, for the screen ────────────────────────────────────────────────────────

export interface TaskItem {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "done";
  due_date: string | null;
  due_at: string | null;
  /** Open, and its day (or moment, when it has a time) has passed. */
  overdue: boolean;
  priority: Priority;
  automatic: boolean;
  created_at: string;
  completed_at: string | null;
  contact: { id: string; name: string; title: string | null } | null;
  company: { id: string | null; name: string } | null;
  opportunity: { id: string; name: string } | null;
  assignee: { id: string; name: string; email: string } | null;
}

export interface TaskFilters {
  status?: "open" | "done" | "all";
  /** A member id, 'me', or 'none'. */
  assignee?: string | null;
  overdue?: boolean;
  priority?: Priority | null;
  q?: string | null;
  target_id?: string | null;
  opportunity_id?: string | null;
}

export interface TaskCounts { open: number; overdue: number; mine: number; completed_today: number; done: number }

/** When a task falls due, as one instant: its moment if it has a time, else the end of its day (UTC). */
const DUE = "COALESCE(td.due_at, CASE WHEN td.due_date IS NOT NULL THEN td.due_date || 'T23:59:59.999Z' END)";
const memberName = (name: string | null, email: string | null) => name?.trim() || (email ?? "").split("@")[0] || "Someone";

function scope(workspaceId: string, userId: string | null, filters: TaskFilters, now: string): { sql: string; params: unknown[] } {
  const where = ["td.workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (filters.status === "open" || filters.status === "done") { where.push("td.status = ?"); params.push(filters.status); }
  if (filters.assignee === "none") where.push("td.assigned_to IS NULL");
  else if (filters.assignee) { where.push("td.assigned_to = ?"); params.push(filters.assignee === "me" ? userId ?? "" : filters.assignee); }
  if (filters.overdue) { where.push(`td.status = 'open' AND ${DUE} < ?`); params.push(now); }
  if (filters.priority) { where.push("td.priority = ?"); params.push(filters.priority); }
  if (filters.target_id) { where.push("td.target_id = ?"); params.push(filters.target_id); }
  if (filters.opportunity_id) { where.push("td.opportunity_id = ?"); params.push(filters.opportunity_id); }
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    where.push("(td.title LIKE ? ESCAPE '\\' OR t.full_name LIKE ? ESCAPE '\\' OR COALESCE(c.name, t.company) LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  return { sql: where.join(" AND "), params };
}

const FROM = `FROM todos td
  LEFT JOIN targets t ON t.id = td.target_id
  LEFT JOIN opportunities o ON o.id = td.opportunity_id
  LEFT JOIN companies c ON c.id = COALESCE(td.company_id, o.company_id, t.company_id)
  LEFT JOIN users u ON u.id = td.assigned_to`;

/** A page of tasks: open ones first by when they are due (soonest first, undated last), then done ones, latest first. */
export function listTasks(db: DB, ctx: { workspaceId: string; userId: string | null }, filters: TaskFilters, page: { limit: number; offset: number }, now: Date = new Date()): { tasks: TaskItem[]; total: number } {
  const at = now.toISOString();
  const where = scope(ctx.workspaceId, ctx.userId, filters, at);
  const total = (db.prepare(`SELECT COUNT(*) AS c ${FROM} WHERE ${where.sql}`).get(...where.params) as { c: number }).c;
  const rows = db.prepare(`
    SELECT td.id, td.title, td.description, td.status, td.due_date, td.due_at, td.priority, td.automatic, td.created_at, td.completed_at,
      td.status = 'open' AND ${DUE} < ? AS overdue,
      t.id AS contact_id, COALESCE(NULLIF(t.full_name, ''), t.email) AS contact_name, COALESCE(NULLIF(t.title, ''), t.headline) AS contact_title,
      c.id AS company_id, COALESCE(c.name, t.company) AS company_name, o.id AS opportunity_id, o.name AS opportunity_name,
      u.id AS assignee_id, u.name AS assignee_name, u.email AS assignee_email
    ${FROM} WHERE ${where.sql}
    ORDER BY td.status = 'done', CASE WHEN td.status = 'open' THEN ${DUE} IS NULL END, CASE WHEN td.status = 'open' THEN ${DUE} END,
      CASE td.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, COALESCE(td.completed_at, td.created_at) DESC, td.id
    LIMIT ? OFFSET ?`).all(at, ...where.params, page.limit, page.offset) as Array<Record<string, string | number | null>>;
  const text = (value: string | number | null) => (value === null ? null : String(value));
  return {
    total,
    tasks: rows.map((row): TaskItem => ({
      id: String(row.id), title: String(row.title), description: text(row.description), status: row.status === "done" ? "done" : "open",
      due_date: text(row.due_date), due_at: text(row.due_at), overdue: Boolean(row.overdue), priority: isPriority(row.priority) ? row.priority : "medium",
      automatic: row.automatic === 1, created_at: String(row.created_at), completed_at: text(row.completed_at),
      contact: row.contact_id ? { id: String(row.contact_id), name: text(row.contact_name) ?? "Contact", title: text(row.contact_title) } : null,
      company: row.company_name ? { id: text(row.company_id), name: String(row.company_name) } : null,
      opportunity: row.opportunity_id ? { id: String(row.opportunity_id), name: String(row.opportunity_name) } : null,
      assignee: row.assignee_id ? { id: String(row.assignee_id), name: memberName(text(row.assignee_name), text(row.assignee_email)), email: text(row.assignee_email) ?? "" } : null,
    })),
  };
}

/** The numbers beside the task list. `dayStart` is the start of today where the member is; without it, of today in UTC. */
export function taskCounts(db: DB, ctx: { workspaceId: string; userId: string | null }, now: Date = new Date(), dayStart?: string | null): TaskCounts {
  const start = dayStart && !Number.isNaN(Date.parse(dayStart)) ? new Date(dayStart).toISOString() : `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  return db.prepare(`SELECT
      COALESCE(SUM(td.status = 'open'), 0) AS open,
      COALESCE(SUM(td.status = 'open' AND ${DUE} < ?), 0) AS overdue,
      COALESCE(SUM(td.status = 'open' AND td.assigned_to = ?), 0) AS mine,
      COALESCE(SUM(td.status = 'done' AND td.completed_at >= ?), 0) AS completed_today,
      COALESCE(SUM(td.status = 'done'), 0) AS done
    FROM todos td WHERE td.workspace_id = ?`).get(now.toISOString(), ctx.userId ?? "", start, ctx.workspaceId) as TaskCounts;
}
