// Scheduled detection: asking Apollo, for each account a workspace watches, whether it has
// raised money, started hiring or changed the tools it uses, and recording what changed as
// signals.
//
// Every question costs Apollo credits on the workspace's own account, so:
//   - it is off until an admin turns it on, and stays off without a monthly cap;
//   - what a run would cost is worked out before anything is asked (estimate());
//   - a run stops the moment the next account would take the month past the cap;
//   - every run is written down with what it spent (signal_detection_runs).
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import { apolloKey } from "@/lib/contacts/apollo-enrich";
import { notify } from "@/lib/platform/notifications";
import { ingestSignal } from "@/lib/platform/signals";
import { ApolloError, fetchJobPostings, fetchOrganization, stopsTheRun, type JobPosting, type Organization } from "@/lib/signals/apollo-org";

type DB = DatabaseType.Database;

export const DETECTION_KINDS = ["funding", "hiring", "technology"] as const;
export type DetectionKind = (typeof DETECTION_KINDS)[number];
export const INTERVAL_DAYS = [1, 7, 14, 30] as const;
/** The most accounts a workspace can watch. */
export const MAX_WATCHED = 500;
export const MAX_CREDIT_CAP = 100_000;

export interface DetectionConfig {
  enabled: boolean;
  kinds: DetectionKind[];
  interval_days: number;
  /** Apollo credits detection may spend in a calendar month (UTC). 0: none set, so nothing runs. */
  monthly_credit_cap: number;
}

const isKind = (value: unknown): value is DetectionKind => (DETECTION_KINDS as readonly unknown[]).includes(value);

export function readDetectionConfig(db: DB, workspaceId: string): DetectionConfig {
  const row = db.prepare("SELECT enabled, kinds, interval_days, monthly_credit_cap FROM signal_detection_config WHERE workspace_id = ?").get(workspaceId) as
    | { enabled: number; kinds: string; interval_days: number; monthly_credit_cap: number } | undefined;
  if (!row) return { enabled: false, kinds: [...DETECTION_KINDS], interval_days: 7, monthly_credit_cap: 0 };
  return { enabled: Boolean(row.enabled), kinds: row.kinds.split(",").filter(isKind), interval_days: row.interval_days, monthly_credit_cap: row.monthly_credit_cap };
}

/** One lookup of the company, and one more for its open roles when hiring is watched. */
export function creditsPerAccount(kinds: readonly DetectionKind[]): number {
  if (kinds.length === 0) return 0;
  return 1 + (kinds.includes("hiring") ? 1 : 0);
}

const monthStart = (now: Date) => `${now.toISOString().slice(0, 7)}-01 00:00:00`;

export function creditsSpentThisMonth(db: DB, workspaceId: string, now: Date = new Date()): number {
  return (db.prepare("SELECT COALESCE(SUM(credits_spent), 0) AS c FROM signal_detection_runs WHERE workspace_id = ? AND started_at >= ?").get(workspaceId, monthStart(now)) as { c: number }).c;
}

export interface DetectionEstimate {
  /** Accounts watched, and how many of them have a website to look up. */
  accounts: number;
  checkable: number;
  credits_per_account: number;
  /** The most one run can spend, and the most a month of runs can. */
  credits_per_run: number;
  runs_per_month: number;
  credits_per_month: number;
  cap: number;
  spent_this_month: number;
  remaining: number;
  /** False when a month of runs would cost more than the cap: runs then stop part-way. */
  fits: boolean;
}

