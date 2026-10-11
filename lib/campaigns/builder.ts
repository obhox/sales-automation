// Everything the sequence builder shows for one campaign, read in one go: the campaign, its
// published sequence and what is happening on it, the draft someone is working on, what
// each step has sent, and the things a step can refer to (templates, lists, custom fields,
// senders).
import type DatabaseType from "better-sqlite3";
import { campaignSummaries, type CampaignSummary } from "@/lib/campaigns/summary";
import { getDraft, sequenceOverview, type SequenceDraft, type SequenceOverview } from "@/lib/outreach/publish";
import { premium } from "@/lib/premium";
import { campaignBreakdown, type BreakdownRow } from "@/lib/reporting/breakdown";
import { parseRange, type ReportRange } from "@/lib/reporting/range";
import { roleAtLeast, type WorkspaceRole } from "@/lib/roles";
import { listTemplates, type Template } from "@/lib/templates/library";

type DB = DatabaseType.Database;

export type StepFigures = Pick<BreakdownRow, "sent" | "contacts" | "opened" | "clicked" | "replied" | "bounced" | "requests" | "accepted">;
export interface VersionFigures extends StepFigures {
  /** Null is the step's own text, version A. */
  variant_id: string | null;
  paused: boolean;
}

export interface BuilderData {
  campaign: CampaignSummary;
  sequence: SequenceOverview;
  draft: { sequence: SequenceDraft; updated_at: string; updated_by: string | null; updated_by_name: string | null; stale: boolean } | null;
  figures: { steps: Record<string, StepFigures>; versions: Record<string, VersionFigures[]> };
  templates: Template[];
  lists: Array<{ id: string; name: string }>;
  custom_fields: Array<{ key: string; name: string }>;
  mailboxes: Array<{ id: string; name: string; email: string }>;
  linkedin_accounts: Array<{ id: string; name: string }>;
  ai: { available: boolean; default_model: string | null; has_key: boolean };
  /** A few contacts to preview the sequence as: the campaign's own first, else any in the workspace. */
  sample_contacts: Array<{ id: string; name: string; title: string | null; company: string | null }>;
  /** Whether this person may make the draft the running sequence right now. */
  can_publish: boolean;
}

const figuresOf = (row: BreakdownRow): StepFigures => ({
  sent: row.sent, contacts: row.contacts, opened: row.opened, clicked: row.clicked, replied: row.replied, bounced: row.bounced, requests: row.requests, accepted: row.accepted,
});

/**
 * Who may publish: a member while nobody is part-way through the sequence, a manager once
 * contacts are in flight. Changing what a running campaign does next is the same kind of
 * decision as pausing it.
 */
export function canPublish(role: WorkspaceRole, inFlight: number): boolean {
  return roleAtLeast(role, inFlight > 0 ? "manager" : "member");
}

/** Null when the campaign is not in this workspace. */
export function builderData(db: DB, workspaceId: string, workflowId: string, role: WorkspaceRole): BuilderData | null {
  const campaign = campaignSummaries(db, workspaceId).find((candidate) => candidate.id === workflowId);
  if (!campaign) return null;
  const sequence = sequenceOverview(db, workflowId);
  const stored = getDraft(db, workflowId);
  const allTime = parseRange({}) as ReportRange;

  const steps: BuilderData["figures"]["steps"] = {};
  for (const row of campaignBreakdown(db, workflowId, "step", allTime).rows) {
    if (!row.key.startsWith("action:")) steps[row.key] = figuresOf(row);
  }
  const versions: BuilderData["figures"]["versions"] = {};
  for (const row of campaignBreakdown(db, workflowId, "variant", allTime).rows) {
    if (row.step_id) (versions[row.step_id] ??= []).push({ ...figuresOf(row), variant_id: row.variant_id ?? null, paused: Boolean(row.paused) });
  }

  const sample = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as BuilderData["sample_contacts"];
  const CONTACT = "t.id, COALESCE(NULLIF(t.full_name, ''), TRIM(COALESCE(t.first_name, '') || ' ' || COALESCE(t.last_name, ''))) AS name, t.title, t.company";
  let sampleContacts = sample(
    `SELECT DISTINCT ${CONTACT} FROM run_profiles rp JOIN runs r ON r.id = rp.run_id JOIN targets t ON t.id = rp.target_id
     WHERE r.workflow_id = ? AND t.workspace_id = ? ORDER BY rp.created_at LIMIT 8`, workflowId, workspaceId);
  if (sampleContacts.length === 0) sampleContacts = sample(`SELECT ${CONTACT} FROM targets t WHERE t.workspace_id = ? ORDER BY t.created_at DESC LIMIT 8`, workspaceId);

  const aiConfig = db.prepare("SELECT default_model FROM workspace_ai_config WHERE workspace_id = ?").get(workspaceId) as { default_model: string | null } | undefined;
  const aiKey = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(workspaceId) as { api_key: string | null } | undefined;

  return {
    campaign,
    sequence,
    draft: stored ? {
      sequence: stored.draft, updated_at: stored.updated_at, updated_by: stored.updated_by, stale: stored.base_version !== sequence.version,
      updated_by_name: stored.updated_by ? (db.prepare("SELECT COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE id = ?").get(stored.updated_by) as { name: string } | undefined)?.name ?? null : null,
    } : null,
    figures: { steps, versions },
    templates: listTemplates(db, workspaceId),
    lists: db.prepare("SELECT id, name FROM lists WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(workspaceId) as BuilderData["lists"],
    custom_fields: db.prepare("SELECT key, name FROM custom_field_definitions WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(workspaceId) as BuilderData["custom_fields"],
    mailboxes: db.prepare("SELECT id, COALESCE(NULLIF(from_name, ''), name) AS name, from_email AS email FROM email_accounts WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(workspaceId) as BuilderData["mailboxes"],
    linkedin_accounts: db.prepare("SELECT id, name FROM accounts WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(workspaceId) as BuilderData["linkedin_accounts"],
    ai: { available: Boolean(premium.ai), default_model: aiConfig?.default_model ?? null, has_key: Boolean(aiKey?.api_key) },
    sample_contacts: sampleContacts,
    can_publish: canPublish(role, sequence.in_flight),
  };
}
