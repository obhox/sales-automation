// A limit on how many requests one API key may make in a minute. Kept in memory: the app
// is a single process, and a count that starts again when it restarts is good enough for
// keeping one integration from crowding out the rest.

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();
let lastSweep = 0;

export const MAX_RATE_LIMIT = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Requests left in the current minute, after this one. */
  remaining: number;
  /** Seconds until a request will be let through again. 0 when this one was. */
  retry_after: number;
}

/**
 * Count a request against a key's limit. A key with no limit is never counted and never
 * refused: that is how every key behaved before limits existed.
 */
export function takeRequest(keyId: string, limitPerMinute: number | null | undefined, now: number = Date.now()): RateLimitResult | null {
  if (!limitPerMinute || limitPerMinute <= 0) return null;
  sweep(now);
  const recent = (hits.get(keyId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= limitPerMinute) {
    hits.set(keyId, recent);
    // The oldest request in the window is the first to leave it.
    return { allowed: false, limit: limitPerMinute, remaining: 0, retry_after: Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000)) };
  }
  recent.push(now);
  hits.set(keyId, recent);
  return { allowed: true, limit: limitPerMinute, remaining: limitPerMinute - recent.length, retry_after: 0 };
}

/** Forget keys that have been quiet for a minute, so the map does not grow for ever. */
function sweep(now: number) {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [keyId, times] of hits) {
    if (times.every((at) => now - at >= WINDOW_MS)) hits.delete(keyId);
  }
}

/** A limit as typed or sent: a whole number from 1 to 10,000, or nothing for no limit. `undefined` when it is neither. */
export function parseRateLimit(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const limit = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RATE_LIMIT) return undefined;
  return limit;
}

/** For tests: start counting from nothing. */
export function resetRateLimits(): void {
  hits.clear();
  lastSweep = 0;
}
