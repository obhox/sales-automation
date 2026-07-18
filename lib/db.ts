import Database from "better-sqlite3";
import path from "path";
import { randomUUID } from "crypto";
import { scheduleUpdateCheck } from "@/lib/update-check";
import { encryptSecret, isEncrypted } from "@/lib/crypto";

const DB_PATH = process.env.LINKI_DB_PATH || path.join(process.cwd(), "linki.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initDb(db);
    runMigrations(db);
    scheduleUpdateCheck();
  }
  return db;
}

function runParallelTracksMigration(db: Database.Database) {
  // This backfill reads the legacy run_profiles.state column. If that column no longer
  // exists, dropDeprecatedRunProfileColumns has already run (a prior startup) and this
  // migration is moot — skip, otherwise the SELECT rp.state below throws "no such column".
  // (Fresh DBs hit this: state is created, dropped on one startup, then this guard would
  // otherwise re-enter on the next because no email-tracked steps exist yet.)
  try {
    const rpCols = db.prepare("PRAGMA table_info(run_profiles)").all() as { name: string }[];
    if (!rpCols.some(c => c.name === "state")) return;
  } catch { return; }

  // Idempotent: skip if run_profile_tracks already has rows or workflow_steps already has email-tracked rows
  try {
    const alreadyRun = (db.prepare("SELECT COUNT(*) as c FROM run_profile_tracks").get() as { c: number }).c > 0
      || (db.prepare("SELECT COUNT(*) as c FROM workflow_steps WHERE track = 'email'").get() as { c: number }).c > 0;
    if (alreadyRun) return;
  } catch { return; }

  db.transaction(() => {
    // 1. Assign email step_type rows to the email track
    db.exec("UPDATE workflow_steps SET track = 'email' WHERE step_type = 'email'");
    // Also assign delay steps to the email track if the next non-delay step after them is an email step.
    // Without this, delays between email steps default to 'linkedin' and create a ghost linkedin track.
    db.exec(`
      UPDATE workflow_steps SET track = 'email'
      WHERE step_type = 'delay'
      AND (
        SELECT step_type FROM workflow_steps ws2
        WHERE ws2.workflow_id = workflow_steps.workflow_id
          AND ws2.step_order > workflow_steps.step_order
          AND ws2.step_type != 'delay'
        ORDER BY ws2.step_order ASC
        LIMIT 1
      ) = 'email'
    `);

    // 2. Re-number step_order densely within each (workflow_id, track), preserving original order
    const stepGroups = db.prepare(
      "SELECT id, workflow_id, track, step_order FROM workflow_steps ORDER BY workflow_id, track, step_order"
    ).all() as Array<{ id: string; workflow_id: string; track: string; step_order: number }>;

    // Group by (workflow_id, track) and assign dense 1-based order
    const grouped = new Map<string, Array<{ id: string; step_order: number }>>();
    for (const row of stepGroups) {
      const key = `${row.workflow_id}|${row.track}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push({ id: row.id, step_order: row.step_order });
    }
    const updateStep = db.prepare("UPDATE workflow_steps SET step_order = ? WHERE id = ?");
    for (const steps of grouped.values()) {
      steps.sort((a, b) => a.step_order - b.step_order);
      steps.forEach((s, i) => updateStep.run(i + 1, s.id));
    }

    // 3. Backfill run_profile_tracks from existing run_profiles
    // Only backfill if there are run_profiles rows to process
    const allProfiles = db.prepare(
      `SELECT rp.id, rp.run_id, rp.state, rp.current_step, rp.next_step_at,
              rp.error_message, rp.last_email_subject, rp.last_email_body, rp.last_linkedin_message,
              r.workflow_id
       FROM run_profiles rp
       JOIN runs r ON r.id = rp.run_id`
    ).all() as Array<{
      id: string; run_id: string; state: string; current_step: number;
      next_step_at: string | null; error_message: string | null;
      last_email_subject: string | null; last_email_body: string | null;
      last_linkedin_message: string | null; workflow_id: string;
    }>;

    if (allProfiles.length === 0) return;

    // Load all workflow steps grouped by workflow_id, preserving their original ordering
    // We need the ORIGINAL step_order to map legacy current_step (0-based flat index) to tracks.
    // After the re-numbering above, step_order is now per-track. We stored the original order as the
    // sort key inside stepGroups above. Rebuild a per-workflow flat list from the original ordering.
    const workflowStepsOrig = db.prepare(
      "SELECT id, workflow_id, track, step_order FROM workflow_steps ORDER BY workflow_id, step_order"
    ).all() as Array<{ id: string; workflow_id: string; track: string; step_order: number }>;

    // For each workflow, build the flat list of steps in their original order (by new step_order within track, then track order linkedin < email)
    // BUT: we need the ORIGINAL flat order before re-numbering. Since we already re-numbered, we have to reconstruct.
    // Approach: the original flat step_order was cross-track. The re-numbered step_order is per-track and starts at 1.
    // We stored the original step_order in stepGroups (before modification). Use that.
    const origStepOrderMap = new Map<string, number>(); // step id → original flat step_order
    for (const row of stepGroups) {
      origStepOrderMap.set(row.id, row.step_order);
    }

    // Per workflow: flat list of steps sorted by original step_order
    const workflowFlatSteps = new Map<string, Array<{ id: string; track: string; orig_order: number }>>();
    for (const step of workflowStepsOrig) {
      if (!workflowFlatSteps.has(step.workflow_id)) workflowFlatSteps.set(step.workflow_id, []);
      workflowFlatSteps.get(step.workflow_id)!.push({
        id: step.id,
        track: step.track,
        orig_order: origStepOrderMap.get(step.id) ?? step.step_order,
      });
    }
    for (const steps of workflowFlatSteps.values()) {
      steps.sort((a, b) => a.orig_order - b.orig_order);
    }

    // Per workflow: which tracks exist
    const workflowTracks = new Map<string, Set<string>>();
    for (const step of workflowStepsOrig) {
      if (!workflowTracks.has(step.workflow_id)) workflowTracks.set(step.workflow_id, new Set());
      workflowTracks.get(step.workflow_id)!.add(step.track);
    }

    const insertTrack = db.prepare(`
      INSERT OR IGNORE INTO run_profile_tracks
        (id, run_profile_id, track, state, current_step, last_step_at, next_step_at,
         error_message, last_email_subject, last_email_body, last_linkedin_message)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `);

    for (const rp of allProfiles) {
      const flatSteps = workflowFlatSteps.get(rp.workflow_id) ?? [];
      const tracks = workflowTracks.get(rp.workflow_id) ?? new Set(["linkedin"]);
      const terminalStates = new Set(["completed", "failed", "skipped"]);

      if (terminalStates.has(rp.state)) {
        // Terminal profile — mark all tracks with the same terminal state
        for (const track of tracks) {
          insertTrack.run(
            randomUUID(), rp.id, track, rp.state, 0,
            null, rp.error_message ?? null, null, null, null
          );
        }
        continue;
      }

      // Active profile — compute per-track completed step count
      // legacy current_step is 0-based index into the flat step list = steps already completed
      const completedCount = rp.current_step;
      const completedSteps = flatSteps.slice(0, completedCount);

      const trackCompletedCount = new Map<string, number>();
      for (const track of tracks) trackCompletedCount.set(track, 0);
      for (const s of completedSteps) {
        trackCompletedCount.set(s.track, (trackCompletedCount.get(s.track) ?? 0) + 1);
      }

      // Which track owned the step we were waiting on (index = completedCount)?
      const currentFlatStep = flatSteps[completedCount];
      const waitingTrack = currentFlatStep?.track ?? null;

      for (const track of tracks) {
        const trackCurrentStep = trackCompletedCount.get(track) ?? 0;
        // next_step_at: only carry over to the track that was waiting; other track starts immediately
        const nextStepAt = track === waitingTrack ? rp.next_step_at : null;
        const lastEmailSubject = track === "email" ? rp.last_email_subject : null;
        const lastEmailBody = track === "email" ? rp.last_email_body : null;
        const lastLinkedinMessage = track === "linkedin" ? rp.last_linkedin_message : null;

        insertTrack.run(
          randomUUID(), rp.id, track, rp.state, trackCurrentStep,
          nextStepAt, rp.error_message ?? null,
          lastEmailSubject, lastEmailBody, lastLinkedinMessage
        );
      }
    }
  })();
}

function dropDeprecatedRunProfileColumns(db: Database.Database) {
  // Idempotent: check if state column still exists on run_profiles
  try {
    const tableInfo = db.prepare("PRAGMA table_info(run_profiles)").all() as { name: string }[];
    const hasState = tableInfo.some(c => c.name === "state");
    if (!hasState) return; // already dropped
  } catch { return; }

  // SQLite requires a table rebuild to drop columns
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE run_profiles_new (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        target_id TEXT REFERENCES targets(id),
        email_account_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, target_id)
      );
      INSERT INTO run_profiles_new (id, run_id, target_id, email_account_id, created_at)
        SELECT id, run_id, target_id, email_account_id, created_at FROM run_profiles;
      DROP TABLE run_profiles;
      ALTER TABLE run_profiles_new RENAME TO run_profiles;
      PRAGMA foreign_keys = ON;
    `);
  } catch { /* ignore — may already be done */ }
}

function runMigrations(db: Database.Database) {
  let initializeEnhancedFollowups = false;
  try {
    const columns = db.prepare("PRAGMA table_info(workflow_steps)").all() as Array<{ name: string }>;
    initializeEnhancedFollowups = !columns.some((column) => column.name === "email_delivery_mode");
  } catch { /* table is created by initDb before migrations run */ }
  // Add columns introduced after initial schema — safe to run on existing DBs
  const migrations = [
    "ALTER TABLE targets ADD COLUMN degree INTEGER",
    "ALTER TABLE targets ADD COLUMN connection_requested_at TEXT",
    "ALTER TABLE targets ADD COLUMN connected_at TEXT",
    "ALTER TABLE targets ADD COLUMN message_sent_at TEXT",
    "ALTER TABLE targets ADD COLUMN last_replied_at TEXT",
    "ALTER TABLE targets ADD COLUMN linkedin_member_urn TEXT",
    "ALTER TABLE targets ADD COLUMN sales_nav_url TEXT",
    "ALTER TABLE lists ADD COLUMN sales_nav_url TEXT",
    "ALTER TABLE accounts ADD COLUMN inbox_synced_at TEXT",
    "ALTER TABLE accounts ADD COLUMN active_hours_start INTEGER DEFAULT 9",
    "ALTER TABLE accounts ADD COLUMN active_hours_end INTEGER DEFAULT 18",
    "ALTER TABLE accounts ADD COLUMN timezone TEXT DEFAULT 'UTC'",
    "ALTER TABLE accounts ADD COLUMN working_days TEXT DEFAULT '1,2,3,4,5'",
    "ALTER TABLE workflow_steps ADD COLUMN connect_note TEXT",
    "ALTER TABLE workflow_steps ADD COLUMN message_body TEXT",
    "ALTER TABLE targets ADD COLUMN headline TEXT",
    "ALTER TABLE targets ADD COLUMN summary TEXT",
    "ALTER TABLE accounts ADD COLUMN accepted_sync_at TEXT",
    // Messaging identity (fsd_profile URN, "urn:li:fsd_profile:ACoAA...") — the
    // form the messaging GraphQL API returns. It is NOT convertible to the
    // numeric urn:li:member we store elsewhere, so we capture it on first reply
    // (matched by name) and then join by it directly on every later sync.
    "ALTER TABLE targets ADD COLUMN messaging_urn TEXT",
    "CREATE INDEX IF NOT EXISTS idx_targets_messaging_urn ON targets(messaging_urn)",
    // Boundary for the incremental connections sync: the createdAt of the newest
    // connection seen last run. NULL = never synced (first run does a full pass).
    "ALTER TABLE accounts ADD COLUMN connections_synced_through_ms INTEGER",
    "ALTER TABLE accounts ADD COLUMN li_connections INTEGER",
    "ALTER TABLE accounts ADD COLUMN li_pending INTEGER",
    "ALTER TABLE accounts ADD COLUMN li_profile_views INTEGER",
    "ALTER TABLE accounts ADD COLUMN li_stats_synced_at TEXT",
    `CREATE TABLE IF NOT EXISTS workflow_step_templates (
      step_id TEXT REFERENCES workflow_steps(id) ON DELETE CASCADE,
      template_id TEXT REFERENCES templates(id) ON DELETE CASCADE,
      PRIMARY KEY (step_id, template_id)
    )`,
    // Extended lead data from salesApiLeadSearch
    "ALTER TABLE targets ADD COLUMN object_urn TEXT",
    "ALTER TABLE targets ADD COLUMN open_link INTEGER DEFAULT 0",
    "ALTER TABLE targets ADD COLUMN company_industry TEXT",
    "ALTER TABLE targets ADD COLUMN company_location TEXT",
    "ALTER TABLE targets ADD COLUMN tenure_months INTEGER",
    "ALTER TABLE targets ADD COLUMN spotlight_badges TEXT",
    // Profile enrichment — populated by visiting their Sales Nav profile page
    "ALTER TABLE targets ADD COLUMN positions_json TEXT",
    "ALTER TABLE targets ADD COLUMN skills_json TEXT",
    "ALTER TABLE targets ADD COLUMN enriched_profile_at TEXT",
    // Email outreach fields
    "ALTER TABLE targets ADD COLUMN email TEXT",
    "ALTER TABLE targets ADD COLUMN email_replied_at TEXT",
    "ALTER TABLE targets ADD COLUMN company_id TEXT",
    // Email account on runs (nullable — only needed when workflow has email steps)
    "ALTER TABLE runs ADD COLUMN email_account_id TEXT REFERENCES email_accounts(id)",
    // Workflow step email fields
    "ALTER TABLE workflow_steps ADD COLUMN email_subject TEXT",
    "ALTER TABLE workflow_steps ADD COLUMN email_body TEXT",
    // Apollo enrichment fields
    "ALTER TABLE targets ADD COLUMN apollo_id TEXT",
    "ALTER TABLE targets ADD COLUMN seniority TEXT",
    "ALTER TABLE targets ADD COLUMN apollo_functions TEXT",
    "ALTER TABLE targets ADD COLUMN company_description TEXT",
    "ALTER TABLE targets ADD COLUMN company_size INTEGER",
    "ALTER TABLE targets ADD COLUMN apollo_enriched_at TEXT",
    "ALTER TABLE targets ADD COLUMN email_status TEXT",
    // Manual fields
    "ALTER TABLE targets ADD COLUMN notes TEXT",
    // Apollo extra person fields
    "ALTER TABLE targets ADD COLUMN city TEXT",
    "ALTER TABLE targets ADD COLUMN country TEXT",
    "ALTER TABLE targets ADD COLUMN time_zone TEXT",
    "ALTER TABLE targets ADD COLUMN apollo_departments TEXT",
    // Apollo extra company fields on companies table
    "ALTER TABLE companies ADD COLUMN founded_year INTEGER",
    "ALTER TABLE companies ADD COLUMN logo_url TEXT",
    "ALTER TABLE companies ADD COLUMN phone TEXT",
    "ALTER TABLE companies ADD COLUMN annual_revenue TEXT",
    "ALTER TABLE companies ADD COLUMN technology_names TEXT",
    "ALTER TABLE companies ADD COLUMN keywords TEXT",
    "ALTER TABLE companies ADD COLUMN city TEXT",
    "ALTER TABLE companies ADD COLUMN country TEXT",
    // Email signature
    "ALTER TABLE email_accounts ADD COLUMN signature TEXT",
    // Reply-To override — if set, outgoing emails include Reply-To header
    "ALTER TABLE email_accounts ADD COLUMN reply_to TEXT",
    // Ramp-up: start slow and increase sending volume over time
    "ALTER TABLE email_accounts ADD COLUMN ramp_up_enabled INTEGER DEFAULT 1",
    "ALTER TABLE email_accounts ADD COLUMN ramp_start_date TEXT",
    // Company description and employee count moved from targets to companies
    "ALTER TABLE companies ADD COLUMN description TEXT",
    "ALTER TABLE companies ADD COLUMN employee_count INTEGER",
    // AI agent columns on workflow steps
    "ALTER TABLE workflow_steps ADD COLUMN ai_enabled INTEGER DEFAULT 0",
    "ALTER TABLE workflow_steps ADD COLUMN ai_model TEXT",
    "ALTER TABLE workflow_steps ADD COLUMN ai_prompt TEXT",
    "ALTER TABLE workflow_steps ADD COLUMN ai_max_words INTEGER",
    // Email step position — which followup number (1 = cold email, 2 = first followup, etc.)
    "ALTER TABLE workflow_steps ADD COLUMN email_position INTEGER DEFAULT 1",
    // Agent default model (stored on agent_config)
    "ALTER TABLE agent_config ADD COLUMN default_model TEXT",
    // Email threading — store sent email message-id for reply threading (future use)
    "ALTER TABLE run_profiles ADD COLUMN last_email_subject TEXT",
    "ALTER TABLE run_profiles ADD COLUMN last_email_body TEXT",
    // LinkedIn message follow-up tracking
    "ALTER TABLE workflow_steps ADD COLUMN message_position INTEGER DEFAULT 1",
    "ALTER TABLE run_profiles ADD COLUMN last_linkedin_message TEXT",
    // Language for AI-generated content per step
    "ALTER TABLE workflow_steps ADD COLUMN ai_language TEXT DEFAULT 'English'",
    // Campaign-level prompt — per-workflow AI context (USP, persona, tone for this campaign)
    "ALTER TABLE workflows ADD COLUMN prompt TEXT",
    // Email domain invalid flag on companies — set when a bounce is detected for any contact at this company
    "ALTER TABLE companies ADD COLUMN email_domain_invalid INTEGER DEFAULT 0",
    // Apollo extra person fields
    "ALTER TABLE targets ADD COLUMN email_domain_catchall INTEGER DEFAULT 0",
    // Per-profile email account assignment (multi-account routing)
    "ALTER TABLE run_profiles ADD COLUMN email_account_id TEXT",
    // Backfill: copy email_account_id from runs → run_profiles for existing records
    `UPDATE run_profiles SET email_account_id = (SELECT email_account_id FROM runs WHERE runs.id = run_profiles.run_id) WHERE email_account_id IS NULL`,
    // Import job progress tracking
    `CREATE TABLE IF NOT EXISTS list_imports (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      phase TEXT,
      page INTEGER DEFAULT 0,
      total_pages INTEGER DEFAULT 0,
      count INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      imported INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    )`,
    // Parallel tracks: add track column to workflow_steps
    "ALTER TABLE workflow_steps ADD COLUMN track TEXT NOT NULL DEFAULT 'linkedin' CHECK(track IN ('linkedin', 'email'))",
    // Parallel tracks: create run_profile_tracks table
    `CREATE TABLE IF NOT EXISTS run_profile_tracks (
      id TEXT PRIMARY KEY,
      run_profile_id TEXT NOT NULL REFERENCES run_profiles(id) ON DELETE CASCADE,
      track TEXT NOT NULL CHECK(track IN ('linkedin', 'email')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
      current_step INTEGER NOT NULL DEFAULT 0,
      last_step_at TEXT,
      next_step_at TEXT,
      error_message TEXT,
      last_email_subject TEXT,
      last_email_body TEXT,
      last_linkedin_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_profile_id, track)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_run_profile_tracks_run_profile_id ON run_profile_tracks(run_profile_id)",
    "CREATE INDEX IF NOT EXISTS idx_run_profile_tracks_state_next ON run_profile_tracks(state, next_step_at)",
    // Drop deprecated columns from run_profiles — all consumers now read from run_profile_tracks
    // SQLite does not support DROP COLUMN directly before 3.35; handled via table rebuild below
    // Separate IMAP credentials for custom mail providers where SMTP ≠ IMAP auth
    "ALTER TABLE email_accounts ADD COLUMN imap_username TEXT",
    "ALTER TABLE email_accounts ADD COLUMN imap_password TEXT",
    "ALTER TABLE workflows ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0",
    // Per-step signature override for email steps (null = use email account default)
    "ALTER TABLE workflow_steps ADD COLUMN email_signature TEXT",
    // Per-email delivery controls. The first email defaults to plain text; users can
    // opt follow-ups into HTML links and first-party open/click tracking.
    "ALTER TABLE workflow_steps ADD COLUMN email_delivery_mode TEXT NOT NULL DEFAULT 'plain' CHECK(email_delivery_mode IN ('plain','enhanced'))",
    "ALTER TABLE workflow_steps ADD COLUMN email_track_opens INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE workflow_steps ADD COLUMN email_track_clicks INTEGER NOT NULL DEFAULT 0",
    // CRM: todos per contact
    `CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'done')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "CREATE INDEX IF NOT EXISTS idx_todos_target_id ON todos(target_id)",
    "CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status)",
    "ALTER TABLE todos ADD COLUMN description TEXT",
    // CRM: activity log per contact
    `CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'note' CHECK(type IN ('call', 'email', 'meeting', 'note', 'other')),
      body TEXT NOT NULL,
      logged_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "CREATE INDEX IF NOT EXISTS idx_activity_logs_target_id ON activity_logs(target_id)",
    // Reply classifier: captured email replies + classifier verdict + dispatcher result
    `CREATE TABLE IF NOT EXISTS email_replies (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      from_email TEXT NOT NULL,
      subject TEXT,
      body_text TEXT NOT NULL,
      received_at TEXT NOT NULL,
      classified_at TEXT,
      classification_json TEXT,
      classification_error TEXT,
      dispatched_at TEXT,
      dispatch_result_json TEXT,
      manually_edited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "CREATE INDEX IF NOT EXISTS idx_email_replies_target_id ON email_replies(target_id)",
    "CREATE INDEX IF NOT EXISTS idx_email_replies_dispatched_at ON email_replies(dispatched_at)",
    // Reply classifier verdict stamped on the target — enables reply-rate-by-kind metrics
    "ALTER TABLE targets ADD COLUMN reply_kind TEXT",
    "ALTER TABLE targets ADD COLUMN inmail_sent_at TEXT",
    "ALTER TABLE targets ADD COLUMN posts_json TEXT",        // recent posts from visit_profile
    "ALTER TABLE targets ADD COLUMN posts_scraped_at TEXT",
    // One-shot OOO reply context for the AI follow-up writer — set by the dispatcher,
    // read + cleared by the runner on the next email send. Distinct from last_email_body
    // (which holds the last email WE sent, used for follow-up threading).
    "ALTER TABLE run_profile_tracks ADD COLUMN pending_reply_context TEXT",
    // Removed the in-app chat agent (replaced by the hosted MCP endpoint at /api/mcp) — drop its tables.
    "DROP TABLE IF EXISTS chat_messages",
    "DROP TABLE IF EXISTS chat_sessions",
    // Batched/scheduled imports — split large lists across days under a daily cap.
    "ALTER TABLE list_imports ADD COLUMN account_id TEXT",
    "ALTER TABLE list_imports ADD COLUMN sales_nav_url TEXT",
    "ALTER TABLE list_imports ADD COLUMN scheduled_for TEXT",      // 'YYYY-MM-DD'; NULL = run now
    "ALTER TABLE list_imports ADD COLUMN start_page INTEGER DEFAULT 1",
    "ALTER TABLE list_imports ADD COLUMN cap INTEGER",             // max contacts for this batch
    "ALTER TABLE list_imports ADD COLUMN cancel_requested INTEGER DEFAULT 0",
    "ALTER TABLE list_imports ADD COLUMN batch_index INTEGER DEFAULT 1",
    "ALTER TABLE list_imports ADD COLUMN enrich INTEGER DEFAULT 0",
    "CREATE INDEX IF NOT EXISTS idx_list_imports_scheduled ON list_imports(status, scheduled_for)",
    // Simple app-wide key/value settings (e.g. daily_import_cap)
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // Sales Nav InMail gets its own daily budget — separate from daily_message_limit,
    // since InMail (non-connections) and regular messages (connections) were being
    // gated off the same counter, starving one whenever the other was busy.
    "ALTER TABLE accounts ADD COLUMN daily_inmail_limit INTEGER DEFAULT 15",
    // Sales Nav search: persistent cache of resolved filter values (typeahead
    // ids). Dedup on (filter_type, id) — LinkedIn ids are stable (e.g. Berlin's
    // geoUrn never changes), so once resolved a value is reused forever with no
    // further live typeahead calls. Lives here (not ee/) per the open-core rule:
    // all migrations stay in lib/db.ts. Consumed only by the ee/ search feature.
    `CREATE TABLE IF NOT EXISTS search_filter_cache (
      id            TEXT NOT NULL,
      filter_type   TEXT NOT NULL,
      display_value TEXT NOT NULL,
      headline      TEXT,
      query         TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (filter_type, id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_sfc_type_query ON search_filter_cache(filter_type, query)",
    "CREATE INDEX IF NOT EXISTS idx_sfc_type_display ON search_filter_cache(filter_type, display_value)",
    // CSV import: lists can be flagged as linkedin- or email-only, so the runner/UI
    // can warn before enrolling a purpose-mismatched list into a campaign.
    "ALTER TABLE lists ADD COLUMN purpose TEXT",
    // Manual/CSV-only field — no automation reads or writes this, reference data only.
    "ALTER TABLE targets ADD COLUMN phone TEXT",
    // Multi-tenant workspace and RBAC foundation. Existing data is assigned to the
    // deterministic legacy workspace; new signups receive an isolated workspace.
    `CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','manager','member','viewer')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_invitations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','manager','member','viewer')),
      token_hash TEXT NOT NULL UNIQUE,
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      expires_at TEXT NOT NULL,
      accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      last_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "CREATE INDEX IF NOT EXISTS idx_workspace_invites_pending ON workspace_invitations(workspace_id, email, accepted_at, revoked_at, expires_at)",
    `CREATE TABLE IF NOT EXISTS workspace_ai_config (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      default_model TEXT, system_prompt TEXT, user_prompt TEXT, email_examples TEXT, linkedin_examples TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `INSERT OR IGNORE INTO workspaces (id, name, slug)
      VALUES ('00000000-0000-4000-8000-000000000001', 'Legacy workspace', 'legacy-workspace')`,
    `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
      SELECT '00000000-0000-4000-8000-000000000001', id, 'owner' FROM users`,
    `INSERT OR IGNORE INTO workspace_ai_config (workspace_id,default_model,system_prompt,user_prompt,email_examples,linkedin_examples)
      SELECT '00000000-0000-4000-8000-000000000001',default_model,system_prompt,user_prompt,email_examples,linkedin_examples FROM agent_config WHERE id=1`,
    "ALTER TABLE accounts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE targets ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE companies ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE lists ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE templates ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE workflows ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE runs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE email_accounts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE integrations ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE todos ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE activity_logs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE email_replies ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE agent_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE targets ADD COLUMN owner_id TEXT REFERENCES users(id)",
    "ALTER TABLE targets ADD COLUMN intent_score REAL NOT NULL DEFAULT 0",
    "UPDATE accounts SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL",
    "UPDATE targets SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL",
    "UPDATE companies SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL",
    "UPDATE lists SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL",
    "UPDATE templates SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL",
    "UPDATE workflows SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL",
    "UPDATE runs SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL",
    "UPDATE email_accounts SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL",
    "UPDATE integrations SET workspace_id = '00000000-0000-4000-8000-000000000001' WHERE workspace_id IS NULL",
    "UPDATE todos SET workspace_id = COALESCE((SELECT workspace_id FROM targets WHERE targets.id = todos.target_id), '00000000-0000-4000-8000-000000000001') WHERE workspace_id IS NULL",
    "UPDATE activity_logs SET workspace_id = COALESCE((SELECT workspace_id FROM targets WHERE targets.id = activity_logs.target_id), '00000000-0000-4000-8000-000000000001') WHERE workspace_id IS NULL",
    "UPDATE email_replies SET workspace_id = COALESCE((SELECT workspace_id FROM targets WHERE targets.id = email_replies.target_id), '00000000-0000-4000-8000-000000000001') WHERE workspace_id IS NULL",
    // Audit, API keys, suppression and custom CRM data.
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
      metadata_json TEXT, ip_address TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
      scopes TEXT NOT NULL, created_by TEXT, last_used_at TEXT, expires_at TEXT,
      revoked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS suppressions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('email','domain','linkedin','phone')),
      value TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'manual', source TEXT,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(workspace_id, kind, value)
    )`,
    `CREATE TABLE IF NOT EXISTS custom_field_definitions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, key TEXT NOT NULL, field_type TEXT NOT NULL DEFAULT 'text',
      options_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id, key)
    )`,
    `CREATE TABLE IF NOT EXISTS contact_custom_values (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
      value_text TEXT, value_number REAL, value_boolean INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (target_id, field_id)
    )`,
    // Conditional workflow graph layered over the existing ordered steps.
    `CREATE TABLE IF NOT EXISTS workflow_branches (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      source_step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
      conditions_json TEXT NOT NULL, true_step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
      false_step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(source_step_id)
    )`,
    // Durable event outbox and signed webhook delivery state.
    `CREATE TABLE IF NOT EXISTS domain_events (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL, entity_type TEXT, entity_id TEXT, payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')), processed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      url TEXT NOT NULL, secret TEXT NOT NULL, event_types TEXT NOT NULL DEFAULT '*',
      enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
      endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')), response_status INTEGER,
      response_body TEXT, last_error TEXT, delivered_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(event_id, endpoint_id)
    )`,
    // Deliverability diagnostics, placement tests and reciprocal mailbox warmup.
    `CREATE TABLE IF NOT EXISTS deliverability_checks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email_account_id TEXT REFERENCES email_accounts(id) ON DELETE CASCADE, domain TEXT NOT NULL,
      spf_status TEXT, dkim_status TEXT, dmarc_status TEXT, mx_status TEXT,
      score INTEGER NOT NULL DEFAULT 0, details_json TEXT, checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS inbox_placement_tests (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email_account_id TEXT REFERENCES email_accounts(id) ON DELETE CASCADE,
      seed_email TEXT NOT NULL, subject TEXT NOT NULL, message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', placement TEXT,
      sent_at TEXT, checked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS warmup_settings (
      email_account_id TEXT PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0, daily_target INTEGER NOT NULL DEFAULT 5,
      reply_rate INTEGER NOT NULL DEFAULT 60, started_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS warmup_messages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      from_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      to_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
      scheduled_at TEXT NOT NULL, sent_at TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // Durable mail plane: a job is created before any network call. A stale leased/sending
    // job becomes "uncertain" instead of being retried blindly, preventing duplicate sends
    // after a process dies between remote SMTP acceptance and the local commit.
    `CREATE TABLE IF NOT EXISTS email_jobs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'campaign',
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
      recipient TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL,
      email_delivery_mode TEXT NOT NULL DEFAULT 'plain' CHECK(email_delivery_mode IN ('plain','enhanced')),
      track_opens INTEGER NOT NULL DEFAULT 0, track_clicks INTEGER NOT NULL DEFAULT 0,
      reply_to_message_id TEXT, headers_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','sending','sent','failed','uncertain','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      available_at TEXT NOT NULL DEFAULT (datetime('now')), lease_owner TEXT, lease_expires_at TEXT,
      last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id,idempotency_key)
    )`,
    `CREATE TABLE IF NOT EXISTS sent_messages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL UNIQUE REFERENCES email_jobs(id) ON DELETE CASCADE,
      email_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      recipient TEXT NOT NULL, subject TEXT NOT NULL, message_id TEXT NOT NULL,
      provider_message_id TEXT, provider TEXT NOT NULL DEFAULT 'smtp', smtp_response TEXT,
      status TEXT NOT NULL DEFAULT 'accepted', accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT, bounced_at TEXT, complained_at TEXT, deferred_at TEXT,
      last_provider_event_at TEXT, UNIQUE(workspace_id,message_id)
    )`,
    `CREATE TABLE IF NOT EXISTS sender_events (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      sent_message_id TEXT REFERENCES sent_messages(id) ON DELETE SET NULL,
      provider TEXT NOT NULL, provider_event_id TEXT, event_type TEXT NOT NULL,
      recipient TEXT, message_id TEXT, payload_json TEXT,
      occurred_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider,provider_event_id)
    )`,
    `CREATE TABLE IF NOT EXISTS provider_webhook_receipts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, replay_key TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider,replay_key)
    )`,
    `CREATE TABLE IF NOT EXISTS mail_provider_connections (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('gmail','microsoft')),
      email TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT,
      expires_at TEXT, scopes TEXT, provider_account_id TEXT,
      watch_id TEXT, watch_expires_at TEXT, client_state TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, last_error TEXT, created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id,provider,email)
    )`,
    `CREATE TABLE IF NOT EXISTS mail_oauth_states (
      state_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL,
      redirect_after TEXT NOT NULL DEFAULT '/platform', expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS worker_leases (
      name TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "ALTER TABLE email_accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'smtp'",
    "ALTER TABLE email_jobs ADD COLUMN email_delivery_mode TEXT NOT NULL DEFAULT 'plain' CHECK(email_delivery_mode IN ('plain','enhanced'))",
    "ALTER TABLE email_jobs ADD COLUMN track_opens INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE email_jobs ADD COLUMN track_clicks INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE email_accounts ADD COLUMN oauth_connection_id TEXT REFERENCES mail_provider_connections(id)",
    "ALTER TABLE email_accounts ADD COLUMN allow_self_signed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE email_accounts ADD COLUMN paused_at TEXT",
    "ALTER TABLE email_accounts ADD COLUMN paused_reason TEXT",
    "ALTER TABLE email_accounts ADD COLUMN bounce_threshold REAL NOT NULL DEFAULT 0.03",
    "ALTER TABLE email_accounts ADD COLUMN complaint_threshold REAL NOT NULL DEFAULT 0.001",
    "ALTER TABLE email_accounts ADD COLUMN min_health_sample INTEGER NOT NULL DEFAULT 50",
    "ALTER TABLE email_accounts ADD COLUMN last_idle_at TEXT",
    "ALTER TABLE accounts ADD COLUMN proxy_url TEXT",
    "ALTER TABLE accounts ADD COLUMN proxy_username TEXT",
    "ALTER TABLE accounts ADD COLUMN proxy_password TEXT",
    "ALTER TABLE warmup_messages ADD COLUMN message_id TEXT",
    "ALTER TABLE warmup_messages ADD COLUMN replied_at TEXT",
    "ALTER TABLE warmup_messages ADD COLUMN engaged_at TEXT",
    "ALTER TABLE warmup_messages ADD COLUMN rescued_at TEXT",
    "CREATE INDEX IF NOT EXISTS idx_email_jobs_ready ON email_jobs(status,available_at,lease_expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_sent_messages_provider ON sent_messages(provider,provider_message_id)",
    "CREATE INDEX IF NOT EXISTS idx_sent_messages_message_id ON sent_messages(workspace_id,message_id)",
    "CREATE INDEX IF NOT EXISTS idx_sender_events_health ON sender_events(email_account_id,event_type,occurred_at)",
    // CRM/calendar sync, pipeline attribution and intent signals.
    `CREATE TABLE IF NOT EXISTS external_connections (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('hubspot','salesforce','ical','google_calendar','microsoft_calendar')),
      name TEXT NOT NULL, config_json TEXT NOT NULL, secret_value TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, last_synced_at TEXT, sync_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS external_sync_records (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES external_connections(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL, local_id TEXT NOT NULL, external_id TEXT,
      direction TEXT NOT NULL DEFAULT 'outbound', status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT, error TEXT, synced_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(connection_id, entity_type, local_id)
    )`,
    `CREATE TABLE IF NOT EXISTS pipeline_stages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, probability INTEGER NOT NULL DEFAULT 0,
      is_won INTEGER NOT NULL DEFAULT 0, is_lost INTEGER NOT NULL DEFAULT 0
    )`,
    `WITH defaults(suffix,name,position,probability,is_won,is_lost) AS (VALUES
      ('new','New',0,10,0,0),('qualified','Qualified',1,30,0,0),('meeting','Meeting',2,50,0,0),
      ('proposal','Proposal',3,75,0,0),('won','Won',4,100,1,0),('lost','Lost',5,0,0,1))
      INSERT INTO pipeline_stages (id,workspace_id,name,position,probability,is_won,is_lost)
      SELECT w.id || ':stage:' || d.suffix,w.id,d.name,d.position,d.probability,d.is_won,d.is_lost
      FROM workspaces w CROSS JOIN defaults d WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages ps WHERE ps.workspace_id=w.id)`,
    `CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      stage_id TEXT REFERENCES pipeline_stages(id) ON DELETE SET NULL, owner_id TEXT REFERENCES users(id),
      name TEXT NOT NULL, amount REAL, currency TEXT NOT NULL DEFAULT 'USD', expected_close_date TEXT,
      source TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      connection_id TEXT REFERENCES external_connections(id) ON DELETE SET NULL,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
      external_id TEXT, title TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT,
      attendees_json TEXT, status TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id) ON DELETE CASCADE, company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('job_change','funding','hiring','technology','product_intent','custom')),
      title TEXT NOT NULL, description TEXT, score REAL NOT NULL DEFAULT 0, source TEXT,
      occurred_at TEXT NOT NULL, metadata_json TEXT, processed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS signal_rules (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, signal_type TEXT NOT NULL, min_score REAL NOT NULL DEFAULT 0,
      list_id TEXT REFERENCES lists(id) ON DELETE SET NULL, workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "ALTER TABLE signal_rules ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0",
    // Collaborative inbox state.
    "ALTER TABLE email_replies ADD COLUMN assigned_to TEXT REFERENCES users(id)",
    "ALTER TABLE email_replies ADD COLUMN inbox_status TEXT NOT NULL DEFAULT 'open'",
    "ALTER TABLE email_replies ADD COLUMN sentiment TEXT",
    "ALTER TABLE email_replies ADD COLUMN sla_due_at TEXT",
    "ALTER TABLE email_replies ADD COLUMN locked_by TEXT REFERENCES users(id)",
    "ALTER TABLE email_replies ADD COLUMN locked_at TEXT",
    `CREATE TABLE IF NOT EXISTS inbox_tags (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#64748b', UNIQUE(workspace_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS email_reply_tags (
      reply_id TEXT NOT NULL REFERENCES email_replies(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES inbox_tags(id) ON DELETE CASCADE, PRIMARY KEY(reply_id, tag_id)
    )`,
    `CREATE TABLE IF NOT EXISTS saved_replies (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, body TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "CREATE INDEX IF NOT EXISTS idx_suppressions_lookup ON suppressions(workspace_id, kind, value)",
    "CREATE INDEX IF NOT EXISTS idx_events_pending ON domain_events(processed_at, occurred_at)",
    "CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending ON webhook_deliveries(status, next_attempt_at)",
    "CREATE INDEX IF NOT EXISTS idx_signals_target ON signals(workspace_id, target_id, occurred_at)",
    "CREATE INDEX IF NOT EXISTS idx_replies_team ON email_replies(workspace_id, inbox_status, assigned_to, sla_due_at)",
    // MCP OAuth 2.1 audience binding and refresh-token expiry.
    "ALTER TABLE oauth_auth_codes ADD COLUMN resource TEXT",
    "ALTER TABLE oauth_auth_codes ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE oauth_tokens ADD COLUMN resource TEXT",
    "ALTER TABLE oauth_tokens ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "ALTER TABLE oauth_tokens ADD COLUMN refresh_expires_at TEXT",
    // MCP calls are auditable independently from campaign logs.
    `CREATE TABLE IF NOT EXISTS mcp_audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_json TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "ALTER TABLE mcp_audit_logs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    "CREATE INDEX IF NOT EXISTS idx_mcp_audit_created ON mcp_audit_logs(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_mcp_audit_client ON mcp_audit_logs(client_id)",
    // Email warmup is on by default: give every verified sender a ramp-up start date
    // and an enabled warmup profile if it doesn't already have one. Accounts the user
    // later disables keep their row (enabled=0), so INSERT OR IGNORE won't re-enable them.
    "UPDATE email_accounts SET ramp_start_date = COALESCE(ramp_start_date, date(created_at), date('now')) WHERE ramp_start_date IS NULL",
    "UPDATE email_accounts SET ramp_up_enabled = 1 WHERE ramp_up_enabled IS NULL",
    "INSERT OR IGNORE INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate, started_at, updated_at) SELECT id, workspace_id, 1, 5, 60, datetime('now'), datetime('now') FROM email_accounts WHERE is_verified = 1",
    // Store which sender inbox a reply belongs to, so the inbox thread viewer + reply
    // composer work even for replies outside a campaign run. Backfill from the run,
    // else from the most recent email we sent that contact.
    "ALTER TABLE email_replies ADD COLUMN email_account_id TEXT REFERENCES email_accounts(id)",
    "UPDATE email_replies SET email_account_id = (SELECT r.email_account_id FROM runs r WHERE r.id = email_replies.run_id) WHERE email_account_id IS NULL AND run_id IS NOT NULL",
    "UPDATE email_replies SET email_account_id = (SELECT ej.email_account_id FROM email_jobs ej WHERE ej.target_id = email_replies.target_id AND ej.status = 'sent' ORDER BY ej.created_at DESC LIMIT 1) WHERE email_account_id IS NULL",
    // When a contact's email was last verified. NULL = never checked.
    "ALTER TABLE targets ADD COLUMN email_verified_at TEXT",
    // Set when a user queues a contact for verification; the background runner clears it as it processes.
    "ALTER TABLE targets ADD COLUMN email_verify_requested_at TEXT",
    // Tracks one-time data cleanups (see below) so they don't re-run on every boot.
    "CREATE TABLE IF NOT EXISTS _migration_flags (key TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  if (initializeEnhancedFollowups) {
    try {
      db.exec("UPDATE workflow_steps SET email_delivery_mode='enhanced', email_track_opens=1, email_track_clicks=1 WHERE step_type='email' AND COALESCE(email_position,1) > 1");
    } catch { /* no existing follow-ups */ }
  }

  // One-time: an earlier email verifier over-suppressed contacts — it treated transient DNS
  // errors as "no MX" and any 5xx as "no mailbox". Release those, reset their status, and let
  // the corrected verifier re-check them. Guarded so it runs exactly once.
  try {
    const done = db.prepare("SELECT 1 FROM _migration_flags WHERE key = 'clear_bad_verification_suppressions_v1'").get();
    if (!done) {
      db.exec(`
        UPDATE targets SET email_status = NULL, email_verified_at = NULL
          WHERE email_status = 'invalid' AND id IN (SELECT target_id FROM suppressions WHERE source = 'verification');
        DELETE FROM suppressions WHERE source = 'verification';
        INSERT INTO _migration_flags (key) VALUES ('clear_bad_verification_suppressions_v1');
      `);
    }
  } catch { /* suppressions/targets not present yet */ }

  // integrations was historically keyed globally by provider name. Rebuild it with a
  // workspace/provider composite key so tenants can configure independent credentials.
  try {
    const info = db.prepare("PRAGMA table_info(integrations)").all() as Array<{ name: string; pk: number }>;
    if (info.find((c) => c.name === "key")?.pk === 1) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE integrations_workspace (
          key TEXT NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          api_key TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (workspace_id, key)
        );
        INSERT INTO integrations_workspace (key, workspace_id, api_key, created_at, updated_at)
          SELECT key, COALESCE(workspace_id, '00000000-0000-4000-8000-000000000001'), api_key, created_at, updated_at FROM integrations;
        DROP TABLE integrations;
        ALTER TABLE integrations_workspace RENAME TO integrations;
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch { /* already migrated */ }

  // Parallel tracks: assign email steps to email track, re-number step_order, backfill run_profile_tracks
  runParallelTracksMigration(db);
  // Drop deprecated run_profiles columns (state, current_step, etc.) — consumers now read track-runs
  dropDeprecatedRunProfileColumns(db);

  // Migrate workflow_steps CHECK constraint to allow 'delay' and 'email' step_types
  try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_steps'").get() as { sql: string } | undefined;
    if (tableInfo && (!tableInfo.sql.includes("'delay'") || !tableInfo.sql.includes("'email'"))) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE workflow_steps_new (
          id TEXT PRIMARY KEY,
          workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
          step_order INTEGER NOT NULL,
          step_type TEXT NOT NULL CHECK(step_type IN ('visit', 'connect', 'message', 'delay', 'email')),
          template_id TEXT REFERENCES templates(id),
          delay_seconds INTEGER DEFAULT 0,
          connect_note TEXT,
          message_body TEXT,
          email_subject TEXT,
          email_body TEXT,
          enabled INTEGER DEFAULT 1,
          email_delivery_mode TEXT NOT NULL DEFAULT 'plain' CHECK(email_delivery_mode IN ('plain','enhanced')),
          email_track_opens INTEGER NOT NULL DEFAULT 0,
          email_track_clicks INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO workflow_steps_new
          (id, workflow_id, step_order, step_type, template_id, delay_seconds,
           connect_note, message_body, email_subject, email_body, enabled)
          SELECT id, workflow_id, step_order, step_type, template_id, delay_seconds,
                 connect_note, message_body,
                 NULL, NULL,
                 enabled
          FROM workflow_steps;
        DROP TABLE workflow_steps;
        ALTER TABLE workflow_steps_new RENAME TO workflow_steps;
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch { /* migration already done */ }

  // Allow the 'sales_inmail' step_type (Sales Navigator InMail). Rebuilds the
  // table preserving EVERY current column (the historical rebuild above only
  // copied the original columns — do NOT reuse it). InMail reuses message_body
  // for the body and email_subject for the required subject.
  try {
    const ti = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_steps'").get() as { sql: string } | undefined;
    if (ti && !ti.sql.includes("'sales_inmail'")) {
      const cols = (db.prepare("PRAGMA table_info(workflow_steps)").all() as Array<{ name: string }>).map((c) => c.name);
      const colList = cols.join(", ");
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE workflow_steps_new (
          id TEXT PRIMARY KEY,
          workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
          step_order INTEGER NOT NULL,
          step_type TEXT NOT NULL CHECK(step_type IN ('visit', 'connect', 'message', 'sales_inmail', 'delay', 'email')),
          template_id TEXT REFERENCES templates(id),
          delay_seconds INTEGER DEFAULT 0,
          connect_note TEXT,
          message_body TEXT,
          email_subject TEXT,
          email_body TEXT,
          enabled INTEGER DEFAULT 1,
          ai_enabled INTEGER DEFAULT 0,
          ai_model TEXT,
          ai_prompt TEXT,
          ai_max_words INTEGER,
          email_position INTEGER DEFAULT 1,
          message_position INTEGER DEFAULT 1,
          ai_language TEXT DEFAULT 'English',
          track TEXT NOT NULL DEFAULT 'linkedin' CHECK(track IN ('linkedin', 'email')),
          email_signature TEXT,
          email_delivery_mode TEXT NOT NULL DEFAULT 'plain' CHECK(email_delivery_mode IN ('plain','enhanced')),
          email_track_opens INTEGER NOT NULL DEFAULT 0,
          email_track_clicks INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO workflow_steps_new (${colList}) SELECT ${colList} FROM workflow_steps;
        DROP TABLE workflow_steps;
        ALTER TABLE workflow_steps_new RENAME TO workflow_steps;
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch { /* migration already done */ }

  // CSV import: allow email-only targets (no LinkedIn URL). targets.linkedin_url was
  // NOT NULL UNIQUE from the base schema — rebuild to make it nullable (still UNIQUE,
  // SQLite allows multiple NULLs under UNIQUE) preserving EVERY current column, same
  // pattern as the sales_inmail rebuild above (do not reuse the older historical rebuilds
  // that only copied the original columns).
  try {
    const ti = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='targets'").get() as { sql: string } | undefined;
    if (ti && ti.sql.includes("linkedin_url TEXT NOT NULL")) {
      const cols = (db.prepare("PRAGMA table_info(targets)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>);
      const colDefs = cols.map((c) => {
        if (c.name === "linkedin_url") return "linkedin_url TEXT UNIQUE";
        if (c.name === "id") return "id TEXT PRIMARY KEY";
        const notnull = c.notnull ? " NOT NULL" : "";
        // Non-literal defaults (e.g. datetime('now')) must be parenthesized in SQLite DDL.
        const isLiteral = c.dflt_value === null || /^-?\d+(\.\d+)?$/.test(c.dflt_value) || /^'.*'$/.test(c.dflt_value);
        const dflt = c.dflt_value !== null ? ` DEFAULT ${isLiteral ? c.dflt_value : `(${c.dflt_value})`}` : "";
        return `${c.name} ${c.type}${notnull}${dflt}`;
      });
      const colList = cols.map((c) => c.name).join(", ");
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE targets_new (
          ${colDefs.join(",\n          ")}
        );
        INSERT INTO targets_new (${colList}) SELECT ${colList} FROM targets;
        DROP TABLE targets;
        ALTER TABLE targets_new RENAME TO targets;
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch { /* migration already done */ }

  // Multi-tenant contacts may legitimately share a LinkedIn profile URL across
  // isolated workspaces. Remove the historical global UNIQUE constraint and
  // replace it with a workspace-scoped partial unique index.
  try {
    const ti = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='targets'").get() as { sql: string } | undefined;
    if (ti && /linkedin_url\s+TEXT\s+UNIQUE/i.test(ti.sql)) {
      const cols = db.prepare("PRAGMA table_info(targets)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
      const colDefs = cols.map((c) => {
        if (c.name === "id") return "id TEXT PRIMARY KEY";
        const notnull = c.notnull ? " NOT NULL" : "";
        const isLiteral = c.dflt_value === null || /^-?\d+(\.\d+)?$/.test(c.dflt_value) || /^'.*'$/.test(c.dflt_value);
        const dflt = c.dflt_value !== null ? ` DEFAULT ${isLiteral ? c.dflt_value : `(${c.dflt_value})`}` : "";
        return `${c.name} ${c.type}${notnull}${dflt}`;
      });
      const colList = cols.map((c) => c.name).join(", ");
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE targets_workspace (${colDefs.join(",\n")});
        INSERT INTO targets_workspace (${colList}) SELECT ${colList} FROM targets;
        DROP TABLE targets;
        ALTER TABLE targets_workspace RENAME TO targets;
        PRAGMA foreign_keys = ON;
      `);
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_workspace_linkedin ON targets(workspace_id, linkedin_url) WHERE linkedin_url IS NOT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_targets_workspace_email ON targets(workspace_id, email)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_targets_messaging_urn ON targets(messaging_urn)");
  } catch { /* already workspace-scoped */ }

  // Backfill: move company_description and company_size from targets into companies
  try {
    db.exec(`
      UPDATE companies
      SET
        description = COALESCE(description, (
          SELECT t.company_description FROM targets t
          WHERE t.company_id = companies.id AND t.company_description IS NOT NULL
          LIMIT 1
        )),
        employee_count = COALESCE(employee_count, (
          SELECT t.company_size FROM targets t
          WHERE t.company_id = companies.id AND t.company_size IS NOT NULL
          LIMIT 1
        ))
      WHERE description IS NULL OR employee_count IS NULL
    `);
  } catch { /* ignore */ }

  // Backfill: for old records where linkedin_url is a Sales Nav URL, move it to sales_nav_url
  try {
    db.exec(`
      UPDATE targets
      SET sales_nav_url = linkedin_url
      WHERE linkedin_url LIKE '%/sales/lead/%' AND (sales_nav_url IS NULL OR sales_nav_url = '')
    `);
  } catch { /* ignore */ }

  // Create unique index on run_profiles if not already present (idempotent)
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_run_profiles_unique ON run_profiles(run_id, target_id);");
  } catch { /* ignore */ }

  encryptLegacySecretsMigration(db);
}

