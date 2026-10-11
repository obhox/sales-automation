// One conversation: read it, or change what the team has decided about it.
//
//   GET   /api/conversations/:id   the row, every message, the member's draft, and how it can be answered
//   PATCH /api/conversations/:id   any of:
//     status ("open" | "snoozed" | "closed"), snoozed_until (with "snoozed"; empty means until they next write)
//     assigned_to (member id or null), temperature ("hot" | "warm" | "cold" | null), sla_due_at (time or null)
//     add_tags / remove_tags (tag ids), read (true | false, for the member asking), lock (true | false)
//   A viewer may send `read` alone; everything else needs a member.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { conversationDetail } from "@/lib/conversations/detail";
import { conversationById } from "@/lib/conversations/rows";
import {
  assignConversation, lockConversation, markRead, markUnread, setAnswerDue, setStatus, setTemperature, settleConversations, tagConversation, unlockConversation, untagConversation,
} from "@/lib/conversations/store";
import { statusFrom, temperatureFrom } from "@/lib/conversations/vocabulary";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

const has = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key);

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "PATCH") {
    res.setHeader("Allow", ["GET", "PATCH"]);
    return res.status(405).end();
  }
  // Whether a member has read a conversation is their own business and nobody else's view
  // of it changes, so a viewer may set that and nothing more.
  const onlyRead = req.method === "PATCH" && Object.keys((req.body ?? {}) as Record<string, unknown>).every((key) => key === "read");
  const ctx = requireWorkspace(req, res, req.method === "GET" || onlyRead ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();
  const id = String(req.query.id ?? "");
  if (req.method === "GET") settleConversations(db, ctx.workspaceId);
  const conversation = conversationById(db, ctx.workspaceId, id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  if (req.method === "GET") return res.json(conversationDetail(db, ctx, conversation));

  const body = (req.body ?? {}) as Record<string, unknown>;
  const changed: Record<string, unknown> = {};

  // Everything is checked before anything is written, so a bad value changes nothing.
  let status: ReturnType<typeof statusFrom> = null;
  let until: string | null = null;
  if (has(body, "status")) {
    status = statusFrom(body.status);
    if (!status) return res.status(400).json({ error: "status must be open, snoozed or closed" });
    if (status === "snoozed" && body.snoozed_until) {
      const at = Date.parse(String(body.snoozed_until));
      if (Number.isNaN(at)) return res.status(400).json({ error: "snoozed_until must be a date and time" });
      if (at <= Date.now()) return res.status(400).json({ error: "snoozed_until must be in the future" });
      until = new Date(at).toISOString();
    }
  }
  const assignee = has(body, "assigned_to") ? (body.assigned_to === null || body.assigned_to === "" ? null : String(body.assigned_to)) : undefined;
  if (assignee && !db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ctx.workspaceId, assignee)) return res.status(400).json({ error: "That person is not a member of this workspace" });
  const temperature = has(body, "temperature") ? (body.temperature === null || body.temperature === "" ? null : temperatureFrom(body.temperature)) : undefined;
  if (has(body, "temperature") && body.temperature !== null && body.temperature !== "" && !temperature) return res.status(400).json({ error: "temperature must be hot, warm or cold" });
  let due: string | null | undefined;
  if (has(body, "sla_due_at")) {
    if (body.sla_due_at === null || body.sla_due_at === "") due = null;
    else {
      const at = Date.parse(String(body.sla_due_at));
      if (Number.isNaN(at)) return res.status(400).json({ error: "sla_due_at must be a date and time" });
      due = new Date(at).toISOString();
    }
  }
  const tagIds = (value: unknown) => (Array.isArray(value) ? value.map(String).slice(0, 50) : []);
  const addTags = tagIds(body.add_tags);
  const removeTags = tagIds(body.remove_tags);
  for (const tagId of addTags) {
    if (!db.prepare("SELECT 1 FROM inbox_tags WHERE id = ? AND workspace_id = ?").get(tagId, ctx.workspaceId)) return res.status(400).json({ error: "Tag not found" });
  }
  if ((has(body, "read") || has(body, "lock")) && !ctx.userId) return res.status(403).json({ error: "Read state and locks are kept per member" });
  if (body.lock === true && !lockConversation(db, conversation, ctx.userId!)) return res.status(409).json({ error: "A teammate is answering this conversation right now" });

  if (status) { setStatus(db, conversation, status, { until, userId: ctx.userId }); changed.status = status; if (status === "snoozed") changed.snoozed_until = until; }
  if (assignee !== undefined) { assignConversation(db, conversation, assignee, ctx.userId); changed.assigned_to = assignee; }
  if (temperature !== undefined) { setTemperature(db, conversation, temperature, ctx.userId); changed.temperature = temperature; }
  if (due !== undefined) { setAnswerDue(db, conversation, due); changed.sla_due_at = due; }
  for (const tagId of addTags) tagConversation(db, conversation.id, tagId);
  for (const tagId of removeTags) untagConversation(db, conversation.id, tagId);
  if (addTags.length) changed.add_tags = addTags;
  if (removeTags.length) changed.remove_tags = removeTags;
  if (body.lock === false) unlockConversation(db, conversation, ctx.userId, ctx.role);
  if (body.read === true) markRead(db, conversation.id, ctx.userId!);
  if (body.read === false) markUnread(db, conversation.id, ctx.userId!);

  // Reading and holding the lock are a member's own business; what the team decided is recorded.
  if (Object.keys(changed).length) recordAudit(ctx, "conversation.updated", "conversation", conversation.id, changed);
  return res.json(conversationDetail(db, ctx, conversationById(db, ctx.workspaceId, id)!));
}
