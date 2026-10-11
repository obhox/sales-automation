// What the Team & roles screen knows and how it words it. No React in here, so the wording
// can be tested.
import type { AuditEntry, AuditSource } from "@/lib/audit";
import { ROLE_LABEL, ROLE_LEVEL, isWorkspaceRole, type WorkspaceRole } from "@/lib/roles";
import type { TeamMember } from "@/lib/team";
import type { AuditPage } from "@/pages/api/platform/audit";
import type { TeamOverview } from "@/pages/api/platform/members";
import { formatDate, formatRelative, parseTime, plural } from "@/lib/client/format";
import type { Tone } from "@/components/ui";

export type { AuditEntry, AuditPage, AuditSource, TeamMember, TeamOverview, WorkspaceRole };
export type Invitation = TeamOverview["invitations"][number];

export const TEAM_PATH = "/api/platform/members";
export const AUDIT_PATH = "/api/platform/audit";

// ── People ────────────────────────────────────────────────────────────────────

/** A row of the members table: someone in the workspace, or someone invited to it. */
export type PersonRow =
  | { kind: "member"; key: string; member: TeamMember; you: boolean }
  | { kind: "invitation"; key: string; invitation: Invitation };

/** Members first, as the server orders them, then invitations, newest first. Narrowed by what was typed and by role. */
export function personRows(overview: TeamOverview, search: string, role: WorkspaceRole | "all"): PersonRow[] {
  const needle = search.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const members: PersonRow[] = overview.members
    .filter((member) => (role === "all" || member.role === role) && matches(`${member.name} ${member.email}`))
    .map((member) => ({ kind: "member", key: `m:${member.id}`, member, you: member.id === overview.you }));
  const invitations: PersonRow[] = overview.invitations
    .filter((invitation) => (role === "all" || invitation.role === role) && matches(invitation.email))
    .map((invitation) => ({ kind: "invitation", key: `i:${invitation.id}`, invitation }));
  return [...members, ...invitations];
}

export interface Badge {
  tone: Tone;
  label: string;
}

export function statusBadge(row: PersonRow): Badge {
  if (row.kind === "invitation") return row.invitation.status === "expired" ? { tone: "neutral", label: "Invitation ran out" } : { tone: "warn", label: "Invited" };
  return row.member.suspended ? { tone: "bad", label: "Suspended" } : { tone: "good", label: "Active" };
}

const ACTIVE_NOW_MS = 5 * 60_000;

