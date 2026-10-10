// Every request the inbox screen makes that changes something, in one place.
import { api, ApiError } from "@/lib/client/api";
import { attachmentPath, conversationPath, SYNC_PATH, VIEWS_PATH, type ConversationDetail, type InboxSyncStatus, type SavedView, type ViewState } from "./model";

type Detail = ConversationDetail;

export const patchConversation = (id: string, body: Record<string, unknown>) => api<Detail>(conversationPath(id), { method: "PATCH", body });
export const markAllRead = () => api<{ marked: number }>("/api/conversations/read", { method: "POST", body: {} });
export const checkReplies = () => api<InboxSyncStatus & { started: boolean }>(SYNC_PATH, { method: "POST" });

export interface DraftBody { channel: "email" | "linkedin"; body: string; subject?: string | null; email_account_id?: string | null; linkedin_account_id?: string | null }
export const saveDraft = (id: string, draft: DraftBody) => api<{ draft: Detail["draft"] }>(`${conversationPath(id)}/draft`, { method: "PUT", body: draft });
export const discardDraft = (id: string) => api(`${conversationPath(id)}/draft`, { method: "DELETE" });

export interface SendBody extends DraftBody { close?: boolean }
export const sendAnswer = (id: string, body: SendBody) => api<Detail & { sent: { channel: "email" | "linkedin"; status: "sent" | "queued" } }>(`${conversationPath(id)}/send`, { method: "POST", body });

/** Add a file to the draft. The file is the request body as it is, so this does not go through `api()`. */
export async function attachFile(id: string, file: File): Promise<void> {
  const response = await fetch(`${conversationPath(id)}/attachments?filename=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new ApiError(response.status, body?.error ?? "That file could not be added.", body);
}
export const removeAttachment = (attachmentId: string) => api(attachmentPath(attachmentId), { method: "DELETE" });

// ── Things done to one reply ────────────────────────────────────────────────────────────
export const reclassify = (replyId: string, verdict?: string) => api(`/api/inbox/${encodeURIComponent(replyId)}/reclassify`, { method: "POST", body: verdict ? { override_kind: verdict } : {} });
export const cancelFollowup = (replyId: string) => api(`/api/inbox/${encodeURIComponent(replyId)}/cancel-followup`, { method: "POST" });
export const relink = (replyId: string, targetId?: string) => api<{ relinked: number }>("/api/platform/inbox", { method: "POST", body: { action: "relink", reply_ids: [replyId], ...(targetId ? { target_id: targetId } : {}) } });

// ── A LinkedIn message that has not gone ────────────────────────────────────────────────
export const retryLinkedin = (messageId: string, confirm: boolean) => api("/api/inbox/linkedin-reply", { method: "POST", body: { retry_id: messageId, confirm } });
export const discardLinkedin = (messageId: string) => api("/api/inbox/linkedin-reply", { method: "DELETE", query: { id: messageId } });

// ── Tags and saved replies ──────────────────────────────────────────────────────────────
const team = <T = { ok: true }>(body: Record<string, unknown>) => api<T>("/api/platform/inbox", { method: "POST", body });
export const createTag = (name: string, color: string) => team<{ id: string }>({ action: "create_tag", name, color });
export const updateTag = (id: string, change: { name?: string; color?: string }) => team({ action: "update_tag", id, ...change });
export const deleteTag = (id: string) => team({ action: "delete_tag", id });
export const createSavedReply = (name: string, body: string) => team<{ id: string }>({ action: "create_saved_reply", name, body });
export const updateSavedReply = (id: string, change: { name?: string; body?: string }) => team({ action: "update_saved_reply", id, ...change });
export const deleteSavedReply = (id: string) => team({ action: "delete_saved_reply", id });

// ── Saved views ─────────────────────────────────────────────────────────────────────────
export const createView = (name: string, state: ViewState, shared: boolean) => api<SavedView>(VIEWS_PATH, { method: "POST", body: { resource: "inbox", name, state, shared } });
export const deleteView = (id: string) => api(VIEWS_PATH, { method: "DELETE", query: { id } });

export const setBookingLink = (url: string) => api<{ url: string | null }>("/api/platform/booking-link", { method: "PUT", body: { url } });

/**
 * Ask for a draft to be rewritten. Only called when the build says it has rewriting
 * (`capabilities.rewrite_route` in /api/conversations/meta), which today it does not.
 *
 * TO CHECK WHEN THE SEQUENCE BUILDER'S BRANCH IS MERGED: this sends what that branch's
 * POST /api/ai/rewrite is expected to take ({ text, channel }) and reads `text` (or
 * `body`) from the answer. If the route takes or returns something else, this function
 * is the only place to change.
 */
export async function rewriteDraft(route: string, input: { text: string; channel: "email" | "linkedin"; target_id?: string | null }): Promise<string> {
  const result = await api<{ text?: string; body?: string }>(route, { method: "POST", body: input });
  const text = result.text ?? result.body;
  if (!text?.trim()) throw new Error("The rewrite came back empty.");
  return text;
}