export function estimate(db: DB, workspaceId: string, config: DetectionConfig, now: Date = new Date()): DetectionEstimate {
  const counts = db.prepare(
    `SELECT COUNT(*) AS accounts, COALESCE(SUM(CASE WHEN COALESCE(c.domain, '') != '' THEN 1 ELSE 0 END), 0) AS checkable
     FROM signal_watch sw JOIN companies c ON c.id = sw.company_id WHERE sw.workspace_id = ?`,
  ).get(workspaceId) as { accounts: number; checkable: number };
  const perAccount = creditsPerAccount(config.kinds);
  const perRun = counts.checkable * perAccount;
  const runs = Math.max(1, Math.ceil(30 / Math.max(1, config.interval_days)));
  const spent = creditsSpentThisMonth(db, workspaceId, now);
  return {
    accounts: counts.accounts, checkable: counts.checkable, credits_per_account: perAccount, credits_per_run: perRun, runs_per_month: runs, credits_per_month: perRun * runs,
    cap: config.monthly_credit_cap, spent_this_month: spent, remaining: Math.max(0, config.monthly_credit_cap - spent),
    fits: config.monthly_credit_cap > 0 && perRun * runs <= config.monthly_credit_cap,
  };
}

export interface DetectionPatch {
  enabled?: unknown;
  kinds?: unknown;
  interval_days?: unknown;
  monthly_credit_cap?: unknown;
}

/**
 * Change the settings that were sent. Turning detection on is refused unless Apollo is
 * connected, a cap is set, something is being detected and at least one watched account
 * can be looked up: otherwise "on" would mean nothing, or would mean spending without a limit.
 */
