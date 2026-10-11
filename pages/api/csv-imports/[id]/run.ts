import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { runImport } from "@/lib/csv-import-store";
import { requireWorkspace, recordAudit } from "@/lib/workspace";

/**
 * POST : run the import. Makes the list if it is to be a new one, writes the rows in one
 * transaction, remembers the mapping for the next file with the same headers, and says it
 * is finished (the `import.finished` event and notification). It can run once.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx = requireWorkspace(req, res, "member"); if (!ctx) return;
  const id = String(req.query.id ?? "");
  const done = runImport(getDb(), ctx.workspaceId, id, ctx.userId);
  if (!done) return res.status(404).json({ error: "Import not found" });
  if ("error" in done) return res.status(400).json({ error: done.error });
  const { result } = done;
  if (result.new_list) recordAudit(ctx, "list.created", "list", result.list.id);
  recordAudit(ctx, "csv_import.finished", "csv_import", id, { list_id: result.list.id, created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors });
  return res.json(done);
}

export const config = { api: { responseLimit: false } };
