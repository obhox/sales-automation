// The Settings tab of a campaign: its name and owner, when it sends, who it sends from,
// who it leaves out, what it tracks. Changes to senders reach the run in flight; the
// rest is what the campaign uses from then on.
import type DatabaseType from "better-sqlite3";
import { campaignSpamChoice, saveSpamChoice, setWorkspaceSpamDefault, spamChoiceProblem, workspaceSpamDefault, type SpamMode } from "@/lib/campaigns/spam-filter";
import { isSpamMode } from "@/lib/email/spam-check";
import { saveSetup, setupOf, setupProblem, type CampaignSetup } from "@/lib/campaigns/setup";
import { changeRunAccountPool, checkAccountPool, runAccountPool, runRotation, workflowTracks, type PoolChange } from "@/lib/outreach/enroll";
import { roleAtLeast, type WorkspaceRole } from "@/lib/roles";

type DB = DatabaseType.Database;

export interface EmailTracking {
  step_id: string;
  /** "Email 2": which email of the sequence this is. */
  email_number: number;
  subject: string;
  opens: boolean;
  clicks: boolean;
}

export interface CampaignSettings {
  name: string;
  description: string | null;
  owner_id: string | null;
  send_in_recipient_tz: boolean;
  ab_auto_promote: boolean;
  /** What the campaign does about spam wording in its emails; "inherit" follows the workspace. */
  spam_filter: "inherit" | SpamMode;
  /** The workspace's own choice, which a campaign set to "inherit" follows. */
  spam_filter_default: SpamMode;
  archived: boolean;
  channels: Array<"linkedin" | "email">;
  setup: Pick<CampaignSetup, "list_id" | "exclude" | "account_ids" | "rotation" | "email_account_ids" | "overlap">;
  tracking: EmailTracking[];
  /** The run a change of senders reaches, with the contacts part-way through it. */
  run: { id: string; status: string; in_flight: number } | null;
  /** Contacts the campaign has ever enrolled: what deleting it would take with it. */
  enrolled: number;
  /** Signal rules that enrol contacts in this campaign as signals come in. */
  signal_rules: Array<{ id: string; name: string; signal_type: string; min_score: number; enabled: boolean; auto_start: boolean }>;
}

export interface SettingsChange {
  name?: unknown;
  description?: unknown;
  owner_id?: unknown;
  send_in_recipient_tz?: unknown;
  ab_auto_promote?: unknown;
  spam_filter?: unknown;
  /** Changes the workspace's default, not this campaign: an admin's. */
  spam_filter_default?: unknown;
  setup?: unknown;
  tracking?: unknown;
}

const liveRun = (db: DB, workspaceId: string, workflowId: string) => db.prepare(
  `SELECT r.id, r.status, (SELECT COUNT(DISTINCT rp.id) FROM run_profiles rp JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id WHERE rp.run_id = r.id AND rt.state IN ('pending', 'in_progress')) AS in_flight
   FROM runs r WHERE r.workflow_id = ? AND r.workspace_id = ? AND r.status IN ('running', 'paused') ORDER BY r.status = 'running' DESC, datetime(r.created_at) DESC, r.rowid DESC LIMIT 1`,
).get(workflowId, workspaceId) as { id: string; status: string; in_flight: number } | undefined;

/** The LinkedIn accounts a run is using: its pool, or the one account of a run that has no pool. */
function poolOf(db: DB, runId: string): string[] {
  const pool = runAccountPool(db, runId);
  if (pool.length > 0) return pool;
  const own = (db.prepare("SELECT account_id FROM runs WHERE id = ?").get(runId) as { account_id: string | null } | undefined)?.account_id;
  return own ? [own] : [];
}

