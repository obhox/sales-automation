/**
 * Timezone-correct scheduling helpers for the campaign runner.
 *
 * The runner decides whether it is inside an account's working window using the ACCOUNT's
 * timezone, but historically generated the resulting slots with `new Date(y, m, d, h)`,
 * which is SERVER-local. On a UTC host with an America/New_York account that produced
 * 09:00-18:00 UTC = 05:00-14:00 NY, so a large share of generated slots were already
 * outside the window on arrival and were immediately rescheduled again.
 *
 * Kept out of the runner so the arithmetic is unit testable without loading Playwright.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  isoWeekday: number; // 1 = Mon .. 7 = Sun
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function safeZone(tz: string): string {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Wall-clock calendar parts for `date` as observed in `tz`. */
export function zonedParts(tz: string, date: Date = new Date()): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(tz || "UTC"),
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10) % 24,
    minute: parseInt(get("minute"), 10),
    isoWeekday: WEEKDAYS[get("weekday")] ?? 1,
  };
}

/**
 * UTC epoch ms for a wall-clock time on a given calendar day *in `tz`*.
 *
 * Converges by measuring the zone's actual offset at the candidate instant, which also
 * lands correctly across DST transitions (two passes are enough for a 1-hour shift).
 */
export function zonedTimeToUtcMs(tz: string, year: number, month: number, day: number, hourFrac: number): number {
  let ms = Date.UTC(year, month - 1, day, Math.floor(hourFrac), Math.round((hourFrac % 1) * 60));
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(tz, new Date(ms));
    // Difference between the wall clock we want and the one we actually landed on.
    let deltaH = hourFrac - (p.hour + p.minute / 60);
    // A calendar-day rollover shows up as a ~24h swing; fold it back.
    if (deltaH > 12) deltaH -= 24;
    if (deltaH < -12) deltaH += 24;
    if (Math.abs(deltaH) < 1 / 120) break; // within ~30s
    ms += deltaH * 3_600_000;
  }
  return ms;
}

/** SQLite `datetime('now')` format: "YYYY-MM-DD HH:MM:SS", UTC, no zone suffix. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * UTC bounds of the calendar day that `at` falls on *in `tz`*, as `[start, end)`.
 *
 * Daily send counters used to compare `date(created_at) = date('now')` — a UTC day — while
 * the sending window is evaluated in the ACCOUNT's timezone. For an America/Los_Angeles
 * account on a 09:00-18:00 window, UTC midnight is 17:00 PDT, so every counter reset an hour
 * before the window closed and the account could send a second full daily quota in that last
 * hour. A daily cap has to be counted over the same day the window belongs to.
 *
 * Returned in SQLite's `datetime('now')` text format rather than ISO, because that is how
 * `logs.created_at` is written and the comparison is lexicographic — an ISO string with `T`
 * and `Z` would sort wrongly against it.
 */
export function localDayBoundsUtc(tz: string, at: Date = new Date()): { start: string; end: string } {
  const zone = safeZone(tz || "UTC");
  const { year, month, day } = zonedParts(zone, at);
  const startMs = zonedTimeToUtcMs(zone, year, month, day, 0);
  // Advance via local noon so the +24h hop lands on the next calendar day even across a DST
  // transition, then take that day's midnight — never startMs + 86_400_000, which is an hour
  // off on a DST boundary.
  const nextDay = zonedParts(zone, new Date(zonedTimeToUtcMs(zone, year, month, day, 12) + 86_400_000));
  const endMs = zonedTimeToUtcMs(zone, nextDay.year, nextDay.month, nextDay.day, 0);
  return { start: sqliteUtc(startMs), end: sqliteUtc(endMs) };
}

/**
 * Pick a slot inside [start, end) on the account-local day containing `onDate`.
 *
 * `notBeforeMs` clamps the lower bound so a slot is never generated in the past - the
 * missing clamp is what let a track outside its window be rescheduled to a time seconds
 * away (and still outside), tripping the same guard on the next poll and looping.
 * Returns null when the window has already closed on that day.
 */
export function slotInWindow(
  tz: string,
  onDate: Date,
  start: number,
  end: number,
  notBeforeMs?: number,
  rand: () => number = Math.random,
): string | null {
  const { year, month, day } = zonedParts(tz, onDate);
  const startMs = zonedTimeToUtcMs(tz, year, month, day, start);
  const endMs = zonedTimeToUtcMs(tz, year, month, day, end);
  const lower = Math.max(startMs, notBeforeMs ?? startMs);
  if (lower >= endMs) return null;
  return new Date(lower + rand() * (endMs - lower)).toISOString();
}
