import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";

// Search across the workspace for the command palette: a few of each kind, best first.
// The client turns a kind and an id into a link, so this does not need to know which
// screens exist.

export type SearchKind = "contact" | "company" | "campaign" | "list" | "template";

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
}

const PER_KIND = 5;
const MAX_QUERY = 80;

/** A LIKE pattern that treats the user's text literally. */
function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, character => `\\${character}`)}%`;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "viewer");
  if (!ctx) return;

  const query = (Array.isArray(req.query.q) ? req.query.q[0] : req.query.q ?? "").trim().slice(0, MAX_QUERY);
  if (query.length < 2) return res.json({ query, results: [] });

  const db = getDb();
  const like = contains(query);
  const starts = `${query.replace(/[\\%_]/g, character => `\\${character}`)}%`;
  const ws = ctx.workspaceId;
  // Names that start with the text come before names that merely contain it.
  const rank = (column: string) => `CASE WHEN ${column} LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, ${column} COLLATE NOCASE`;

  const contacts = db
    .prepare(
      `SELECT id, COALESCE(NULLIF(full_name, ''), email, linkedin_url) AS title,
              NULLIF(TRIM(COALESCE(title, '') || CASE WHEN title IS NOT NULL AND company IS NOT NULL THEN ' · ' ELSE '' END || COALESCE(company, '')), '') AS subtitle
       FROM targets
       WHERE workspace_id = ? AND (full_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\')
       ORDER BY ${rank("full_name")} LIMIT ?`,
    )
    .all(ws, like, like, like, starts, PER_KIND) as Omit<SearchResult, "kind">[];
  const companies = db
    .prepare(
      `SELECT id, name AS title, domain AS subtitle FROM companies
       WHERE workspace_id = ? AND (name LIKE ? ESCAPE '\\' OR domain LIKE ? ESCAPE '\\')
       ORDER BY ${rank("name")} LIMIT ?`,
    )
    .all(ws, like, like, starts, PER_KIND) as Omit<SearchResult, "kind">[];
  const campaigns = db
    .prepare(
      `SELECT id, name AS title, CASE WHEN is_archived = 1 THEN 'Archived' ELSE NULL END AS subtitle FROM workflows
       WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\'
       ORDER BY is_archived, ${rank("name")} LIMIT ?`,
    )
    .all(ws, like, starts, PER_KIND) as Omit<SearchResult, "kind">[];
  const lists = db
    .prepare(
      `SELECT l.id, l.name AS title, (SELECT COUNT(*) FROM list_targets lt WHERE lt.list_id = l.id) || ' contacts' AS subtitle FROM lists l
       WHERE l.workspace_id = ? AND l.name LIKE ? ESCAPE '\\'
       ORDER BY ${rank("l.name")} LIMIT ?`,
    )
    .all(ws, like, starts, PER_KIND) as Omit<SearchResult, "kind">[];
  const templates = db
    .prepare(
      `SELECT id, name AS title, NULL AS subtitle FROM templates
       WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\'
       ORDER BY ${rank("name")} LIMIT ?`,
    )
    .all(ws, like, starts, PER_KIND) as Omit<SearchResult, "kind">[];

  const tag = (kind: SearchKind, rows: Omit<SearchResult, "kind">[]): SearchResult[] => rows.map(row => ({ kind, ...row }));
  return res.json({
    query,
    results: [...tag("contact", contacts), ...tag("company", companies), ...tag("campaign", campaigns), ...tag("list", lists), ...tag("template", templates)],
  });
}
