import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { MAX_SELECTION } from "@/lib/contacts/filters";
import { listContactTags } from "@/lib/contacts/table";
import { CONTACT_TAG_COLORS, MAX_TAGS, tagColor, tagName } from "@/lib/contacts/tags";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

// Contact tags: the labels a workspace puts on its contacts.
//
//   GET     the workspace's tags, each with how many contacts carry it
//   POST    { name, color? }                          make a tag (member)
//   PATCH   { id, name?, color? }                     rename or recolour one (manager)
//   DELETE  ?id=                                      remove one from every contact (manager)
//   PUT     { target_ids, add?, remove?, create? }    put tags on contacts or take them off (member)
//
// Anyone who can change contacts can make a tag and use it. Renaming or deleting one
// changes it for the whole workspace, so that takes a manager.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const minimum = req.method === "GET" ? "viewer" : req.method === "PATCH" || req.method === "DELETE" ? "manager" : "member";
  const ctx = requireWorkspace(req, res, minimum);
  if (!ctx) return;
  const db = getDb();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const owned = (id: unknown) => db.prepare("SELECT id, name, color FROM contact_tags WHERE id = ? AND workspace_id = ?").get(String(id ?? ""), ctx.workspaceId) as { id: string; name: string; color: string } | undefined;
  const taken = (name: string, exceptId = "") => Boolean(db.prepare("SELECT 1 FROM contact_tags WHERE workspace_id = ? AND name = ? AND id != ?").get(ctx.workspaceId, name, exceptId));

  /** Make a tag, or hand back the one already called that. */
  const ensure = (name: string, color: string): string => {
    const existing = db.prepare("SELECT id FROM contact_tags WHERE workspace_id = ? AND name = ?").get(ctx.workspaceId, name) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    db.prepare("INSERT INTO contact_tags (id, workspace_id, name, color, created_by) VALUES (?, ?, ?, ?, ?)").run(id, ctx.workspaceId, name, color, ctx.userId);
    recordAudit(ctx, "contact_tag.created", "contact_tag", id, { name });
    return id;
  };
  const roomForAnother = () => (db.prepare("SELECT COUNT(*) AS c FROM contact_tags WHERE workspace_id = ?").get(ctx.workspaceId) as { c: number }).c < MAX_TAGS;

  if (req.method === "GET") return res.json({ tags: listContactTags(db, ctx.workspaceId), colors: CONTACT_TAG_COLORS });

  if (req.method === "POST") {
    const named = tagName(body.name);
    if (typeof named === "string") return res.status(400).json({ error: named });
    if (taken(named.name)) return res.status(409).json({ error: `There is already a tag called "${named.name}"` });
    if (!roomForAnother()) return res.status(400).json({ error: `A workspace can keep up to ${MAX_TAGS} contact tags` });
    const id = ensure(named.name, tagColor(body.color));
    return res.status(201).json({ ...owned(id)!, count: 0 });
  }

  if (req.method === "PATCH") {
    const tag = owned(body.id);
    if (!tag) return res.status(404).json({ error: "Tag not found" });
    let name = tag.name;
    if (body.name !== undefined) {
      const named = tagName(body.name);
      if (typeof named === "string") return res.status(400).json({ error: named });
      if (taken(named.name, tag.id)) return res.status(409).json({ error: `There is already a tag called "${named.name}"` });
      name = named.name;
    }
    const color = body.color === undefined ? tag.color : tagColor(body.color);
    db.prepare("UPDATE contact_tags SET name = ?, color = ? WHERE id = ?").run(name, color, tag.id);
    recordAudit(ctx, "contact_tag.updated", "contact_tag", tag.id, { name, color });
    return res.json(owned(tag.id));
  }

  if (req.method === "DELETE") {
    const tag = owned(req.query.id);
    if (!tag) return res.status(404).json({ error: "Tag not found" });
    const removed = db.transaction(() => {
      const from = db.prepare("DELETE FROM target_tags WHERE tag_id = ?").run(tag.id).changes;
      db.prepare("DELETE FROM contact_tags WHERE id = ?").run(tag.id);
      return from;
    })();
    recordAudit(ctx, "contact_tag.deleted", "contact_tag", tag.id, { name: tag.name, contacts: removed });
    return res.json({ ok: true, removed_from: removed });
  }

  if (req.method === "PUT") {
    const targetIds = Array.isArray(body.target_ids) ? [...new Set(body.target_ids.filter((id): id is string => typeof id === "string" && id !== ""))] : [];
    if (targetIds.length === 0) return res.status(400).json({ error: "target_ids must be a non-empty array" });
    if (targetIds.length > MAX_SELECTION) return res.status(400).json({ error: `At most ${MAX_SELECTION} contacts can be tagged at once` });
    const addIds = Array.isArray(body.add) ? body.add.map(String) : [];
    const removeIds = Array.isArray(body.remove) ? body.remove.map(String) : [];
    // `create` names a tag to make (if it is not there yet) and add in the same step.
    let created: string | null = null;
    if (body.create !== undefined) {
      const named = tagName(body.create);
      if (typeof named === "string") return res.status(400).json({ error: named });
      if (!taken(named.name) && !roomForAnother()) return res.status(400).json({ error: `A workspace can keep up to ${MAX_TAGS} contact tags` });
      created = ensure(named.name, tagColor(body.color));
      addIds.push(created);
    }
    if (addIds.length === 0 && removeIds.length === 0) return res.status(400).json({ error: "Name at least one tag to add or remove" });
    for (const id of [...addIds, ...removeIds]) if (!owned(id)) return res.status(404).json({ error: "Tag not found" });

    const marks = targetIds.map(() => "?").join(",");
    const contacts = (db.prepare(`SELECT id FROM targets WHERE workspace_id = ? AND id IN (${marks})`).all(ctx.workspaceId, ...targetIds) as { id: string }[]).map((row) => row.id);
    const insert = db.prepare("INSERT OR IGNORE INTO target_tags (target_id, tag_id) VALUES (?, ?)");
    const remove = db.prepare("DELETE FROM target_tags WHERE target_id = ? AND tag_id = ?");
    const result = db.transaction(() => {
      let added = 0;
      let removed = 0;
      for (const contact of contacts) {
        for (const tag of addIds) added += insert.run(contact, tag).changes;
        for (const tag of removeIds) removed += remove.run(contact, tag).changes;
      }
      return { added, removed };
    })();
    recordAudit(ctx, "contact.tags_changed", "contact", contacts.length === 1 ? contacts[0] : undefined, { contacts: contacts.length, add: addIds, remove: removeIds });
    return res.json({ contacts: contacts.length, ...result, created_tag_id: created });
  }

  res.setHeader("Allow", ["GET", "POST", "PATCH", "DELETE", "PUT"]);
  return res.status(405).end();
}
