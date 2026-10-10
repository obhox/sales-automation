import type DatabaseType from "better-sqlite3";
import { isValidTimeZone } from "@/lib/outreach/schedule";
import { getWorkspaceSetting, setWorkspaceSetting } from "@/lib/workspace-settings";
import { proxyProblem } from "@/lib/linkedin/session-context";

type DB = DatabaseType.Database;

// What may be saved on a LinkedIn account, and the workspace's preset for new ones.
// Checked here, not in the form, because the API and the MCP tool reach the same routes,
// and a limit typed past these ceilings is how an account gets restricted by LinkedIn.

/** Whole-number settings and the range each may take. `nullable` ones can be cleared to fall back to the default. */
const NUMBER_RULES: Record<string, { min: number; max: number; nullable?: boolean; label: string }> = {
  daily_connection_limit: { min: 1, max: 100, label: "Invitations per day" },
  daily_message_limit: { min: 1, max: 200, label: "Messages per day" },
  daily_inmail_limit: { min: 1, max: 100, label: "InMails per day" },
  daily_visit_limit: { min: 1, max: 150, label: "Profile visits per day" },
  weekly_connection_limit: { min: 1, max: 400, nullable: true, label: "Invitations per week" },
  daily_withdraw_limit: { min: 1, max: 50, nullable: true, label: "Withdrawals per day" },
  invite_max_wait_days: { min: 3, max: 180, nullable: true, label: "Days before an invitation is withdrawn" },
  ramp_days: { min: 2, max: 60, nullable: true, label: "Warm-up length in days" },
  ramp_start_limit: { min: 1, max: 100, nullable: true, label: "Invitations per day at the start of warm-up" },
};

export const ACCOUNT_NUMBER_FIELDS = Object.keys(NUMBER_RULES);

/** Why these settings cannot be saved, or null when they can. `current` fills in whichever hour is not being changed. */
export function accountSettingsProblem(body: Record<string, unknown>, current?: { active_hours_start: number; active_hours_end: number }): string | null {
  for (const [field, rule] of Object.entries(NUMBER_RULES)) {
    const value = body[field];
    // Null clears a setting that can fall back to a default, and leaves any other one as it is.
    if (value == null) continue;
    if (!Number.isInteger(value) || (value as number) < rule.min || (value as number) > rule.max) return `${rule.label} must be a whole number from ${rule.min} to ${rule.max}`;
  }
  for (const field of ["active_hours_start", "active_hours_end"]) {
    const value = body[field];
    if (value != null && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 24)) return `${field} must be an hour from 0 to 24`;
  }
  const start = (body.active_hours_start ?? current?.active_hours_start) as number | undefined;
  const end = (body.active_hours_end ?? current?.active_hours_end) as number | undefined;
  if ((body.active_hours_start != null || body.active_hours_end != null) && start != null && end != null && start >= end) return "active_hours_start must be before active_hours_end";
  if (body.timezone != null && !isValidTimeZone(String(body.timezone))) return "timezone must be a zone name such as Europe/Berlin or America/New_York";
  if (body.working_days != null) {
    const days = String(body.working_days).split(",").map((day) => day.trim());
    if (days.length === 0 || days.some((day) => !/^[1-7]$/.test(day)) || new Set(days).size !== days.length) return "working_days must be a list of days from 1 (Monday) to 7 (Sunday), such as 1,2,3,4,5";
  }
  if (body.ramp_start_date != null && body.ramp_start_date !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.ramp_start_date))) return "ramp_start_date must be a date such as 2026-10-10";
  if (typeof body.proxy_url === "string" && body.proxy_url.trim()) {
    const problem = proxyProblem(body.proxy_url.trim(), typeof body.proxy_username === "string" ? body.proxy_username : null);
    if (problem) return problem;
  }
  for (const field of ["plan", "proxy_label"]) {
    if (body[field] != null && String(body[field]).length > 80) return `${field} must be 80 characters or fewer`;
  }
  return null;
}

// ── The workspace preset ──────────────────────────────────────────────────────

/** The limits and schedule a new LinkedIn account in this workspace starts with. */
export interface LinkedinPreset {
  daily_connection_limit: number;
  daily_message_limit: number;
  daily_inmail_limit: number;
  daily_visit_limit: number;
  weekly_connection_limit: number | null;
  daily_withdraw_limit: number | null;
  invite_max_wait_days: number | null;
  active_hours_start: number;
  active_hours_end: number;
  working_days: string;
  withdraw_stale_invites: boolean;
  /** Warm a new account up over this many days, starting from ramp_start_limit a day. Null: no warm-up. */
  ramp_days: number | null;
  ramp_start_limit: number | null;
}

/** What accounts got before there was a preset: the column defaults. */
export const DEFAULT_PRESET: LinkedinPreset = {
  daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15, daily_visit_limit: 150,
  weekly_connection_limit: null, daily_withdraw_limit: null, invite_max_wait_days: null,
  active_hours_start: 9, active_hours_end: 18, working_days: "1,2,3,4,5",
  withdraw_stale_invites: false, ramp_days: null, ramp_start_limit: null,
};

/** Settings that can be cleared (set to null) to fall back to the instance default. */
export const CLEARABLE_NUMBER_FIELDS = Object.entries(NUMBER_RULES).filter(([, rule]) => rule.nullable).map(([field]) => field);

const PRESET_KEY = "linkedin_account_preset";
/** The fields of a preset that are copied onto an account when the preset is applied to it. */
export const PRESET_ACCOUNT_FIELDS = [
  "daily_connection_limit", "daily_message_limit", "daily_inmail_limit", "daily_visit_limit", "weekly_connection_limit",
  "daily_withdraw_limit", "invite_max_wait_days", "active_hours_start", "active_hours_end", "working_days",
] as const;

export function getLinkedinPreset(workspaceId: string, db?: DB): LinkedinPreset {
  const stored = getWorkspaceSetting(workspaceId, PRESET_KEY, db);
  if (!stored) return { ...DEFAULT_PRESET };
  try {
    const parsed = JSON.parse(stored) as Partial<LinkedinPreset>;
    return { ...DEFAULT_PRESET, ...Object.fromEntries(Object.entries(parsed).filter(([key]) => key in DEFAULT_PRESET)) } as LinkedinPreset;
  } catch {
    return { ...DEFAULT_PRESET };
  }
}

/** Save a preset. Returns the reason it was refused, or the preset as stored. */
export function saveLinkedinPreset(workspaceId: string, body: Record<string, unknown>, db?: DB): LinkedinPreset | string {
  const next = { ...getLinkedinPreset(workspaceId, db) } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_PRESET)) if (body[key] !== undefined) next[key] = body[key];
  const problem = accountSettingsProblem(next);
  if (problem) return problem;
  if (typeof next.withdraw_stale_invites !== "boolean") return "withdraw_stale_invites must be true or false";
  if ((next.ramp_days === null) !== (next.ramp_start_limit === null)) return "A warm-up needs both a length and a starting number";
  if (typeof next.ramp_start_limit === "number" && next.ramp_start_limit > (next.daily_connection_limit as number)) return "Warm-up cannot start above the daily invitation limit";
  setWorkspaceSetting(workspaceId, PRESET_KEY, JSON.stringify(next), db);
  return next as unknown as LinkedinPreset;
}