export function campaignSettings(db: DB, workspaceId: string, workflowId: string): CampaignSettings | null {
  const row = db.prepare("SELECT name, description, owner_id, send_in_recipient_tz, ab_auto_promote, is_archived FROM workflows WHERE id = ? AND workspace_id = ?").get(workflowId, workspaceId) as
    | { name: string; description: string | null; owner_id: string | null; send_in_recipient_tz: number | null; ab_auto_promote: number | null; is_archived: number | null } | undefined;
  if (!row) return null;
  const setup = setupOf(db, workflowId);
  const run = liveRun(db, workspaceId, workflowId) ?? null;
  const emails = db.prepare("SELECT id, email_subject, email_track_opens, email_track_clicks FROM workflow_steps WHERE workflow_id = ? AND step_type = 'email' ORDER BY step_order").all(workflowId) as
    Array<{ id: string; email_subject: string | null; email_track_opens: number | null; email_track_clicks: number | null }>;
  return {
    name: row.name, description: row.description, owner_id: row.owner_id,
    send_in_recipient_tz: Boolean(row.send_in_recipient_tz), ab_auto_promote: row.ab_auto_promote === 1, archived: Boolean(row.is_archived),
    spam_filter: campaignSpamChoice(db, workflowId) ?? "inherit", spam_filter_default: workspaceSpamDefault(db, workspaceId),
    channels: workflowTracks(db, workflowId) as CampaignSettings["channels"],
    // What the run in flight is really using, where there is one: the setup is only what it was launched with.
    setup: {
      list_id: setup.list_id, exclude: setup.exclude, overlap: setup.overlap, email_account_ids: setup.email_account_ids,
      account_ids: run && poolOf(db, run.id).length > 0 ? poolOf(db, run.id) : setup.account_ids,
      rotation: run ? runRotation(db, run.id) : setup.rotation,
    },
    tracking: emails.map((step, index) => ({ step_id: step.id, email_number: index + 1, subject: step.email_subject ?? "", opens: step.email_track_opens === 1, clicks: step.email_track_clicks === 1 })),
    run,
    enrolled: (db.prepare("SELECT COUNT(*) AS c FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE r.workflow_id = ? AND r.workspace_id = ?").get(workflowId, workspaceId) as { c: number }).c,
    signal_rules: (db.prepare("SELECT id, name, signal_type, min_score, enabled, auto_start FROM signal_rules WHERE workflow_id = ? AND workspace_id = ? ORDER BY enabled DESC, created_at").all(workflowId, workspaceId) as
      Array<{ id: string; name: string; signal_type: string; min_score: number | null; enabled: number; auto_start: number }>)
      .map((rule) => ({ id: rule.id, name: rule.name, signal_type: rule.signal_type, min_score: rule.min_score ?? 0, enabled: rule.enabled === 1, auto_start: rule.auto_start === 1 })),
  };
}

/** The parts of a change that alter how the campaign sends, as against what it is called. */
const SENDING_KEYS = ["send_in_recipient_tz", "ab_auto_promote", "spam_filter", "setup", "tracking"] as const;

/**
 * Whether this role may make this change. Anyone who can edit campaigns can rename one or
 * hand it to someone; changing how a campaign sends while contacts are part-way through
 * it is a manager's call, as publishing its sequence is.
 */
export function mayChange(role: WorkspaceRole, change: SettingsChange, inFlight: number): boolean {
  const sending = SENDING_KEYS.some((key) => change[key] !== undefined);
  return roleAtLeast(role, sending && inFlight > 0 ? "manager" : "member");
}

/** Why this change cannot be kept, or null. */
export function settingsProblem(db: DB, workspaceId: string, workflowId: string, change: SettingsChange): string | null {
  if (change.name !== undefined && (typeof change.name !== "string" || !change.name.trim())) return "A campaign needs a name";
  if (change.description != null && typeof change.description !== "string") return "description must be text";
  if (change.owner_id != null) {
    if (typeof change.owner_id !== "string") return "owner_id must be a member's id";
    if (!db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(workspaceId, change.owner_id)) return "The owner must be a member of this workspace";
  }
  if (change.spam_filter !== undefined) {
    const spam = spamChoiceProblem(change.spam_filter);
    if (spam) return spam;
  }
  if (change.spam_filter_default !== undefined && !isSpamMode(change.spam_filter_default)) return "spam_filter_default must be off, flag or remove";
  const setup = setupProblem(db, workspaceId, change.setup);
  if (setup) return setup;
  const picked = change.setup as Partial<CampaignSetup> | undefined;
  const channels = workflowTracks(db, workflowId);
  if (picked?.account_ids !== undefined) {
    const pool = checkAccountPool(db, workspaceId, picked.account_ids);
    if (!Array.isArray(pool)) return pool.error;
    if (pool.length === 0 && channels.includes("linkedin") && liveRun(db, workspaceId, workflowId)) return "A running campaign with LinkedIn steps needs at least one LinkedIn account";
  }
  if (change.tracking !== undefined) {
    if (!Array.isArray(change.tracking)) return "tracking must be a list of { step_id, opens, clicks }";
    for (const entry of change.tracking as Array<Record<string, unknown>>) {
      if (!entry || typeof entry !== "object" || typeof entry.step_id !== "string") return "tracking must be a list of { step_id, opens, clicks }";
      if (!db.prepare("SELECT 1 FROM workflow_steps WHERE id = ? AND workflow_id = ? AND step_type = 'email'").get(entry.step_id, workflowId)) return "tracking names a step that is not one of this campaign's emails";
    }
  }
  return null;
}

