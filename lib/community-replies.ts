import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { addSuppression } from "@/lib/platform/suppression";
import { emitDomainEvent } from "@/lib/platform/events";

export type ReplyKind = "positive" | "negative" | "out_of_office" | "unsubscribe" | "human_review";
interface Verdict { kind: ReplyKind; confidence: number; summary: string; suggested_action: string; return_date?: string | null }

export const communityReplies = {
  shouldSyncInbox: () => false,
  syncAccountInbox: async () => 0,
  classifyAndDispatch,
};

export async function classifyAndDispatch(replyId: string): Promise<void> {
  const db = getDb();
  const reply = db.prepare(`SELECT er.*, t.email, t.full_name, t.workspace_id target_workspace
    FROM email_replies er JOIN targets t ON t.id = er.target_id WHERE er.id = ?`).get(replyId) as Record<string, unknown> | undefined;
  if (!reply) throw new Error("Reply not found");
  const workspaceId = String(reply.workspace_id ?? reply.target_workspace);
  try {
    const verdict = await classifyReply(workspaceId, String(reply.subject ?? ""), String(reply.body_text ?? ""));
    const now = new Date().toISOString();
    db.prepare(`UPDATE email_replies SET classified_at = ?, classification_json = ?, classification_error = NULL,
      sentiment = ?, inbox_status = 'open', sla_due_at = COALESCE(sla_due_at, datetime('now', '+4 hours')) WHERE id = ?`)
      .run(now, JSON.stringify(verdict), verdict.kind === "positive" ? "positive" : verdict.kind === "negative" || verdict.kind === "unsubscribe" ? "negative" : "neutral", replyId);
    db.prepare("UPDATE targets SET reply_kind = ?, email_replied_at = COALESCE(email_replied_at, ?) WHERE id = ?")
      .run(verdict.kind, verdict.kind === "out_of_office" ? null : now, reply.target_id);

    let dispatch: Record<string, unknown> = { action: "human_review" };
    if (verdict.kind === "unsubscribe") {
      if (reply.email) addSuppression({ workspaceId, kind: "email", value: String(reply.email), reason: "unsubscribe", source: "reply_classifier", targetId: String(reply.target_id) });
      stopAutomation(String(reply.target_id), "Unsubscribed");
      dispatch = { action: "suppressed_and_unenrolled" };
    } else if (verdict.kind === "negative") {
      stopAutomation(String(reply.target_id), "Negative reply");
      dispatch = { action: "unenrolled" };
    } else if (verdict.kind === "positive") {
      stopAutomation(String(reply.target_id), "Positive reply — human follow-up");
      createFollowup(workspaceId, String(reply.target_id), `Follow up with ${String(reply.full_name ?? "interested prospect")}`, "Positive reply requires a personal response");
      dispatch = { action: "unenrolled_and_task_created" };
    } else if (verdict.kind === "out_of_office") {
      const scheduled = verdict.return_date && !Number.isNaN(Date.parse(verdict.return_date)) ? new Date(verdict.return_date).toISOString() : new Date(Date.now() + 7 * 86400_000).toISOString();
      db.prepare(`UPDATE run_profile_tracks SET next_step_at = ?, pending_reply_context = ? WHERE run_profile_id IN
        (SELECT id FROM run_profiles WHERE target_id = ?) AND state IN ('pending','in_progress')`)
        .run(scheduled, JSON.stringify({ reply: reply.body_text, summary: verdict.summary }), reply.target_id);
      dispatch = { action: "rescheduled", scheduled_for: scheduled };
    } else {
      stopAutomation(String(reply.target_id), "Reply needs human review");
      createFollowup(workspaceId, String(reply.target_id), `Review reply from ${String(reply.full_name ?? reply.email ?? "contact")}`, verdict.summary);
      dispatch = { action: "paused_and_task_created" };
    }
    db.prepare("UPDATE email_replies SET dispatched_at = ?, dispatch_result_json = ? WHERE id = ?").run(now, JSON.stringify(dispatch), replyId);
    emitDomainEvent({ workspaceId, type: "reply.classified", entityType: "email_reply", entityId: replyId, payload: { target_id: reply.target_id, verdict, dispatch } });
  } catch (error) {
    db.prepare("UPDATE email_replies SET classification_error = ? WHERE id = ?").run(error instanceof Error ? error.message : String(error), replyId);
    throw error;
  }
}

async function classifyReply(workspaceId: string, subject: string, body: string): Promise<Verdict> {
  const text = `${subject}\n${body}`.trim();
  const deterministic = ruleVerdict(text);
  if (deterministic && deterministic.confidence >= 0.97) return deterministic;
  const row = getDb().prepare("SELECT api_key FROM integrations WHERE workspace_id = ? AND key = 'openrouter'").get(workspaceId) as { api_key: string } | undefined;
  const apiKey = decryptSecret(row?.api_key ?? null);
  const modelRow = getDb().prepare("SELECT default_model FROM workspace_ai_config WHERE workspace_id = ?").get(workspaceId) as { default_model: string | null } | undefined;
  if (!apiKey || !modelRow?.default_model) return deterministic ?? { kind: "human_review", confidence: 0.4, summary: "No AI classifier configured; manual review required", suggested_action: "review" };
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: modelRow.default_model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: "Classify a sales reply. Return JSON only with kind (positive|negative|out_of_office|unsubscribe|human_review), confidence 0-1, summary, suggested_action, and optional return_date ISO date. Unsubscribe must take priority over every other label." }, { role: "user", content: text.slice(0, 12_000) }] }) });
  if (!response.ok) return deterministic ?? { kind: "human_review", confidence: 0.3, summary: "Classifier request failed", suggested_action: "review" };
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as Verdict;
  if (!["positive", "negative", "out_of_office", "unsubscribe", "human_review"].includes(parsed.kind)) throw new Error("Classifier returned an invalid kind");
  return { ...parsed, confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)) };
}

function ruleVerdict(text: string): Verdict | null {
  const lower = text.toLowerCase();
  if (/unsubscribe|remove me|stop (emailing|contacting)|do not (email|contact)|opt[ -]?out|take me off/.test(lower)) return { kind: "unsubscribe", confidence: 1, summary: "Explicit opt-out request", suggested_action: "suppress" };
  if (/out of (the )?office|automatic reply|auto-?reply|on (annual )?leave|away from (my )?email|returning on/.test(lower)) return { kind: "out_of_office", confidence: 0.99, summary: "Out-of-office automatic response", suggested_action: "reschedule" };
  if (/not interested|no thanks|not a priority|we('re| are) all set|do not need|pass on this/.test(lower)) return { kind: "negative", confidence: 0.98, summary: "Prospect declined", suggested_action: "unenroll" };
  if (/sounds (good|interesting)|let's (talk|chat)|book|schedule|interested|send me|tell me more|available (on|tomorrow|next)/.test(lower)) return { kind: "positive", confidence: 0.97, summary: "Prospect expressed interest", suggested_action: "human_followup" };
  return null;
}

function stopAutomation(targetId: string, reason: string) {
  getDb().prepare(`UPDATE run_profile_tracks SET state = 'skipped', error_message = ? WHERE run_profile_id IN
    (SELECT id FROM run_profiles WHERE target_id = ?) AND state NOT IN ('completed','failed','skipped')`).run(reason, targetId);
}
function createFollowup(workspaceId: string, targetId: string, title: string, description: string) {
  getDb().prepare("INSERT INTO todos (id, workspace_id, target_id, title, description, due_date) VALUES (?, ?, ?, ?, ?, date('now', '+1 day'))")
    .run(randomUUID(), workspaceId, targetId, title, description);
}
