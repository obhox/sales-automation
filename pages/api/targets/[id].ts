import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { requireWorkspace, recordAudit } from "@/lib/workspace";
import { isValidTimeZone } from "@/lib/outreach/schedule";
import { TIMELINE_CHANNELS, contactProfile, contactTimeline, type TimelineChannel } from "@/lib/contacts/profile";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;

  if (req.method === "GET") {
    // What the contact profile reads. Without `view` the answer is the contact as the API
    // and the MCP tool have always been given it.
    if (req.query.view === "profile") {
      const profile = contactProfile(db, ctx.workspaceId, id);
      return profile ? res.json(profile) : res.status(404).json({ error: "Not found" });
    }
    if (req.query.view === "timeline") {
      const channel = TIMELINE_CHANNELS.includes(req.query.channel as TimelineChannel) ? (req.query.channel as TimelineChannel) : "all";
      const timeline = contactTimeline(db, ctx.workspaceId, id, { channel, limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0 });
      return timeline ? res.json(timeline) : res.status(404).json({ error: "Not found" });
    }
    const target = db.prepare("SELECT * FROM targets WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId);
    if (!target) return res.status(404).json({ error: "Not found" });

    const company = db.prepare("SELECT * FROM companies WHERE id = (SELECT company_id FROM targets WHERE id = ?) AND workspace_id = ?").get(id, ctx.workspaceId);
    const lists = db.prepare(`
      SELECT l.id, l.name FROM lists l
      INNER JOIN list_targets lt ON lt.list_id = l.id
      WHERE lt.target_id = ?
      ORDER BY l.name COLLATE NOCASE
    `).all(id);

    return res.json({ ...target as object, company: company ?? null, lists });
  }

  if (req.method === "PATCH") {
    const target = db.prepare("SELECT id, notes FROM targets WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId) as { id: string; notes: string | null } | undefined;
    if (!target) return res.status(404).json({ error: "Not found" });

    // Editable contact fields (CRM hygiene). Anything else is owned by enrichment/automation.
    const EDITABLE = [
      "first_name", "last_name", "full_name", "title", "company", "location",
      "email", "phone", "headline", "summary", "notes", "time_zone",
    ] as const;

    const body = req.body as Record<string, unknown>;
    // A zone the scheduler cannot read would silently mean "use the sender's", so refuse it here.
    if (typeof body.time_zone === "string" && body.time_zone.trim() !== "" && !isValidTimeZone(body.time_zone.trim())) {
      return res.status(400).json({ error: "time_zone must be a zone name such as Europe/Berlin or America/New_York" });
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const col of EDITABLE) {
      if (body[col] !== undefined) {
        const v = body[col];
        fields.push(`${col} = ?`);
        params.push(typeof v === "string" ? (v.trim() || null) : v);
      }
    }
    // Who looks after the contact: a member of this workspace, or nobody.
    if (body.owner_id !== undefined) {
      const owner = body.owner_id === null || body.owner_id === "" ? null : String(body.owner_id);
      if (owner && !db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ctx.workspaceId, owner)) {
        return res.status(400).json({ error: "The owner must be a member of this workspace" });
      }
      fields.push("owner_id = ?");
      params.push(owner);
    }
    // Notes say who last changed them and when, so the profile can show it.
    if (body.notes !== undefined) {
      const next = typeof body.notes === "string" ? body.notes.trim() || null : null;
      if (next !== (target.notes ?? null)) {
        fields.push("notes_updated_at = datetime('now')", "notes_updated_by = ?");
        params.push(ctx.userId);
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: "No editable fields provided" });
    params.push(id);
    db.prepare(`UPDATE targets SET ${fields.join(", ")} WHERE id = ? AND workspace_id = ?`).run(...params, ctx.workspaceId);

    recordAudit(ctx, "contact.updated", "contact", id, body);
    return res.json(db.prepare("SELECT * FROM targets WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId));
  }

  if (req.method === "DELETE") {
    const target = db.prepare("SELECT id FROM targets WHERE id = ? AND workspace_id = ?").get(id, ctx.workspaceId);
    if (!target) return res.status(404).json({ error: "Not found" });
    // Some references (run_profiles, logs) have no ON DELETE CASCADE — clear them first so the
    // FK constraint doesn't block the delete. run_profile_tracks cascade off run_profiles.
    db.transaction(() => {
      db.prepare("DELETE FROM run_profiles WHERE target_id = ?").run(id);
      db.prepare("DELETE FROM logs WHERE target_id = ?").run(id);
      db.prepare("DELETE FROM targets WHERE id = ? AND workspace_id = ?").run(id, ctx.workspaceId);
    })();
    recordAudit(ctx, "contact.deleted", "contact", id);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "PATCH", "DELETE"]);
  return res.status(405).end();
}
