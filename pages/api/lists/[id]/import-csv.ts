import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { importCsv, importCsvWithMapping, type ColumnMapping } from "@/lib/csv-import";
import { requireWorkspace } from "@/lib/workspace";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member");
  if (!ctx) return;

  const db = getDb();
  const listId = req.query.id as string;

  const list = db.prepare("SELECT id FROM lists WHERE id = ? AND workspace_id = ?").get(listId, ctx.workspaceId) as { id: string } | undefined;
  if (!list) return res.status(404).json({ error: "List not found" });

  const { csv, mapping } = req.body as { csv?: string; mapping?: unknown };
  if (!csv || typeof csv !== "string" || !csv.trim()) {
    return res.status(400).json({ error: "csv content is required" });
  }

  if (mapping !== undefined) {
    const validated = validateMapping(mapping);
    if ("error" in validated) return res.status(400).json({ error: validated.error });
    const result = importCsvWithMapping(db, listId, ctx.workspaceId, csv, validated.mapping);
    return res.json(result);
  }

  const result = importCsv(db, listId, ctx.workspaceId, csv);
  res.json(result);
}

// CSV text is posted as JSON — raise the request body limit well above the 1MB default
// so large lists don't get silently rejected with a 413 before reaching the handler.
export const config = {
  api: { bodyParser: { sizeLimit: "25mb" }, responseLimit: false },
};

const STANDARD_FIELDS = new Set([
  "linkedin_url", "sales_nav_url", "email",
  "first_name", "last_name", "title", "company", "location",
  "city", "country", "phone", "headline", "summary", "notes",
]);
const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]*$/;

// Defensive shape validation for a user-supplied column mapping.
function validateMapping(input: unknown): { mapping: ColumnMapping[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "mapping must be an array" };
  const out: ColumnMapping[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { error: "each mapping entry must be an object" };
    const m = raw as Record<string, unknown>;
    if (typeof m.column !== "string" || !m.column) return { error: "each mapping entry needs a column name" };
    if (m.kind === "ignore") {
      out.push({ column: m.column, kind: "ignore" });
    } else if (m.kind === "standard") {
      if (typeof m.field !== "string" || !STANDARD_FIELDS.has(m.field)) return { error: `unknown standard field for column "${m.column}"` };
      out.push({ column: m.column, kind: "standard", field: m.field as never });
    } else if (m.kind === "custom") {
      if (typeof m.key !== "string" || !CUSTOM_KEY_RE.test(m.key)) return { error: `invalid variable key for column "${m.column}"` };
      const fieldType = m.fieldType === "number" || m.fieldType === "boolean" ? m.fieldType : "text";
      const name = typeof m.name === "string" && m.name ? m.name : m.key;
      out.push({ column: m.column, kind: "custom", key: m.key, name, fieldType });
    } else {
      return { error: `invalid mapping kind for column "${m.column}"` };
    }
  }
  return { mapping: out };
}
