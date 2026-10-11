import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { createImport, listImports } from "@/lib/csv-import-store";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * CSV imports that keep a record, so one can be left part-way and picked up again.
 *
 *   GET                                         the imports still being set up, and those that ran this week
 *   POST { csv, filename, encoding?, list_id? } start one from a file's text. Its columns come back mapped:
 *                                               the way the workspace last mapped these headers, or by their names
 *
 * Nothing is imported until POST /api/csv-imports/{id}/run. Importing is a member's job.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;
  const db = getDb();

  if (req.method === "GET") return res.json({ imports: listImports(db, ctx.workspaceId) });

  const created = createImport(db, ctx.workspaceId, ctx.userId, (req.body ?? {}) as Record<string, unknown>);
  if ("error" in created) return res.status(400).json({ error: created.error });
  recordAudit(ctx, "csv_import.started", "csv_import", created.id, { filename: created.file.name, rows: created.file.rows });
  return res.status(201).json({ import: created });
}

// The file is posted as text inside JSON, so the limit is raised well above the 1 MB default.
export const config = { api: { bodyParser: { sizeLimit: "30mb" }, responseLimit: false } };