// One-time (per-row) migration: encrypt any plaintext accounts.cookies_json,
// email_accounts.password/imap_password, integrations.api_key left over from before
// encryption-at-rest was added. isEncrypted() lets this run safely on every boot — already
//-encrypted rows (real "v1:" ciphertext) are skipped, so this is idempotent and cheap once
// migrated. See lib/crypto.ts for the format and lib/premium.ts-style boundary notes.
function encryptLegacySecretsMigration(db: Database.Database) {
  const accounts = db.prepare("SELECT id, cookies_json FROM accounts WHERE cookies_json IS NOT NULL").all() as
    { id: string; cookies_json: string }[];
  for (const row of accounts) {
    if (isEncrypted(row.cookies_json)) continue;
    db.prepare("UPDATE accounts SET cookies_json = ? WHERE id = ?").run(encryptSecret(row.cookies_json), row.id);
  }

  const emailAccounts = db
    .prepare("SELECT id, password, imap_password FROM email_accounts")
    .all() as { id: string; password: string; imap_password: string | null }[];
  for (const row of emailAccounts) {
    const needsPassword = !isEncrypted(row.password);
    const needsImapPassword = row.imap_password !== null && !isEncrypted(row.imap_password);
    if (!needsPassword && !needsImapPassword) continue;
    db.prepare("UPDATE email_accounts SET password = ?, imap_password = ? WHERE id = ?").run(
      needsPassword ? encryptSecret(row.password) : row.password,
      needsImapPassword ? encryptSecret(row.imap_password!) : row.imap_password,
      row.id
    );
  }

  const integrations = db.prepare("SELECT key, api_key FROM integrations WHERE api_key IS NOT NULL").all() as
    { key: string; api_key: string }[];
  for (const row of integrations) {
    if (isEncrypted(row.api_key)) continue;
    db.prepare("UPDATE integrations SET api_key = ? WHERE key = ?").run(encryptSecret(row.api_key), row.key);
  }
}

