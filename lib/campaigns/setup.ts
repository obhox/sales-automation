// Setting a campaign up: what the wizard has chosen so far (kept so it can be left and
// come back to), what there is to choose from, and whether the campaign is ready to launch.
import type DatabaseType from "better-sqlite3";
import { budgetState } from "@/lib/ai/usage";
import { decryptSecret } from "@/lib/crypto";
import { hasUnsubscribeTag, unsubscribeUrl } from "@/lib/email/content";
import { latestDomainChecks, listMailboxes } from "@/lib/email/mailbox-list";
import { aiContextOf, type AiContext } from "@/lib/campaigns/context";
import { linkedinAccountsOverview, type AccountStatus } from "@/lib/linkedin/account-list";
import { isLinkedinRotation, MAX_POOL_ACCOUNTS, workflowTracks, type LinkedinRotation } from "@/lib/outreach/enroll";
import { audienceFor, isOverlapChoice, type Audience, type Exclusions, type OverlapChoice } from "@/lib/outreach/launch";
import { premium } from "@/lib/premium";

type DB = DatabaseType.Database;

export const SETUP_STEPS = ["list", "context", "linkedin", "email", "senders", "summary"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface CampaignSetup {
  /** Where the wizard was left. */
  step: SetupStep;
  list_id: string | null;
  exclude: Exclusions;
  /** LinkedIn accounts to run from. Several are a pool. */
  account_ids: string[];
  rotation: LinkedinRotation;
  email_account_ids: string[];
  overlap: OverlapChoice;
}

export const DEFAULT_SETUP: CampaignSetup = {
  step: "list", list_id: null, exclude: { customers: true, open_deals: true }, account_ids: [], rotation: "round_robin", email_account_ids: [], overlap: "skip",
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))] : []);

function readSetup(json: string | null | undefined): CampaignSetup | null {
  try {
    const stored = JSON.parse(json ?? "null") as Partial<CampaignSetup> | null;
    if (!stored || typeof stored !== "object") return null;
    return {
      step: (SETUP_STEPS as readonly unknown[]).includes(stored.step) ? (stored.step as SetupStep) : "list",
      list_id: typeof stored.list_id === "string" && stored.list_id ? stored.list_id : null,
      exclude: { customers: stored.exclude?.customers !== false, open_deals: stored.exclude?.open_deals !== false },
      account_ids: strings(stored.account_ids),
      rotation: isLinkedinRotation(stored.rotation) ? stored.rotation : "round_robin",
      email_account_ids: strings(stored.email_account_ids),
      overlap: isOverlapChoice(stored.overlap) ? stored.overlap : "skip",
    };
  } catch {
    return null;
  }
}

/**
 * What a campaign is set up with. One that was launched before there was a wizard to
 * remember it has its last run to go by: the same list and the same senders.
 */
export function setupOf(db: DB, workflowId: string): CampaignSetup {
  const row = db.prepare("SELECT setup_json FROM workflows WHERE id = ?").get(workflowId) as { setup_json: string | null } | undefined;
  const stored = readSetup(row?.setup_json);
  if (stored) return stored;
  const run = db.prepare("SELECT id, list_id, account_id, linkedin_rotation FROM runs WHERE workflow_id = ? ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 1")
    .get(workflowId) as { id: string; list_id: string | null; account_id: string | null; linkedin_rotation: string | null } | undefined;
  if (!run) return { ...DEFAULT_SETUP, exclude: { ...DEFAULT_SETUP.exclude } };
  const pool = (db.prepare("SELECT account_id FROM run_accounts WHERE run_id = ? ORDER BY position").all(run.id) as { account_id: string }[]).map((entry) => entry.account_id);
  const mailboxes = (db.prepare("SELECT DISTINCT email_account_id AS id FROM run_profiles WHERE run_id = ? AND email_account_id IS NOT NULL").all(run.id) as { id: string }[]).map((entry) => entry.id);
  return {
    ...DEFAULT_SETUP, exclude: { customers: false, open_deals: false }, step: "summary", list_id: run.list_id,
    account_ids: pool.length ? pool : run.account_id ? [run.account_id] : [], rotation: isLinkedinRotation(run.linkedin_rotation) ? run.linkedin_rotation : "round_robin", email_account_ids: mailboxes,
  };
}

