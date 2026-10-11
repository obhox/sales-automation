// The period a report covers. Every series here is cut on UTC days, which is what the
// stored timestamps are in, so a range is a pair of UTC days.

export interface ReportRange {
  /** First and last day covered, both included, as YYYY-MM-DD. */
  fromDay: string;
  toDay: string;
  /** The same as timestamps to compare against: from <= t < to. */
  from: string;
  to: string;
  /**
   * True when the caller named the period. Then it means two things at once: counts of
   * activity are of what happened in it, and funnels and rates are of the contacts first
   * contacted in it. False when it is only the default window for the charts and
   * everything else is for all time.
   */
  explicit: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Long enough for a year-on-year look, short enough that a chart of days stays a chart. */
export const MAX_RANGE_DAYS = 366;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOf = (day: string) => Date.parse(`${day}T00:00:00Z`);
const validDay = (value: unknown): value is string => typeof value === "string" && DAY.test(value) && !Number.isNaN(startOf(value)) && dayOf(startOf(value)) === value;

function between(fromDay: string, toDay: string, explicit: boolean): ReportRange {
  return { fromDay, toDay, from: `${fromDay} 00:00:00`, to: `${dayOf(startOf(toDay) + DAY_MS)} 00:00:00`, explicit };
}

/** The last `days` days, today included. */
export function lastDays(days: number, now = Date.now()): ReportRange {
  return between(dayOf(now - (days - 1) * DAY_MS), dayOf(now), false);
}

/**
 * `from` and `to` (YYYY-MM-DD, both included; `to` defaults to today) name a period.
 * Without `from`, the report is for all time and `days` (7 to 90, 30 unless given) is how
 * far back its charts go. A string is the reason the range was refused.
 */
export function parseRange(query: { from?: unknown; to?: unknown; days?: unknown }, now = Date.now()): ReportRange | string {
  const given = (value: unknown) => value !== undefined && value !== "";
  if (!given(query.from)) {
    if (given(query.to)) return "A range needs a from date";
    return lastDays(Math.min(Math.max(Number(query.days) || 30, 7), 90), now);
  }
  if (!validDay(query.from)) return "from must be a date (YYYY-MM-DD)";
  if (given(query.to) && !validDay(query.to)) return "to must be a date (YYYY-MM-DD)";
  const toDay = given(query.to) ? (query.to as string) : dayOf(now);
  if (query.from > toDay) return "from must not be after to";
  if ((startOf(toDay) - startOf(query.from)) / DAY_MS + 1 > MAX_RANGE_DAYS) return `A range can cover at most ${MAX_RANGE_DAYS} days`;
  return between(query.from, toDay, true);
}

/** Every day of the range, oldest first. */
export function daysOf(range: ReportRange): string[] {
  const days: string[] = [];
  for (let ms = startOf(range.fromDay); ms <= startOf(range.toDay); ms += DAY_MS) days.push(dayOf(ms));
  return days;
}