export function saveDetectionConfig(db: DB, workspaceId: string, userId: string | null, patch: DetectionPatch): { ok: true; config: DetectionConfig } | { ok: false; error: string } {
  const next = { ...readDetectionConfig(db, workspaceId) };
  if (patch.kinds !== undefined) {
    if (!Array.isArray(patch.kinds) || !patch.kinds.every(isKind)) return { ok: false, error: `kinds must be a list of: ${DETECTION_KINDS.join(", ")}` };
    next.kinds = DETECTION_KINDS.filter((kind) => (patch.kinds as unknown[]).includes(kind));
  }
  if (patch.interval_days !== undefined) {
    if (!(INTERVAL_DAYS as readonly unknown[]).includes(patch.interval_days)) return { ok: false, error: `interval_days must be one of: ${INTERVAL_DAYS.join(", ")}` };
    next.interval_days = patch.interval_days as number;
  }
  if (patch.monthly_credit_cap !== undefined) {
    const cap = patch.monthly_credit_cap;
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0 || cap > MAX_CREDIT_CAP) return { ok: false, error: `The monthly cap must be a whole number of credits from 0 to ${MAX_CREDIT_CAP.toLocaleString("en-US")}` };
    next.monthly_credit_cap = cap;
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
    next.enabled = patch.enabled;
  }
  if (next.enabled) {
    if (!apolloKey(db, workspaceId)) return { ok: false, error: "Connect Apollo first: detection asks Apollo about each account." };
    if (next.kinds.length === 0) return { ok: false, error: "Choose at least one kind of change to look for." };
    if (next.monthly_credit_cap <= 0) return { ok: false, error: "Set a monthly cap on Apollo credits before turning detection on." };
    if (estimate(db, workspaceId, next).checkable === 0) return { ok: false, error: "Watch at least one account that has a website. Detection looks a company up by its domain." };
  }
  db.prepare(
    `INSERT INTO signal_detection_config (workspace_id, enabled, kinds, interval_days, monthly_credit_cap, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(workspace_id) DO UPDATE SET enabled = excluded.enabled, kinds = excluded.kinds, interval_days = excluded.interval_days,
       monthly_credit_cap = excluded.monthly_credit_cap, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(workspaceId, next.enabled ? 1 : 0, next.kinds.join(","), next.interval_days, next.monthly_credit_cap, userId);
  return { ok: true, config: next };
}

// ── The accounts watched ─────────────────────────────────────────────

export interface WatchedAccount {
  company_id: string;
  name: string;
  domain: string | null;
  contacts: number;
  added_at: string;
  last_checked_at: string | null;
  /** One line on what the last check found, or why it could not be made. */
  last_result: string | null;
}

export function watchedAccounts(db: DB, workspaceId: string): WatchedAccount[] {
  return db.prepare(
    `SELECT sw.company_id, c.name, NULLIF(c.domain, '') AS domain, sw.added_at, sw.last_checked_at, sw.last_result,
            (SELECT COUNT(*) FROM targets t WHERE t.company_id = c.id AND t.workspace_id = sw.workspace_id) AS contacts
     FROM signal_watch sw JOIN companies c ON c.id = sw.company_id
     WHERE sw.workspace_id = ? ORDER BY c.name COLLATE NOCASE`,
  ).all(workspaceId) as WatchedAccount[];
}

/** Start watching companies of this workspace. Returns how many were added, and how many were left out because the list is full. */
export function watchCompanies(db: DB, workspaceId: string, userId: string | null, companyIds: string[]): { added: number; left_out: number } {
  const ids = [...new Set(companyIds)];
  const room = MAX_WATCHED - (db.prepare("SELECT COUNT(*) AS c FROM signal_watch WHERE workspace_id = ?").get(workspaceId) as { c: number }).c;
  const insert = db.prepare("INSERT OR IGNORE INTO signal_watch (workspace_id, company_id, added_by) SELECT ?, id, ? FROM companies WHERE id = ? AND workspace_id = ?");
  let added = 0;
  let leftOut = 0;
  db.transaction(() => {
    for (const id of ids) {
      if (added >= room) {
        if (!db.prepare("SELECT 1 FROM signal_watch WHERE workspace_id = ? AND company_id = ?").get(workspaceId, id)) leftOut += 1;
        continue;
      }
      added += insert.run(workspaceId, userId, id, workspaceId).changes;
    }
  })();
  return { added, left_out: leftOut };
}

/** The companies the contacts of a list work at. */
export function companiesOfList(db: DB, workspaceId: string, listId: string): string[] {
  return (db.prepare(
    `SELECT DISTINCT t.company_id AS id FROM list_targets lt JOIN targets t ON t.id = lt.target_id JOIN lists l ON l.id = lt.list_id
     WHERE lt.list_id = ? AND l.workspace_id = ? AND t.company_id IS NOT NULL`,
  ).all(listId, workspaceId) as Array<{ id: string }>).map((row) => row.id);
}

export function unwatchCompanies(db: DB, workspaceId: string, companyIds: string[]): number {
  const ids = [...new Set(companyIds)].slice(0, MAX_WATCHED);
  if (ids.length === 0) return 0;
  return db.prepare(`DELETE FROM signal_watch WHERE workspace_id = ? AND company_id IN (${ids.map(() => "?").join(", ")})`).run(workspaceId, ...ids).changes;
}

// ── What changed ─────────────────────────────────────────────────────

/** What a check found about one account. Kept so the next check can tell what is new. */
export interface Snapshot {
  checked_at: string;
  headcount: number | null;
  funding_stage: string | null;
  funding_date: string | null;
  funding_total: string | null;
  technologies: string[];
  /** Null when open roles were not asked about. */
  open_roles: number | null;
}

export interface Detected {
  type: DetectionKind;
  title: string;
  description: string;
  score: number;
  /** When it happened, where Apollo says: a funding round's own day. Otherwise the check's. */
  occurred_at: string;
}

/** A round this recent is worth a signal the first time an account is checked. */
export const FRESH_FUNDING_DAYS = 60;
/** An account with this many open roles is hiring, the first time it is checked. */
export const HIRING_ROLES = 5;
const DAY_MS = 86_400_000;

const list = (items: string[], most = 4) => (items.length <= most ? items.join(", ") : `${items.slice(0, most).join(", ")} and ${items.length - most} more`);

/**
 * The signals one check gives rise to. The first check of an account is its baseline: it
 * reports a recent round and an account already hiring, but not the technologies it uses,
 * since every one of them would look new.
 */
export function compareSnapshots(name: string, previous: Snapshot | null, current: Snapshot, roles: JobPosting[], kinds: readonly DetectionKind[], now: Date = new Date()): Detected[] {
  const found: Detected[] = [];
  const at = now.toISOString();

  if (kinds.includes("funding") && current.funding_date) {
    const isNew = previous ? current.funding_date > (previous.funding_date ?? "") : now.getTime() - Date.parse(`${current.funding_date}T00:00:00Z`) <= FRESH_FUNDING_DAYS * DAY_MS;
    if (isNew) {
      found.push({
        type: "funding", score: 70, occurred_at: `${current.funding_date}T00:00:00.000Z`,
        title: `${name} raised ${current.funding_stage ? `a ${current.funding_stage} round` : "a new round"}`,
        description: [`Round dated ${current.funding_date}`, current.funding_total ? `${current.funding_total} raised in all` : null].filter(Boolean).join(" · "),
      });
    }
  }

  if (kinds.includes("hiring")) {
    const titles = [...new Set(roles.map((role) => role.title))];
    const sample = titles.length > 0 ? `Open roles include ${list(titles)}` : "";
    if (current.open_roles !== null) {
      const before = previous?.open_roles ?? null;
      const grew = before !== null ? current.open_roles >= before + Math.max(3, Math.ceil(before * 0.25)) : !previous && current.open_roles >= HIRING_ROLES;
      if (grew) {
        found.push({
          type: "hiring", score: 50, occurred_at: at,
          title: before !== null ? `${name} went from ${before} to ${current.open_roles} open roles` : `${name} has ${current.open_roles} open roles`,
          description: sample,
        });
      }
    }
    // Headcount is a slower sign of the same thing, and the only one when roles cannot be read.
    if (!found.some((signal) => signal.type === "hiring") && previous?.headcount && current.headcount && current.headcount >= Math.ceil(previous.headcount * 1.1) && current.headcount - previous.headcount >= 5) {
      found.push({ type: "hiring", score: 40, occurred_at: at, title: `${name} grew from ${previous.headcount} to ${current.headcount} people`, description: sample });
    }
  }

  if (kinds.includes("technology") && previous) {
    const had = new Set(previous.technologies.map((item) => item.toLowerCase()));
    const added = current.technologies.filter((item) => !had.has(item.toLowerCase()));
    // A list that was empty last time tells nothing about what is new.
    if (added.length > 0 && previous.technologies.length > 0) {
      found.push({ type: "technology", score: 40, occurred_at: at, title: `${name} started using ${list(added)}`, description: `${added.length} ${added.length === 1 ? "technology" : "technologies"} Apollo did not list at the last check` });
    }
  }
  return found;
}

function snapshotOf(org: Organization, roles: JobPosting[] | null, now: Date): Snapshot {
  return {
    checked_at: now.toISOString(), headcount: org.headcount, funding_stage: org.funding_stage, funding_date: org.funding_date, funding_total: org.funding_total,
    technologies: org.technologies, open_roles: roles ? roles.length : null,
  };
}

function parseSnapshot(json: string | null): Snapshot | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<Snapshot>;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.technologies) ? (parsed as Snapshot) : null;
  } catch {
    return null;
  }
}

// ── Runs ─────────────────────────────────────────────────────────────

export type RunStatus = "running" | "done" | "stopped_at_cap" | "failed";

export interface DetectionRun {
  id: string;
  trigger: "schedule" | "manual";
  status: RunStatus;
  accounts_checked: number;
  credits_spent: number;
  signals_found: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function recentRuns(db: DB, workspaceId: string, limit = 10): DetectionRun[] {
  return db.prepare(
    "SELECT id, trigger, status, accounts_checked, credits_spent, signals_found, error, started_at, finished_at FROM signal_detection_runs WHERE workspace_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?",
  ).all(workspaceId, limit) as DetectionRun[];
}

/** A run that began this recently and has not finished is taken to be still going. */
const RUN_STALE_MINUTES = 30;

export function runUnderWay(db: DB, workspaceId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM signal_detection_runs WHERE workspace_id = ? AND status = 'running' AND started_at >= datetime('now', '-${RUN_STALE_MINUTES} minutes')`).get(workspaceId));
}