/** Why this change cannot be kept, or null. Everything named must belong to the workspace. */
export function setupProblem(db: DB, workspaceId: string, change: unknown): string | null {
  if (change == null) return null;
  if (typeof change !== "object") return "setup must be an object";
  const input = change as Record<string, unknown>;
  if (input.step !== undefined && !(SETUP_STEPS as readonly unknown[]).includes(input.step)) return `setup.step must be one of ${SETUP_STEPS.join(", ")}`;
  if (input.rotation !== undefined && !isLinkedinRotation(input.rotation)) return "setup.rotation must be round_robin or capacity";
  if (input.overlap !== undefined && !isOverlapChoice(input.overlap)) return "setup.overlap must be skip or take_over";
  if (input.exclude !== undefined && (input.exclude === null || typeof input.exclude !== "object")) return "setup.exclude must be an object";
  if (input.list_id != null && !db.prepare("SELECT 1 FROM lists WHERE id = ? AND workspace_id = ?").get(input.list_id, workspaceId)) return "That list is not in this workspace";
  for (const [key, table, noun] of [["account_ids", "accounts", "LinkedIn account"], ["email_account_ids", "email_accounts", "mailbox"]] as const) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || (input[key] as unknown[]).some((id) => typeof id !== "string")) return `setup.${key} must be a list of ids`;
    const ids = strings(input[key]);
    if (key === "account_ids" && ids.length > MAX_POOL_ACCOUNTS) return `A campaign can run from at most ${MAX_POOL_ACCOUNTS} LinkedIn accounts`;
    const found = ids.length === 0 ? 0 : (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE workspace_id = ? AND id IN (${ids.map(() => "?").join(",")})`).get(workspaceId, ...ids) as { c: number }).c;
    if (found !== ids.length) return `A ${noun} that was chosen is not in this workspace`;
  }
  return null;
}

/** Keep a change to the setup; what is left out stays as it was. Validate with setupProblem() first. */
export function saveSetup(db: DB, workflowId: string, change: Partial<CampaignSetup>): CampaignSetup {
  const current = setupOf(db, workflowId);
  const next = readSetup(JSON.stringify({ ...current, ...change, exclude: { ...current.exclude, ...(change.exclude ?? {}) } }))!;
  db.prepare("UPDATE workflows SET setup_json = ? WHERE id = ?").run(JSON.stringify(next), workflowId);
  return next;
}

// ── What there is to choose from ──────────────────────────────────────────────

export interface SetupOptions {
  lists: Array<{ id: string; name: string; contacts: number; with_email: number; verified_email: number }>;
  linkedin_accounts: Array<{ id: string; name: string; status: AccountStatus; usable: boolean; connections_per_day: number; messages_per_day: number; connections_left_today: number; warming_up: boolean }>;
  mailboxes: Array<{ id: string; name: string; email: string; usable: boolean; verified: boolean; paused: boolean; emails_per_day: number; warming_up: boolean; domain_checked: boolean; domain_ok: boolean }>;
}

const USABLE: AccountStatus[] = ["active", "warming_up", "weekly_hold"];

export function setupOptions(db: DB, workspaceId: string): SetupOptions {
  const lists = db.prepare(
    `SELECT l.id, l.name, COUNT(t.id) AS contacts,
       COALESCE(SUM(CASE WHEN t.email IS NOT NULL AND t.email != '' THEN 1 ELSE 0 END), 0) AS with_email,
       COALESCE(SUM(CASE WHEN t.email IS NOT NULL AND t.email != '' AND t.email_status = 'verified' THEN 1 ELSE 0 END), 0) AS verified_email
     FROM lists l LEFT JOIN list_targets lt ON lt.list_id = l.id LEFT JOIN targets t ON t.id = lt.target_id AND t.workspace_id = l.workspace_id
     WHERE l.workspace_id = ? GROUP BY l.id ORDER BY l.name COLLATE NOCASE`,
  ).all(workspaceId) as SetupOptions["lists"];

  const linkedin = linkedinAccountsOverview(db, workspaceId).accounts.map((account) => ({
    id: account.id, name: account.name, status: account.status, usable: USABLE.includes(account.status),
    connections_per_day: account.limits.connections, messages_per_day: account.limits.messages,
    connections_left_today: Math.max(0, account.limits.connections - account.usage.connects),
    warming_up: account.status === "warming_up",
  }));

  // The mailboxes as the Mailboxes screen knows them: the same status, the same limit for
  // today (less while one ramps up), the same latest check of each sending domain.
  const dns = latestDomainChecks(db, workspaceId);
  const mailboxes = listMailboxes(db, workspaceId).map((mailbox) => {
    const domain = dns.get(mailbox.domain);
    return {
      id: mailbox.id, name: mailbox.from_name || mailbox.name, email: mailbox.from_email,
      verified: mailbox.status !== "untested", paused: mailbox.status === "paused" || mailbox.status === "auto_paused" || mailbox.status === "disconnected",
      // At its limit for today is still a mailbox that sends: it carries on tomorrow.
      usable: mailbox.status === "active" || mailbox.status === "at_limit",
      emails_per_day: mailbox.sending.limit_today, warming_up: mailbox.sending.limit_today < mailbox.sending.limit_full,
      domain_checked: Boolean(domain?.checked_at), domain_ok: domain?.spf === "pass" && domain?.dkim === "pass",
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { lists, linkedin_accounts: linkedin, mailboxes };
}

// ── Ready to launch? ──────────────────────────────────────────────────────────

export interface Check {
  key: "sequence" | "audience" | "linkedin" | "mailboxes" | "ai" | "overlap";
  label: string;
  /** `block` stops a launch; `warn` is worth reading and does not. */
  state: "ok" | "warn" | "block";
  detail: string;
}

export interface CostEstimate {
  /** Steps that AI writes, and how many messages that comes to for this audience. */
  ai_steps: number;
  generations: number;
  /** From what this workspace's recent AI writing actually cost. Null when it has no history to go by. */
  per_generation_usd: number | null;
  total_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** How many past generations the estimate rests on. */
  sample: number;
  spent_this_month_usd: number;
  /** The workspace's monthly AI budget, or null when none is set. */
  budget_usd: number | null;
}

export interface Prelaunch {
  setup: CampaignSetup;
  ai: AiContext;
  tracks: string[];
  audience: Audience | null;
  list: { id: string; name: string } | null;
  checks: Check[];
  /** Nothing blocks a launch. */
  ready: boolean;
  capacity: { linkedin_accounts: number; invites_per_day: number; mailboxes: number; emails_per_day: number; warming_up: number };
  cost: CostEstimate;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function prelaunch(db: DB, workspaceId: string, workflowId: string): Prelaunch {
  const setup = setupOf(db, workflowId);
  const ai = aiContextOf(db, workflowId);
  const options = setupOptions(db, workspaceId);
  const tracks = workflowTracks(db, workflowId);
  const steps = db.prepare("SELECT track, step_type, message_body, email_subject, email_body, ai_enabled, ai_model, template_id, id FROM workflow_steps WHERE workflow_id = ? AND step_type != 'delay'")
    .all(workflowId) as Array<{ id: string; track: string; step_type: string; message_body: string | null; email_subject: string | null; email_body: string | null; ai_enabled: number | null; ai_model: string | null; template_id: string | null }>;
  const list = setup.list_id ? (db.prepare("SELECT id, name FROM lists WHERE id = ? AND workspace_id = ?").get(setup.list_id, workspaceId) as { id: string; name: string } | undefined) ?? null : null;
  const audience = list ? audienceFor(db, workspaceId, workflowId, list.id, { exclude: setup.exclude, overlap: setup.overlap }).audience : null;
  const checks: Check[] = [];

  // 1. The sequence itself.
  const pooled = new Set((db.prepare("SELECT DISTINCT st.step_id FROM workflow_step_templates st JOIN workflow_steps ws ON ws.id = st.step_id WHERE ws.workflow_id = ?").all(workflowId) as { step_id: string }[]).map((row) => row.step_id));
  const empty = steps.filter((step) => !step.ai_enabled && !pooled.has(step.id) && !step.template_id
    && ((step.step_type === "email" && !(step.email_body ?? "").trim()) || ((step.step_type === "message" || step.step_type === "sales_inmail") && !(step.message_body ?? "").trim())));
  const offersUnsubscribe = steps.some((step) => step.step_type === "email" && hasUnsubscribeTag(step.email_body ?? ""));
  const noPublicAddress = offersUnsubscribe && !unsubscribeUrl("00000000-0000-0000-0000-000000000000");
  checks.push(steps.length === 0
    ? { key: "sequence", label: "Sequence", state: "block", detail: "The campaign has no steps yet." }
    : noPublicAddress
      ? { key: "sequence", label: "Sequence", state: "block", detail: "An email uses {{unsubscribe}}, which needs the app's public address (EMAIL_TRACKING_BASE_URL). Until that is set those emails will not send." }
      : empty.length > 0
        ? { key: "sequence", label: "Sequence", state: "block", detail: `${count(empty.length, "step has", "steps have")} nothing to send yet.` }
        : { key: "sequence", label: "Sequence", state: "ok", detail: `${count(steps.length, "step", "steps")} on ${tracks.length === 2 ? "LinkedIn and email" : tracks[0] === "email" ? "email" : "LinkedIn"}.` });

  // 2. Someone to send it to.
  checks.push(!list
    ? { key: "audience", label: "Audience", state: "block", detail: "Choose the list to run the campaign on." }
    : audience!.enrol === 0
      ? { key: "audience", label: "Audience", state: "block", detail: audience!.total === 0 ? "The list is empty." : "Nobody in the list can be enrolled: everyone is already in this campaign, left out, or in another one." }
      : { key: "audience", label: "Audience", state: "ok", detail: `${count(audience!.enrol, "contact", "contacts")} will be enrolled${audience!.excluded > 0 ? `; ${audience!.excluded.toLocaleString("en-US")} left out as customers or open deals` : ""}.` });

  // 3. LinkedIn accounts to run its LinkedIn steps from.
  const chosenLinkedin = options.linkedin_accounts.filter((account) => setup.account_ids.includes(account.id));
  const usableLinkedin = chosenLinkedin.filter((account) => account.usable);
  if (!tracks.includes("linkedin")) checks.push({ key: "linkedin", label: "LinkedIn accounts", state: "ok", detail: "The campaign has no LinkedIn steps." });
  else if (chosenLinkedin.length === 0) checks.push({ key: "linkedin", label: "LinkedIn accounts", state: "block", detail: "Choose at least one LinkedIn account to run the LinkedIn steps from." });
  else if (usableLinkedin.length === 0) checks.push({ key: "linkedin", label: "LinkedIn accounts", state: "block", detail: "None of the chosen LinkedIn accounts can send right now: each is signed out or paused." });
  else if (usableLinkedin.length < chosenLinkedin.length) {
    checks.push({ key: "linkedin", label: "LinkedIn accounts", state: "warn", detail: `${count(chosenLinkedin.length - usableLinkedin.length, "account is", "accounts are")} signed out or paused. Their contacts wait until that is put right.` });
  } else checks.push({ key: "linkedin", label: "LinkedIn accounts", state: "ok", detail: `${count(usableLinkedin.length, "account", "accounts")} signed in and under ${usableLinkedin.length === 1 ? "its" : "their"} daily limits.` });

  // 4. Mailboxes for its emails.
  const chosenMailboxes = options.mailboxes.filter((mailbox) => setup.email_account_ids.includes(mailbox.id));
  const usableMailboxes = chosenMailboxes.filter((mailbox) => mailbox.usable);
  const weakDomains = usableMailboxes.filter((mailbox) => mailbox.domain_checked && !mailbox.domain_ok);
  const unchecked = usableMailboxes.filter((mailbox) => !mailbox.domain_checked);
  if (!tracks.includes("email")) checks.push({ key: "mailboxes", label: "Mailboxes", state: "ok", detail: "The campaign has no email steps." });
  else if (chosenMailboxes.length === 0) checks.push({ key: "mailboxes", label: "Mailboxes", state: "block", detail: "Choose at least one mailbox to send the emails from." });
  else if (usableMailboxes.length === 0) checks.push({ key: "mailboxes", label: "Mailboxes", state: "block", detail: "None of the chosen mailboxes can send right now: each is unverified or paused." });
  else if (usableMailboxes.length < chosenMailboxes.length) checks.push({ key: "mailboxes", label: "Mailboxes", state: "warn", detail: `${count(chosenMailboxes.length - usableMailboxes.length, "mailbox is", "mailboxes are")} unverified or paused and will not send.` });
  else if (weakDomains.length > 0) checks.push({ key: "mailboxes", label: "Mailboxes", state: "warn", detail: `SPF or DKIM is not passing for ${count(weakDomains.length, "mailbox", "mailboxes")}. Mail from ${weakDomains.length === 1 ? "it" : "them"} is more likely to land in spam.` });
  else if (unchecked.length > 0) checks.push({ key: "mailboxes", label: "Mailboxes", state: "warn", detail: `${count(unchecked.length, "mailbox has", "mailboxes have")} never had SPF and DKIM checked. Run a check under Deliverability.` });
  else checks.push({ key: "mailboxes", label: "Mailboxes", state: "ok", detail: `${count(usableMailboxes.length, "mailbox", "mailboxes")} verified, with SPF and DKIM passing.` });

  // 5. The AI writer, when a step uses it.
  const aiSteps = steps.filter((step) => step.ai_enabled);
  const hasKey = Boolean(decryptSecret((db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter' AND workspace_id = ?").get(workspaceId) as { api_key: string | null } | undefined)?.api_key ?? null));
  const defaultModel = (db.prepare("SELECT default_model FROM workspace_ai_config WHERE workspace_id = ?").get(workspaceId) as { default_model: string | null } | undefined)?.default_model ?? null;
  const withoutModel = aiSteps.filter((step) => !(step.ai_model || ai.model || defaultModel));
  if (aiSteps.length === 0) checks.push({ key: "ai", label: "AI writer", state: "ok", detail: "No step is written by AI." });
  else if (!premium.ai) checks.push({ key: "ai", label: "AI writer", state: "block", detail: "The AI writer is not part of this build, so its steps would be skipped." });
  else if (!hasKey) checks.push({ key: "ai", label: "AI writer", state: "block", detail: "Steps are written by AI, and no OpenRouter key is set. They would be skipped." });
  else if (withoutModel.length > 0) checks.push({ key: "ai", label: "AI writer", state: "block", detail: `${count(withoutModel.length, "AI step has", "AI steps have")} no model: choose one for the campaign or a default under AI & models.` });
  else checks.push({ key: "ai", label: "AI writer", state: "ok", detail: `${count(aiSteps.length, "step", "steps")} written by ${ai.model || defaultModel || "each step's own model"}.` });

  // 6. Contacts who are in the middle of another campaign.
  const overlapping = audience?.overlapping ?? 0;
  checks.push(overlapping === 0
    ? { key: "overlap", label: "Other campaigns", state: "ok", detail: "Nobody in the audience is part-way through another campaign." }
    : { key: "overlap", label: "Other campaigns", state: "warn", detail: setup.overlap === "take_over"
        ? `${count(overlapping, "contact is", "contacts are")} part-way through another campaign. Their steps there will be held until they are done here.`
        : `${count(overlapping, "contact is", "contacts are")} part-way through another campaign and will be skipped.` });

  // What the AI writing is likely to cost, from what it has cost here before.
  const history = db.prepare(
    `SELECT COUNT(*) AS n, AVG(cost_usd) AS cost, AVG(input_tokens) AS input, AVG(output_tokens) AS output FROM (
       SELECT cost_usd, input_tokens, output_tokens FROM agent_sessions WHERE workspace_id = ? AND cost_usd IS NOT NULL AND step_id IS NOT NULL ORDER BY datetime(created_at) DESC LIMIT 200)`,
  ).get(workspaceId) as { n: number; cost: number | null; input: number | null; output: number | null };
  const budget = budgetState(workspaceId);
  const enrol = audience?.enrol ?? 0;
  const generations = aiSteps.reduce((sum, step) => sum + (step.track === "email" ? audience?.with_email ?? 0 : enrol), 0);
  const perGeneration = history.n > 0 ? history.cost : null;
  const cost: CostEstimate = {
    ai_steps: aiSteps.length, generations,
    per_generation_usd: perGeneration,
    total_usd: perGeneration === null ? null : Math.round(perGeneration * generations * 100) / 100,
    input_tokens: history.n > 0 && history.input !== null ? Math.round(history.input * generations) : null,
    output_tokens: history.n > 0 && history.output !== null ? Math.round(history.output * generations) : null,
    sample: history.n,
    spent_this_month_usd: Math.round(budget.spent_usd * 100) / 100,
    budget_usd: budget.budget_usd,
  };
  // The writer stops when the month's budget is used up: say so before the launch, not after.
  const aiCheck = checks.find((entry) => entry.key === "ai")!;
  if (aiSteps.length > 0 && aiCheck.state === "ok" && budget.budget_usd !== null) {
    const left = budget.budget_usd - budget.spent_usd;
    if (budget.reached) Object.assign(aiCheck, { state: "warn", detail: "This month's AI budget is used up. Steps written by AI will wait until it is raised or the month turns." });
    else if (cost.total_usd !== null && cost.total_usd > left) Object.assign(aiCheck, { state: "warn", detail: `The AI writing is estimated at $${cost.total_usd.toFixed(2)}, and $${Math.max(0, left).toFixed(2)} is left of this month's budget. Steps written by AI wait once it runs out.` });
  }

  return {
    setup, ai, tracks, audience, list, checks,
    ready: checks.every((check) => check.state !== "block"),
    capacity: {
      linkedin_accounts: usableLinkedin.length, invites_per_day: usableLinkedin.reduce((sum, account) => sum + account.connections_per_day, 0),
      mailboxes: usableMailboxes.length, emails_per_day: usableMailboxes.reduce((sum, mailbox) => sum + mailbox.emails_per_day, 0),
      warming_up: usableLinkedin.filter((account) => account.warming_up).length + usableMailboxes.filter((mailbox) => mailbox.warming_up).length,
    },
    cost,
  };
}
