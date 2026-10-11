import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { discardImport, previewRows, readImport, updateImport } from "@/lib/csv-import-store";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * One CSV import.
 *
 *   GET     the import as its page shows it: the file's columns with what each is mapped to, where it
 *           goes, how duplicates are treated, and the lists, custom fields and draft campaigns to choose from
 *   GET ?view=rows&limit=   the first rows of the file as they are, to look at
 *   PATCH   { mapping?, automap?, list_mode?, list_id?, new_list_name?, match?, on_duplicate?, after?, step?,
 *             csv?, filename?, encoding? }   change any of it; what is left out stays as it was.
 *           `csv` replaces the file and maps its columns afresh; `automap: true` maps them by their names.
 *   DELETE  throw it away. An import that has run keeps the contacts it imported.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "PATCH" && req.method !== "DELETE") {
    res.setHeader("Allow", ["GET", "PATCH", "DELETE"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;
  const db = getDb();
  const id = String(req.query.id ?? "");

  if (req.method === "GET") {
    if (req.query.view === "rows") {
      const preview = previewRows(db, ctx.workspaceId, id, Number(req.query.limit) || 50);
      return preview ? res.json(preview) : res.status(404).json({ error: "Import not found" });
    }
    const found = readImport(db, ctx.workspaceId, id);
    return found ? res.json({ import: found }) : res.status(404).json({ error: "Import not found" });
  }

  if (req.method === "PATCH") {
    const changed = updateImport(db, ctx.workspaceId, id, (req.body ?? {}) as Record<string, unknown>);
    if (!changed) return res.status(404).json({ error: "Import not found" });
    if ("error" in changed) return res.status(400).json({ error: changed.error });
    return res.json({ import: changed });
  }

  if (!discardImport(db, ctx.workspaceId, id)) return res.status(404).json({ error: "Import not found" });
  recordAudit(ctx, "csv_import.discarded", "csv_import", id);
  return res.status(204).end();
}

export const config = { api: { bodyParser: { sizeLimit: "30mb" }, responseLimit: false } };
