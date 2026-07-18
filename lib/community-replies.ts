import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { addSuppression, removeSuppression } from "@/lib/platform/suppression";
import { emitDomainEvent } from "@/lib/platform/events";
import { sendEmailDurably } from "@/lib/email/infrastructure";

export type ReplyKind = "positive" | "negative" | "out_of_office" | "unsubscribe" | "human_review";
interface Verdict { kind: ReplyKind; confidence: number; summary: string; suggested_action: string; return_date?: string | null }

// Suppression is workspace-wide and hard to undo, so it must NOT hinge on the model's
// inferred intent (which happily labels a neutral "I have replied" as unsubscribe at
// confidence 1). Only an EXPLICIT opt-out in the reply text may suppress an address.
const EXPLICIT_OPT_OUT = /\bunsubscribe\b|\bremove me\b|stop (emailing|contacting|messaging)|do not (email|contact|message)|opt[ -]?out|take me off|no longer (wish|want)/i;

export const communityReplies = {
  shouldSyncInbox: () => false,
  syncAccountInbox: async () => 0,
  classifyAndDispatch,
};

export async function classifyAndDispatch(replyId: string, overrideKind?: ReplyKind): Promise<void> {
  const db = getDb();
  const reply = db.prepare(`SELECT er.*, t.email, t.full_name, t.workspace_id target_workspace
    FROM email_replies er JOIN targets t ON t.id = er.target_id WHERE er.id = ?`).get(replyId) as Record<string, unknown> | undefined;
  if (!reply) throw new Error("Reply not found");
  const workspaceId = String(reply.workspace_id ?? reply.target_workspace);
  try {
    // An explicit override lets a human correct a misclassification instead of just re-running
    // the same model (which would repeat the error). It dispatches through the same safe path.
    const verdict: Verdict = overrideKind
      ? { kind: overrideKind, confidence: 1, summary: "Manually reclassified", suggested_action: "manual", return_date: null }
      : await classifyReply(workspaceId, String(reply.subject ?? ""), String(reply.body_text ?? ""));
    const now = new Date().toISOString();
    db.prepare(`UPDATE email_replies SET classified_at = ?, classification_json = ?, classification_error = NULL,
      sentiment = ?, inbox_status = 'open', sla_due_at = COALESCE(sla_due_at, datetime('now', '+4 hours')) WHERE id = ?`)
      .run(now, JSON.stringify(verdict), verdict.kind === "positive" ? "positive" : verdict.kind === "negative" || verdict.kind === "unsubscribe" ? "negative" : "neutral", replyId);
    db.prepare("UPDATE targets SET reply_kind = ?, email_replied_at = COALESCE(email_replied_at, ?) WHERE id = ?")
      .run(verdict.kind, verdict.kind === "out_of_office" ? null : now, reply.target_id);

    // A human override to unsubscribe is an explicit, deliberate choice; the model's inferred
    // unsubscribe still requires explicit opt-out language in the reply.
    const explicitOptOut = overrideKind ? overrideKind === "unsubscribe" : EXPLICIT_OPT_OUT.test(String(reply.body_text ?? ""));
    let dispatch: Record<string, unknown> = { action: "human_review" };
    if (verdict.kind === "unsubscribe" && explicitOptOut) {
      // Genuine opt-out — honour it: suppress workspace-wide and unenroll.
      if (reply.email) addSuppression({ workspaceId, kind: "email", value: String(reply.email), reason: "unsubscribe", source: "reply_classifier", targetId: String(reply.target_id) });
      stopAutomation(String(reply.target_id), "Unsubscribed");
      dispatch = { action: "suppressed_and_unenrolled" };
    } else if (verdict.kind === "unsubscribe") {
      // The model inferred an opt-out but there's no explicit opt-out language. Halt the
      // sequence (any reply stops follow-ups) but do NOT suppress — flag for a human instead.
      stopAutomation(String(reply.target_id), "Reply — stopped (inferred opt-out, not suppressed)");
      createFollowup(workspaceId, String(reply.target_id), `Review reply from ${String(reply.full_name ?? reply.email ?? "contact")}`, verdict.summary);
      dispatch = { action: "unenrolled_and_flagged", note: "inferred opt-out without explicit language — not suppressed" };
    } else if (verdict.kind === "negative") {
      stopAutomation(String(reply.target_id), "Negative reply");
      dispatch = { action: "unenrolled" };
    } else if (verdict.kind === "positive") {
      stopAutomation(String(reply.target_id), "Positive reply — human follow-up");
      createFollowup(workspaceId, String(reply.target_id), `Follow up with ${String(reply.full_name ?? "interested prospect")}`, "Positive reply requires a personal response");
      // Alert the workspace so a human can jump on a warm lead. Non-fatal: a failed
      // notification must never block classification/dispatch of the reply itself.
      await notifyWorkspaceOfPositiveReply(workspaceId, replyId, reply, verdict);
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
    // Correction path: if a prior classification suppressed this address but this one doesn't
    // warrant it, lift the (classifier-created only) suppression — so reclassify actually
    // reverses a false positive instead of just re-running the model.
    if (dispatch.action !== "suppressed_and_unenrolled" && reply.email) {
      removeSuppression(workspaceId, "email", String(reply.email), { source: "reply_classifier" });
    }
    db.prepare("UPDATE email_replies SET dispatched_at = ?, dispatch_result_json = ? WHERE id = ?").run(now, JSON.stringify(dispatch), replyId);
    emitDomainEvent({ workspaceId, type: "reply.classified", entityType: "email_reply", entityId: replyId, payload: { target_id: reply.target_id, verdict, dispatch } });
  } catch (error) {
    db.prepare("UPDATE email_replies SET classification_error = ? WHERE id = ?").run(error instanceof Error ? error.message : String(error), replyId);
    throw error;
  }
}

const VALID_KINDS: ReplyKind[] = ["positive", "negative", "out_of_office", "unsubscribe", "human_review"];

/** Pull a Verdict out of a raw model response, tolerating markdown fences and
 *  surrounding prose. Returns null if no usable JSON object is present. */
function parseVerdict(content: string): Verdict | null {
  const cleaned = content.replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(match[0]); } catch { return null; }
  const kind = String(obj.kind ?? "").toLowerCase() as ReplyKind;
  if (!VALID_KINDS.includes(kind)) return null;
  return {
    kind,
    confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0)),
    summary: String(obj.summary ?? "").slice(0, 500),
    suggested_action: String(obj.suggested_action ?? "review"),
    return_date: obj.return_date ? String(obj.return_date) : null,
  };
}

