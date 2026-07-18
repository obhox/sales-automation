import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, requireWorkspaceEntity } from "@/lib/workspace";

// Add EXISTING contacts to a list by id (membership only — does not create
// contacts). Idempotent: already-member ids are skipped. This is the inverse of
// remove-members and the way to UNDO a removal (feed back removed_contact_ids).
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const ctx=requireWorkspace(req,res,"member"); if(!ctx)return;

  const db = getDb();
  const list_id = req.query.id as string;
  if(!requireWorkspaceEntity(res,ctx,"lists",list_id))return;

  const list = db.prepare("SELECT id FROM lists WHERE id = ?").get(list_id);
  if (!list) return res.status(404).json({ error: "List not found" });

  // Accept both `contact_ids` (web UI) and `target_ids` (MCP tools and the other list
  // endpoints use this name) so the two don't silently reject each other.
  const body = req.body as { contact_ids?: string[]; target_ids?: string[] };
  const contact_ids = (Array.isArray(body.contact_ids) && body.contact_ids.length ? body.contact_ids : body.target_ids) ?? [];
  if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
    return res.status(400).json({ error: "contact_ids[] (or target_ids[]) is required." });
  }

  // Only add ids that actually exist as contacts (ignore unknown ids rather
  // than failing the whole batch).
  const placeholders = contact_ids.map(() => "?").join(", ");
  const existing = db
    .prepare(`SELECT id, full_name, title FROM targets WHERE workspace_id = ? AND id IN (${placeholders})`)
    .all(ctx.workspaceId,...contact_ids) as Array<{ id: string; full_name: string | null; title: string | null }>;
  const existingIds = new Set(existing.map((r) => r.id));
  const unknown = contact_ids.filter((id) => !existingIds.has(id));

  const insert = db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)");
  let added = 0;
  const addTx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      const info = insert.run(list_id, id);
      if (info.changes > 0) added++;
    }
  });
  addTx([...existingIds]);

  const total = (db.prepare("SELECT COUNT(*) as c FROM list_targets WHERE list_id = ?").get(list_id) as { c: number }).c;

  return res.json({
    added,
    already_members: existingIds.size - added,
    unknown_contact_ids: unknown,
    list_total: total,
    contacts_added: existing,
  });
}
