import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { getSessionPage, saveSessionState, getSessionContext } from "@/lib/linkedin/session";
import { visitProfile } from "@/lib/linkedin/visit";
import { sendConnectionRequest, WeeklyLimitError, AlreadyConnectedError, PendingInviteError } from "@/lib/linkedin/connect";
import { sendMessage } from "@/lib/linkedin/message";
import { shouldSyncAccepted, syncAcceptedConnections } from "@/lib/linkedin/sync-accepted";
import { acquireWorkerLease, processEmailJobs, sendEmailDurably } from "@/lib/email/infrastructure";
import { shouldSyncEmailInbox, syncEmailInbox, listImapEmailAccountIds } from "@/lib/email/inbox";
import { enrichProfile } from "@/lib/linkedin/enrich";
import { matchPerson } from "@/lib/apollo";
import { premium } from "@/lib/premium";
import { decryptSecret } from "@/lib/crypto";
import { findTargetSuppression, addSuppression } from "@/lib/platform/suppression";
import { verifyEmailAddress, emailStatusFor, processVerificationQueue } from "@/lib/email/verify";
import { emitDomainEvent, processWebhookDeliveries } from "@/lib/platform/events";
import { branchLandingIndex, emailSendGapMs } from "@/lib/outreach/sequence";
import { localDayBoundsUtc, slotInWindow, zonedParts, zonedTimeToUtcMs } from "@/lib/outreach/schedule";
import { guard } from "@/lib/watchdog";
import { evaluateWorkflowConditions, type ConditionGroup } from "@/lib/platform/conditions";
import { processWarmupCycle } from "@/lib/platform/deliverability";
import { processWarmupEngagement } from "@/lib/email/warmup-engagement";
import { syncDueConnections } from "@/lib/platform/connectors";
import { renderOutreachTemplate } from "@/lib/outreach/render";
import { loadTargetCustomValues } from "@/lib/outreach/custom-values";

// Minimum gap between Sales Nav profile enrichment calls per account (ms)
const SALES_NAV_ENRICH_MIN_GAP_MS = 5 * 60 * 1000;
// Per-account timestamp of last ensureSalesNavEnriched execution
const lastSalesNavEnrichAt: Record<string, number> = {};

// Initial wait before first acceptance check (6h)
const CONNECTION_RECHECK_HOURS = 6;
// Max days to wait for acceptance before giving up
const CONNECTION_MAX_WAIT_DAYS = 7;
// Delay between profiles (seconds)
const PROFILE_DELAY_MIN = 8;
const PROFILE_DELAY_MAX = 20;
// Poll interval (ms)
const POLL_INTERVAL_MS = 30_000;

// Watchdog budgets. Every network/browser await on a runner loop gets one: the loops are
// sequential, so a single promise that never settles halts everything downstream of it with
// no error and no log line. These are deliberately generous — they exist to break a hang,
// not to cut short slow-but-progressing work. Playwright's own 30s per-action timeouts sit
// under EXECUTE_STEP_TIMEOUT_MS.
const INBOX_SYNC_TIMEOUT_MS = 60_000;
const REPLY_SYNC_TIMEOUT_MS = 60_000;
const ACCEPTED_SYNC_TIMEOUT_MS = 180_000;
const CONNECTION_SYNC_TIMEOUT_MS = 120_000;
const EXECUTE_STEP_TIMEOUT_MS = 300_000;
// Backstop for the whole tick: comfortably above the sum of a realistic pass, so it only
// fires on a genuine wedge.
const TICK_TIMEOUT_MS = 15 * 60_000;

interface ScheduleConfig {
  active_hours_start: number;
  active_hours_end: number;
  timezone: string;
  working_days: string;
}

interface AccountLimits extends ScheduleConfig {
  daily_connection_limit: number;
  daily_message_limit: number;
  daily_inmail_limit: number;
}

interface EmailAccountLimits extends ScheduleConfig {
  daily_email_limit: number;
  ramp_up_enabled: number | null;
  ramp_start_date: string | null;
}

function effectiveEmailLimit(account: EmailAccountLimits): number {
  if (!account.ramp_up_enabled || !account.ramp_start_date) return account.daily_email_limit;
  const daysActive = Math.max(1, Math.floor((Date.now() - new Date(account.ramp_start_date).getTime()) / 86_400_000) + 1);
  const ramped = daysActive * 2;
  return Math.min(account.daily_email_limit, ramped);
}

// Floor on the gap between two sends from the SAME email account, plus jitter so the
// spacing is not uniform. Uniform gaps are themselves a detectable automation signature.
const MIN_EMAIL_GAP_MS = 4 * 60_000;
const EMAIL_GAP_JITTER_MS = 90_000;

/**
 * Decide whether this email account may send right now, or must wait.
 *
 * The daily cap is a ceiling, not a rate. On its own it lets an account emit its entire
 * allowance in a single burst (8 sends in 11 minutes observed in production) and then sit
 * idle for the rest of the window. Mailbox providers fingerprint burst rate and timing
 * regularity, not just daily volume, so that pattern is risky no matter how low the total.
 *
 * Spreads the remaining quota across the remaining working window, floored at
 * MIN_EMAIL_GAP_MS and jittered. Returns an ISO timestamp to wait until, or null to send.
 */
function emailPaceGate(
  db: ReturnType<typeof getDb>,
  emailAccountId: string,
  limits: EmailAccountLimits,
  sentToday: number,
  dailyLimit: number,
): string | null {
  // Same ground-truth source AND the same day bounds as the daily-limit guard, so the two
  // can never disagree about what "today" means for this account.
  const day = localDayBoundsUtc(limits.timezone);
  const last = (db.prepare(
    `SELECT MAX(l.created_at) AS t FROM logs l
     WHERE l.message LIKE 'Email sent%'
       AND l.created_at >= ? AND l.created_at < ?
       AND EXISTS (
         SELECT 1 FROM run_profiles rp
         WHERE rp.run_id = l.run_id AND rp.target_id = l.target_id
           AND rp.email_account_id = ?
       )`
  ).get(day.start, day.end, emailAccountId) as { t: string | null }).t;
  if (!last) return null; // first send of the day for this account

  // logs.created_at is SQLite datetime('now') — UTC, no zone suffix.
  const lastMs = Date.parse(`${last.replace(" ", "T")}Z`);
  if (Number.isNaN(lastMs)) return null;

  const { hour, minute } = getLocalParts(limits.timezone);
  const remainingHours = Math.max(0, limits.active_hours_end - (hour + minute / 60));
  const remainingSends = Math.max(1, dailyLimit - sentToday);

  const jitter = (Math.random() * 2 - 1) * EMAIL_GAP_JITTER_MS;
  const readyAt = lastMs + emailSendGapMs(remainingHours, remainingSends, MIN_EMAIL_GAP_MS, jitter);
  return readyAt > Date.now() ? new Date(readyAt).toISOString() : null;
}

function getLocalParts(tz: string, date = new Date()): { hour: number; minute: number; isoWeekday: number } {
  const safeZone = (() => { try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; } catch { return "UTC"; } })();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone,
    hour: "numeric", minute: "numeric", weekday: "short", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { hour, minute, isoWeekday: weekdayMap[get("weekday")] ?? 1 };
}

function isWithinSchedule(account: ScheduleConfig): boolean {
  const { hour, minute, isoWeekday } = getLocalParts(account.timezone || "UTC");
  const allowedDays = (account.working_days || "1,2,3,4,5").split(",").map(Number);
  if (!allowedDays.includes(isoWeekday)) return false;
  const frac = hour + minute / 60;
  return frac >= (account.active_hours_start ?? 9) && frac < (account.active_hours_end ?? 18);
}

// Slots are generated in the ACCOUNT's timezone so they agree with isWithinSchedule,
// which also evaluates there. Generating them in server-local time meant a UTC host with
// an America/New_York account produced 09:00-18:00 UTC = 05:00-14:00 NY, so many slots
// were already outside the window on arrival and were rescheduled again immediately.
function randomSlotInActiveWindow(account: ScheduleConfig, targetDate?: Date): string {
  const tz = account.timezone || "UTC";
  const start = account.active_hours_start ?? 9;
  const end = account.active_hours_end ?? 18;
  const base = targetDate ?? new Date();
  const slot = slotInWindow(tz, base, start, end);
  if (slot) return slot;
  // Misconfigured window (start >= end): fall back to the window start on that day.
  const { year, month, day } = zonedParts(tz, base);
  return new Date(zonedTimeToUtcMs(tz, year, month, day, start)).toISOString();
}

function rescheduleToTomorrow(account: ScheduleConfig): string {
  const tz = account.timezone || "UTC";
  // Advance a day on the ACCOUNT's calendar, not the server's. Anchoring at local noon
  // keeps the +24h hop on the intended day across DST transitions.
  const { year, month, day } = zonedParts(tz);
  const tomorrow = new Date(zonedTimeToUtcMs(tz, year, month, day, 12) + 86_400_000);
  return randomSlotInActiveWindow(account, tomorrow);
}

function nextScheduledSlot(account: ScheduleConfig): string {
  const tz = account.timezone || "UTC";
  const allowedDays = (account.working_days || "1,2,3,4,5").split(",").map(Number);
  const start = account.active_hours_start ?? 9;
  const end = account.active_hours_end ?? 18;
  const now = new Date();

  // Today, when it is a working day and the window has not closed yet. slotInWindow
  // clamps the lower bound to max(window start, now), which is the fix for the
  // reschedule loop: previously only the END was checked, so a track woken BEFORE the
  // window (e.g. 03:00 for a 09:00-18:00 account) got a slot anywhere in the next 15
  // hours - frequently seconds away and still outside the window - which tripped the
  // same guard on the next poll, over and over. The +60s floor also stops a slot
  // landing effectively "now".
  if (allowedDays.includes(zonedParts(tz, now).isoWeekday)) {
    const slot = slotInWindow(tz, now, start, end, now.getTime() + 60_000);
    if (slot) return slot;
  }
  for (let i = 1; i <= 14; i++) {
    const candidate = new Date(now.getTime() + i * 86_400_000);
    if (!allowedDays.includes(zonedParts(tz, candidate).isoWeekday)) continue;
    const slot = slotInWindow(tz, candidate, start, end);
    if (slot) return slot;
  }
  return new Date(Date.now() + 86_400_000).toISOString();
}

