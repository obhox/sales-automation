// Message templates: reusable wording a step can send instead of its own.
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

export const TEMPLATE_CHANNELS = ["linkedin", "email"] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

export interface Template {
  id: string;
  name: string;
  body: string;
  channel: TemplateChannel;
  /** An email template's subject line. Always null on a LinkedIn template. */
  subject: string | null;
  /** Groups templates so a step can take the whole set as its pool. */
  category: string | null;
  created_at: string;
}

export interface TemplateInput {
  name?: unknown;
  body?: unknown;
  channel?: unknown;
  subject?: unknown;
  category?: unknown;
}

const COLUMNS = "id, name, body, channel, subject, category, created_at";
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Why these fields cannot be saved, or null. `creating` requires what a new template cannot do without. */
export function templateProblem(input: TemplateInput, creating: boolean): string | null {
  if (creating && (!text(input.name, 200) || typeof input.body !== "string" || !input.body.trim())) return "name and body required";
  if (input.name !== undefined && input.name !== null && !text(input.name, 200)) return "name cannot be empty";
  if (input.body !== undefined && input.body !== null && (typeof input.body !== "string" || !input.body.trim())) return "body cannot be empty";
  if (input.channel !== undefined && input.channel !== null && !(TEMPLATE_CHANNELS as readonly unknown[]).includes(input.channel)) return `channel must be one of ${TEMPLATE_CHANNELS.join(", ")}`;
  for (const key of ["subject", "category"] as const) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== "string") return `${key} must be text`;
  }
  return null;
}

export function listTemplates(db: DB, workspaceId: string, filter: { channel?: string } = {}): Template[] {
  const byChannel = (TEMPLATE_CHANNELS as readonly string[]).includes(filter.channel ?? "");
  return db.prepare(`SELECT ${COLUMNS} FROM templates WHERE workspace_id = ?${byChannel ? " AND channel = ?" : ""} ORDER BY created_at DESC, rowid DESC`)
    .all(...(byChannel ? [workspaceId, filter.channel] : [workspaceId])) as Template[];
}

export function getTemplate(db: DB, workspaceId: string, id: string): Template | null {
  return (db.prepare(`SELECT ${COLUMNS} FROM templates WHERE id = ? AND workspace_id = ?`).get(id, workspaceId) as Template | undefined) ?? null;
}

/** Validate with templateProblem(input, true) first. */
export function createTemplate(db: DB, workspaceId: string, input: TemplateInput): Template {
  const id = randomUUID();
  const channel: TemplateChannel = input.channel === "email" ? "email" : "linkedin";
  db.prepare("INSERT INTO templates (id, workspace_id, name, body, channel, subject, category) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, workspaceId, text(input.name, 200), String(input.body), channel, channel === "email" ? text(input.subject, 300) : null, text(input.category, 80));
  return getTemplate(db, workspaceId, id)!;
}

/**
 * Change the fields that were sent; the rest stay. An empty subject or category clears it.
 * Returns null when there is no such template. Validate with templateProblem(input, false) first.
 */
export function updateTemplate(db: DB, workspaceId: string, id: string, input: TemplateInput): Template | null {
  const current = getTemplate(db, workspaceId, id);
  if (!current) return null;
  const channel: TemplateChannel = input.channel === "email" || input.channel === "linkedin" ? input.channel : current.channel;
  const subject = input.subject === undefined ? current.subject : text(input.subject, 300);
  db.prepare("UPDATE templates SET name = ?, body = ?, channel = ?, subject = ?, category = ? WHERE id = ? AND workspace_id = ?").run(
    text(input.name, 200) ?? current.name,
    typeof input.body === "string" && input.body.trim() ? input.body : current.body,
    channel,
    // A LinkedIn message has no subject line, so a template moved to LinkedIn loses its own.
    channel === "email" ? subject : null,
    input.category === undefined ? current.category : text(input.category, 80),
    id, workspaceId,
  );
  return getTemplate(db, workspaceId, id);
}

/** The categories in use, each with how many templates of each channel it holds. */
export function templateCategories(db: DB, workspaceId: string): Array<{ category: string; channel: TemplateChannel; templates: number }> {
  return db.prepare(
    "SELECT category, channel, COUNT(*) AS templates FROM templates WHERE workspace_id = ? AND category IS NOT NULL AND category != '' GROUP BY category, channel ORDER BY category COLLATE NOCASE",
  ).all(workspaceId) as Array<{ category: string; channel: TemplateChannel; templates: number }>;
}