/** Why a run cannot be started now, or null when it can. The same checks for a person's run and the schedule's. */
export function runProblem(db: DB, workspaceId: string, now: Date = new Date()): string | null {
  const config = readDetectionConfig(db, workspaceId);
  if (!apolloKey(db, workspaceId)) return "Apollo is not connected.";
  if (config.kinds.length === 0) return "No kind of change is chosen to look for.";
  if (config.monthly_credit_cap <= 0) return "No monthly cap on Apollo credits has been set.";
  const cost = estimate(db, workspaceId, config, now);
  if (cost.checkable === 0) return "No watched account has a website to look up.";
  if (cost.remaining < cost.credits_per_account) return `This month's cap of ${config.monthly_credit_cap.toLocaleString("en-US")} credits is used up.`;
  if (runUnderWay(db, workspaceId)) return "A run is already under way.";
  return null;
}

/**
 * Check the watched accounts, least recently checked first, until they are all done or
 * the month's cap would be passed. Signals are recorded against the company. Never throws:
 * what went wrong is written on the run.
 */
export async function runDetection(db: DB, workspaceId: string, options: { trigger: "schedule" | "manual"; startedBy?: string | null; now?: Date } = { trigger: "manual" }): Promise<DetectionRun> {
  const now = options.now ?? new Date();
  const id = randomUUID();
  db.prepare("INSERT INTO signal_detection_runs (id, workspace_id, trigger, status, started_by, started_at) VALUES (?, ?, ?, 'running', ?, ?)")
    .run(id, workspaceId, options.trigger, options.startedBy ?? null, now.toISOString().slice(0, 19).replace("T", " "));
  const read = () => db.prepare("SELECT id, trigger, status, accounts_checked, credits_spent, signals_found, error, started_at, finished_at FROM signal_detection_runs WHERE id = ?").get(id) as DetectionRun;
  const finish = (status: RunStatus, error: string | null = null) => {
    db.prepare("UPDATE signal_detection_runs SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?").run(status, error, id);
    return read();
  };

  const config = readDetectionConfig(db, workspaceId);
  const key = apolloKey(db, workspaceId);
  if (!key) return finish("failed", "Apollo is not connected.");
  if (config.kinds.length === 0) return finish("failed", "No kind of change is chosen to look for.");
  if (config.monthly_credit_cap <= 0) return finish("failed", "No monthly cap on Apollo credits has been set.");

  const perAccount = creditsPerAccount(config.kinds);
  // This run's own row is in the sum, at zero so far.
  let remaining = config.monthly_credit_cap - creditsSpentThisMonth(db, workspaceId, now);
  const accounts = db.prepare(
    `SELECT sw.company_id, c.name, NULLIF(c.domain, '') AS domain, sw.snapshot_json
     FROM signal_watch sw JOIN companies c ON c.id = sw.company_id
     WHERE sw.workspace_id = ? ORDER BY sw.last_checked_at IS NOT NULL, sw.last_checked_at, c.name COLLATE NOCASE`,
  ).all(workspaceId) as Array<{ company_id: string; name: string; domain: string | null; snapshot_json: string | null }>;

  const note = db.prepare("UPDATE signal_watch SET last_checked_at = datetime('now'), last_result = ?, snapshot_json = COALESCE(?, snapshot_json) WHERE workspace_id = ? AND company_id = ?");
  const spend = db.prepare("UPDATE signal_detection_runs SET credits_spent = credits_spent + ? WHERE id = ?");
  const count = db.prepare("UPDATE signal_detection_runs SET accounts_checked = accounts_checked + 1, signals_found = signals_found + ? WHERE id = ?");
  let signals = 0;
  let stoppedAtCap = false;

  for (const account of accounts) {
    if (!account.domain) {
      db.prepare("UPDATE signal_watch SET last_result = ? WHERE workspace_id = ? AND company_id = ?").run("No website to look it up by", workspaceId, account.company_id);
      continue;
    }
    // Asked before spending: an account is only looked up when the whole of it fits under the cap.
    if (remaining < perAccount) { stoppedAtCap = true; break; }
    try {
      // Written down before the answer comes back, so a credit Apollo took is never one this forgot.
      spend.run(1, id);
      remaining -= 1;
      const org = await fetchOrganization(account.domain, key);
      if (!org) {
        note.run("Apollo does not know this company", null, workspaceId, account.company_id);
        count.run(0, id);
        continue;
      }
      let roles: JobPosting[] | null = null;
      if (config.kinds.includes("hiring") && org.apollo_id) {
        spend.run(1, id);
        remaining -= 1;
        roles = await fetchJobPostings(org.apollo_id, key);
      }
      const current = snapshotOf(org, roles, now);
      const found = compareSnapshots(account.name, parseSnapshot(account.snapshot_json), current, roles ?? [], config.kinds, now);
      for (const signal of found) {
        ingestSignal({ workspaceId, companyId: account.company_id, type: signal.type, title: signal.title, description: signal.description || undefined, score: signal.score, source: "apollo", occurredAt: signal.occurred_at, metadata: { detection_run: id } });
      }
      signals += found.length;
      note.run(found.length > 0 ? found.map((signal) => signal.title).join(" · ").slice(0, 300) : "Nothing new", JSON.stringify(current), workspaceId, account.company_id);
      count.run(found.length, id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Turned away at the door (no answer, the key, the balance, the rate): Apollo did no work, so the credit counted for this call is given back.
      if (error instanceof ApolloError && [0, 401, 402, 403, 429].includes(error.status)) {
        spend.run(-1, id);
        remaining += 1;
      }
      note.run(message.slice(0, 300), null, workspaceId, account.company_id);
      // The key, the credits or the rate: the next account would fail the same way, and might cost a credit to find out.
      if (stopsTheRun(error)) return finish("failed", message.slice(0, 300));
    }
  }

  const run = finish(stoppedAtCap ? "stopped_at_cap" : "done");
  if (signals > 0) {
    notify({ workspaceId, kind: "signals.detected", tone: "good", title: `${signals} new ${signals === 1 ? "signal" : "signals"} from your watched accounts`, body: `${run.accounts_checked} ${run.accounts_checked === 1 ? "account" : "accounts"} checked.`, link: "/signals", dedupeKey: `signals.detected:${id}` }, db);
  }
  if (stoppedAtCap) {
    notify({ workspaceId, kind: "signals.cap_reached", tone: "warn", minRole: "admin", title: "Signal detection stopped at its Apollo credit cap", body: `This month's cap is ${config.monthly_credit_cap.toLocaleString("en-US")} credits. The accounts not reached are checked first next time.`, link: "/signals?tab=detection", dedupeKey: `signals.cap_reached:${workspaceId}:${now.toISOString().slice(0, 7)}` }, db);
  }
  return run;
}

/**
 * The schedule: start a run for every workspace whose detection is on and whose last run
 * began at least its interval ago. Called from the background loop, which comes round
 * often, so it answers at once when nothing is due.
 */
export async function runDueSignalDetection(db: DB, now: Date = new Date()): Promise<number> {
  const due = db.prepare(
    `SELECT c.workspace_id AS id FROM signal_detection_config c
     WHERE c.enabled = 1 AND c.monthly_credit_cap > 0
       AND NOT EXISTS (SELECT 1 FROM signal_detection_runs r WHERE r.workspace_id = c.workspace_id AND datetime(r.started_at) > datetime(?, '-' || c.interval_days || ' days'))`,
  ).all(now.toISOString().slice(0, 19).replace("T", " ")) as Array<{ id: string }>;
  let started = 0;
  for (const workspace of due) {
    if (runProblem(db, workspace.id, now)) continue;
    await runDetection(db, workspace.id, { trigger: "schedule", now });
    started += 1;
  }
  return started;
}