/**
 * Keep a change; what is left out stays as it was. Validate with settingsProblem() first.
 * A change of LinkedIn accounts is applied to the run in flight as well, and `pool` says
 * what that did.
 */
export function saveSettings(db: DB, workspaceId: string, workflowId: string, change: SettingsChange): { pool: PoolChange | null } {
  let pool: PoolChange | null = null;
  db.transaction(() => {
    if (typeof change.name === "string") db.prepare("UPDATE workflows SET name = ? WHERE id = ?").run(change.name.trim().slice(0, 160), workflowId);
    if (change.description !== undefined) db.prepare("UPDATE workflows SET description = ? WHERE id = ?").run(typeof change.description === "string" && change.description.trim() ? change.description.trim().slice(0, 500) : null, workflowId);
    if (change.owner_id !== undefined) db.prepare("UPDATE workflows SET owner_id = ? WHERE id = ?").run(change.owner_id || null, workflowId);
    if (change.send_in_recipient_tz !== undefined) db.prepare("UPDATE workflows SET send_in_recipient_tz = ? WHERE id = ?").run(change.send_in_recipient_tz ? 1 : 0, workflowId);
    if (change.ab_auto_promote !== undefined) db.prepare("UPDATE workflows SET ab_auto_promote = ? WHERE id = ?").run(change.ab_auto_promote ? 1 : 0, workflowId);
    if (change.spam_filter !== undefined) saveSpamChoice(db, workflowId, change.spam_filter);
    if (isSpamMode(change.spam_filter_default)) setWorkspaceSpamDefault(db, workspaceId, change.spam_filter_default);

    if (change.setup) {
      const next = saveSetup(db, workflowId, change.setup as Partial<CampaignSetup>);
      const picked = change.setup as Partial<CampaignSetup>;
      const run = liveRun(db, workspaceId, workflowId);
      const changesPool = picked.account_ids !== undefined || picked.rotation !== undefined;
      if (run && changesPool && next.account_ids.length > 0 && workflowTracks(db, workflowId).includes("linkedin")) {
        // How a pool is shared out only means something with two accounts or more.
        const same = JSON.stringify(poolOf(db, run.id)) === JSON.stringify(next.account_ids) && (next.account_ids.length < 2 || runRotation(db, run.id) === next.rotation);
        if (!same) pool = changeRunAccountPool(db, run.id, next.account_ids, next.rotation);
      }
    }

    if (Array.isArray(change.tracking)) {
      // Tracking needs the email sent as HTML: there is nowhere in plain text to put a pixel or a rewritten link.
      const set = db.prepare(
        "UPDATE workflow_steps SET email_track_opens = @opens, email_track_clicks = @clicks, email_delivery_mode = CASE WHEN @opens = 1 OR @clicks = 1 THEN 'enhanced' ELSE email_delivery_mode END WHERE id = @id AND workflow_id = @wf",
      );
      const wanted = new Map<string, { opens: number; clicks: number }>();
      for (const entry of change.tracking as Array<{ step_id: string; opens?: unknown; clicks?: unknown }>) {
        wanted.set(entry.step_id, { opens: entry.opens ? 1 : 0, clicks: entry.clicks ? 1 : 0 });
        set.run({ id: entry.step_id, wf: workflowId, opens: entry.opens ? 1 : 0, clicks: entry.clicks ? 1 : 0 });
      }
      // An unpublished draft of the sequence carries its own copy of each step; without this, publishing it would put the old tracking back.
      const draft = db.prepare("SELECT draft_json FROM workflow_drafts WHERE workflow_id = ?").get(workflowId) as { draft_json: string } | undefined;
      if (draft) {
        try {
          const stored = JSON.parse(draft.draft_json) as { steps?: Array<Record<string, unknown>> };
          let touched = false;
          for (const step of stored.steps ?? []) {
            const want = typeof step.id === "string" ? wanted.get(step.id) : undefined;
            if (!want) continue;
            step.email_track_opens = want.opens;
            step.email_track_clicks = want.clicks;
            if (want.opens || want.clicks) step.email_delivery_mode = "enhanced";
            touched = true;
          }
          if (touched) db.prepare("UPDATE workflow_drafts SET draft_json = ? WHERE workflow_id = ?").run(JSON.stringify(stored), workflowId);
        } catch { /* a draft that cannot be read is left alone */ }
      }
    }
  })();
  return { pool };
}