interface WorkflowStep {
  id: string;
  step_order: number;
  track: "linkedin" | "email";
  step_type: "visit" | "connect" | "message" | "sales_inmail" | "delay" | "email";
  template_id: string | null;
  delay_seconds: number;
  connect_note: string | null;
  message_body: string | null;
  email_subject: string | null;
  email_body: string | null;
  ai_enabled: number | null;
  ai_model: string | null;
  ai_prompt: string | null;
  ai_max_words: number | null;
  ai_language: string | null;
  email_position: number | null;
  message_position: number | null;
  email_signature: string | null;
  email_delivery_mode: "plain" | "enhanced" | null;
  email_track_opens: number | null;
  email_track_clicks: number | null;
}

// A track-run row joined with its parent run_profile and run context
interface TrackRun {
  // run_profile_tracks columns
  id: string;
  run_profile_id: string;
  track: "linkedin" | "email";
  state: string;
  current_step: number;
  next_step_at: string | null;
  error_message: string | null;
  last_email_subject: string | null;
  last_email_body: string | null;
  last_linkedin_message: string | null;
  pending_reply_context: string | null;
  // joined from run_profiles / runs
  run_id: string;
  target_id: string;
  email_account_id: string | null;
  account_id: string;
  workflow_id: string;
  // joined from targets — lets the daily-limit gate tell a NEW connect send apart
  // from a free acceptance recheck on an already-sent request
  connection_requested_at: string | null;
}

interface Target {
  id: string;
  linkedin_url: string;
  sales_nav_url: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  degree: number | null;
  connection_requested_at: string | null;
  connected_at: string | null;
  email: string | null;
  email_status: string | null;
  email_replied_at: string | null;
  company_id: string | null;
  workspace_id: string;
}

interface Template { id: string; body: string; }

// ─── helpers ────────────────────────────────────────────────────────────────

function log(db: ReturnType<typeof getDb>, runId: string, targetId: string | null, level: "info" | "warn" | "error", message: string) {
  db.prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), runId, targetId, level, message);
  console.log(`[runner] [${level}] run=${runId} target=${targetId ?? "-"} ${message}`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(minSec: number, maxSec: number) { return sleep((minSec + Math.random() * (maxSec - minSec)) * 1000); }
function nowIso() { return new Date().toISOString(); }
function addHours(h: number) { return new Date(Date.now() + h * 3600_000).toISOString(); }
function hoursSince(isoStr: string) { return (Date.now() - new Date(isoStr).getTime()) / 3600_000; }

// ─── TrackRun verb layer ─────────────────────────────────────────────────────
// These are the only functions that write to run_profile_tracks rows.

function trAdvance(db: ReturnType<typeof getDb>, tr: TrackRun, steps: WorkflowStep[]) {
  let nextIndex = tr.current_step + 1;
  const sourceStep = steps[tr.current_step];
  if (sourceStep) {
    const branch = db.prepare("SELECT conditions_json, true_step_id, false_step_id FROM workflow_branches WHERE source_step_id = ?")
      .get(sourceStep.id) as { conditions_json: string; true_step_id: string | null; false_step_id: string | null } | undefined;
    if (branch) {
      try {
        const group = JSON.parse(branch.conditions_json) as ConditionGroup;
        // Only branch on a well-formed, non-empty condition group. A malformed/legacy branch
        // (e.g. missing the conditions array) must NOT silently evaluate as "matched" and
        // misroute — fall through to the next step in order instead.
        if (!Array.isArray(group?.conditions) || group.conditions.length === 0) {
          console.warn(`[runner] Branch on step ${sourceStep.id} has no valid conditions — running steps in order`);
        } else {
          const matched = evaluateWorkflowConditions(db, tr.target_id, group);
          const destination = matched ? branch.true_step_id : branch.false_step_id;
          if (destination) {
            const branchIndex = steps.findIndex((step) => step.id === destination);
            if (branchIndex > tr.current_step) {
              // A branch names an ACTION step, but a sequence models "wait N days, then
              // do X" as [delay(N), X]. Jumping straight to X discards that wait: the
              // destination's own delay_seconds is 0, so the write below sets
              // next_step_at = NULL and the step runs on the very next poll. A
              // reply-gated 5-email sequence therefore collapsed into ~40 minutes,
              // sending every follow-up at once. Land on the delay that guards the
              // destination so the normal wait/advance path applies it. Only walk back
              // over delays that are still ahead of us, preserving forward-only branching.
              nextIndex = branchLandingIndex(steps, tr.current_step, branchIndex);
            }
          }
        }
      } catch (error) {
        console.warn(`[runner] Invalid branch on step ${sourceStep.id}:`, error);
      }
    }
  }
  if (nextIndex >= steps.length) {
    db.prepare(
      "UPDATE run_profile_tracks SET state = 'completed', current_step = ?, last_step_at = datetime('now'), next_step_at = NULL WHERE id = ?"
    ).run(nextIndex, tr.id);
  } else {
    const nextStep = steps[nextIndex];
    const nextAt = nextStep.delay_seconds > 0 ? new Date(Date.now() + nextStep.delay_seconds * 1000).toISOString() : null;
    db.prepare(
      "UPDATE run_profile_tracks SET current_step = ?, last_step_at = datetime('now'), next_step_at = ? WHERE id = ?"
    ).run(nextIndex, nextAt, tr.id);
  }
}

function trWait(db: ReturnType<typeof getDb>, tr: TrackRun, hours: number) {
  db.prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE id = ?").run(addHours(hours), tr.id);
}

function trReschedule(db: ReturnType<typeof getDb>, tr: TrackRun, isoTimestamp: string) {
  db.prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE id = ?").run(isoTimestamp, tr.id);
}

function trSkip(db: ReturnType<typeof getDb>, tr: TrackRun, reason: string) {
  db.prepare("UPDATE run_profile_tracks SET state = 'skipped', error_message = ? WHERE id = ?").run(reason, tr.id);
}

function trFail(db: ReturnType<typeof getDb>, tr: TrackRun, reason: string) {
  db.prepare("UPDATE run_profile_tracks SET state = 'failed', error_message = ? WHERE id = ?").run(reason, tr.id);
}

function trRecordContext(db: ReturnType<typeof getDb>, tr: TrackRun, ctx: { linkedinMessage?: string; emailSubject?: string; emailBody?: string }) {
  if (ctx.linkedinMessage !== undefined) {
    db.prepare("UPDATE run_profile_tracks SET last_linkedin_message = ? WHERE id = ?").run(ctx.linkedinMessage, tr.id);
  }
  if (ctx.emailSubject !== undefined || ctx.emailBody !== undefined) {
    db.prepare("UPDATE run_profile_tracks SET last_email_subject = ?, last_email_body = ? WHERE id = ?")
      .run(ctx.emailSubject ?? null, ctx.emailBody ?? null, tr.id);
  }
}

// ─── enforceSchedule helper ──────────────────────────────────────────────────
// Returns true if the step may proceed. Returns false and reschedules if outside the window.

function enforceSchedule(
  db: ReturnType<typeof getDb>,
  tr: TrackRun,
  runId: string,
  targetId: string,
  name: string,
  schedule: ScheduleConfig
): boolean {
  if (isWithinSchedule(schedule)) return true;
  const nextSlot = nextScheduledSlot(schedule);
  log(db, runId, targetId, "info", `Outside working schedule — rescheduling ${name} to ${nextSlot}`);
  trReschedule(db, tr, nextSlot);
  return false;
}

// ─── URL resolution ──────────────────────────────────────────────────────────

async function resolveLinkedinUrl(db: ReturnType<typeof getDb>, target: Target, accountId: string): Promise<string> {
  if (target.linkedin_url?.includes("/in/")) return target.linkedin_url;
  const salesNavUrl = target.sales_nav_url ?? target.linkedin_url;
  if (!salesNavUrl) throw new Error(`${target.full_name ?? target.id} has no Sales Nav URL to resolve from`);
  const leadMatch = salesNavUrl.match(/\/sales\/lead\/(.+)/);
  if (!leadMatch) throw new Error(`${target.full_name ?? target.id} has no Sales Nav lead URL — cannot resolve LinkedIn URL`);

  const page = await getSessionPage(accountId);
  let profileJson: Record<string, unknown> | null = null;
  try {
    page.on("response", async (response) => {
      if (response.url().includes("salesApiProfiles/") && response.status() === 200 && !profileJson) {
        try { profileJson = await response.json() as Record<string, unknown>; } catch { /* ignore */ }
      }
    });
    await page.goto(`https://www.linkedin.com/sales/lead/${leadMatch[1]}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(10000);
  } finally {
    await page.close();
  }

  const p = profileJson as Record<string, unknown> | null;
  const flagshipUrl = typeof p?.flagshipProfileUrl === "string" ? p.flagshipProfileUrl : null;
  if (!flagshipUrl) throw new Error(`Could not resolve LinkedIn URL for ${target.full_name ?? target.id}`);
  const linkedinUrl = flagshipUrl.endsWith("/") ? flagshipUrl : flagshipUrl + "/";

  type RawPosition = { title?: unknown; companyName?: unknown; current?: unknown; startedOn?: unknown; endedOn?: unknown; description?: unknown };
  const rawPositions = Array.isArray(p?.positions) ? (p.positions as RawPosition[]) : [];
  const positions = rawPositions.map((pos) => ({
    title: typeof pos.title === "string" ? pos.title : "",
    companyName: typeof pos.companyName === "string" ? pos.companyName : "",
    current: pos.current === true,
    startedOn: pos.startedOn as { year?: number; month?: number } | undefined,
    endedOn: pos.endedOn as { year?: number; month?: number } | undefined,
    description: typeof pos.description === "string" ? pos.description : undefined,
  }));
  type RawSkill = { name?: unknown };
  const rawSkills = Array.isArray(p?.skills) ? (p.skills as RawSkill[]) : [];
  const skills = rawSkills.map((s) => (typeof s.name === "string" ? s.name : "")).filter(Boolean);

  db.prepare(`
    UPDATE targets SET
      linkedin_url         = ?,
      linkedin_member_urn  = COALESCE(linkedin_member_urn, ?),
      headline             = COALESCE(headline, ?),
      summary              = COALESCE(summary, ?),
      positions_json       = COALESCE(positions_json, ?),
      skills_json          = CASE WHEN skills_json IS NULL AND ? IS NOT NULL THEN ? ELSE skills_json END,
      enriched_profile_at  = COALESCE(enriched_profile_at, datetime('now'))
    WHERE id = ?
  `).run(
    linkedinUrl,
    typeof p?.objectUrn === "string" ? p.objectUrn : null,
    typeof p?.headline === "string" ? p.headline : null,
    typeof p?.summary === "string" ? p.summary : null,
    positions.length > 0 ? JSON.stringify(positions) : null,
    skills.length > 0 ? "1" : null,
    skills.length > 0 ? JSON.stringify(skills) : null,
    target.id
  );
  return linkedinUrl;
}

async function getLinkedinUrl(db: ReturnType<typeof getDb>, target: Target, accountId: string): Promise<string> {
  if (target.linkedin_url?.includes("/in/")) return target.linkedin_url;
  return resolveLinkedinUrl(db, target, accountId);
}

// ─── pre-action enrichment ───────────────────────────────────────────────────

async function ensureSalesNavEnriched(db: ReturnType<typeof getDb>, target: Target, accountId: string): Promise<void> {
  const fresh = db.prepare("SELECT enriched_profile_at, apollo_enriched_at, sales_nav_url, full_name FROM targets WHERE id = ?").get(target.id) as { enriched_profile_at: string | null; apollo_enriched_at: string | null; sales_nav_url: string | null; full_name: string | null } | undefined;
  if (!fresh || fresh.enriched_profile_at || fresh.apollo_enriched_at || !fresh.sales_nav_url) return;
  const last = lastSalesNavEnrichAt[accountId] ?? 0;
  if (Date.now() - last < SALES_NAV_ENRICH_MIN_GAP_MS) return;
  try {
    lastSalesNavEnrichAt[accountId] = Date.now();
    const ctx = await getSessionContext(accountId);
    await enrichProfile(ctx, { id: target.id, sales_nav_url: fresh.sales_nav_url, full_name: fresh.full_name ?? target.full_name ?? target.id });
  } catch (e) {
    console.warn(`[runner] Sales Nav enrichment failed for ${target.full_name ?? target.id}:`, e instanceof Error ? e.message : e);
  }
}

async function ensureApolloEnriched(db: ReturnType<typeof getDb>, target: Target, runId: string): Promise<void> {
  const fresh = db.prepare("SELECT apollo_enriched_at, email, linkedin_url, sales_nav_url FROM targets WHERE id = ?").get(target.id) as { apollo_enriched_at: string | null; email: string | null; linkedin_url: string | null; sales_nav_url: string | null } | undefined;
  if (!fresh || fresh.apollo_enriched_at || fresh.email) return;
  const apolloUrl = fresh.linkedin_url?.includes("/in/") ? fresh.linkedin_url : fresh.sales_nav_url;
  if (!apolloUrl) return;

  const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'apollo' AND workspace_id = ?").get(target.workspace_id) as { api_key: string } | undefined;
  if (!integration?.api_key) return;

  try {
    const result = await matchPerson(apolloUrl, decryptSecret(integration.api_key)!);
    if (!result) {
      db.prepare("UPDATE targets SET apollo_enriched_at = datetime('now') WHERE id = ?").run(target.id);
      return;
    }

    let companyId: string | null = null;
    if (result.organization?.domain) {
      const domain = result.organization.domain.replace(/^www\./, "").toLowerCase();
      const existing = db.prepare("SELECT id FROM companies WHERE domain = ?").get(domain) as { id: string } | undefined;
      const org = result.organization;
      if (existing) {
        companyId = existing.id;
        db.prepare(`
          UPDATE companies SET
            industry = COALESCE(industry, ?), location = COALESCE(location, ?),
            linkedin_url = COALESCE(linkedin_url, ?), website = COALESCE(website, ?),
            founded_year = COALESCE(founded_year, ?), logo_url = COALESCE(logo_url, ?),
            phone = COALESCE(phone, ?), annual_revenue = COALESCE(annual_revenue, ?),
            technology_names = COALESCE(technology_names, ?), keywords = COALESCE(keywords, ?),
            city = COALESCE(city, ?), country = COALESCE(country, ?),
            description = COALESCE(description, ?), employee_count = COALESCE(employee_count, ?)
          WHERE id = ?
        `).run(
          org.industry ?? null, org.location ?? null, org.linkedin_url ?? null,
          org.website_url ?? null, org.founded_year ?? null, org.logo_url ?? null,
          org.phone ?? null, org.annual_revenue_printed ?? null,
          org.technology_names ? JSON.stringify(org.technology_names) : null,
          org.keywords ? JSON.stringify(org.keywords) : null,
          org.city ?? null, org.country ?? null,
          org.short_description ?? null, org.estimated_num_employees ?? null,
          existing.id
        );
      } else {
        companyId = randomUUID();
        db.prepare(`
          INSERT INTO companies (id, name, domain, industry, location, linkedin_url, website, founded_year, logo_url, phone, annual_revenue, technology_names, keywords, city, country, description, employee_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          companyId, org.name ?? "", domain,
          org.industry ?? null, org.location ?? null, org.linkedin_url ?? null,
          org.website_url ?? null, org.founded_year ?? null, org.logo_url ?? null,
          org.phone ?? null, org.annual_revenue_printed ?? null,
          org.technology_names ? JSON.stringify(org.technology_names) : null,
          org.keywords ? JSON.stringify(org.keywords) : null,
          org.city ?? null, org.country ?? null,
          org.short_description ?? null, org.estimated_num_employees ?? null
        );
      }
    }

    db.prepare(`
      UPDATE targets SET
        apollo_id = ?, seniority = ?, apollo_functions = ?, apollo_departments = ?,
        email = COALESCE(email, ?), email_status = COALESCE(email_status, ?),
        email_domain_catchall = ?,
        city = COALESCE(city, ?), country = COALESCE(country, ?),
        time_zone = COALESCE(time_zone, ?),
        headline = COALESCE(headline, ?),
        positions_json = COALESCE(positions_json, ?),
        company_id = COALESCE(company_id, ?),
        linkedin_url = COALESCE(linkedin_url, ?),
        apollo_enriched_at = datetime('now')
      WHERE id = ?
    `).run(
      result.apollo_id,
      result.seniority ?? null,
      result.functions ? JSON.stringify(result.functions) : null,
      result.departments ? JSON.stringify(result.departments) : null,
      result.email ?? null,
      result.email_status ?? null,
      result.email_domain_catchall ? 1 : 0,
      result.city ?? null,
      result.country ?? null,
      result.time_zone ?? null,
      result.headline ?? null,
      result.positions_json ?? null,
      companyId,
      result.linkedin_url ?? null,
      target.id
    );
    console.log(`[runner] Apollo enriched ${target.full_name ?? target.id} — email: ${result.email ?? "not found"}`);
  } catch (e) {
    console.warn(`[runner] Apollo enrichment failed for ${target.full_name ?? target.id}:`, e instanceof Error ? e.message : e);
  }
}

