// Meetings, as the pipeline screen reads them. They arrive from connected calendars
// (lib/platform/connectors.ts); a whole calendar arrives, so a meeting is "matched" when one
// of the people invited is a contact, and the rest are a member's own appointments.
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

export const CALENDAR_PROVIDERS = ["google_calendar", "microsoft_calendar", "ical"] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];
const isCalendarProvider = (value: unknown): value is CalendarProvider => (CALENDAR_PROVIDERS as readonly unknown[]).includes(value);

export interface MeetingItem {
  id: string;
  title: string;
  /** As the calendar gave them: a moment, or just a day for something that lasts all day. */
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  duration_minutes: number | null;
  cancelled: boolean;
  contact: { id: string; name: string; title: string | null } | null;
  company: { id: string | null; name: string } | null;
  opportunity: { id: string; name: string } | null;
  calendar: { id: string; provider: CalendarProvider; name: string } | null;
  attendee_count: number;
}

export interface MeetingFilters {
  when: "upcoming" | "past";
  /** Only meetings with a contact (the default), only those without, or all of them. */
  match: "matched" | "unmatched" | "all";
}

export interface MeetingCounts { upcoming: number; upcoming_unmatched: number; past: number }

// A calendar gives times with an offset, in UTC, or as a bare day. datetime() reads all three as UTC.
const START = "datetime(m.starts_at)";
const END = "datetime(COALESCE(NULLIF(m.ends_at, ''), m.starts_at))";
const LIVE = "COALESCE(m.status, '') != 'cancelled'";

function durationMinutes(startsAt: string, endsAt: string | null, allDay: boolean): number | null {
  if (allDay || !endsAt) return null;
  const minutes = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 && minutes < 24 * 60 ? minutes : null;
}

/** A page of meetings: the next ones soonest first, or the past ones latest first. A meeting still going on counts as upcoming. */
export function listMeetings(db: DB, workspaceId: string, filters: MeetingFilters, page: { limit: number; offset: number }, now: Date = new Date()): { meetings: MeetingItem[]; total: number } {
  const where = ["m.workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (filters.when === "upcoming") where.push(`${END} >= datetime(?)`, LIVE);
  else where.push(`${END} < datetime(?)`);
  params.push(now.toISOString());
  if (filters.match === "matched") where.push("m.target_id IS NOT NULL");
  else if (filters.match === "unmatched") where.push("m.target_id IS NULL");
  const from = `FROM meetings m
    LEFT JOIN targets t ON t.id = m.target_id
    LEFT JOIN opportunities o ON o.id = m.opportunity_id
    LEFT JOIN companies c ON c.id = COALESCE(o.company_id, t.company_id)
    LEFT JOIN external_connections ec ON ec.id = m.connection_id
    WHERE ${where.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) AS c ${from}`).get(...params) as { c: number }).c;
  const rows = db.prepare(`SELECT m.id, m.title, m.starts_at, m.ends_at, m.status, m.attendees_json,
      t.id AS contact_id, COALESCE(NULLIF(t.full_name, ''), t.email) AS contact_name, COALESCE(NULLIF(t.title, ''), t.headline) AS contact_title,
      c.id AS company_id, COALESCE(c.name, t.company) AS company_name, o.id AS opportunity_id, o.name AS opportunity_name,
      ec.id AS calendar_id, ec.provider AS calendar_provider, ec.name AS calendar_name
    ${from} ORDER BY ${START} ${filters.when === "upcoming" ? "ASC" : "DESC"}, m.id LIMIT ? OFFSET ?`).all(...params, page.limit, page.offset) as Array<Record<string, string | null>>;
  return {
    total,
    meetings: rows.map((row): MeetingItem => {
      const startsAt = String(row.starts_at);
      const allDay = /^\d{4}-\d{2}-\d{2}$/.test(startsAt);
      let attendees = 0;
      try { const list: unknown = JSON.parse(row.attendees_json ?? "[]"); attendees = Array.isArray(list) ? list.length : 0; } catch { /* a count that cannot be read is no count */ }
      return {
        id: String(row.id), title: String(row.title), starts_at: startsAt, ends_at: row.ends_at || null, all_day: allDay,
        duration_minutes: durationMinutes(startsAt, row.ends_at || null, allDay), cancelled: row.status === "cancelled",
        contact: row.contact_id ? { id: row.contact_id, name: row.contact_name ?? "Contact", title: row.contact_title } : null,
        company: row.company_name ? { id: row.company_id, name: row.company_name } : null,
        opportunity: row.opportunity_id ? { id: row.opportunity_id, name: row.opportunity_name ?? "Opportunity" } : null,
        calendar: row.calendar_id && isCalendarProvider(row.calendar_provider) ? { id: row.calendar_id, provider: row.calendar_provider, name: row.calendar_name ?? "" } : null,
        attendee_count: attendees,
      };
    }),
  };
}

