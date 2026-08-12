import { syncWorkspaceEmailInboxes } from "@/lib/email/inbox";

/**
 * Background runner for the manual "Check for replies now" sweep.
 *
 * The sweep opens an IMAP session per account with a 90s ceiling each, so a workspace with a
 * dozen mailboxes can legitimately run for minutes. Awaiting that inside the HTTP handler put
 * the whole sweep behind whatever timeout the caller happened to have: the browser saw a
 * hung request, and the MCP client gave up with -32001 and never learned the result even
 * though the work completed. The request now only starts the sweep; the outcome is read back
 * separately.
 */
export interface InboxSyncState {
  status: "idle" | "running" | "done" | "error";
  started_at: string | null;
  finished_at: string | null;
  result: { accounts: number; replies: number; bounces: number; skipped_no_imap: number } | null;
  error: string | null;
}

const IDLE: InboxSyncState = { status: "idle", started_at: null, finished_at: null, result: null, error: null };

// Keyed by workspace so one tenant's sweep never reports another's. Held on `global` for the
// same reason the runner loop is: Next.js re-evaluates modules across dev recompiles, and a
// fresh module instance would lose a sweep that is still running.
const g = global as typeof global & { __linkiInboxSync?: Map<string, InboxSyncState> };
const states = (g.__linkiInboxSync ??= new Map<string, InboxSyncState>());

export function getInboxSyncState(workspaceId: string): InboxSyncState {
  return states.get(workspaceId) ?? IDLE;
}

/**
 * Start a sweep unless one is already in flight for this workspace. Returns the state the
 * caller should report — `already_running` is not an error, it is the correct answer to
 * "sync now" when a sync is happening.
 */
export function startInboxSync(
  workspaceId: string,
  onFinish?: (result: NonNullable<InboxSyncState["result"]>) => void,
): { started: boolean; state: InboxSyncState } {
  const current = getInboxSyncState(workspaceId);
  if (current.status === "running") return { started: false, state: current };

  const state: InboxSyncState = { status: "running", started_at: new Date().toISOString(), finished_at: null, result: null, error: null };
  states.set(workspaceId, state);

  // Deliberately not awaited. Rejections are captured into the state rather than escaping as
  // an unhandled rejection, which in this process would take down the whole server.
  void syncWorkspaceEmailInboxes(workspaceId)
    .then((result) => {
      states.set(workspaceId, { status: "done", started_at: state.started_at, finished_at: new Date().toISOString(), result, error: null });
      try { onFinish?.(result); } catch { /* audit logging must never fail the sweep */ }
    })
    .catch((err) => {
      states.set(workspaceId, { status: "error", started_at: state.started_at, finished_at: new Date().toISOString(), result: null, error: err instanceof Error ? err.message : String(err) });
    });

  return { started: true, state };
}
