import {formatAge, formatDateTime, formatRelative, parseTime} from "@/lib/client/format";

/** Keep the original English formatting; use Brazilian Portuguese for localized inbox timestamps. */
export function formatRelativeByLocale(value: string | number | Date | null | undefined, locale: string, now: Date = new Date()): string {
  if (locale !== "pt-BR") return formatRelative(value, now);
  const date = parseTime(value);
  if (!date) return "—";
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 0 || seconds >= 30 * 24 * 60 * 60) {
    return date.toLocaleDateString("pt-BR", {day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : {year: "numeric"})});
  }
  if (seconds < 45) return "agora";
  const minutes = Math.round(seconds / 60);
  const relative = new Intl.RelativeTimeFormat("pt-BR", {numeric: "auto", style: "short"});
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  return relative.format(-Math.round(hours / 24), "day");
}


/** Compact inbox timestamp in pt-BR; preserves existing English and the instant. */
export function formatAgeByLocale(value: string | number | Date | null | undefined, locale: string, now: Date = new Date()): string {
  if (locale !== "pt-BR") return formatAge(value, now);
  const date = parseTime(value);
  if (!date) return "—";
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (minutes < 1440 && sameDay(date, now)) return `${Math.round(minutes / 60)} h`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return "Ontem";
  return date.toLocaleDateString("pt-BR", {
    day: "numeric", month: "short",
    ...(date.getFullYear() !== now.getFullYear() ? {year: "numeric"} : {}),
  });
}

/** Full timestamp for inbox message cards; keeps the existing English fallback. */
export function formatDateTimeByLocale(value: string | number | Date | null | undefined, locale: string, now: Date = new Date()): string {
  if (locale !== "pt-BR") return formatDateTime(value, now);
  const date = parseTime(value);
  if (!date) return "—";
  const previous = new Date(now);
  previous.setDate(previous.getDate() - 1);
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  const day = date.toDateString() === now.toDateString() ? "Hoje"
    : date.toDateString() === previous.toDateString() ? "Ontem"
    : date.toDateString() === next.toDateString() ? "Amanhã"
    : date.toLocaleDateString("pt-BR", {
      day: "numeric", month: "short",
      ...(date.getFullYear() !== now.getFullYear() ? {year: "numeric"} : {}),
    });
  return `${day} · ${date.toLocaleTimeString("pt-BR", {hour: "2-digit", minute: "2-digit"})}`;
}
