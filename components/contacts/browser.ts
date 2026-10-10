// The few places the Contacts screens touch the browser directly: a preference kept in
// local storage, the list a profile was opened from, and saving a file the server sends.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ApiError, apiUrl, type Query } from "@/lib/client/api";

const listeners = new Set<() => void>();
// Used when storage is switched off (private windows): the choice lasts for the visit.
const memory = new Map<string, string>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

/**
 * A small preference kept in this browser. `parse` turns whatever was stored (or null)
 * into a usable value, so a value written by an older version never breaks the screen.
 */
export function useStoredPreference<T>(key: string, parse: (stored: unknown) => T): [T, (next: T) => void] {
  const raw = useSyncExternalStore(subscribe, () => readRaw(key), () => null);
  const value = useMemo(() => {
    try {
      return parse(raw === null ? null : JSON.parse(raw));
    } catch {
      return parse(null);
    }
  }, [raw, parse]);
  const save = useCallback(
    (next: T) => {
      const text = JSON.stringify(next);
      memory.set(key, text);
      try {
        window.localStorage.setItem(key, text);
      } catch {
        // Kept in memory instead.
      }
      listeners.forEach((listener) => listener());
    },
    [key],
  );
  return [value, save];
}

// ── The list a profile was opened from ────────────────────────────────────────

const CONTEXT_KEY = "linki.contacts.context";

export interface ListContext {
  /** The list request the contact was found in, without paging: filters, search and sort. */
  query: Record<string, string>;
  /** Where to go back to: the contacts page with that same state in its address. */
  href: string;
}

/** Remember which result set a profile is being opened from, so it can step to the next one. */
export function rememberListContext(context: ListContext): void {
  try {
    window.sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(context));
  } catch {
    // Without it the profile simply has no previous and next.
  }
}

export function recallListContext(): ListContext | null {
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(CONTEXT_KEY) ?? "null");
    if (!stored || typeof stored !== "object") return null;
    const { query, href } = stored as Partial<ListContext>;
    return query && typeof query === "object" && typeof href === "string" ? { query: query as Record<string, string>, href } : null;
  } catch {
    return null;
  }
}

const noSubscription = () => () => {};
const readContext = () => {
  try {
    return window.sessionStorage.getItem(CONTEXT_KEY);
  } catch {
    return null;
  }
};

/** The list the profile was opened from, read once the page is in the browser. Null when it was opened some other way. */
export function useListContext(): ListContext | null {
  // Session storage does not announce changes, and none is expected while a profile is open.
  const raw = useSyncExternalStore(noSubscription, readContext, () => null);
  return useMemo(() => (raw ? recallListContext() : null), [raw]);
}

// ── Files ─────────────────────────────────────────────────────────────────────

/**
 * Ask the server for a file and save it. The filters go in the body, because a
 * hand-picked selection can be longer than an address may be.
 */
export async function downloadFile(path: string, body: Query | Record<string, unknown>, fallbackName: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "The server could not be reached. Check your connection and try again.", null);
  }
  if (!response.ok) {
    let message = response.status === 403 ? "You do not have permission to do this." : `The file could not be made (${response.status}).`;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // Not JSON: keep the general message.
    }
    throw new ApiError(response.status, message, null);
  }
  const named = /filename="?([^";]+)"?/.exec(response.headers.get("Content-Disposition") ?? "")?.[1];
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = named ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