async function classifyReply(workspaceId: string, subject: string, body: string): Promise<Verdict> {
  const text = `${subject}\n${body}`.trim();
  const deterministic = ruleVerdict(text);
  if (deterministic && deterministic.confidence >= 0.97) return deterministic;
  const row = getDb().prepare("SELECT api_key FROM integrations WHERE workspace_id = ? AND key = 'openrouter'").get(workspaceId) as { api_key: string } | undefined;
  const apiKey = decryptSecret(row?.api_key ?? null);
  const modelRow = getDb().prepare("SELECT default_model FROM workspace_ai_config WHERE workspace_id = ?").get(workspaceId) as { default_model: string | null } | undefined;
  if (!apiKey || !modelRow?.default_model) return deterministic ?? { kind: "human_review", confidence: 0.4, summary: "No AI classifier configured; manual review required", suggested_action: "review" };
  // No response_format: many models (including OpenRouter's free tier) reject strict
  // json_object mode. We instruct JSON-only in the prompt and parse it out defensively.
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelRow.default_model,
        temperature: 0,
        messages: [
          { role: "system", content: "You classify a single sales email reply. Respond with ONLY a compact JSON object and nothing else — no markdown, no code fences, no commentary. Keys: kind (exactly one of: positive, negative, out_of_office, unsubscribe, human_review), confidence (number 0-1), summary (short string), suggested_action (short string), return_date (ISO date string or null). 'unsubscribe' takes priority over every other label." },
          { role: "user", content: text.slice(0, 12_000) },
        ],
      }),
    });
    if (!response.ok) return deterministic ?? { kind: "human_review", confidence: 0.3, summary: `Classifier request failed (${response.status})`, suggested_action: "review" };
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = parseVerdict(json.choices?.[0]?.message?.content ?? "");
    return parsed ?? deterministic ?? { kind: "human_review", confidence: 0.3, summary: "Classifier returned no usable result", suggested_action: "review" };
  } catch {
    return deterministic ?? { kind: "human_review", confidence: 0.3, summary: "Classifier request failed", suggested_action: "review" };
  }
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

/** The address to alert when a warm lead comes in: the workspace owner, falling
 *  back to the highest-privilege earliest member. Returns null if none found. */
function positiveReplyNotifyRecipient(workspaceId: string): string | null {
  const row = getDb().prepare(
    `SELECT u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ?
       ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, wm.created_at
       LIMIT 1`,
  ).get(workspaceId) as { email: string } | undefined;
  return row?.email ?? null;
}

/** Strip quoted lines and collapse whitespace so the alert shows only what the
 *  prospect actually wrote, not the whole reply chain. */
function replySnippet(bodyText: string): string {
  return bodyText
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 600);
}

/** Email the workspace owner that a prospect replied positively. Sent through the
 *  same durable queue as outreach, from the account that received the reply, and
 *  keyed on the reply id so reclassification never double-sends. Swallows errors —
 *  losing a notification is acceptable; breaking reply dispatch is not. */
async function notifyWorkspaceOfPositiveReply(
  workspaceId: string,
  replyId: string,
  reply: Record<string, unknown>,
  verdict: Verdict,
): Promise<void> {
  try {
    const recipient = positiveReplyNotifyRecipient(workspaceId);
    const emailAccountId = reply.email_account_id ? String(reply.email_account_id) : null;
    if (!recipient || !emailAccountId) return;
    // Don't email the prospect's own address if it happens to match a member.
    if (reply.email && recipient.toLowerCase() === String(reply.email).toLowerCase()) return;

    const prospect = String(reply.full_name ?? reply.email ?? "a prospect");
    const prospectEmail = reply.email ? String(reply.email) : "";
    const snippet = replySnippet(String(reply.body_text ?? ""));
    const subject = `Positive reply from ${prospect}`;
    const body = [
      `${prospect}${prospectEmail ? ` (${prospectEmail})` : ""} just replied — and it looks positive.`,
      "",
      verdict.summary ? `Summary: ${verdict.summary}` : "",
      "",
      snippet ? `They wrote:\n${snippet}` : "",
      "",
      "This prospect has been unenrolled from automation and a follow-up task was created so you can reply personally.",
    ].filter((line) => line !== "").join("\n");

    await sendEmailDurably({
      workspaceId,
      emailAccountId,
      idempotencyKey: `positive-notify:${replyId}`,
      source: "positive_reply_notification",
      to: recipient,
      subject,
      body,
    });
  } catch (err) {
    console.warn(`[reply-notify] Failed to alert workspace of positive reply ${replyId}:`, err);
  }
}
