// What the contact profile reads: the contact with its company, lists, tags, custom
// fields and tasks; each campaign the contact has been in, step by step; one timeline of
// everything that happened on either channel; and where the contact sits in the list the
// profile was opened from.
import type DatabaseType from "better-sqlite3";
import { getBookingUrl } from "@/lib/platform/booking";
import { LINKEDIN_STATUS_SQL, contactsQuery, type LinkedinStatus, type Query } from "./filters";
import { LAST_ACTIVITY_SQL, contactsOrder, memberName, type ContactTag } from "./table";

type DB = DatabaseType.Database;
type Row = Record<string, unknown>;

/** "2026-10-10T14:02:11.000Z" and "2026-10-10 14:02:11" both become the second, as UTC text that sorts. */
export function stampOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 10) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value} 00:00:00`;
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace("T", " ");
}

const snippet = (text: unknown, max = 220): string | null => {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const marks = (values: unknown[]) => values.map(() => "?").join(",");

// ── Campaign history ──────────────────────────────────────────────────────────

export type StepStatus = "sent" | "next" | "upcoming" | "skipped" | "stopped" | "failed";

export interface CampaignStep {
  id: string;
  /** 1, 2, 3… across both channels, in the order the steps come due. */
  number: number;
  track: "linkedin" | "email";
  type: string;
  /** The subject of an email step, as written in the campaign (merge tags and all). */
  subject: string | null;
  status: StepStatus;
  /** When it was sent, or when it is due. */
  at: string | null;
  /** Why a step did not or will not run, in the engine's words. */
  reason: string | null;
  email: { status: string; opens: number; clicks: number; bounced: boolean } | null;
  /** For an invitation: when it was accepted. */
  accepted_at: string | null;
}

export type CampaignState = "active" | "paused" | "waiting" | "completed" | "stopped" | "failed";

export interface CampaignHistory {
  run_id: string;
  workflow_id: string;
  name: string;
  run_status: string;
  enrolled_at: string | null;
  state: CampaignState;
  steps_total: number;
  steps_sent: number;
  /** The number of the step that runs next, while the campaign is still going for this contact. */
  next_number: number | null;
  stop_reason: string | null;
  last_touch_at: string | null;
  replied: boolean;
  steps: CampaignStep[];
}

interface StepRow { id: string; track: string; step_type: string; step_order: number; delay_seconds: number | null; email_subject: string | null; enabled: number | null }
interface NumberedStep { step: StepRow; number: number; index: number; offset: number }

/**
 * A campaign's action steps, numbered across both channels in the order they come due.
 * Each channel keeps its own order and its own waits, so a step's place is the total of
 * the waits before it on its channel. `index` is the step's position on its channel
 * counting waits, which is how a contact's progress is stored.
 */
export function numberSteps(steps: StepRow[]): NumberedStep[] {
  const out: Omit<NumberedStep, "number">[] = [];
  for (const track of ["linkedin", "email"]) {
    let offset = 0;
    steps.filter((step) => step.track === track).sort((a, b) => a.step_order - b.step_order).forEach((step, index) => {
      if (step.step_type === "delay") offset += step.delay_seconds ?? 0;
      else out.push({ step, index, offset });
    });
  }
  return out
    .sort((a, b) => a.offset - b.offset || (a.step.track === b.step.track ? a.step.step_order - b.step.step_order : a.step.track === "linkedin" ? -1 : 1))
    .map((entry, position) => ({ ...entry, number: position + 1 }));
}

interface TrackRow { track: string; state: string; current_step: number; next_step_at: string | null; error_message: string | null; hold: string | null }

/** Every campaign the contact has been enrolled in, newest first, with what became of each step. */
export function campaignHistory(db: DB, workspaceId: string, targetId: string, contact: { connected_at: string | null; replied: boolean }): CampaignHistory[] {
  const runs = db.prepare(
    `SELECT rp.id AS run_profile_id, rp.created_at AS enrolled_at, r.id AS run_id, r.status AS run_status, r.workflow_id, w.name
     FROM run_profiles rp JOIN runs r ON r.id = rp.run_id JOIN workflows w ON w.id = r.workflow_id
     WHERE rp.target_id = ? AND r.workspace_id = ?
     ORDER BY (r.status IN ('running', 'paused')) DESC, r.created_at DESC`,
  ).all(targetId, workspaceId) as { run_profile_id: string; enrolled_at: string | null; run_id: string; run_status: string; workflow_id: string; name: string }[];

  return runs.map((run): CampaignHistory => {
    const numbered = numberSteps(db.prepare(
      "SELECT id, track, step_type, step_order, delay_seconds, email_subject, enabled FROM workflow_steps WHERE workflow_id = ? ORDER BY track, step_order",
    ).all(run.workflow_id) as StepRow[]);
    const tracks = new Map((db.prepare(
      "SELECT track, state, current_step, next_step_at, error_message, hold FROM run_profile_tracks WHERE run_profile_id = ?",
    ).all(run.run_profile_id) as TrackRow[]).map((track) => [track.track, track]));
    const sends = new Map((db.prepare(
      "SELECT step_id, MIN(sent_at) AS sent_at, MAX(email_job_id) AS email_job_id FROM step_sends WHERE run_id = ? AND target_id = ? AND step_id IS NOT NULL GROUP BY step_id",
    ).all(run.run_id, targetId) as { step_id: string; sent_at: string; email_job_id: string | null }[]).map((send) => [send.step_id, send]));

    const jobIds = [...sends.values()].map((send) => send.email_job_id).filter((id): id is string => Boolean(id));
    const mail = new Map<string, { status: string; opens: number; clicks: number; bounced: boolean }>();
    if (jobIds.length) {
      for (const row of db.prepare(
        `SELECT sm.job_id, sm.status, sm.bounced_at,
                COALESCE(SUM(CASE WHEN se.event_type = 'opened' AND se.is_bot = 0 THEN 1 ELSE 0 END), 0) AS opens,
                COALESCE(SUM(CASE WHEN se.event_type = 'clicked' AND se.is_bot = 0 THEN 1 ELSE 0 END), 0) AS clicks
         FROM sent_messages sm LEFT JOIN sender_events se ON se.sent_message_id = sm.id
         WHERE sm.job_id IN (${marks(jobIds)}) GROUP BY sm.id`,
      ).all(...jobIds) as { job_id: string; status: string; bounced_at: string | null; opens: number; clicks: number }[]) {
        mail.set(row.job_id, { status: row.status, opens: row.opens, clicks: row.clicks, bounced: row.bounced_at !== null || row.status === "bounced" });
      }
    }

    // The step each channel runs next: the first unsent action step at or after where the contact stands.
    const nextIndex = new Map<string, number>();
    for (const [name, track] of tracks) {
      if (track.state !== "pending" && track.state !== "in_progress") continue;
      const upcoming = numbered.filter((entry) => entry.step.track === name && entry.index >= track.current_step && !sends.has(entry.step.id)).map((entry) => entry.index);
      if (upcoming.length) nextIndex.set(name, Math.min(...upcoming));
    }

    const steps = numbered.map(({ step, number, index }): CampaignStep => {
      const track = tracks.get(step.track);
      const sent = sends.get(step.id);
      const base = { id: step.id, number, track: step.track as "linkedin" | "email", type: step.step_type, subject: step.step_type === "email" ? step.email_subject : null, email: null, accepted_at: null };
      if (sent) {
        const accepted = step.step_type === "connect" && contact.connected_at && (stampOf(contact.connected_at) ?? "") >= (stampOf(sent.sent_at) ?? "") ? stampOf(contact.connected_at) : null;
        return { ...base, status: "sent", at: stampOf(sent.sent_at), reason: null, email: sent.email_job_id ? mail.get(sent.email_job_id) ?? null : null, accepted_at: accepted };
      }
      if (step.enabled === 0) return { ...base, status: "skipped", at: null, reason: "This step is switched off" };
      if (!track) return { ...base, status: "upcoming", at: null, reason: null };
      if (track.state === "failed") return index === track.current_step || index === nextIndexFallback(numbered, step.track, track.current_step)
        ? { ...base, status: "failed", at: null, reason: track.error_message }
        : { ...base, status: index < track.current_step ? "skipped" : "stopped", at: null, reason: null };
      if (track.state === "skipped") return index < track.current_step ? { ...base, status: "skipped", at: null, reason: null } : { ...base, status: "stopped", at: null, reason: track.error_message };
      if (track.state === "completed") return { ...base, status: "skipped", at: null, reason: null };
      if (index === nextIndex.get(step.track)) return { ...base, status: "next", at: stampOf(track.next_step_at), reason: track.hold === "handover" ? "Starts when the LinkedIn steps hand this contact over" : null };
      return { ...base, status: index < track.current_step ? "skipped" : "upcoming", at: null, reason: null };
    });

    const states = [...tracks.values()].map((track) => track.state);
    const going = states.some((state) => state === "pending" || state === "in_progress");
    const stopped = [...tracks.values()].find((track) => track.state === "skipped");
    const failed = [...tracks.values()].find((track) => track.state === "failed");
    const state: CampaignState = going
      ? run.run_status === "paused" ? "paused" : run.run_status === "running" ? "active" : run.run_status === "completed" || run.run_status === "failed" ? "completed" : "waiting"
      : failed ? "failed" : stopped ? "stopped" : "completed";
    const sentSteps = steps.filter((step) => step.status === "sent");
    const next = steps.filter((step) => step.status === "next").sort((a, b) => a.number - b.number)[0];
    return {
      run_id: run.run_id, workflow_id: run.workflow_id, name: run.name, run_status: run.run_status, enrolled_at: stampOf(run.enrolled_at), state,
      steps_total: steps.length, steps_sent: sentSteps.length, next_number: going && next ? next.number : null,
      stop_reason: failed?.error_message ?? stopped?.error_message ?? null,
      last_touch_at: sentSteps.map((step) => step.at).filter((at): at is string => at !== null).sort().pop() ?? null,
      replied: contact.replied, steps,
    };
  });
}

/** Where a failed channel stood, when it stood on a wait: the action step that would have come next. */
function nextIndexFallback(numbered: NumberedStep[], track: string, current: number): number | undefined {
  return numbered.filter((entry) => entry.step.track === track && entry.index >= current).map((entry) => entry.index).sort((a, b) => a - b)[0];
}

// ── The profile ───────────────────────────────────────────────────────────────

export interface ContactProfile {
  contact: {
    id: string;
    full_name: string | null; first_name: string | null; last_name: string | null;
    title: string | null; company: string | null; headline: string | null; summary: string | null;
    location: string | null; time_zone: string | null;
    email: string | null; email_status: string | null; email_verified_at: string | null; verifying: boolean;
    phone: string | null; linkedin_url: string | null; sales_nav_url: string | null;
    linkedin_status: LinkedinStatus; degree: number | null;
    intent_score: number; seniority: string | null;
    owner: { id: string; name: string } | null;
    tags: ContactTag[];
    notes: string | null; notes_updated_at: string | null; notes_updated_by: { id: string; name: string } | null;
    /** The latest reply on either channel, with the verdict it was given when there is one. */
    reply: { channel: "linkedin" | "email"; at: string; verdict: string | null } | null;
    unsubscribed_at: string | null;
    apollo_enriched_at: string | null; profile_refreshed_at: string | null;
    last_activity_at: string | null; created_at: string | null;
    positions: { title: string; company: string; start: string | null; end: string | null; current: boolean }[];
  };
  company: {
    id: string; name: string; domain: string | null; industry: string | null; employee_count: number | null; location: string | null;
    /** A few of the company's other contacts, and how many there are in all. */
    others: { id: string; full_name: string | null }[]; other_count: number;
  } | null;
  lists: { id: string; name: string }[];
  campaigns: CampaignHistory[];
  custom: { fields: { id: string; name: string; key: string; field_type: string }[]; values: Record<string, string | number | boolean | null> };
  tasks: { id: string; title: string; description: string | null; due_date: string | null; status: "open" | "done"; created_at: string }[];
  booking_url: string | null;
}

/** Everything the profile page shows about one contact, or null when it is not in this workspace. */
export function contactProfile(db: DB, workspaceId: string, targetId: string): ContactProfile | null {
  const row = db.prepare(
    `SELECT t.*, ${LINKEDIN_STATUS_SQL} AS linkedin_status, ${LAST_ACTIVITY_SQL} AS last_activity_at FROM targets t WHERE t.id = ? AND t.workspace_id = ?`,
  ).get(targetId, workspaceId) as (Row & { linkedin_status: LinkedinStatus }) | undefined;
  if (!row) return null;
  const text = (key: string) => (typeof row[key] === "string" && row[key] !== "" ? (row[key] as string) : null);
  const person = (id: unknown) => {
    if (typeof id !== "string" || !id) return null;
    const user = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(id) as { id: string; name: string | null; email: string } | undefined;
    return user ? { id: user.id, name: memberName(user) } : null;
  };

  // The latest reply, from the stored replies when there are any, else from the contact's own record.
  const stored = db.prepare(
    "SELECT channel, received_at, classification_json, sentiment FROM email_replies WHERE target_id = ? AND workspace_id = ? ORDER BY received_at DESC LIMIT 1",
  ).get(targetId, workspaceId) as { channel: string; received_at: string; classification_json: string | null; sentiment: string | null } | undefined;
  const linkedinReply = stampOf(row.last_replied_at);
  const emailReply = stampOf(row.email_replied_at);
  let reply: ContactProfile["contact"]["reply"] = null;
  if (stored && stampOf(stored.received_at)) {
    reply = { channel: stored.channel === "linkedin" ? "linkedin" : "email", at: stampOf(stored.received_at)!, verdict: parseJson<{ kind?: string }>(stored.classification_json, {}).kind ?? stored.sentiment ?? text("reply_kind") };
  }
  const flagged = [linkedinReply ? { channel: "linkedin" as const, at: linkedinReply } : null, emailReply ? { channel: "email" as const, at: emailReply } : null]
    .filter((entry): entry is { channel: "linkedin" | "email"; at: string } => entry !== null).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (flagged && (!reply || flagged.at > reply.at)) reply = { ...flagged, verdict: reply?.verdict ?? text("reply_kind") };

  const companyRow = text("company_id")
    ? db.prepare("SELECT id, name, domain, industry, employee_count, location FROM companies WHERE id = ? AND workspace_id = ?").get(row.company_id, workspaceId) as
      { id: string; name: string; domain: string | null; industry: string | null; employee_count: number | null; location: string | null } | undefined
    : undefined;
  const company: ContactProfile["company"] = companyRow
    ? {
      ...companyRow,
      others: db.prepare("SELECT id, full_name FROM targets WHERE company_id = ? AND workspace_id = ? AND id != ? ORDER BY intent_score DESC, full_name LIMIT 3").all(companyRow.id, workspaceId, targetId) as { id: string; full_name: string | null }[],
      other_count: (db.prepare("SELECT COUNT(*) AS c FROM targets WHERE company_id = ? AND workspace_id = ? AND id != ?").get(companyRow.id, workspaceId, targetId) as { c: number }).c,
    }
    : null;

  const fields = db.prepare("SELECT id, name, key, field_type FROM custom_field_definitions WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(workspaceId) as ContactProfile["custom"]["fields"];
  const typeOf = new Map(fields.map((field) => [field.id, field.field_type]));
  const values: ContactProfile["custom"]["values"] = {};
  for (const value of db.prepare("SELECT field_id, value_text, value_number, value_boolean FROM contact_custom_values WHERE workspace_id = ? AND target_id = ?").all(workspaceId, targetId) as
    { field_id: string; value_text: string | null; value_number: number | null; value_boolean: number | null }[]) {
    const type = typeOf.get(value.field_id);
    values[value.field_id] = type === "number" ? value.value_number : type === "boolean" ? value.value_boolean === 1 : value.value_text;
  }

  const positions = parseJson<{ title?: string; companyName?: string; startDate?: unknown; endDate?: unknown; current?: boolean }[]>(row.positions_json, [])
    .filter((position) => position && (position.title || position.companyName))
    .map((position) => ({ title: position.title ?? "", company: position.companyName ?? "", start: dateText(position.startDate), end: dateText(position.endDate), current: position.current === true }));

  return {
    contact: {
      id: targetId, full_name: text("full_name"), first_name: text("first_name"), last_name: text("last_name"), title: text("title"), company: text("company"),
      headline: text("headline"), summary: text("summary"), location: text("location"), time_zone: text("time_zone"),
      email: text("email"), email_status: text("email_status"), email_verified_at: stampOf(row.email_verified_at), verifying: row.email_verify_requested_at !== null,
      phone: text("phone"), linkedin_url: text("linkedin_url"), sales_nav_url: text("sales_nav_url"),
      linkedin_status: row.linkedin_status, degree: typeof row.degree === "number" ? row.degree : null,
      intent_score: Math.round(Number(row.intent_score ?? 0)), seniority: text("seniority"),
      owner: person(row.owner_id),
      tags: db.prepare("SELECT ct.id, ct.name, ct.color FROM target_tags tt JOIN contact_tags ct ON ct.id = tt.tag_id WHERE tt.target_id = ? AND ct.workspace_id = ? ORDER BY ct.name").all(targetId, workspaceId) as ContactTag[],
      notes: text("notes"), notes_updated_at: stampOf(row.notes_updated_at), notes_updated_by: person(row.notes_updated_by),
      reply, unsubscribed_at: stampOf(row.unsubscribed_at),
      apollo_enriched_at: stampOf(row.apollo_enriched_at), profile_refreshed_at: stampOf(row.posts_scraped_at) ?? stampOf(row.enriched_profile_at),
      last_activity_at: text("last_activity_at"), created_at: stampOf(row.created_at),
      positions,
    },
    company,
    lists: db.prepare("SELECT l.id, l.name FROM lists l JOIN list_targets lt ON lt.list_id = l.id WHERE lt.target_id = ? AND l.workspace_id = ? ORDER BY l.name COLLATE NOCASE").all(targetId, workspaceId) as { id: string; name: string }[],
    campaigns: campaignHistory(db, workspaceId, targetId, { connected_at: text("connected_at"), replied: reply !== null }),
    custom: { fields, values },
    tasks: db.prepare("SELECT id, title, description, due_date, status, created_at FROM todos WHERE target_id = ? AND workspace_id = ? ORDER BY status = 'done', due_date IS NULL, due_date, created_at DESC").all(targetId, workspaceId) as ContactProfile["tasks"],
    booking_url: getBookingUrl(workspaceId, db),
  };
}

/** A career date as stored: "2022-03-01", {year, month} from Sales Navigator, or nothing. */
function dateText(value: unknown): string | null {
  if (typeof value === "string" && value) return value.slice(0, 10);
  if (value && typeof value === "object") {
    const { year, month } = value as { year?: number; month?: number };
    if (typeof year === "number") return `${year}-${String(typeof month === "number" ? month : 1).padStart(2, "0")}-01`;
  }
  return null;
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export type TimelineKind =
  | "email_sent" | "email_engaged" | "email_bounced"
  | "linkedin_visit" | "linkedin_invite" | "linkedin_accepted" | "linkedin_withdrawn" | "linkedin_message" | "linkedin_received" | "linkedin_inmail"
  | "reply" | "activity" | "meeting" | "list_added" | "list_removed" | "enriched" | "created";

export interface TimelineItem {
  id: string;
  at: string;
  channel: "email" | "linkedin" | "other";
  kind: TimelineKind;
  /** The campaign step number, when a campaign did this. */
  step: number | null;
  campaign: { id: string; name: string } | null;
  /** The teammate who did it, when a person did. */
  actor: string | null;
  /** A reply's verdict, a logged activity's type, a hand-sent message's state. */
  label: string | null;
  list: { id: string; name: string | null } | null;
  opens: number;
  clicks: number;
  detail: string | null;
  /** An email's subject, in full. */
  subject: string | null;
  /** The whole of a message or reply, where `detail` only has the start of it. */
  body: string | null;
  /** The activity log entry behind an "activity" item, so it can be edited or deleted. */
  activity_id: string | null;
}

export const TIMELINE_CHANNELS = ["all", "email", "linkedin"] as const;
export type TimelineChannel = (typeof TIMELINE_CHANNELS)[number];

const SEND_KIND: Record<string, TimelineKind> = { email: "email_sent", visit: "linkedin_visit", connect: "linkedin_invite", message: "linkedin_message", sales_inmail: "linkedin_inmail", inmail: "linkedin_inmail" };

/**
 * Everything that has happened with a contact, newest first: campaign steps sent on
 * either channel, opens and clicks, invitations accepted, replies, messages sent by hand,
 * activities and notes teammates logged, meetings, and joining or leaving a list.
 */
export function contactTimeline(
  db: DB, workspaceId: string, targetId: string, options: { channel?: TimelineChannel; limit?: number; offset?: number } = {},
): { items: TimelineItem[]; total: number; counts: Record<TimelineChannel, number> } | null {
  const target = db.prepare(
    "SELECT id, created_at, connected_at, connection_requested_at, invite_withdrawn_at, message_sent_at, inmail_sent_at, last_replied_at, email_replied_at, apollo_enriched_at FROM targets WHERE id = ? AND workspace_id = ?",
  ).get(targetId, workspaceId) as Record<string, string | null> | undefined;
  if (!target) return null;
  const items: TimelineItem[] = [];
  const blank = { step: null, campaign: null, actor: null, label: null, list: null, opens: 0, clicks: 0, detail: null, subject: null, body: null, activity_id: null };
  const push = (item: Omit<Partial<TimelineItem>, "at"> & Pick<TimelineItem, "id" | "kind" | "channel"> & { at: string | null }) => {
    if (item.at) items.push({ ...blank, ...item, at: item.at });
  };
  const names = new Map<string, string>();
  const nameOf = (id: string | null) => {
    if (!id) return null;
    if (!names.has(id)) {
      const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(id) as { name: string | null; email: string } | undefined;
      names.set(id, user ? memberName(user) : "");
    }
    return names.get(id) || null;
  };

  // Campaign steps. The step's number comes from its campaign as it stands now.
  const sends = db.prepare(
    `SELECT ss.id, ss.channel, ss.action, ss.sent_at, ss.workflow_id, ss.step_id, ss.email_job_id, w.name AS campaign, ej.subject, ej.body_text
     FROM step_sends ss LEFT JOIN workflows w ON w.id = ss.workflow_id LEFT JOIN email_jobs ej ON ej.id = ss.email_job_id
     WHERE ss.target_id = ? AND ss.workspace_id = ?`,
  ).all(targetId, workspaceId) as { id: string; channel: string; action: string; sent_at: string; workflow_id: string | null; step_id: string | null; email_job_id: string | null; campaign: string | null; subject: string | null; body_text: string | null }[];
  const numbers = new Map<string, Map<string, number>>();
  const stepNumber = (workflowId: string | null, stepId: string | null) => {
    if (!workflowId || !stepId) return null;
    if (!numbers.has(workflowId)) {
      const steps = db.prepare("SELECT id, track, step_type, step_order, delay_seconds, email_subject, enabled FROM workflow_steps WHERE workflow_id = ?").all(workflowId) as StepRow[];
      numbers.set(workflowId, new Map(numberSteps(steps).map((entry) => [entry.step.id, entry.number])));
    }
    return numbers.get(workflowId)!.get(stepId) ?? null;
  };
  // What a campaign message said, where the conversation has been stored: the outgoing message nearest the send.
  const outgoing = db.prepare(
    "SELECT id, body, sent_at, status, error, created_by FROM linkedin_messages WHERE target_id = ? AND workspace_id = ? AND direction = 'out'",
  ).all(targetId, workspaceId) as { id: string; body: string; sent_at: string; status: string; error: string | null; created_by: string | null }[];
  const campaignMessages = outgoing.filter((message) => message.created_by === null).map((message) => ({ id: message.id, body: message.body, sent_at: message.sent_at, status: message.status, ms: Date.parse(`${(stampOf(message.sent_at) ?? "").replace(" ", "T")}Z`) }));
  const matched = new Set<string>();
  const sentActions = new Set<string>();
  for (const send of sends) {
    const kind = SEND_KIND[send.action] ?? (send.channel === "email" ? "email_sent" : "linkedin_message");
    sentActions.add(send.action);
    let detail = send.channel === "email" ? snippet(send.subject) ?? snippet(send.body_text) : null;
    let body = send.channel === "email" ? send.body_text : null;
    if (kind === "linkedin_message" || kind === "linkedin_inmail") {
      const ms = Date.parse(`${(stampOf(send.sent_at) ?? "").replace(" ", "T")}Z`);
      const nearest = campaignMessages.filter((message) => Math.abs(message.ms - ms) <= 10 * 60_000).sort((a, b) => Math.abs(a.ms - ms) - Math.abs(b.ms - ms))[0];
      detail = snippet(nearest?.body);
      body = nearest?.body ?? null;
      if (nearest) matched.add(nearest.id);
    }
    push({
      id: `send:${send.id}`, kind, channel: send.channel === "email" ? "email" : "linkedin", at: stampOf(send.sent_at), detail, body, subject: send.channel === "email" ? send.subject : null,
      step: stepNumber(send.workflow_id, send.step_id), campaign: send.workflow_id && send.campaign ? { id: send.workflow_id, name: send.campaign } : null,
    });
  }

  // Opens and clicks, one line per email, at the latest of them. Mail scanners are left out.
  for (const row of db.prepare(
    `SELECT sm.id, sm.subject, sm.bounced_at, MAX(se.occurred_at) AS last_at,
            COALESCE(SUM(CASE WHEN se.event_type = 'opened' THEN 1 ELSE 0 END), 0) AS opens, COALESCE(SUM(CASE WHEN se.event_type = 'clicked' THEN 1 ELSE 0 END), 0) AS clicks
     FROM sent_messages sm LEFT JOIN sender_events se ON se.sent_message_id = sm.id AND se.is_bot = 0 AND se.event_type IN ('opened', 'clicked')
     WHERE sm.target_id = ? AND sm.workspace_id = ? GROUP BY sm.id`,
  ).all(targetId, workspaceId) as { id: string; subject: string | null; bounced_at: string | null; last_at: string | null; opens: number; clicks: number }[]) {
    if (row.opens + row.clicks > 0) push({ id: `engaged:${row.id}`, kind: "email_engaged", channel: "email", at: stampOf(row.last_at), opens: row.opens, clicks: row.clicks, detail: snippet(row.subject) });
    push({ id: `bounced:${row.id}`, kind: "email_bounced", channel: "email", at: stampOf(row.bounced_at), detail: snippet(row.subject) });
  }

  // Emails that were not a campaign step: sent from the contact page, or a campaign email whose step is gone.
  for (const job of db.prepare(
    `SELECT ej.id, ej.subject, ej.body_text, ej.status, ej.source, ej.last_error, ej.updated_at, ej.created_at, sm.accepted_at
     FROM email_jobs ej LEFT JOIN sent_messages sm ON sm.job_id = ej.id
     WHERE ej.target_id = ? AND ej.workspace_id = ? AND ej.status != 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM step_sends ss WHERE ss.email_job_id = ej.id)
       AND (ej.source != 'campaign' OR ej.status IN ('sent', 'failed', 'uncertain'))`,
  ).all(targetId, workspaceId) as { id: string; subject: string; body_text: string; status: string; source: string; last_error: string | null; updated_at: string; created_at: string; accepted_at: string | null }[]) {
    push({
      id: `mail:${job.id}`, kind: "email_sent", channel: "email", at: stampOf(job.accepted_at) ?? stampOf(job.status === "sent" ? job.updated_at : job.created_at),
      detail: snippet(job.subject) ?? snippet(job.body_text), subject: job.subject, body: job.body_text,
      label: job.status === "sent" ? null : job.status === "pending" || job.status === "leased" || job.status === "sending" ? "queued" : job.status,
    });
  }

  // LinkedIn facts kept on the contact. A send recorded as a campaign step is not said twice.
  push({ id: "accepted", kind: "linkedin_accepted", channel: "linkedin", at: stampOf(target.connected_at) });
  push({ id: "withdrawn", kind: "linkedin_withdrawn", channel: "linkedin", at: stampOf(target.invite_withdrawn_at) });
  if (!sentActions.has("connect")) push({ id: "invited", kind: "linkedin_invite", channel: "linkedin", at: stampOf(target.connection_requested_at) });
  if (!sentActions.has("sales_inmail") && !sentActions.has("inmail")) push({ id: "inmail", kind: "linkedin_inmail", channel: "linkedin", at: stampOf(target.inmail_sent_at) });

  // Messages a teammate sent by hand, with what became of each.
  for (const message of outgoing.filter((entry) => entry.created_by !== null)) {
    push({
      id: `message:${message.id}`, kind: "linkedin_message", channel: "linkedin", at: stampOf(message.sent_at), actor: nameOf(message.created_by), detail: snippet(message.body),
      label: message.status === "delivered" ? null : message.status, body: message.body,
    });
  }
  // What was said on LinkedIn that no campaign step and no teammate here accounts for: messages the
  // contact sent, and ones the account's owner sent from LinkedIn itself.
  for (const message of campaignMessages.filter((entry) => !matched.has(entry.id))) {
    push({ id: `message:${message.id}`, kind: "linkedin_message", channel: "linkedin", at: stampOf(message.sent_at), detail: snippet(message.body), body: message.body, label: message.status === "delivered" ? null : message.status });
  }
  const filedAsReply = new Set((db.prepare(
    "SELECT external_id FROM email_replies WHERE target_id = ? AND workspace_id = ? AND channel = 'linkedin' AND external_id IS NOT NULL",
  ).all(targetId, workspaceId) as { external_id: string }[]).map((row) => row.external_id));
  for (const message of db.prepare(
    "SELECT id, message_urn, body, sent_at FROM linkedin_messages WHERE target_id = ? AND workspace_id = ? AND direction = 'in'",
  ).all(targetId, workspaceId) as { id: string; message_urn: string | null; body: string; sent_at: string }[]) {
    if (message.message_urn && filedAsReply.has(message.message_urn)) continue;
    push({ id: `received:${message.id}`, kind: "linkedin_received", channel: "linkedin", at: stampOf(message.sent_at), detail: snippet(message.body), body: message.body });
  }

  // Replies on either channel.
  const replies = db.prepare(
    "SELECT id, channel, received_at, subject, body_text, classification_json, sentiment FROM email_replies WHERE target_id = ? AND workspace_id = ?",
  ).all(targetId, workspaceId) as { id: string; channel: string; received_at: string; subject: string | null; body_text: string | null; classification_json: string | null; sentiment: string | null }[];
  for (const reply of replies) {
    push({
      id: `reply:${reply.id}`, kind: "reply", channel: reply.channel === "linkedin" ? "linkedin" : "email", at: stampOf(reply.received_at),
      label: parseJson<{ kind?: string }>(reply.classification_json, {}).kind ?? reply.sentiment ?? null, detail: snippet(reply.body_text) ?? snippet(reply.subject),
      subject: reply.subject, body: reply.body_text,
    });
  }
  // A reply known only from the contact's record: marked by hand, or noticed by a campaign.
  if (!replies.some((reply) => reply.channel === "linkedin")) push({ id: "replied:linkedin", kind: "reply", channel: "linkedin", at: stampOf(target.last_replied_at) });
  if (!replies.some((reply) => reply.channel !== "linkedin")) push({ id: "replied:email", kind: "reply", channel: "email", at: stampOf(target.email_replied_at) });

  for (const activity of db.prepare(
    "SELECT id, type, body, logged_at, created_by FROM activity_logs WHERE target_id = ? AND workspace_id = ?",
  ).all(targetId, workspaceId) as { id: string; type: string; body: string; logged_at: string; created_by: string | null }[]) {
    push({ id: `activity:${activity.id}`, kind: "activity", channel: "other", at: stampOf(activity.logged_at), label: activity.type, actor: nameOf(activity.created_by), detail: activity.body, activity_id: activity.id });
  }

  for (const meeting of db.prepare("SELECT id, title, starts_at, status FROM meetings WHERE target_id = ? AND workspace_id = ?").all(targetId, workspaceId) as { id: string; title: string; starts_at: string; status: string | null }[]) {
    push({ id: `meeting:${meeting.id}`, kind: "meeting", channel: "other", at: stampOf(meeting.starts_at), detail: meeting.title, label: meeting.status });
  }

  // Joining and leaving lists. A list deleted since keeps the name it had when the contact joined.
  const membership = db.prepare(
    "SELECT e.id, e.list_id, e.list_name, e.action, e.created_at, l.name AS current_name FROM list_membership_events e LEFT JOIN lists l ON l.id = e.list_id WHERE e.target_id = ? ORDER BY e.id",
  ).all(targetId) as { id: number; list_id: string; list_name: string | null; action: string; created_at: string; current_name: string | null }[];
  const lastKnown = new Map<string, string>();
  for (const event of membership) {
    if (event.list_name) lastKnown.set(event.list_id, event.list_name);
    push({
      id: `list:${event.id}`, kind: event.action === "removed" ? "list_removed" : "list_added", channel: "other", at: stampOf(event.created_at),
      list: { id: event.list_id, name: event.current_name ?? event.list_name ?? lastKnown.get(event.list_id) ?? null },
    });
  }

  push({ id: "enriched", kind: "enriched", channel: "other", at: stampOf(target.apollo_enriched_at) });
  push({ id: "created", kind: "created", channel: "other", at: stampOf(target.created_at) });

  items.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const counts = { all: items.length, email: items.filter((item) => item.channel === "email").length, linkedin: items.filter((item) => item.channel === "linkedin").length };
  const channel = options.channel && options.channel !== "all" ? options.channel : null;
  const chosen = channel ? items.filter((item) => item.channel === channel) : items;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  return { items: chosen.slice(offset, offset + limit), total: chosen.length, counts };
}

// ── Previous and next ─────────────────────────────────────────────────────────

/**
 * Where a contact sits in a contacts request (the same filters, search and sort the table
 * takes), with the contacts either side of it. Null when the contact is not in that result.
 */
export function contactNeighbours(db: DB, workspaceId: string, targetId: string, query: Query): { position: number; total: number; previous: string | null; next: string | null } | null {
  const { from, where, params } = contactsQuery(query, workspaceId);
  const order = contactsOrder(query).orderBy;
  const row = db.prepare(
    `WITH ordered AS (
       SELECT t.id AS id, ROW_NUMBER() OVER (${order}) AS position, LAG(t.id) OVER (${order}) AS previous, LEAD(t.id) OVER (${order}) AS next
       ${from} ${where}
     )
     SELECT position, previous, next, (SELECT COUNT(*) FROM ordered) AS total FROM ordered WHERE id = ?`,
  ).get(...params, targetId) as { position: number; previous: string | null; next: string | null; total: number } | undefined;
  return row ?? null;
}
