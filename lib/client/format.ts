// How numbers, rates and times are written across the new UI. Pure functions,
// so every screen writes "1,240", "11.4%" and "4 min ago" the same way.

const EM_DASH = "—";

/** 1240 → "1,240". Missing values show as a dash, never as 0. */
export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? EM_DASH : Math.round(value).toLocaleString("en-US");
}

/** 12480 → "12.5k", 3912 → "3.9k", 950 → "950". For axes and tight spaces. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimZero((value / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${trimZero((value / 1_000).toFixed(1))}k`;
  return String(Math.round(value));
}

const trimZero = (text: string) => text.replace(/\.0$/, "");

/** A share of a whole as a ratio (0–1), or null when there is no whole to divide by. */
export function rate(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part === null || part === undefined || !whole) return null;
  return part / whole;
}

/** 0.114 → "11.4%". A null ratio (nothing to measure yet) shows as a dash. */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return EM_DASH;
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 18000 → "$18,000". Whole units only; pipeline values are not shown to the cent. */
export function formatMoney(amount: number | null | undefined, currency = "USD"): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return EM_DASH;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString("en-US")} ${currency}`;
  }
}

/** "campaign" / "campaigns" by count. */
export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export interface Change {
  /** "+8.2%", "-3", "+1.3 pts". */
  label: string;
  direction: "up" | "down" | "flat";
}

/** Change of a count against the previous period, as a percentage ("+8.2%"). Null when there is nothing to compare with. */
export function changeInCount(current: number, previous: number | null | undefined): Change | null {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? { label: "0%", direction: "flat" } : null;
  const ratio = (current - previous) / previous;
  return { label: `${ratio > 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`, direction: direction(ratio) };
}

/** Change of a small tally as a plain difference ("+22", "-3"). */
export function changeInTally(current: number, previous: number | null | undefined): Change | null {
  if (previous === null || previous === undefined) return null;
  const difference = current - previous;
  return { label: `${difference > 0 ? "+" : ""}${difference}`, direction: direction(difference) };
}

/** Change of a rate in percentage points ("+1.3 pts"). Both are ratios (0–1). */
export function changeInRate(current: number | null, previous: number | null | undefined): Change | null {
  if (current === null || previous === null || previous === undefined) return null;
  const points = (current - previous) * 100;
  const rounded = Number(points.toFixed(1));
  return { label: `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(1)} pts`, direction: direction(rounded) };
}

const direction = (value: number): Change["direction"] => (value > 0 ? "up" : value < 0 ? "down" : "flat");

/**
 * SQLite hands back "2026-10-10 14:02:11" (UTC, no zone) as well as ISO strings.
 * Read both as the instant they mean. Returns null for anything unreadable.
 */
export function parseTime(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return new Date(value);
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "just now", "4 min ago", "2 h ago", "3 d ago", then a date. For "last activity" columns. */
export function formatRelative(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const date = parseTime(value);
  if (!date) return EM_DASH;
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 0) return formatDate(date, now);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatDate(date, now);
}

/** "2m", "14m", "1h", "Yesterday", "Oct 4". The short form used in the inbox list. */
export function formatAge(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const date = parseTime(value);
  if (!date) return EM_DASH;
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24 && sameDay(date, now)) return `${Math.round(minutes / 60)}h`;
  if (dayDistance(date, now) === 1) return "Yesterday";
  return formatDate(date, now);
}

/** "Oct 4", with the year added when it is not this year. */
export function formatDate(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const date = parseTime(value);
  if (!date) return EM_DASH;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** "Today · 2:04 PM", "Yesterday · 5:00 PM", "Oct 7 · 9:12 AM". For timelines and threads. */
export function formatDateTime(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const date = parseTime(value);
  if (!date) return EM_DASH;
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const distance = dayDistance(date, now);
  const day = distance === 0 ? "Today" : distance === 1 ? "Yesterday" : distance === -1 ? "Tomorrow" : formatDate(date, now);
  return `${day} · ${time}`;
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const sameDay = (a: Date, b: Date) => startOfDay(a) === startOfDay(b);
/** Whole calendar days from `date` to `now` in local time: 0 today, 1 yesterday, -1 tomorrow. */
const dayDistance = (date: Date, now: Date) => Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
