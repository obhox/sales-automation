import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { importCsv } from "@/lib/csv-import";
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

  const { csv } = req.body as { csv?: string };
  if (!csv || typeof csv !== "string" || !csv.trim()) {
    return res.status(400).json({ error: "csv content is required" });
  }

  const result = importCsv(db, listId, ctx.workspaceId, csv);
  res.json(result);
}