export function meetingCounts(db: DB, workspaceId: string, now: Date = new Date()): MeetingCounts {
  const at = now.toISOString();
  return db.prepare(`SELECT
      COALESCE(SUM(${END} >= datetime(?) AND ${LIVE} AND m.target_id IS NOT NULL), 0) AS upcoming,
      COALESCE(SUM(${END} >= datetime(?) AND ${LIVE} AND m.target_id IS NULL), 0) AS upcoming_unmatched,
      COALESCE(SUM(${END} < datetime(?) AND m.target_id IS NOT NULL), 0) AS past
    FROM meetings m WHERE m.workspace_id = ?`).get(at, at, at, workspaceId) as MeetingCounts;
}

/**
 * Say which contact a meeting is with, for one the calendar could not match. It takes the
 * contact's most recent opportunity with it, as a matched meeting does. Returns false when
 * there is no such meeting.
 */
export function linkMeeting(db: DB, workspaceId: string, meetingId: string, targetId: string): boolean {
  const opportunity = db.prepare("SELECT id FROM opportunities WHERE workspace_id = ? AND target_id = ? ORDER BY updated_at DESC LIMIT 1").get(workspaceId, targetId) as { id: string } | undefined;
  return db.prepare("UPDATE meetings SET target_id = ?, opportunity_id = COALESCE(?, opportunity_id) WHERE id = ? AND workspace_id = ?").run(targetId, opportunity?.id ?? null, meetingId, workspaceId).changes > 0;
}

// ── The calendars meetings come from ────────────────────────────────────────────────────

export interface CalendarItem {
  id: string;
  provider: CalendarProvider;
  name: string;
  /** The account that was signed in to, for a calendar connected that way. */
  account_email: string | null;
  signed_in: boolean;
  /** For a feed: the site it is read from. The address itself is a secret and is never sent. */
  host: string | null;
  enabled: boolean;
  last_synced_at: string | null;
  sync_error: string | null;
  meeting_count: number;
}

export function listCalendars(db: DB, workspaceId: string): CalendarItem[] {
  const rows = db.prepare(`SELECT ec.id, ec.provider, ec.name, ec.account_email, ec.auth_method, ec.config_json, ec.enabled, ec.last_synced_at, ec.sync_error,
      (SELECT COUNT(*) FROM meetings m WHERE m.connection_id = ec.id) AS meeting_count
    FROM external_connections ec WHERE ec.workspace_id = ? AND ec.provider IN (${CALENDAR_PROVIDERS.map(() => "?").join(",")})
    ORDER BY ec.created_at, ec.rowid`).all(workspaceId, ...CALENDAR_PROVIDERS) as Array<Record<string, string | number | null>>;
  return rows.map((row): CalendarItem => {
    let host: string | null = null;
    if (row.provider === "ical") {
      try { host = new URL(String((JSON.parse(String(row.config_json ?? "{}")) as { url?: unknown }).url)).host; } catch { /* no address to show */ }
    }
    return {
      id: String(row.id), provider: row.provider as CalendarProvider, name: String(row.name), account_email: row.account_email === null ? null : String(row.account_email),
      signed_in: row.auth_method === "oauth", host, enabled: row.enabled === 1, last_synced_at: row.last_synced_at === null ? null : String(row.last_synced_at),
      sync_error: row.sync_error === null ? null : String(row.sync_error), meeting_count: Number(row.meeting_count ?? 0),
    };
  });
}