/** "Active now", "12 minutes ago", "Yesterday 18:40", "3 days ago". */
export function lastActive(value: string | null, now: Date = new Date()): string {
  const date = parseTime(value);
  if (!date) return "Not yet";
  const ms = now.getTime() - date.getTime();
  if (ms < ACTIVE_NOW_MS) return "Active now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  const startOfDay = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `${hours} ${plural(hours, "hour", "hours")} ago`;
  if (days === 1) return `Yesterday ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  if (days < 60) return `${days} days ago`;
  return formatDate(date, now);
}

/** What the "last active" column says for a row. */
export function activityLine(row: PersonRow, now: Date = new Date()): string {
  if (row.kind === "member") return lastActive(row.member.last_active_at, now);
  // "Invited", not "sent": an invitation can be made as a link alone, with no email.
  const invited = row.invitation.last_sent_at ?? row.invitation.created_at;
  return row.invitation.status === "expired" ? `Ran out ${formatRelative(row.invitation.expires_at, now)}` : `Invited ${formatRelative(invited, now)}`;
}

/** "Acme Growth · 6 members, 1 pending invite". */
export function teamSummary(overview: TeamOverview): string {
  const members = overview.members.length;
  const waiting = overview.invitations.filter((invitation) => invitation.status === "pending").length;
  return `${overview.workspace.name} · ${members} ${plural(members, "member", "members")}${waiting ? `, ${waiting} pending ${plural(waiting, "invite", "invites")}` : ""}`;
}

/** What one member may do to another. The server decides again; this only hides what would be refused. */
export function allowedOn(actorRole: WorkspaceRole, row: PersonRow): { role: boolean; suspend: boolean; remove: boolean; owner: boolean } {
  const admin = ROLE_LEVEL[actorRole] >= ROLE_LEVEL.admin;
  if (row.kind === "invitation") return { role: false, suspend: false, remove: admin, owner: false };
  if (!admin || row.you) return { role: false, suspend: false, remove: false, owner: false };
  const isOwner = row.member.role === "owner";
  const mayTouch = !isOwner || actorRole === "owner";
  return { role: mayTouch, suspend: mayTouch && !isOwner, remove: mayTouch, owner: actorRole === "owner" };
}

// ── Roles ─────────────────────────────────────────────────────────────────────

export const ROLE_ORDER: WorkspaceRole[] = ["owner", "admin", "manager", "member", "viewer"];
export { ROLE_LABEL };

/** One line on what each role is for. Each is what the routes actually allow. */
export const ROLE_SUMMARY: Record<WorkspaceRole, string> = {
  owner: "Everything an admin can do, and the only role that can make someone an owner or change one.",
  admin: "Connects LinkedIn accounts and mailboxes, sets up AI, integrations and API keys, and manages members.",
  manager: "Starts and stops campaigns, enrols contacts, imports from Sales Navigator and exports.",
  member: "Builds campaigns, works the inbox, and adds and edits contacts, lists and templates.",
  viewer: "Reads every page. Cannot change, send or export anything.",
};

export interface Capability {
  key: string;
  label: string;
  /** The lowest role that can. */
  min: WorkspaceRole;
}

export interface CapabilityGroup {
  title: string;
  capabilities: Capability[];
}

/** What each role can do, as the comparison shows it. `min` is the role the route asks for. */
export const CAPABILITIES: CapabilityGroup[] = [
  {
    title: "Everyday work",
    capabilities: [
      { key: "read", label: "See every page, report and conversation", min: "viewer" },
      { key: "contacts", label: "Add and edit contacts, companies, lists and templates", min: "member" },
      { key: "inbox", label: "Reply from the inbox; tag and assign conversations", min: "member" },
      { key: "campaigns", label: "Create campaigns and edit their steps", min: "member" },
      { key: "publish-idle", label: "Publish a sequence nobody is part-way through", min: "member" },
      { key: "ai-steps", label: "Test the AI writer and change how a step is written", min: "member" },
      { key: "pipeline", label: "Work tasks and the pipeline", min: "member" },
    ],
  },
  {
    title: "Running campaigns",
    capabilities: [
      { key: "publish-live", label: "Publish a sequence that contacts are part-way through", min: "manager" },
      { key: "runs", label: "Start, pause and stop a campaign; enrol and remove contacts", min: "manager" },
      { key: "imports", label: "Import from Sales Navigator, and cancel an import", min: "manager" },
      { key: "export", label: "Export contacts, replies and reports as files", min: "manager" },
      { key: "rules", label: "Set up signal rules and custom fields", min: "manager" },
      { key: "pause-account", label: "Pause and resume a LinkedIn account", min: "manager" },
    ],
  },
  {
    title: "Setting up the workspace",
    capabilities: [
      { key: "senders", label: "Connect and change LinkedIn accounts and mailboxes", min: "admin" },
      { key: "ai", label: "Set the AI key, models, writing style and budget", min: "admin" },
      { key: "developers", label: "Set up integrations, API keys and webhooks", min: "admin" },
      { key: "members", label: "Invite, suspend and remove members, and change their roles", min: "admin" },
      { key: "audit", label: "Rename the workspace; read and download the audit log", min: "admin" },
      { key: "owners", label: "Make someone an owner, or change an owner", min: "owner" },
    ],
  },
];

export const can = (role: WorkspaceRole, capability: Capability) => ROLE_LEVEL[role] >= ROLE_LEVEL[capability.min];

/** The roles one member can give another: an owner any, anyone else all but owner. */
export function grantableRoles(actorRole: WorkspaceRole): WorkspaceRole[] {
  return actorRole === "owner" ? ROLE_ORDER : ROLE_ORDER.filter((role) => role !== "owner");
}

export function roleCounts(members: TeamMember[]): Record<WorkspaceRole, number> {
  const counts: Record<WorkspaceRole, number> = { owner: 0, admin: 0, manager: 0, member: 0, viewer: 0 };
  for (const member of members) counts[member.role] += 1;
  return counts;
}

// ── The audit log ─────────────────────────────────────────────────────────────

export const SOURCE_LABEL: Record<AuditSource, string> = { web: "Web", api: "API", mcp: "MCP" };

// What each kind of thing is called in a sentence.
const NOUN: Record<string, string> = {
  workflow: "campaign", run: "the run of", account: "LinkedIn account", email_account: "mailbox", contact: "contact", target: "contact",
  company: "company", list: "list", template: "template", todo: "task", opportunity: "opportunity", suppression: "do-not-contact entry",
  signal_rule: "signal rule", signal: "signal", pipeline_stage: "pipeline stage", custom_field: "custom field", connection: "integration connection",
  activity: "activity note", api_key: "API key", webhook: "webhook", integration: "integration", export: "an export", reply: "reply",
  placement_test: "placement test", domain_event: "event", warmup: "warm-up for",
};

const VERB: Record<string, string> = {
  created: "created", updated: "changed", deleted: "deleted", archived: "archived", paused: "paused", resumed: "resumed", activated: "resumed",
  connected: "connected", disconnected: "disconnected", published: "published", duplicated: "duplicated", revoked: "revoked", configured: "set up",
  started: "started", synced: "synced", imported: "imported", sent: "sent", checked: "checked", applied: "applied", emitted: "emitted",
  reordered: "reordered", redelivered: "sent again", reclassified: "reclassified",
};

// What setting a run to each status amounts to.
const RUN_STATUS_VERB: Record<string, string> = { paused: "paused", running: "resumed", stopped: "stopped", cancelled: "stopped", completed: "completed", pending: "queued" };

const role = (value: unknown): string => (isWorkspaceRole(value) ? ROLE_LABEL[value] : String(value ?? ""));
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

export interface AuditSentence {
  /** What was done, to follow the name of whoever did it: "paused campaign". */
  phrase: string;
  /** What it was done to, shown stronger: "Series B SaaS · VP Sales". Null when the phrase says it all. */
  target: string | null;
}

/** An audit entry as a sentence. Known actions have their own wording; the rest are read off their name. */
export function auditSentence(entry: AuditEntry): AuditSentence {
  const meta = entry.metadata ?? {};
  const label = entry.entity_label;
  switch (entry.action) {
    case "workspace.member_role_changed":
    case "workspace.member_upserted":
      return meta.role ? { phrase: `changed the role of ${label ?? "a member"} to`, target: role(meta.role) } : { phrase: "changed the role of", target: label ?? "a member" };
    case "workspace.member_suspended":
      return { phrase: "suspended", target: label ?? "a member" };
    case "workspace.member_restored":
      return { phrase: "restored access for", target: label ?? "a member" };
    case "workspace.member_removed":
      return { phrase: "removed from the workspace", target: label ?? "a member" };
    case "workspace.invitation_created":
      return { phrase: `invited${meta.role ? ` as ${role(meta.role).toLowerCase()}` : ""}`, target: text(meta.email) ?? label };
    case "workspace.invitation_resent":
      return { phrase: "sent the invitation again to", target: text(meta.email) ?? label };
    case "workspace.invitation_link_renewed":
      return { phrase: "made a new invitation link for", target: text(meta.email) ?? label };
    case "workspace.invitation_revoked":
      return { phrase: "revoked the invitation for", target: label ?? "someone" };
    case "workspace.invitation_accepted":
      return { phrase: "accepted the invitation and joined", target: meta.role ? `as ${role(meta.role).toLowerCase()}` : null };
    case "workspace.updated":
      return { phrase: "renamed the workspace to", target: text(meta.name) ?? label };
    case "workspace.created":
      return { phrase: "created the workspace", target: text(meta.name) ?? label };
    case "workspace.settings_updated":
      return { phrase: "changed the workspace settings", target: null };
    case "ai_config.updated":
      return { phrase: "changed the AI settings", target: Array.isArray(meta.fields) && meta.fields.length ? `(${(meta.fields as unknown[]).map((field) => String(field).replace(/_usd$/, "").replace(/_/g, " ")).join(", ")})` : null };
    case "workflow.step_ai_updated":
      return { phrase: "changed how a step is written in", target: label ?? "a campaign" };
    case "run.status_changed":
      return { phrase: `${RUN_STATUS_VERB[String(meta.status)] ?? "changed the status of"} the run of`, target: label ?? "a campaign" };
    case "run.started":
    case "run.created":
      return { phrase: `${entry.action === "run.started" ? "started" : "set up"} a run of`, target: label ?? "a campaign" };
    case "run.deleted":
      return { phrase: "deleted a run of", target: label ?? "a campaign" };
    case "contact.bulk_deleted":
      return { phrase: "deleted", target: `${Number(meta.deleted ?? 0)} ${plural(Number(meta.deleted ?? 0), "contact", "contacts")}` };
    case "audit_log.downloaded":
      return { phrase: "downloaded the audit log", target: typeof meta.entries === "number" ? `${meta.entries.toLocaleString("en-US")} ${plural(meta.entries, "entry", "entries")}` : null };
    case "mcp.tool_used":
      return { phrase: "used the tool", target: entry.entity_id };
    case "integration.configured":
    case "integration.deleted":
      return { phrase: entry.action.endsWith("deleted") ? "removed the integration" : "set up the integration", target: entry.entity_id };
    case "linkedin_preset.updated":
      return { phrase: "changed the LinkedIn limit preset", target: null };
    case "linkedin_preset.applied":
      return { phrase: "applied the LinkedIn limit preset", target: null };
  }
  const [thing, ...rest] = entry.action.split(".");
  const verb = rest.join(".") || "changed";
  const noun = NOUN[entry.entity_type ?? ""] ?? NOUN[thing] ?? thing.replace(/_/g, " ");
  const known = VERB[verb];
  // With a name to show: "paused campaign" + the name. Without: "created a contact".
  if (known) return { phrase: label || /^(the|an?) /.test(noun) || noun.endsWith(" for") ? `${known} ${noun}` : `${known} ${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`, target: label };
  // "workflow.sequence_settings_changed" → "campaign: sequence settings changed".
  return { phrase: `${noun}: ${verb.replace(/_/g, " ")}`, target: label };
}

/** Who an entry is attributed to, when it was not a person in the app. */
export function auditActor(entry: AuditEntry): { name: string; person: boolean } {
  if (entry.actor) return { name: entry.actor.name, person: true };
  if (entry.source === "api") return { name: "API key", person: false };
  if (entry.source === "mcp") return { name: "MCP client", person: false };
  return { name: "Linki", person: false };
}

/** "14:12" for today, "Oct 9 · 14:12" before that. */
export function auditTime(value: string, now: Date = new Date()): { time: string; day: string | null } {
  const date = parseTime(value);
  if (!date) return { time: "—", day: null };
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return { time, day: sameDay ? null : formatDate(date, now) };
}
