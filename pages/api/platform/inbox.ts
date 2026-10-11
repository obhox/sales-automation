// What a team keeps about its inbox (tags, saved replies) and what it does to a
// conversation: who has it, where it stands, how warm it is, when an answer is due.
//
// A conversation is named here by one of its replies (`reply_id`, `reply_ids`), as it was
// when this state sat on the reply itself, or directly (`conversation_id`,
// `conversation_ids`). Either way the change lands on the conversation, so the next
// message from the same contact no longer undoes it.
import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { refileReplies, type ConversationRow } from "@/lib/conversations/rows";
import {
  assignConversation, findConversation, lockConversation, markRead, markUnread, setAnswerDue, setStatus, setTemperature, settleConversations,
  tagConversation, unlockConversation, untagConversation,
} from "@/lib/conversations/store";
import { statusFrom, temperatureFrom } from "@/lib/conversations/vocabulary";
import { recordAudit, requireWorkspace } from "@/lib/workspace";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireWorkspace(req, res, req.method === "GET" ? "viewer" : "member");
  if (!ctx) return;
  const db = getDb();
  if (req.method === "GET") {
    settleConversations(db, ctx.workspaceId, { force: true });
    const members = db.prepare(`SELECT u.id,u.email,wm.role FROM workspace_members wm JOIN users u ON u.id=wm.user_id
      WHERE wm.workspace_id=? ORDER BY u.email`).all(ctx.workspaceId);
    const tags = db.prepare("SELECT * FROM inbox_tags WHERE workspace_id=? ORDER BY name").all(ctx.workspaceId);
    const saved_replies = db.prepare("SELECT * FROM saved_replies WHERE workspace_id=? ORDER BY name").all(ctx.workspaceId);
    // Counted per conversation (one per contact), where it used to be per reply.
    const stats = db.prepare(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN status='open' THEN 1 ELSE 0 END), 0) open,
      COALESCE(SUM(CASE WHEN status='open' AND sla_due_at IS NOT NULL AND sla_due_at < ? THEN 1 ELSE 0 END), 0) overdue,
      COALESCE(SUM(CASE WHEN assigned_to IS NULL THEN 1 ELSE 0 END), 0) unassigned
      FROM conversations WHERE workspace_id=?`).get(new Date().toISOString(), ctx.workspaceId);
    return res.json({ members, tags, saved_replies, stats });
  }
  if (req.method !== "POST") return res.status(405).end();
  const body = req.body as Record<string, unknown>;
  const action = String(body.action ?? "");

  // ── Tags and saved replies ──────────────────────────────────────────────────────────
  if (action === "create_tag") {
    const name = String(body.name ?? "").trim(); if (!name) return res.status(400).json({ error: "name is required" });
    const color = String(body.color ?? "#64748b"); if (!HEX_COLOR.test(color)) return res.status(400).json({ error: "color must be a hex colour such as #64748b" });
    const id = randomUUID();
    try { db.prepare("INSERT INTO inbox_tags (id,workspace_id,name,color) VALUES (?,?,?,?)").run(id, ctx.workspaceId, name, color); }
    catch { return res.status(409).json({ error: "Tag already exists" }); }
    recordAudit(ctx, "inbox.tag_created", "inbox_tag", id); return res.status(201).json({ id });
  }
  if (action === "update_tag") {
    const id = String(body.id ?? "");
    if (!db.prepare("SELECT 1 FROM inbox_tags WHERE id=? AND workspace_id=?").get(id, ctx.workspaceId)) return res.status(404).json({ error: "Tag not found" });
    const name = body.name === undefined ? null : String(body.name).trim();
    const color = body.color === undefined ? null : String(body.color);
    if (name === "") return res.status(400).json({ error: "name is required" });
    if (color !== null && !HEX_COLOR.test(color)) return res.status(400).json({ error: "color must be a hex colour such as #64748b" });
    try { db.prepare("UPDATE inbox_tags SET name=COALESCE(?,name), color=COALESCE(?,color) WHERE id=? AND workspace_id=?").run(name, color, id, ctx.workspaceId); }
    catch { return res.status(409).json({ error: "Tag already exists" }); }
    recordAudit(ctx, "inbox.tag_updated", "inbox_tag", id); return res.json({ ok: true });
  }
  if (action === "create_saved_reply") {
    const name = String(body.name ?? "").trim(), replyBody = String(body.body ?? "").trim(); if (!name || !replyBody) return res.status(400).json({ error: "name and body are required" });
    const id = randomUUID(); db.prepare("INSERT INTO saved_replies (id,workspace_id,name,body,created_by) VALUES (?,?,?,?,?)").run(id, ctx.workspaceId, name, replyBody, ctx.userId);
    recordAudit(ctx, "inbox.saved_reply_created", "saved_reply", id); return res.status(201).json({ id });
  }
  if (action === "update_saved_reply") {
    const id = String(body.id ?? "");
    if (!db.prepare("SELECT 1 FROM saved_replies WHERE id=? AND workspace_id=?").get(id, ctx.workspaceId)) return res.status(404).json({ error: "Saved reply not found" });
    const name = body.name === undefined ? null : String(body.name).trim();
    const replyBody = body.body === undefined ? null : String(body.body).trim();
    if (name === "" || replyBody === "") return res.status(400).json({ error: "name and body cannot be empty" });
    db.prepare("UPDATE saved_replies SET name=COALESCE(?,name), body=COALESCE(?,body) WHERE id=? AND workspace_id=?").run(name, replyBody, id, ctx.workspaceId);
    recordAudit(ctx, "inbox.saved_reply_updated", "saved_reply", id); return res.json({ ok: true });
  }
  if (action === "delete_tag" || action === "delete_saved_reply") {
    const id = String(body.id ?? ""); const table = action === "delete_tag" ? "inbox_tags" : "saved_replies";
    db.prepare(`DELETE FROM ${table} WHERE id=? AND workspace_id=?`).run(id, ctx.workspaceId); recordAudit(ctx, `inbox.${action}`, table, id); return res.json({ ok: true });
  }

  // ── Which conversations ─────────────────────────────────────────────────────────────
  const replyIds = Array.isArray(body.reply_ids) ? body.reply_ids.map(String).slice(0, 500) : body.reply_id ? [String(body.reply_id)] : [];
  const conversationIds = Array.isArray(body.conversation_ids) ? body.conversation_ids.map(String).slice(0, 500) : body.conversation_id ? [String(body.conversation_id)] : [];
  if (!replyIds.length && !conversationIds.length) return res.status(400).json({ error: "reply_id or reply_ids is required" });
  const placeholders = replyIds.map(() => "?").join(",");
  let extra: Record<string, unknown> = {};

  if (action === "relink") {
    // Re-attach replies that lost their contact (the contact was deleted). With an explicit
    // target_id the operator picks the contact; without one each reply is matched to a contact
    // with the same email address, which is what recreating a deleted contact produces.
    if (!replyIds.length) return res.status(400).json({ error: "reply_id or reply_ids is required" });
    const owned = db.prepare(`SELECT id FROM email_replies WHERE workspace_id=? AND id IN (${placeholders})`).all(ctx.workspaceId, ...replyIds) as Array<{ id: string }>;
    if (owned.length !== replyIds.length) return res.status(404).json({ error: "One or more replies were not found" });
    const targetId = body.target_id === null || body.target_id === undefined ? null : String(body.target_id);
    if (targetId) {
      if (!db.prepare("SELECT 1 FROM targets WHERE id=? AND workspace_id=?").get(targetId, ctx.workspaceId)) return res.status(400).json({ error: "Contact not found in this workspace" });
      const linked = db.prepare(`UPDATE email_replies SET target_id=? WHERE id IN (${placeholders}) AND workspace_id=?`).run(targetId, ...replyIds, ctx.workspaceId);
      extra = { relinked: linked.changes, target_id: targetId };
    } else {
      const matched = db.prepare(`
        UPDATE email_replies SET target_id = (
          SELECT t.id FROM targets t
          WHERE t.workspace_id = email_replies.workspace_id AND lower(t.email) = lower(email_replies.from_email)
          ORDER BY t.created_at DESC LIMIT 1
        )
        WHERE id IN (${placeholders}) AND workspace_id = ? AND target_id IS NULL AND channel = 'email'
          AND EXISTS (SELECT 1 FROM targets t WHERE t.workspace_id = email_replies.workspace_id AND lower(t.email) = lower(email_replies.from_email))
      `).run(...replyIds, ctx.workspaceId);
      extra = { relinked: matched.changes, unmatched: replyIds.length - matched.changes };
    }
    // Each one moves to its contact's conversation, with what the team had decided about it.
    refileReplies(db, replyIds);
    recordAudit(ctx, "inbox.relink", "email_reply", replyIds[0], { reply_ids: replyIds, ...extra });
    return res.json({ ok: true, updated: replyIds.length, ...extra });
  }

  const conversations: ConversationRow[] = [];
  for (const replyId of replyIds) {
    const found = findConversation(db, ctx.workspaceId, { replyId });
    if (!found) return res.status(404).json({ error: "One or more replies were not found" });
    if (!conversations.some((conversation) => conversation.id === found.id)) conversations.push(found);
  }
  for (const conversationId of conversationIds) {
    const found = findConversation(db, ctx.workspaceId, { conversationId });
    if (!found) return res.status(404).json({ error: "One or more conversations were not found" });
    if (!conversations.some((conversation) => conversation.id === found.id)) conversations.push(found);
  }

  if (action === "lock") {
    if (!ctx.userId) return res.status(403).json({ error: "User identity required" });
    if (!lockConversation(db, conversations[0], ctx.userId)) return res.status(409).json({ error: "Reply is being handled by another teammate" });
  } else if (action === "unlock") {
    for (const conversation of conversations) unlockConversation(db, conversation, ctx.userId, ctx.role);
  } else if (action === "assign") {
    const assignee = body.assigned_to === null ? null : String(body.assigned_to ?? "");
    if (assignee && !db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?").get(ctx.workspaceId, assignee)) return res.status(400).json({ error: "Assignee is not a workspace member" });
    for (const conversation of conversations) assignConversation(db, conversation, assignee || null, ctx.userId);
  } else if (action === "status" || action === "snooze") {
    // 'pending' and 'resolved', the words a reply's status was once kept in, are read as snoozed and closed.
    const status = action === "snooze" ? "snoozed" : statusFrom(body.status);
    if (!status) return res.status(400).json({ error: "Invalid status" });
    const until = body.snoozed_until === null || body.snoozed_until === undefined || body.snoozed_until === "" ? null : Date.parse(String(body.snoozed_until));
    if (until !== null && Number.isNaN(until)) return res.status(400).json({ error: "snoozed_until must be a date and time" });
    if (until !== null && until <= Date.now()) return res.status(400).json({ error: "snoozed_until must be in the future" });
    for (const conversation of conversations) setStatus(db, conversation, status, { until: until === null ? null : new Date(until).toISOString(), userId: ctx.userId });
    extra = { status };
  } else if (action === "set_sla") {
    const due = body.sla_due_at === null || body.sla_due_at === undefined || body.sla_due_at === "" ? null : Date.parse(String(body.sla_due_at));
    if (due !== null && Number.isNaN(due)) return res.status(400).json({ error: "sla_due_at must be a date and time" });
    for (const conversation of conversations) setAnswerDue(db, conversation, due === null ? null : new Date(due).toISOString());
  } else if (action === "set_sentiment" || action === "set_temperature") {
    // Hot, warm or cold. 'positive', 'neutral' and 'negative' are read as those.
    const given = body.temperature ?? body.sentiment;
    const temperature = given === null || given === undefined ? null : temperatureFrom(given);
    if (given !== null && given !== undefined && !temperature) return res.status(400).json({ error: "sentiment must be hot, warm or cold" });
    for (const conversation of conversations) setTemperature(db, conversation, temperature, ctx.userId);
  } else if (action === "tag") {
    const tagId = String(body.tag_id ?? ""); if (!db.prepare("SELECT 1 FROM inbox_tags WHERE id=? AND workspace_id=?").get(tagId, ctx.workspaceId)) return res.status(400).json({ error: "Tag not found" });
    db.transaction(() => conversations.forEach((conversation) => tagConversation(db, conversation.id, tagId)))();
  } else if (action === "untag") {
    const tagId = String(body.tag_id ?? "");
    for (const conversation of conversations) untagConversation(db, conversation.id, tagId);
  } else if (action === "mark_read" || action === "mark_unread") {
    if (!ctx.userId) return res.status(403).json({ error: "User identity required" });
    for (const conversation of conversations) (action === "mark_read" ? markRead : markUnread)(db, conversation.id, ctx.userId);
  } else return res.status(400).json({ error: "Unknown action" });

  const ids = conversations.map((conversation) => conversation.id);
  recordAudit(ctx, `inbox.${action}`, replyIds.length ? "email_reply" : "conversation", replyIds[0] ?? ids[0], { ...(replyIds.length ? { reply_ids: replyIds } : {}), conversation_ids: ids, ...extra });
  return res.json({ ok: true, updated: replyIds.length || ids.length, ...extra });
}
