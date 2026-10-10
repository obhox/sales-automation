import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { getWorkspaceSetting, getWorkspaceSwitch, setWorkspaceSetting, setWorkspaceSwitch } from "@/lib/workspace-settings";
import { guardProblem, rampProblem } from "@/lib/email/mailbox-policy";

// The choices a workspace makes about its mailboxes as a group, and the checks on what a
// person can save on one mailbox.

type DB = DatabaseType.Database;

/**
 * How a campaign with several mailboxes shares its contacts out.
 * round_robin: in turn, as it always has. capacity: in proportion to what each mailbox may
 * send today, so one still ramping up is given fewer. Either way a company stays with one
 * mailbox.
 */
export type MailboxRotation = "round_robin" | "capacity";
export const MAILBOX_ROTATIONS: readonly MailboxRotation[] = ["round_robin", "capacity"];

export function isMailboxRotation(value: unknown): value is MailboxRotation {
  return typeof value === "string" && (MAILBOX_ROTATIONS as readonly string[]).includes(value);
}

export function getMailboxRotation(workspaceId: string, db: DB = getDb()): MailboxRotation {
  const stored = getWorkspaceSetting(workspaceId, "mailbox_rotation", db);
  return isMailboxRotation(stored) ? stored : "round_robin";
}

export interface MailboxSettings {
  rotation: MailboxRotation;
  /** A guard-paused mailbox's not-yet-emailed contacts move to the campaign's other mailboxes. */
  failover: boolean;
  /** Warm-up mail is exchanged with other workspaces' mailboxes on this instance. */
  shared_pool: boolean;
}

export function getMailboxSettings(workspaceId: string, db: DB = getDb()): MailboxSettings {
  return {
    rotation: getMailboxRotation(workspaceId, db),
    failover: getWorkspaceSwitch(workspaceId, "mailbox_failover", db),
    shared_pool: getWorkspaceSwitch(workspaceId, "warmup_shared_pool", db),
  };
}

/** Save the settings sent. Returns the settings afterwards, or a sentence saying what is wrong. */
export function saveMailboxSettings(workspaceId: string, input: Record<string, unknown>, db: DB = getDb()): MailboxSettings | string {
  if (input.rotation !== undefined && !isMailboxRotation(input.rotation)) return "rotation must be round_robin or capacity";
  for (const key of ["failover", "shared_pool"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") return `${key} must be true or false`;
  }
  if (input.rotation !== undefined) setWorkspaceSetting(workspaceId, "mailbox_rotation", input.rotation as string, db);
  if (input.failover !== undefined) setWorkspaceSwitch(workspaceId, "mailbox_failover", input.failover as boolean, db);
  if (input.shared_pool !== undefined) setWorkspaceSwitch(workspaceId, "warmup_shared_pool", input.shared_pool as boolean, db);
  return getMailboxSettings(workspaceId, db);
}

// ── One mailbox ───────────────────────────────────────────────────────────────

const isInt = (value: unknown, low: number, high: number) => Number.isInteger(value) && (value as number) >= low && (value as number) <= high;

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * What is wrong with a mailbox's settings as sent, or null. Only the fields present are
 * checked, so a partial save is judged on what it changes. `current` is the mailbox as it
 * stands, for checks that need both ends (hours, the ramp against the limit).
 */
export function mailboxSettingsProblem(input: Record<string, unknown>, current: { daily_email_limit?: number | null; active_hours_start?: number | null; active_hours_end?: number | null } = {}): string | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  if (has("daily_email_limit") && !isInt(input.daily_email_limit, 1, 2000)) return "The daily limit must be between 1 and 2,000 emails.";
  if (has("active_hours_start") && !isInt(input.active_hours_start, 0, 23)) return "Sending must start on an hour between 00:00 and 23:00.";
  if (has("active_hours_end") && !isInt(input.active_hours_end, 1, 24)) return "Sending must end on an hour between 01:00 and 24:00.";
  const start = has("active_hours_start") ? (input.active_hours_start as number) : current.active_hours_start;
  const end = has("active_hours_end") ? (input.active_hours_end as number) : current.active_hours_end;
  if ((has("active_hours_start") || has("active_hours_end")) && typeof start === "number" && typeof end === "number" && end <= start) return "Sending must end after it starts.";
  if (has("timezone") && !isTimeZone(input.timezone)) return "That time zone is not one Linki knows.";
  if (has("working_days")) {
    const days = typeof input.working_days === "string" ? input.working_days.split(",").map((day) => Number(day.trim())) : [];
    if (days.length === 0 || days.some((day) => !isInt(day, 1, 7))) return "Choose at least one day to send on.";
  }
  if (has("smtp_port") && !isInt(input.smtp_port, 1, 65535)) return "The SMTP port must be a number between 1 and 65535.";
  if (has("imap_port") && input.imap_port !== null && !isInt(input.imap_port, 1, 65535)) return "The IMAP port must be a number between 1 and 65535.";
  if (has("from_email") && !(typeof input.from_email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.from_email.trim()))) return "Enter the address this mailbox sends from.";
  if (has("reply_to") && input.reply_to !== null && input.reply_to !== "" && !(typeof input.reply_to === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.reply_to.trim()))) return "The reply-to address is not an email address.";
  if (has("signature") && input.signature !== null && typeof input.signature !== "string") return "The signature must be text.";
  if (typeof input.signature === "string" && input.signature.length > 4000) return "The signature is longer than 4,000 characters.";
  const limit = has("daily_email_limit") ? (input.daily_email_limit as number) : current.daily_email_limit ?? undefined;
  return rampProblem({ ramp_days: input.ramp_days, ramp_start_limit: input.ramp_start_limit, daily_email_limit: limit }) ?? guardProblem(input);
}

/** The mailbox fields that are numbers. */
export const NUMERIC_MAILBOX_FIELDS = ["smtp_port", "imap_port", "daily_email_limit", "active_hours_start", "active_hours_end", "ramp_days", "ramp_start_limit", "bounce_threshold", "complaint_threshold", "min_health_sample"] as const;

/** A copy of a request body with numbers that arrived as text ("50") made numbers, as callers of the API have always been allowed to send them. */
export function withNumbers(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const field of NUMERIC_MAILBOX_FIELDS) {
    const value = out[field];
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) out[field] = Number(value);
  }
  return out;
}
