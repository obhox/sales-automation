import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { cancelImport } from "@/lib/import-jobs";
import { requireWorkspace } from "@/lib/workspace";

/** POST — cancel an import batch. A running batch stops at its next page boundary. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const ctx=requireWorkspace(req,res,"manager"); if(!ctx)return;
  const db = getDb();
  const id = req.query.id as string;

  const job = db.prepare("SELECT li.id, li.status FROM list_imports li JOIN lists l ON l.id=li.list_id WHERE li.id = ? AND l.workspace_id = ?").get(id,ctx.workspaceId) as
    | { id: string; status: string }
    | undefined;
  if (!job) return res.status(404).json({ error: "Import not found" });

  cancelImport(db, id);
  return res.json({ ok: true });
}