function initDb(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      cookies_json TEXT,
      is_authenticated INTEGER DEFAULT 0,
      daily_connection_limit INTEGER DEFAULT 20,
      daily_message_limit INTEGER DEFAULT 50,
      daily_inmail_limit INTEGER DEFAULT 15,
      active_hours_start INTEGER DEFAULT 9,
      active_hours_end INTEGER DEFAULT 18,
      timezone TEXT DEFAULT 'UTC',
      working_days TEXT DEFAULT '1,2,3,4,5',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS targets (
      id TEXT PRIMARY KEY,
      linkedin_url TEXT UNIQUE,
      sales_nav_url TEXT,
      first_name TEXT,
      last_name TEXT,
      full_name TEXT,
      title TEXT,
      company TEXT,
      location TEXT,
      profile_image_url TEXT,
      degree INTEGER,
      connection_requested_at TEXT,
      connected_at TEXT,
      message_sent_at TEXT,
      last_replied_at TEXT,
      linkedin_member_urn TEXT,
      enriched_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      sales_nav_url TEXT,
      purpose TEXT CHECK(purpose IN ('linkedin', 'email')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS list_targets (
      list_id TEXT REFERENCES lists(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id) ON DELETE CASCADE,
      PRIMARY KEY (list_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      step_type TEXT NOT NULL CHECK(step_type IN ('visit', 'connect', 'message', 'delay')),
      template_id TEXT REFERENCES templates(id),
      delay_seconds INTEGER DEFAULT 0,
      connect_note TEXT,
      message_body TEXT,
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS workflow_step_templates (
      step_id TEXT REFERENCES workflow_steps(id) ON DELETE CASCADE,
      template_id TEXT REFERENCES templates(id) ON DELETE CASCADE,
      PRIMARY KEY (step_id, template_id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT REFERENCES workflows(id),
      list_id TEXT REFERENCES lists(id),
      account_id TEXT REFERENCES accounts(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'paused', 'completed', 'failed')),
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      runner_pid INTEGER
    );

    CREATE TABLE IF NOT EXISTS run_profiles (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id),
      state TEXT DEFAULT 'pending' CHECK(state IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
      current_step INTEGER DEFAULT 0,
      last_step_at TEXT,
      next_step_at TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(run_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id),
      level TEXT DEFAULT 'info' CHECK(level IN ('info', 'warn', 'error')),
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT,
      industry TEXT,
      location TEXT,
      linkedin_url TEXT,
      website TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS integrations (
      key TEXT PRIMARY KEY,
      api_key TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      system_prompt TEXT,
      user_prompt TEXT,
      email_examples TEXT,
      linkedin_examples TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      target_id TEXT,
      step_id TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      prompt TEXT,
      generated_text TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Hosted MCP OAuth 2.1 server: clients (DCR), single-use auth codes, access/refresh tokens.
    -- Tokens/codes are stored only as sha256 hashes. Reuses NEXTAUTH user identity.
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT,
      redirect_uris TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS oauth_auth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scope TEXT,
      resource TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id TEXT PRIMARY KEY,
      access_hash TEXT NOT NULL UNIQUE,
      refresh_hash TEXT UNIQUE,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scope TEXT,
      resource TEXT,
      expires_at TEXT NOT NULL,
      refresh_expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_json TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      from_email TEXT NOT NULL,
      from_name TEXT,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER DEFAULT 587,
      smtp_secure INTEGER DEFAULT 0,
      imap_host TEXT,
      imap_port INTEGER DEFAULT 993,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      daily_email_limit INTEGER DEFAULT 50,
      active_hours_start INTEGER DEFAULT 9,
      active_hours_end INTEGER DEFAULT 18,
      timezone TEXT DEFAULT 'UTC',
      working_days TEXT DEFAULT '1,2,3,4,5',
      is_verified INTEGER DEFAULT 0,
      inbox_synced_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}