// ─── step execution ──────────────────────────────────────────────────────────

async function executeStep(
  db: ReturnType<typeof getDb>,
  runId: string,
  tr: TrackRun,
  target: Target,
  steps: WorkflowStep[],
  accountId: string,
  accountLimits: AccountLimits,
  emailAccountId?: string | null,
  emailAccountLimits?: EmailAccountLimits | null,
  campaignPrompt?: string | null
): Promise<void> {
  const stepIndex = tr.current_step;
  if (stepIndex >= steps.length) {
    db.prepare("UPDATE run_profile_tracks SET state = 'completed', last_step_at = datetime('now') WHERE id = ?").run(tr.id);
    return;
  }

  const suppression = findTargetSuppression(target.workspace_id, target.id);
  if (suppression) {
    log(db, runId, target.id, "warn", `${target.full_name ?? target.linkedin_url} is suppressed (${suppression.kind}: ${suppression.reason}) — unenrolling`);
    db.prepare("UPDATE run_profile_tracks SET state = 'skipped', error_message = ? WHERE run_profile_id = ? AND state NOT IN ('completed','failed','skipped')")
      .run(`Suppressed: ${suppression.reason}`, tr.run_profile_id);
    return;
  }

  // Auto-unenroll if lead has replied on either channel — mark ALL track-runs for this profile skipped
  const replyCheck = db.prepare("SELECT last_replied_at, email_replied_at FROM targets WHERE id = ?").get(target.id) as { last_replied_at: string | null; email_replied_at: string | null };
  if (replyCheck?.last_replied_at || replyCheck?.email_replied_at) {
    const channel = replyCheck.email_replied_at ? "email" : "LinkedIn";
    log(db, runId, target.id, "info", `${target.full_name ?? target.linkedin_url} replied via ${channel} — unenrolling from workflow`);
    db.prepare(
      "UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Lead replied' WHERE run_profile_id = ? AND state NOT IN ('completed', 'failed', 'skipped')"
    ).run(tr.run_profile_id);
    return;
  }

  const step = steps[stepIndex];
  const name = target.full_name ?? target.linkedin_url;

  try {
    if (step.step_type === "delay") {
      trAdvance(db, tr, steps);
      log(db, runId, target.id, "info", `Delay step passed for ${name}`);
      return;
    }

    if (step.step_type === "visit") {
      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Visiting ${name}`);
      const linkedinUrl = await getLinkedinUrl(db, target, accountId);
      const page = await getSessionPage(accountId);
      try { await visitProfile(page, linkedinUrl); } finally { await page.close(); }
      await saveSessionState(accountId);
      trAdvance(db, tr, steps);
      log(db, runId, target.id, "info", `Visited ${name}`);

    } else if (step.step_type === "connect") {
      if (!enforceSchedule(db, tr, runId, target.id, name, accountLimits)) return;

      const freshTarget = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id) as Target;
      if (freshTarget.degree === 1) {
        if (!freshTarget.connected_at) db.prepare("UPDATE targets SET connected_at = ? WHERE id = ?").run(nowIso(), target.id);
        log(db, runId, target.id, "info", `${name} already connected — skipping connect step`);
        trAdvance(db, tr, steps);
        return;
      }

      if (freshTarget.connection_requested_at) {
        const hoursSinceRequest = hoursSince(freshTarget.connection_requested_at);
        if (hoursSinceRequest / 24 > CONNECTION_MAX_WAIT_DAYS) {
          log(db, runId, target.id, "warn", `${name} did not accept after ${CONNECTION_MAX_WAIT_DAYS} days — skipping`);
          trSkip(db, tr, `Did not accept connection after ${CONNECTION_MAX_WAIT_DAYS} days`);
          return;
        }
        // Acceptance is detected by the daily sync-accepted job (scrolls invitation manager).
        // Runner just re-checks degree from DB — no per-profile page visits needed.
        log(db, runId, target.id, "info", `${name} not yet accepted — rechecking in ${CONNECTION_RECHECK_HOURS}h`);
        trWait(db, tr, CONNECTION_RECHECK_HOURS);
        return;
      }

      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Sending connection request to ${name}`);
      const linkedinUrl = await getLinkedinUrl(db, target, accountId);
      const page = await getSessionPage(accountId);
      try { await sendConnectionRequest(page, linkedinUrl); } finally { await page.close(); }
      await saveSessionState(accountId);
      db.prepare("UPDATE targets SET connection_requested_at = ? WHERE id = ?").run(nowIso(), target.id);
      trWait(db, tr, CONNECTION_RECHECK_HOURS);
      log(db, runId, target.id, "info", `Connection request sent to ${name} — will recheck in ${CONNECTION_RECHECK_HOURS}h`);

    } else if (step.step_type === "message") {
      await ensureSalesNavEnriched(db, target, accountId);
      if (!enforceSchedule(db, tr, runId, target.id, name, accountLimits)) return;

      const freshTarget = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id) as Target;
      if (freshTarget.degree !== 1) {
        const requested = freshTarget.connection_requested_at;
        if (requested && hoursSince(requested) / 24 > CONNECTION_MAX_WAIT_DAYS) {
          log(db, runId, target.id, "warn", `${name} never accepted — skipping message step`);
          trSkip(db, tr, "Never accepted connection");
          return;
        }
        log(db, runId, target.id, "info", `${name} not yet connected — rescheduling message in ${CONNECTION_RECHECK_HOURS}h`);
        trWait(db, tr, CONNECTION_RECHECK_HOURS);
        return;
      }

      let messageText = "";
      if (step.ai_enabled) {
        if (!premium?.ai) {
          log(db, runId, target.id, "warn", `AI writer is unavailable in this build. Skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(target.workspace_id) as { api_key: string } | undefined;
        const agentCfgForMsg = premium.ai.getAgentConfig(target.workspace_id);
        const resolvedMsgModel = step.ai_model || agentCfgForMsg.default_model;
        if (!integration?.api_key || !resolvedMsgModel) {
          log(db, runId, target.id, "warn", `AI enabled on message step but OpenRouter key or model missing — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const contactData = premium.ai.getContactWithCompany(target.id);
        if (!contactData) {
          log(db, runId, target.id, "warn", `Could not load contact data for AI message — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        log(db, runId, target.id, "info", `Generating AI message for ${name} with ${resolvedMsgModel}`);
        const msgPosition = step.message_position ?? 1;
        let previousMessageContext: { followupNumber: number; previousMessage: string } | undefined;
        if (msgPosition > 1 && tr.last_linkedin_message) {
          previousMessageContext = { followupNumber: msgPosition - 1, previousMessage: tr.last_linkedin_message };
        }
        const result = await premium.ai.writeLinkedInMessage({
          apiKey: decryptSecret(integration.api_key)!,
          model: resolvedMsgModel,
          stepType: "message",
          stepPrompt: step.ai_prompt ?? "",
          maxWords: step.ai_max_words ?? undefined,
          language: step.ai_language ?? undefined,
          campaignPrompt: campaignPrompt ?? undefined,
          contact: contactData.contact,
          company: contactData.company,
          agentConfig: agentCfgForMsg,
          previousMessageContext,
          runId,
          targetId: target.id,
          stepId: step.id,
        });
        messageText = result.body;
      } else {
        const customVals = loadTargetCustomValues(db, target.workspace_id, target.id);
        const multiTemplateIds = (db.prepare("SELECT template_id FROM workflow_step_templates WHERE step_id = ?").all(step.id) as Array<{ template_id: string }>).map(r => r.template_id);
        if (multiTemplateIds.length > 0) {
          const randomId = multiTemplateIds[Math.floor(Math.random() * multiTemplateIds.length)];
          const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(randomId) as Template | undefined;
          if (tmpl) messageText = renderOutreachTemplate(tmpl.body, freshTarget, customVals);
        } else if (step.template_id) {
          const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(step.template_id) as Template | undefined;
          if (tmpl) messageText = renderOutreachTemplate(tmpl.body, freshTarget, customVals);
        }
        if (!messageText && step.message_body) messageText = renderOutreachTemplate(step.message_body, freshTarget, customVals);
      }
      if (!messageText) {
        log(db, runId, target.id, "warn", `No message body for message step — skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }

      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Sending message to ${name}`);
      const page = await getSessionPage(accountId);
      try {
        if (!target.full_name) throw new Error(`Target ${target.id} has no full_name — cannot search messaging`);
        await sendMessage(page, target.full_name, messageText);
      } finally {
        await page.close();
      }
      await saveSessionState(accountId);
      db.prepare("UPDATE targets SET message_sent_at = ? WHERE id = ?").run(nowIso(), target.id);
      emitDomainEvent({ workspaceId: target.workspace_id, type: "linkedin.message_sent", entityType: "contact", entityId: target.id, payload: { run_id: runId } });
      trRecordContext(db, tr, { linkedinMessage: messageText });
      trAdvance(db, tr, steps);
      log(db, runId, target.id, "info", `Message sent to ${name}`);

    } else if (step.step_type === "sales_inmail") {
      // Sales Navigator InMail — reaches NON-connections (no degree gate), needs a
      // subject + body, costs one InMail credit. Body config mirrors the message
      // step (AI writer OR templates OR raw body); subject comes from email_subject.
      if (!premium?.inmail) {
        log(db, runId, target.id, "warn", `Sales Nav InMail is not implemented in this build. Skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }
      await ensureSalesNavEnriched(db, target, accountId);
      if (!enforceSchedule(db, tr, runId, target.id, name, accountLimits)) return;

      const freshTarget = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id) as Target;
      if (!freshTarget.sales_nav_url) {
        log(db, runId, target.id, "warn", `${name} has no Sales Nav URL — cannot send InMail, skipping`);
        trSkip(db, tr, "No Sales Nav URL for InMail");
        return;
      }

      let inmailBody = "";
      let inmailSubject = "";
      if (step.ai_enabled) {
        if (!premium?.ai) {
          log(db, runId, target.id, "warn", `AI writer is unavailable in this build. Skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(target.workspace_id) as { api_key: string } | undefined;
        const agentCfgForMsg = premium.ai.getAgentConfig(target.workspace_id);
        const resolvedMsgModel = step.ai_model || agentCfgForMsg.default_model;
        if (!integration?.api_key || !resolvedMsgModel) {
          log(db, runId, target.id, "warn", `AI enabled on InMail step but OpenRouter key or model missing — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const contactData = premium.ai.getContactWithCompany(target.id);
        if (!contactData) {
          log(db, runId, target.id, "warn", `Could not load contact data for AI InMail — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        log(db, runId, target.id, "info", `Generating AI InMail for ${name} with ${resolvedMsgModel}`);
        const msgPosition = step.message_position ?? 1;
        let previousMessageContext: { followupNumber: number; previousMessage: string } | undefined;
        if (msgPosition > 1 && tr.last_linkedin_message) {
          previousMessageContext = { followupNumber: msgPosition - 1, previousMessage: tr.last_linkedin_message };
        }
        const result = await premium.ai.writeSalesInMail({
          apiKey: decryptSecret(integration.api_key)!,
          model: resolvedMsgModel,
          stepType: "sales_inmail",
          stepPrompt: step.ai_prompt ?? "",
          maxWords: step.ai_max_words ?? undefined,
          language: step.ai_language ?? undefined,
          campaignPrompt: campaignPrompt ?? undefined,
          contact: contactData.contact,
          company: contactData.company,
          agentConfig: agentCfgForMsg,
          previousMessageContext,
          runId,
          targetId: target.id,
          stepId: step.id,
        });
        inmailBody = result.body;
        inmailSubject = result.subject;
      } else {
        const customVals = loadTargetCustomValues(db, target.workspace_id, target.id);
        const multiTemplateIds = (db.prepare("SELECT template_id FROM workflow_step_templates WHERE step_id = ?").all(step.id) as Array<{ template_id: string }>).map(r => r.template_id);
        if (multiTemplateIds.length > 0) {
          const randomId = multiTemplateIds[Math.floor(Math.random() * multiTemplateIds.length)];
          const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(randomId) as Template | undefined;
          if (tmpl) inmailBody = renderOutreachTemplate(tmpl.body, freshTarget, customVals);
        } else if (step.template_id) {
          const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(step.template_id) as Template | undefined;
          if (tmpl) inmailBody = renderOutreachTemplate(tmpl.body, freshTarget, customVals);
        }
        if (!inmailBody && step.message_body) inmailBody = renderOutreachTemplate(step.message_body, freshTarget, customVals);
        inmailSubject = renderOutreachTemplate(step.email_subject ?? "", freshTarget, customVals).trim();
      }
      if (!inmailBody) {
        log(db, runId, target.id, "warn", `No body for InMail step — skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }
      if (!inmailSubject) {
        log(db, runId, target.id, "warn", `No subject for InMail step (required) — skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }

      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Sending InMail to ${name}`);
      const page = await getSessionPage(accountId);
      try {
        await premium.inmail.sendInMail(page, freshTarget.sales_nav_url, inmailSubject, inmailBody);
      } finally {
        await page.close();
      }
      await saveSessionState(accountId);
      db.prepare("UPDATE targets SET inmail_sent_at = ?, message_sent_at = COALESCE(message_sent_at, ?) WHERE id = ?").run(nowIso(), nowIso(), target.id);
      trRecordContext(db, tr, { linkedinMessage: inmailBody });
      trAdvance(db, tr, steps);
      log(db, runId, target.id, "info", `InMail sent to ${name}`);

    } else if (step.step_type === "email") {
      await ensureApolloEnriched(db, target, runId);

      if (!emailAccountId || !emailAccountLimits) {
        log(db, runId, target.id, "warn", `Email step skipped — no email account configured on this run`);
        trAdvance(db, tr, steps);
        return;
      }

      if (!enforceSchedule(db, tr, runId, target.id, name, emailAccountLimits)) return;

      const freshTarget = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id) as Target;
      if (!freshTarget.email) {
        // No email even after Apollo enrichment — skip only this email track
        log(db, runId, target.id, "warn", `${name} has no email address — skipping email track`);
        trSkip(db, tr, "No email address found");
        return;
      }
      if (freshTarget.email_status === "invalid") {
        log(db, runId, target.id, "warn", `${name} has an invalid email address — unenrolling email track`);
        trSkip(db, tr, "Email bounced — invalid address");
        return;
      }
      // Just-in-time verification: never email an address we haven't checked. Verify once,
      // persist the result, and if it definitively bounces, add it to the do-not-send list
      // and skip the track. Catch-all / inconclusive addresses are left sendable.
      if (!freshTarget.email_status || freshTarget.email_status === "unverified") {
        const senderRow = db.prepare("SELECT from_email FROM email_accounts WHERE workspace_id = ? AND is_verified = 1 AND from_email IS NOT NULL ORDER BY created_at LIMIT 1").get(target.workspace_id) as { from_email: string } | undefined;
        const verdict = await verifyEmailAddress(freshTarget.email, { fromEmail: senderRow?.from_email });
        db.prepare("UPDATE targets SET email_status = ? WHERE id = ?").run(emailStatusFor(verdict.status), target.id);
        if (verdict.status === "invalid") {
          addSuppression({ workspaceId: target.workspace_id, kind: "email", value: freshTarget.email, reason: `Email verification: ${verdict.reason}`, source: "verification", targetId: target.id });
          log(db, runId, target.id, "warn", `${name}'s email failed verification (${verdict.reason}) — added to do-not-send, unenrolling email track`);
          trSkip(db, tr, "Email failed verification — invalid address");
          return;
        }
      }
      if (freshTarget.company_id) {
        const company = db.prepare("SELECT email_domain_invalid FROM companies WHERE id = ?").get(freshTarget.company_id) as { email_domain_invalid: number } | undefined;
        if (company?.email_domain_invalid) {
          log(db, runId, target.id, "warn", `${name}'s company email domain is flagged invalid — unenrolling email track`);
          trSkip(db, tr, "Email domain invalid — company flagged");
          return;
        }
      }

      let emailSubject = "";
      let emailBody = "";
      if (step.ai_enabled) {
        if (!premium?.ai) {
          log(db, runId, target.id, "warn", `AI writer is unavailable in this build. Skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(target.workspace_id) as { api_key: string } | undefined;
        const agentCfgForEmail = premium.ai.getAgentConfig(target.workspace_id);
        const resolvedEmailModel = step.ai_model || agentCfgForEmail.default_model;
        if (!integration?.api_key || !resolvedEmailModel) {
          log(db, runId, target.id, "warn", `AI enabled on email step but OpenRouter key or model missing — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const contactData = premium.ai.getContactWithCompany(target.id);
        if (!contactData) {
          log(db, runId, target.id, "warn", `Could not load contact data for AI email — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        log(db, runId, target.id, "info", `Generating AI email for ${name} with ${resolvedEmailModel}`);
        const emailPosition = step.email_position ?? 1;
        let followupContext: { followupNumber: number; previousSubject: string; previousBody: string } | undefined;
        if (emailPosition > 1 && (tr.last_email_subject || tr.last_email_body)) {
          followupContext = {
            followupNumber: emailPosition - 1,
            previousSubject: tr.last_email_subject ?? "",
            previousBody: tr.last_email_body ?? "",
          };
        }
        const result = await premium.ai.writeEmail({
          apiKey: decryptSecret(integration.api_key)!,
          model: resolvedEmailModel,
          stepType: "email",
          stepPrompt: step.ai_prompt ?? "",
          maxWords: step.ai_max_words ?? undefined,
          language: step.ai_language ?? undefined,
          campaignPrompt: campaignPrompt ?? undefined,
          contact: contactData.contact,
          company: contactData.company,
          agentConfig: agentCfgForEmail,
          followupContext,
          replyContext: tr.pending_reply_context ?? undefined,
          runId,
          targetId: target.id,
          stepId: step.id,
        });
        emailSubject = result.subject;
        emailBody = result.body;
        // One-shot: consume the OOO reply context so later follow-ups don't re-acknowledge it
        if (tr.pending_reply_context) {
          db.prepare("UPDATE run_profile_tracks SET pending_reply_context = NULL WHERE id = ?").run(tr.id);
        }
      } else {
        const customVals = loadTargetCustomValues(db, target.workspace_id, target.id);
        emailSubject = renderOutreachTemplate(step.email_subject ?? "", freshTarget, customVals);
        emailBody = renderOutreachTemplate(step.email_body ?? "", freshTarget, customVals);
      }

      if (!emailBody) {
        log(db, runId, target.id, "warn", `No email body for email step — skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }

      const emailAccount = db.prepare("SELECT * FROM email_accounts WHERE id = ?").get(emailAccountId) as {
        id: string; from_email: string; from_name: string | null; reply_to: string | null;
        smtp_host: string; smtp_port: number; smtp_secure: number;
        username: string; password: string; signature: string | null;
      } | undefined;

      if (!emailAccount) {
        log(db, runId, target.id, "error", `Email account ${emailAccountId} not found`);
        trFail(db, tr, "Email account missing");
        return;
      }

      // Last-line-of-defense: re-check the daily limit for this email account against ground-truth
      // (matched by run_profiles.email_account_id, the actual sender). If any prior gate is buggy,
      // this catches the overshoot and reschedules instead of sending.
      const guardDay = localDayBoundsUtc(emailAccountLimits.timezone);
      const sentTodayActual = (db.prepare(
        `SELECT COUNT(*) as c FROM logs l
         WHERE l.message LIKE 'Email sent%'
         AND l.created_at >= ? AND l.created_at < ?
         AND EXISTS (
           SELECT 1 FROM run_profiles rp
           WHERE rp.run_id = l.run_id AND rp.target_id = l.target_id
           AND rp.email_account_id = ?
         )`
      ).get(guardDay.start, guardDay.end, emailAccountId) as { c: number }).c;
      const hardLimit = effectiveEmailLimit(emailAccountLimits);
      if (sentTodayActual >= hardLimit) {
        log(db, runId, target.id, "warn", `Daily limit guard tripped for ${emailAccountId} (${sentTodayActual}/${hardLimit}) — rescheduling ${name} to tomorrow`);
        trReschedule(db, tr, rescheduleToTomorrow(emailAccountLimits));
        return;
      }

      // Rate, not just volume: keep this account's sends spaced across the working window
      // rather than racing to exhaust the daily cap in one burst.
      const paceUntil = emailPaceGate(db, emailAccountId, emailAccountLimits, sentTodayActual, hardLimit);
      if (paceUntil) {
        log(db, runId, target.id, "info", `Pacing ${name} — next send window for ${emailAccountId} at ${paceUntil}`);
        trReschedule(db, tr, paceUntil);
        return;
      }

      // Step-level signature takes precedence; null means fall back to email account default
      const sig = (step.email_signature !== null ? step.email_signature : emailAccount.signature)?.trim();
      const finalEmailBody = sig ? `${emailBody}\n\n--\n${sig}` : emailBody;
      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Sending email to ${name} <${freshTarget.email}>`);
      await sendEmailDurably({
        workspaceId: target.workspace_id,
        emailAccountId,
        idempotencyKey: `campaign:${runId}:${tr.id}:${step.id}`,
        source: "campaign",
        targetId: target.id,
        runId,
        stepId: step.id,
        to: freshTarget.email,
        subject: emailSubject,
        body: finalEmailBody,
        deliveryMode: step.email_delivery_mode === "enhanced" ? "enhanced" : "plain",
        trackOpens: step.email_delivery_mode === "enhanced" && step.email_track_opens === 1,
        trackClicks: step.email_delivery_mode === "enhanced" && step.email_track_clicks === 1,
      });
      trRecordContext(db, tr, { emailSubject, emailBody });
      trAdvance(db, tr, steps);
      log(db, runId, target.id, "info", `Email sent to ${name}`);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof WeeklyLimitError) {
      log(db, runId, target.id, "error", `Weekly connection limit reached — pausing run`);
      db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(runId);
      return;
    }
    if (err instanceof AlreadyConnectedError) {
      log(db, runId, target.id, "info", `${name} already connected — advancing`);
      db.prepare("UPDATE targets SET degree = 1, connected_at = COALESCE(connected_at, ?) WHERE id = ?").run(nowIso(), target.id);
      trAdvance(db, tr, steps);
      return;
    }
    if (err instanceof PendingInviteError) {
      log(db, runId, target.id, "info", `${name} invite already pending — will recheck`);
      if (!target.connection_requested_at) db.prepare("UPDATE targets SET connection_requested_at = ? WHERE id = ?").run(nowIso(), target.id);
      trWait(db, tr, CONNECTION_RECHECK_HOURS);
      return;
    }
    log(db, runId, target.id, "error", `Error on ${name}: ${msg}`);
    trFail(db, tr, msg);
  }
}

// ─── global loop ─────────────────────────────────────────────────────────────

const g = global as typeof global & { __linkiGlobalRunnerStarted?: boolean };

export function ensureGlobalRunnerStarted(): void {
  if (g.__linkiGlobalRunnerStarted) return;
  g.__linkiGlobalRunnerStarted = true;
  const db = getDb();

  // LinkedIn stays ONE strictly-sequential loop — every LinkedIn browser-session action
  // (tick + connection sync) runs here and nowhere else, so LinkedIn is never driven from
  // two places at once. Its pacing / daily-limits / active-hours are unchanged.
  linkedinLoop().catch(err => console.error("[runner] LinkedIn loop crashed:", err));

  // Every other background process gets its OWN independent loop, lease and cadence, so a
  // slow or hung one can never starve the others. These are all safe SMTP/IMAP/HTTP/DB
  // work; they interleave cooperatively in this single Node process (no SQLite write
  // contention) while yielding to each other on every network await.
  //
  // Reply detection is IMAP, not LinkedIn browser work, so it belongs here and not in the
  // LinkedIn loop. It used to run at the top of tick(), which put an unbounded network await
  // in front of the entire campaign engine: one stalled mailbox froze all outreach, and
  // because the per-account throttle is only stamped after a successful sync, the stall
  // reproduced itself on every restart.
  startLoop("Email inbox sync", "email-inbox-runner", syncDueEmailInboxes);
  startLoop("Email queue", "email-jobs-runner", async () => { await processEmailJobs(); });
  startLoop("Warmup", "warmup-runner", async () => {
    await processWarmupCycle();
    await processWarmupEngagement();
  });
  startLoop("Email verification", "verification-runner", async () => {
    const verified = await processVerificationQueue(db);
    if (verified > 0) console.log(`[runner] Email verification — processed ${verified}`);
  });
  startLoop("Webhook delivery", "webhook-runner", async () => { await processWebhookDeliveries(); });
  startLoop("Import scheduler", "imports-runner", async () => {
    const { processScheduledImports } = await import("@/lib/import-jobs");
    await processScheduledImports(db);
  });
}

/** Run `step` forever on its own leased loop. Each background process gets one of these,
 *  so one process stalling only stalls itself — never its siblings. */
function startLoop(name: string, leaseName: string, step: () => Promise<void>): void {
  void (async () => {
    console.log(`[runner] ${name} loop started`);
    while (true) {
      if (acquireWorkerLease(leaseName)) {
        try {
          await step();
        } catch (err) {
          console.error(`[runner] ${name} error:`, err instanceof Error ? err.message : err);
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
  })().catch(err => console.error(`[runner] ${name} loop crashed:`, err));
}

/** Poll every IMAP-configured account that is due, for replies and bounces. Runs on its own
 *  loop so a stalled mailbox degrades reply detection only. Independent of whether a
 *  campaign is running, so replies still land after a campaign finishes. */
async function syncDueEmailInboxes(): Promise<void> {
  for (const emailAccId of listImapEmailAccountIds()) {
    if (!shouldSyncEmailInbox(emailAccId)) continue;
    await guard(`Email inbox sync (${emailAccId})`, INBOX_SYNC_TIMEOUT_MS, async () => {
      const { replies, bounces } = await syncEmailInbox(emailAccId);
      if (replies > 0 || bounces > 0) {
        console.log(`[runner] Email inbox sync (${emailAccId}) — ${replies} repl${replies === 1 ? "y" : "ies"}, ${bounces} bounce(s)`);
      }
    });
  }
}

async function linkedinLoop(): Promise<void> {
  console.log("[runner] LinkedIn loop started");
  const db = getDb();

  while (true) {
    if (!acquireWorkerLease("linkedin-runner")) { await sleep(POLL_INTERVAL_MS); continue; }
    // Outer deadline on the whole tick. Every await inside is individually bounded, but this
    // is the backstop that keeps a future unguarded await from silently killing outreach
    // again — the failure mode this loop had no defence against, since a try/catch cannot
    // catch a promise that never settles.
    await guard("Campaign tick", TICK_TIMEOUT_MS, () => tick(db));
    // Connection-acceptance sync also touches the LinkedIn session, so it stays in this
    // loop — sequential with tick, never concurrent.
    await guard("Connection sync", CONNECTION_SYNC_TIMEOUT_MS, () => syncDueConnections());
    await sleep(POLL_INTERVAL_MS);
  }
}


/**
 * Stamp the runner heartbeat on the given runs.
 *
 * Called at the top of every tick AND again after each profile the tick processes. Stamping
 * only at the top was not enough: a tick legitimately runs for minutes while it drains a
 * backlog (up to EXECUTE_STEP_TIMEOUT_MS per step, plus the human-like delay between
 * profiles), so a single stamp made a busy runner look stalled. The heartbeat has to track
 * progress through the tick, not just its start, or the stalled indicator cries wolf on
 * exactly the workload it matters most during.
 */
function heartbeat(db: ReturnType<typeof getDb>, runs: Array<{ run_id: string }>): void {
  const stmt = db.prepare("UPDATE runs SET runner_pid = ?, last_tick_at = datetime('now') WHERE id = ?");
  for (const run of runs) {
    try { stmt.run(process.pid, run.run_id); } catch { /* non-fatal bookkeeping */ }
  }
}

async function tick(db: ReturnType<typeof getDb>): Promise<void> {
  const activeRuns = db.prepare(`
    SELECT r.id as run_id, r.workflow_id, r.account_id, r.email_account_id,
           a.daily_connection_limit, a.daily_message_limit, a.daily_inmail_limit,
           a.active_hours_start, a.active_hours_end, a.timezone, a.working_days
    FROM runs r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.status = 'running' AND a.is_authenticated = 1
  `).all() as Array<{ run_id: string; workflow_id: string; account_id: string; email_account_id: string | null } & AccountLimits>;

  if (activeRuns.length === 0) return;

  // Liveness FIRST, before any network I/O. runs.runner_pid existed but nothing ever wrote
  // it; then it was written after an unbounded IMAP sync, so a wedged loop still reported a
  // null pid and an orphaned run stayed indistinguishable from a supervised one. Stamped
  // here, pid + last_tick_at are a true heartbeat: if they stop advancing, the loop is stuck,
  // and that is now visible instead of silent.
  heartbeat(db, activeRuns);

  console.log(`[runner] Tick — ${activeRuns.length} active run(s)`);

  const seenAccounts = new Set<string>();
  for (const run of activeRuns) {
    if (seenAccounts.has(run.account_id)) continue;
    seenAccounts.add(run.account_id);
  }

  // Daily sync: stamp accepted connections from invitation manager (once per 23h per account).
  // Drives a browser, so it gets a deadline — a hung navigation here used to sit between the
  // heartbeat and the work that actually sends.
  for (const accountId of seenAccounts) {
    if (shouldSyncAccepted(accountId)) {
      console.log(`[runner] Starting accepted-connections sync for account ${accountId}`);
      await guard(`Accepted-connections sync (${accountId})`, ACCEPTED_SYNC_TIMEOUT_MS, async () => {
        const stamped = await syncAcceptedConnections(accountId);
        if (stamped > 0) {
          for (const r of activeRuns.filter(x => x.account_id === accountId)) {
            log(db, r.run_id, null, "info", `Accepted-connections sync: ${stamped} contact${stamped === 1 ? "" : "s"} marked as connected`);
          }
        }
        console.log(`[runner] Accepted-connections sync complete — ${stamped} stamped`);
      });
    }
  }

  // LinkedIn inbox reply detection (messaging GraphQL) — once per 15min per
  // account. Sets targets.last_replied_at so the runner auto-unenrolls repliers.
  // LinkedIn reply detection runs only when a reply processor is configured.
  for (const accountId of seenAccounts) {
    if (premium?.replies?.shouldSyncInbox(accountId)) {
      console.log(`[runner] Starting LinkedIn inbox sync for account ${accountId}`);
      await guard(`LinkedIn inbox sync (${accountId})`, REPLY_SYNC_TIMEOUT_MS, async () => {
        const replies = await premium!.replies!.syncAccountInbox(accountId);
        console.log(`[runner] LinkedIn inbox sync complete — ${replies} new repl${replies === 1 ? "y" : "ies"}`);
        if (replies > 0) {
          for (const r of activeRuns.filter(x => x.account_id === accountId)) {
            log(db, r.run_id, null, "info", `LinkedIn inbox sync: ${replies} new repl${replies === 1 ? "y" : "ies"} detected`);
          }
        }
      });
    }
  }

  // Auto-complete runs where ALL track-runs across all profiles are terminal
  for (const run of activeRuns) {
    const remaining = (db.prepare(
      `SELECT COUNT(*) as c FROM run_profile_tracks rt
       JOIN run_profiles rp ON rp.id = rt.run_profile_id
       WHERE rp.run_id = ? AND rt.state NOT IN ('completed', 'failed', 'skipped')`
    ).get(run.run_id) as { c: number }).c;
    if (remaining === 0) {
      db.prepare("UPDATE runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(run.run_id);
      const completedRun = db.prepare("SELECT workspace_id, workflow_id FROM runs WHERE id = ?").get(run.run_id) as { workspace_id: string; workflow_id: string } | undefined;
      if (completedRun) emitDomainEvent({ workspaceId: completedRun.workspace_id, type: "workflow.completed", entityType: "run", entityId: run.run_id, payload: { workflow_id: completedRun.workflow_id } });
      log(db, run.run_id, null, "info", "All profiles processed — run completed");
    }
  }

  // Re-load active runs after potential completions
  const stillActive = db.prepare(`
    SELECT r.id as run_id, r.workflow_id, r.account_id, r.email_account_id,
           a.daily_connection_limit, a.daily_message_limit, a.daily_inmail_limit,
           a.active_hours_start, a.active_hours_end, a.timezone, a.working_days
    FROM runs r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.status = 'running'
  `).all() as Array<{ run_id: string; workflow_id: string; account_id: string; email_account_id: string | null } & AccountLimits>;

  if (stillActive.length === 0) return;

  const accountLimitsMap = new Map<string, AccountLimits>();
  for (const run of stillActive) {
    if (!accountLimitsMap.has(run.account_id)) accountLimitsMap.set(run.account_id, run);
  }

  // Build email account limits map
  const stillActiveRunIds = stillActive.map(r => r.run_id);
  const emailAccountIds: string[] = stillActiveRunIds.length > 0
    ? [...new Set(
        (db.prepare(
          `SELECT DISTINCT rp.email_account_id FROM run_profiles rp
           WHERE rp.run_id IN (${stillActiveRunIds.map(() => "?").join(",")})
           AND rp.email_account_id IS NOT NULL`
        ).all(...stillActiveRunIds) as { email_account_id: string }[]).map(r => r.email_account_id)
      )]
    : [];
  const emailAccountLimitsMap = new Map<string, EmailAccountLimits>();
  for (const emailAccountId of emailAccountIds) {
    const ea = db.prepare("SELECT daily_email_limit, active_hours_start, active_hours_end, timezone, working_days, ramp_up_enabled, ramp_start_date FROM email_accounts WHERE id = ?").get(emailAccountId) as EmailAccountLimits | undefined;
    if (ea) emailAccountLimitsMap.set(emailAccountId, ea);
  }

  // Count actions already done today per LinkedIn account — messages and InMail are
  // counted separately so a busy message quota never starves InMail sends (and vice versa).
  const connectsSentToday = new Map<string, number>();
  const messagesSentToday = new Map<string, number>();
  const inmailsSentToday = new Map<string, number>();
  // Counted over the ACCOUNT's calendar day, not the server's UTC day. A UTC boundary that
  // falls inside the working window (17:00 for a Los Angeles account) reset every cap an
  // hour before the window closed, letting a second full quota out in that last hour.
  for (const [accountId, accountLimits] of accountLimitsMap) {
    const day = localDayBoundsUtc(accountLimits.timezone);
    const c = (db.prepare(
      `SELECT COUNT(*) as c FROM logs WHERE run_id IN (SELECT id FROM runs WHERE account_id = ?)
       AND message LIKE 'Connection request sent%' AND created_at >= ? AND created_at < ?`
    ).get(accountId, day.start, day.end) as { c: number }).c;
    const m = (db.prepare(
      `SELECT COUNT(*) as c FROM logs WHERE run_id IN (SELECT id FROM runs WHERE account_id = ?)
       AND message LIKE 'Message sent%' AND created_at >= ? AND created_at < ?`
    ).get(accountId, day.start, day.end) as { c: number }).c;
    const im = (db.prepare(
      `SELECT COUNT(*) as c FROM logs WHERE run_id IN (SELECT id FROM runs WHERE account_id = ?)
       AND message LIKE 'InMail sent%' AND created_at >= ? AND created_at < ?`
    ).get(accountId, day.start, day.end) as { c: number }).c;
    connectsSentToday.set(accountId, c);
    messagesSentToday.set(accountId, m);
    inmailsSentToday.set(accountId, im);
  }

  // Count emails sent today per email account — match by run_profiles.email_account_id
  // (the actual sending account), not runs.email_account_id (which may differ when accounts rotate)
  const emailsSentToday = new Map<string, number>();
  for (const emailAccountId of emailAccountIds) {
    // Falls back to UTC only when the account row is missing, which also means it has no
    // window to be inconsistent with.
    const day = localDayBoundsUtc(emailAccountLimitsMap.get(emailAccountId)?.timezone ?? "UTC");
    const e = (db.prepare(
      `SELECT COUNT(*) as c FROM logs l
       WHERE l.message LIKE 'Email sent%'
       AND l.created_at >= ? AND l.created_at < ?
       AND EXISTS (
         SELECT 1 FROM run_profiles rp
         WHERE rp.run_id = l.run_id AND rp.target_id = l.target_id
         AND rp.email_account_id = ?
       )`
    ).get(day.start, day.end, emailAccountId) as { c: number }).c;
    emailsSentToday.set(emailAccountId, e);
  }

  // Steps cache: (workflow_id, track) → steps filtered by that track
  const stepsCache = new Map<string, WorkflowStep[]>();
  const getSteps = (workflowId: string, track: string): WorkflowStep[] => {
    const key = `${workflowId}|${track}`;
    if (!stepsCache.has(key)) {
      stepsCache.set(key, db.prepare(
        "SELECT * FROM workflow_steps WHERE workflow_id = ? AND track = ? ORDER BY step_order"
      ).all(workflowId, track) as WorkflowStep[]);
    }
    return stepsCache.get(key)!;
  };

  // Workflow prompt cache: workflow_id → campaign prompt string (or null)
  const workflowPromptCache = new Map<string, string | null>();
  const getWorkflowPrompt = (workflowId: string): string | null => {
    if (!workflowPromptCache.has(workflowId)) {
      const row = db.prepare("SELECT prompt FROM workflows WHERE id = ?").get(workflowId) as { prompt: string | null } | undefined;
      workflowPromptCache.set(workflowId, row?.prompt ?? null);
    }
    return workflowPromptCache.get(workflowId) ?? null;
  };

  // Collect ALL due track-runs across all active runs, oldest-due first
  const runIds = stillActive.map(r => r.run_id);
  const placeholders = runIds.map(() => "?").join(",");
  const dueTrackRuns = db.prepare(
    `SELECT rt.id, rt.run_profile_id, rt.track, rt.state, rt.current_step, rt.next_step_at,
            rt.error_message, rt.last_email_subject, rt.last_email_body, rt.last_linkedin_message,
            rt.pending_reply_context,
            rp.run_id, rp.target_id, rp.email_account_id,
            r.account_id, r.workflow_id,
            t.connection_requested_at
     FROM run_profile_tracks rt
     JOIN run_profiles rp ON rp.id = rt.run_profile_id
     JOIN runs r ON r.id = rp.run_id
     JOIN targets t ON t.id = rp.target_id
     WHERE rp.run_id IN (${placeholders})
       AND rt.state = 'in_progress'
       AND (rt.next_step_at IS NULL OR datetime(rt.next_step_at) <= datetime('now'))
     ORDER BY rt.next_step_at ASC`
  ).all(...runIds) as TrackRun[];

  // Enroll new pending track-runs — track remaining slots per account across runs.
  // Enrollment (pending -> in_progress) happens exactly once per track-run, on its
  // FIRST linkedin-track step, so the budget it draws from must match that step's
  // type — a workflow can open on "connect" (e.g. connect -> message) or on
  // "sales_inmail" (e.g. an InMail-first campaign), and each type has its own daily cap.
  const connectSlotsRemaining = new Map<string, number>();
  const inmailSlotsRemaining = new Map<string, number>();
  const firstLinkedinStepCache = new Map<string, string | undefined>();
  const getFirstLinkedinStepType = (workflowId: string): string | undefined => {
    if (!firstLinkedinStepCache.has(workflowId)) {
      const row = db.prepare(
        "SELECT step_type FROM workflow_steps WHERE workflow_id = ? AND track = 'linkedin' ORDER BY step_order LIMIT 1"
      ).get(workflowId) as { step_type: string } | undefined;
      firstLinkedinStepCache.set(workflowId, row?.step_type);
    }
    return firstLinkedinStepCache.get(workflowId);
  };
  const enrolledEmailPairs = new Set<string>();
  for (const run of stillActive) {
    const limits = accountLimitsMap.get(run.account_id)!;
    const firstStepType = getFirstLinkedinStepType(run.workflow_id);
    const isInmailFirst = firstStepType === "sales_inmail";
    const slotsRemaining = isInmailFirst ? inmailSlotsRemaining : connectSlotsRemaining;

    // LinkedIn track enrollment — each run gets its own enrollment, but all runs
    // for the same account share the daily slot budget for that action type
    if (!slotsRemaining.has(run.account_id)) {
      const dailyLimit = isInmailFirst ? (limits.daily_inmail_limit ?? 15) : (limits.daily_connection_limit ?? 20);
      const sentToday = isInmailFirst
        ? (inmailsSentToday.get(run.account_id) ?? 0)
        : (connectsSentToday.get(run.account_id) ?? 0);
      const actionsLeft = Math.max(0, dailyLimit - sentToday);
      const firstStepTypeSql = isInmailFirst ? "'sales_inmail'" : "'connect'";
      const scheduledToday = (db.prepare(
        `SELECT COUNT(*) as c FROM run_profile_tracks rt
         JOIN run_profiles rp ON rp.id = rt.run_profile_id
         JOIN runs r ON r.id = rp.run_id
         JOIN workflow_steps ws ON ws.workflow_id = r.workflow_id AND ws.track = 'linkedin' AND ws.step_order = 1
         WHERE r.account_id = ? AND rt.track = 'linkedin' AND rt.state = 'in_progress'
         AND ws.step_type = ${firstStepTypeSql}
         AND date(datetime(rt.next_step_at)) = date('now')`
      ).get(run.account_id) as { c: number }).c;
      slotsRemaining.set(run.account_id, Math.max(0, actionsLeft - scheduledToday));
    }
    const slotsLeft = slotsRemaining.get(run.account_id)!;
    if (slotsLeft > 0) {
      const toEnroll = Math.min(slotsLeft, 5);
      const pending = db.prepare(
        `SELECT rt.id, rt.run_profile_id, rt.track FROM run_profile_tracks rt
         JOIN run_profiles rp ON rp.id = rt.run_profile_id
         WHERE rp.run_id = ? AND rt.track = 'linkedin' AND rt.state = 'pending'
         ORDER BY rt.id LIMIT ?`
      ).all(run.run_id, toEnroll) as Array<{ id: string; run_profile_id: string; track: string }>;
      spreadEnrollBatch(db, run.run_id, pending, limits, "linkedin");
      slotsRemaining.set(run.account_id, slotsLeft - pending.length);
    }

    // Email track enrollment — iterate per actual sending account used by this run's profiles
    // (run_profiles.email_account_id may differ from runs.email_account_id when accounts are rotated)
    const runEmailAccountIds = (db.prepare(
      `SELECT DISTINCT rp.email_account_id FROM run_profiles rp
       WHERE rp.run_id = ? AND rp.email_account_id IS NOT NULL`
    ).all(run.run_id) as { email_account_id: string }[]).map(r => r.email_account_id);

    for (const emailAccId of runEmailAccountIds) {
      const emailKey = `${run.run_id}|${emailAccId}|email`;
      if (!enrolledEmailPairs.has(emailKey)) {
        enrolledEmailPairs.add(emailKey);
        const emailLimits = emailAccountLimitsMap.get(emailAccId);
        if (emailLimits) {
          const effectiveLimit = effectiveEmailLimit(emailLimits);
          const emailsLeft = Math.max(0, effectiveLimit - (emailsSentToday.get(emailAccId) ?? 0));
          const emailScheduledToday = (db.prepare(
            `SELECT COUNT(*) as c FROM run_profile_tracks rt
             JOIN run_profiles rp ON rp.id = rt.run_profile_id
             WHERE rp.email_account_id = ? AND rt.track = 'email' AND rt.state = 'in_progress'
             AND date(datetime(rt.next_step_at)) = date('now')`
          ).get(emailAccId) as { c: number }).c;
          const emailSlotsLeft = Math.max(0, emailsLeft - emailScheduledToday);
          if (emailSlotsLeft > 0) {
            const pendingEmail = db.prepare(
              `SELECT rt.id, rt.run_profile_id, rt.track FROM run_profile_tracks rt
               JOIN run_profiles rp ON rp.id = rt.run_profile_id
               WHERE rp.run_id = ? AND rp.email_account_id = ? AND rt.track = 'email' AND rt.state = 'pending'
               ORDER BY rt.id LIMIT ?`
            ).all(run.run_id, emailAccId, Math.min(emailSlotsLeft, 5)) as Array<{ id: string; run_profile_id: string; track: string }>;
            spreadEnrollBatch(db, run.run_id, pendingEmail, emailLimits, "email");
          }
        }
      }
    }
  }

  if (dueTrackRuns.length === 0) return;

  // Apply daily limits — separate due track-runs into execute vs reschedule
  const toExecute: TrackRun[] = [];
  const toReschedule: TrackRun[] = [];

  const connectsPlanned = new Map<string, number>(Array.from(accountLimitsMap.keys()).map(id => [id, 0]));
  const messagesPlanned = new Map<string, number>(Array.from(accountLimitsMap.keys()).map(id => [id, 0]));
  const inmailsPlanned = new Map<string, number>(Array.from(accountLimitsMap.keys()).map(id => [id, 0]));
  const emailsPlanned = new Map<string, number>(emailAccountIds.map(id => [id, 0]));

  for (const tr of dueTrackRuns) {
    const steps = getSteps(tr.workflow_id, tr.track);
    const stepIndex = tr.current_step;
    if (stepIndex >= steps.length) { toExecute.push(tr); continue; }
    const step = steps[stepIndex];
    const limits = accountLimitsMap.get(tr.account_id)!;

    if (step.step_type === "connect") {
      // A connect step is "due" both when it's about to send a NEW request and when
      // it's just rechecking an already-sent one for acceptance (see the `degree === 1`
      // check in executeStep). Only the former spends a daily connect slot — the recheck
      // is a free DB read and must never be blocked by the cap, or an accepted connection
      // can never hand off to the next step (it'd be rescheduled behind new sends forever).
      if (tr.connection_requested_at) {
        toExecute.push(tr);
        continue;
      }
      const sentToday = connectsSentToday.get(tr.account_id) ?? 0;
      const planned = connectsPlanned.get(tr.account_id) ?? 0;
      if (sentToday + planned >= (limits.daily_connection_limit ?? 20)) {
        toReschedule.push(tr);
      } else {
        connectsPlanned.set(tr.account_id, planned + 1);
        toExecute.push(tr);
      }
    } else if (step.step_type === "message") {
      const sentToday = messagesSentToday.get(tr.account_id) ?? 0;
      const planned = messagesPlanned.get(tr.account_id) ?? 0;
      if (sentToday + planned >= (limits.daily_message_limit ?? 50)) {
        toReschedule.push(tr);
      } else {
        messagesPlanned.set(tr.account_id, planned + 1);
        toExecute.push(tr);
      }
    } else if (step.step_type === "sales_inmail") {
      const sentToday = inmailsSentToday.get(tr.account_id) ?? 0;
      const planned = inmailsPlanned.get(tr.account_id) ?? 0;
      if (sentToday + planned >= (limits.daily_inmail_limit ?? 15)) {
        toReschedule.push(tr);
      } else {
        inmailsPlanned.set(tr.account_id, planned + 1);
        toExecute.push(tr);
      }
    } else if (step.step_type === "email") {
      const profileEmailAccountId = tr.email_account_id;
      if (!profileEmailAccountId) {
        toExecute.push(tr);
      } else {
        const emailLimits = emailAccountLimitsMap.get(profileEmailAccountId);
        const sentToday = emailsSentToday.get(profileEmailAccountId) ?? 0;
        const planned = emailsPlanned.get(profileEmailAccountId) ?? 0;
        const effectiveLimit = emailLimits ? effectiveEmailLimit(emailLimits) : 50;
        if (sentToday + planned >= effectiveLimit) {
          toReschedule.push(tr);
        } else {
          emailsPlanned.set(profileEmailAccountId, planned + 1);
          toExecute.push(tr);
        }
      }
    } else {
      // visit, delay — no limit
      toExecute.push(tr);
    }
  }

  // Reschedule overflow to tomorrow (use LinkedIn account schedule for reschedule)
  for (const tr of toReschedule) {
    const limits = accountLimitsMap.get(tr.account_id)!;
    const slot = rescheduleToTomorrow(limits);
    db.prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE id = ?").run(slot, tr.id);
    log(db, tr.run_id, tr.target_id, "info", `Daily limit reached — rescheduled to ${slot}`);
  }

  // Execute what's left
  for (const tr of toExecute) {
    const steps = getSteps(tr.workflow_id, tr.track);
    const limits = accountLimitsMap.get(tr.account_id)!;
    const emailAccountId = tr.email_account_id ?? null;
    const emailLimits = emailAccountId ? (emailAccountLimitsMap.get(emailAccountId) ?? null) : null;

    const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(tr.run_id) as { status: string } | undefined;
    if (!runStatus || runStatus.status !== "running") continue;

    const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(tr.target_id) as Target;
    // Bounded so one wedged profile cannot stop every profile behind it in the queue. On a
    // timeout the track keeps its current state and stays due, so it is simply retried next
    // tick — the same outcome as any other failed step.
    await guard(
      `Step for target ${tr.target_id}`,
      EXECUTE_STEP_TIMEOUT_MS,
      () => executeStep(db, tr.run_id, tr, target, steps, tr.account_id, limits, emailAccountId, emailLimits, getWorkflowPrompt(tr.workflow_id)),
      (err) => log(db, tr.run_id, tr.target_id, "error", `Step aborted: ${err.message}`),
    );
    // Progress through a long tick is liveness too — without this the indicator flags a
    // runner that is working hard through a backlog.
    heartbeat(db, stillActive);
    await randomDelay(PROFILE_DELAY_MIN, PROFILE_DELAY_MAX);
  }
}

function spreadEnrollBatch(
  db: ReturnType<typeof getDb>,
  runId: string,
  pending: Array<{ id: string; run_profile_id: string; track: string }>,
  limits: ScheduleConfig,
  track: string
) {
  const batchSize = pending.length;
  if (batchSize === 0) return;
  const start = limits.active_hours_start ?? 9;
  const end = limits.active_hours_end ?? 18;
  const tz = limits.timezone || "UTC";
  const { hour, minute } = getLocalParts(tz);
  const nowFrac = hour + minute / 60;
  // Window bounds in the ACCOUNT's timezone (previously server-local, so on a UTC host
  // with a non-UTC account the buckets landed outside the account's real window).
  const { year, month, day } = zonedParts(tz);
  const dayStartMs = zonedTimeToUtcMs(tz, year, month, day, start);
  const dayEndMs = zonedTimeToUtcMs(tz, year, month, day, end);
  // Spread over what is LEFT of the window. Anchoring at the window start meant every
  // bucket before "now" was already due, so a whole enrolment batch fired at once.
  const spreadFrom = Math.max(dayStartMs, Date.now());
  const bucketMs = Math.max(0, dayEndMs - spreadFrom) / batchSize;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const claimed = db.prepare(
      "UPDATE run_profile_tracks SET state = 'in_progress' WHERE id = ? AND state = 'pending'"
    ).run(row.id);
    if (claimed.changes === 0) continue;
    const slot = (() => {
      if (nowFrac >= end - 0.25) return rescheduleToTomorrow(limits);
      const bucketStart = spreadFrom + i * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      return new Date(bucketStart + Math.random() * (bucketEnd - bucketStart)).toISOString();
    })();
    db.prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE id = ?").run(slot, row.id);
    const tgt = db.prepare("SELECT full_name, linkedin_url FROM targets WHERE id = (SELECT target_id FROM run_profiles WHERE id = ?)").get(row.run_profile_id) as { full_name: string | null; linkedin_url: string } | undefined;
    log(db, runId, null, "info", `[${track}] Scheduled ${tgt?.full_name ?? tgt?.linkedin_url ?? row.run_profile_id} within active window`);
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

export function startRun(runId: string): void {
  const db = getDb();
  db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(runId);
  console.log(`[runner] Run ${runId} marked running — global loop will pick it up`);
}
