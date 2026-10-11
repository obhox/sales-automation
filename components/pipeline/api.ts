// Every request the pipeline screen makes that changes something, in one place. Paths are
// written out in full so scripts/check-route-coverage.mjs can see which routes the screen uses.
import { api } from "@/lib/client/api";
import type { LogType, Opportunity, Priority, StageKind } from "./model";

// ── Opportunities ───────────────────────────────────────────────────────────────────────
export interface OpportunityBody {
  name?: string; amount?: number | null; currency?: string; expected_close_date?: string | null; stage_id?: string | null;
  owner_id?: string | null; target_id?: string | null; company_id?: string | null; source?: string | null;
}
export const createOpportunity = (body: OpportunityBody) => api<Opportunity>("/api/platform/pipeline", { method: "POST", body });
export const updateOpportunity = (id: string, change: OpportunityBody) => api<Opportunity>("/api/platform/pipeline", { method: "PATCH", body: { id, ...change } });
export const deleteOpportunity = (id: string) => api("/api/platform/pipeline", { method: "DELETE", query: { id } });

// ── Stages, and what the pipeline does by itself ────────────────────────────────────────
const kindFields = (kind: StageKind) => ({ is_won: kind === "won", is_lost: kind === "lost" });
export const createStage = (stage: { name: string; probability: number; kind: StageKind }) =>
  api<{ id: string }>("/api/platform/pipeline", { method: "POST", body: { entity: "stage", name: stage.name, probability: stage.probability, ...kindFields(stage.kind) } });
export const updateStage = (id: string, change: { name?: string; probability?: number; kind?: StageKind }) =>
  api("/api/platform/pipeline", { method: "PATCH", body: { entity: "stage", id, name: change.name, probability: change.probability, ...(change.kind ? kindFields(change.kind) : {}) } });
export const reorderStages = (ids: string[]) => api("/api/platform/pipeline", { method: "PATCH", body: { entity: "stage_order", ids } });
export const deleteStage = (id: string, moveTo?: string) => api<{ moved: number }>("/api/platform/pipeline", { method: "DELETE", query: { stage_id: id, move_to: moveTo } });
export const setAutoOpportunity = (on: boolean) => api("/api/platform/pipeline", { method: "PATCH", body: { entity: "settings", auto_opportunity_on_reply: on } });

// ── Tasks ───────────────────────────────────────────────────────────────────────────────
export interface TaskBody {
  title?: string; description?: string | null; due_date?: string | null; due_at?: string | null; priority?: Priority;
  assigned_to?: string | null; target_id?: string | null; company_id?: string | null; opportunity_id?: string | null; status?: "open" | "done";
}
export const createTask = (body: TaskBody) => api<{ id: string }>("/api/todos", { method: "POST", body });
export const updateTask = (id: string, change: TaskBody) => api(`/api/todos/${encodeURIComponent(id)}`, { method: "PATCH", body: change });
export const deleteTask = (id: string) => api(`/api/todos/${encodeURIComponent(id)}`, { method: "DELETE" });

// ── Activity ────────────────────────────────────────────────────────────────────────────
export const logActivity = (entry: { target_id: string; type: LogType; body: string }) => api("/api/activity-logs", { method: "POST", body: entry });

// ── Meetings and calendars ──────────────────────────────────────────────────────────────
export const linkMeeting = (id: string, targetId: string) => api("/api/pipeline/meetings", { method: "PATCH", body: { id, target_id: targetId } });
export const addCalendarFeed = (name: string, url: string) => api<{ id: string }>("/api/platform/connections", { method: "POST", body: { provider: "ical", name, config: { url } } });
/** Read a calendar now. Answers with how many meetings were new. */
export const readCalendar = (id: string) => api<{ meetings_imported?: number }>("/api/platform/connections", { method: "PUT", body: { id } });
export const removeCalendar = (id: string) => api("/api/platform/connections", { method: "DELETE", query: { id } });
/** Where the browser goes to sign in to a calendar. A link, not a request: the provider's page takes over the tab. */
export const calendarSignInHref = (provider: "google_calendar" | "microsoft_calendar") => `/api/platform/calendar-oauth/${provider}/start`;
