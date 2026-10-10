// The one way the new UI talks to the API.

export type Query = Record<string, string | number | boolean | null | undefined | string[]>;

/** A response that was not 2xx. `message` is the server's `error` text when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Set on a 403 raised by a role check: the role the action needs. */
  readonly requiredRole?: string;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    if (body && typeof body === "object" && typeof (body as { required_role?: unknown }).required_role === "string") {
      this.requiredRole = (body as { required_role: string }).required_role;
    }
  }
}

/** Build a URL from a path and query, leaving out empty values. Arrays repeat the key. */
export function apiUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach(item => params.append(key, item));
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}${path.includes("?") ? "&" : "?"}${text}` : path;
}

const STATUS_TEXT: Record<number, string> = {
  401: "Your session has ended. Sign in again.",
  403: "You do not have permission to do this.",
  404: "This could not be found.",
  429: "Too many requests. Try again in a moment.",
};

type SessionEndedListener = () => void;
const sessionEndedListeners = new Set<SessionEndedListener>();

/** Called once when any request comes back 401, so the app can send the user to sign in. */
export function onSessionEnded(listener: SessionEndedListener): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  /** Sent as JSON. */
  body?: unknown;
  signal?: AbortSignal;
}

/** Call the API and return the parsed JSON. Throws ApiError for any non-2xx response. */
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", query, body, signal } = options;
  let response: Response;
  try {
    response = await fetch(apiUrl(path, query), {
      method,
      signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, "The server could not be reached. Check your connection and try again.", null);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const fromServer = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : null;
    if (response.status === 401) sessionEndedListeners.forEach(listener => listener());
    throw new ApiError(response.status, fromServer ?? STATUS_TEXT[response.status] ?? `The request failed (${response.status}).`, parsed);
  }
  return parsed as T;
}

/** The message to show a person for anything thrown by `api()`. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}
