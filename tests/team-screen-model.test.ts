// The Team & roles screen's own wording: who is listed and what may be done to them, when
// someone was last active, how an audit entry reads, and the roles comparison, which is
// checked here against what the routes really ask for.
import { describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ROLE_LEVEL, type WorkspaceRole } from "@/lib/roles";
import { changeMember } from "@/lib/team";
import {
  CAPABILITIES, ROLE_ORDER, ROLE_SUMMARY, activityLine, allowedOn, auditActor, auditSentence, auditTime, can, grantableRoles, lastActive, personRows, roleCounts,
  statusBadge, teamSummary, type AuditEntry, type PersonRow, type TeamMember, type TeamOverview,
} from "@/components/team/model";
import { signedHeaders } from "./helpers/ctx";

const member = (fields: Partial<TeamMember> & { id: string; role: WorkspaceRole }): TeamMember => ({
  name: `${fields.id} person`, email: `${fields.id}@team.test`, suspended: false, suspended_at: null, last_active_at: null, joined_at: "2026-01-01 00:00:00", campaigns: 0, ...fields,
});
const OVERVIEW: TeamOverview = {
  workspace: { id: "ws", name: "Acme Growth", created_at: null },
  you: "jordan", your_role: "owner",
  members: [
    member({ id: "jordan", role: "owner", name: "Jordan Mertens" }), member({ id: "elena", role: "admin", name: "Elena Vogt" }),
    member({ id: "marcus", role: "member", name: "Marcus Oyelaran" }), member({ id: "sam", role: "member", name: "Sam Okafor", suspended: true, suspended_at: "2026-09-20 10:00:00" }),
  ],
  invitations: [
    { id: "i1", email: "tomas@acme.example", role: "member", status: "pending", created_at: "2026-10-08 12:00:00", last_sent_at: "2026-10-08 12:00:00", expires_at: "2026-10-15T12:00:00.000Z", invited_by_email: "elena@team.test" },
    { id: "i2", email: "late@acme.example", role: "viewer", status: "expired", created_at: "2026-09-01 12:00:00", last_sent_at: null, expires_at: "2026-09-08T12:00:00.000Z", invited_by_email: null },
  ],
  workspaces: [{ id: "ws", name: "Acme Growth", role: "owner", suspended: false, members: 4 }],
  active_api_keys: {},
};
const row = (id: string) => personRows(OVERVIEW, "", "all").find((candidate) => candidate.key.endsWith(id))!;

describe("the people listed", () => {
  it("are the members, then the invitations still waiting", () => {
    expect(personRows(OVERVIEW, "", "all").map((person) => person.key)).toEqual(["m:jordan", "m:elena", "m:marcus", "m:sam", "i:i1", "i:i2"]);
    expect(teamSummary(OVERVIEW)).toBe("Acme Growth · 4 members, 1 pending invite");
    expect(teamSummary({ ...OVERVIEW, members: OVERVIEW.members.slice(0, 1), invitations: [] })).toBe("Acme Growth · 1 member");
  });

  it("can be narrowed by name, address and role", () => {
    expect(personRows(OVERVIEW, "ELENA", "all").map((person) => person.key)).toEqual(["m:elena"]);
    expect(personRows(OVERVIEW, "acme.example", "all").map((person) => person.key)).toEqual(["i:i1", "i:i2"]);
    expect(personRows(OVERVIEW, "", "member").map((person) => person.key)).toEqual(["m:marcus", "m:sam", "i:i1"]);
    expect(personRows(OVERVIEW, "nobody", "all")).toEqual([]);
  });

  it("each say what state they are in", () => {
    expect(statusBadge(row("jordan"))).toEqual({ tone: "good", label: "Active" });
    expect(statusBadge(row("sam"))).toEqual({ tone: "bad", label: "Suspended" });
    expect(statusBadge(row("i1"))).toEqual({ tone: "warn", label: "Invited" });
    expect(statusBadge(row("i2"))).toEqual({ tone: "neutral", label: "Invitation ran out" });
  });

  it("are counted by role, suspended or not", () => {
    expect(roleCounts(OVERVIEW.members)).toEqual({ owner: 1, admin: 1, manager: 0, member: 2, viewer: 0 });
  });
});

describe("last active", () => {
  const now = new Date(2026, 9, 10, 14, 0, 0);
  const at = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");
  const ago = (minutes: number) => at(new Date(now.getTime() - minutes * 60_000));

  it("reads as people say it", () => {
    expect(lastActive(null, now)).toBe("Not yet");
    expect(lastActive(ago(2), now)).toBe("Active now");
    expect(lastActive(ago(12), now)).toBe("12 minutes ago");
    expect(lastActive(ago(65), now)).toBe("1 hour ago");
    expect(lastActive(ago(5 * 60), now)).toBe("5 hours ago");
    expect(lastActive(at(new Date(2026, 9, 9, 18, 40)), now)).toBe("Yesterday 18:40");
    expect(lastActive(at(new Date(2026, 9, 7, 9, 0)), now)).toBe("3 days ago");
    expect(lastActive(at(new Date(2026, 5, 1, 9, 0)), now)).toBe("Jun 1");
  });

  it("is when an invitation was made, for someone not here yet", () => {
    const invited: PersonRow = { kind: "invitation", key: "i", invitation: { ...OVERVIEW.invitations[0], last_sent_at: ago(2 * 24 * 60), created_at: ago(9 * 24 * 60) } };
    expect(activityLine(invited, now)).toBe("Invited 2 d ago");
    expect(activityLine({ kind: "invitation", key: "i", invitation: { ...OVERVIEW.invitations[1], expires_at: new Date(now.getTime() - 3 * 86_400_000).toISOString() } }, now)).toBe("Ran out 3 d ago");
    expect(activityLine({ kind: "member", key: "m", member: member({ id: "x", role: "member", last_active_at: ago(1) }), you: false }, now)).toBe("Active now");
  });
});

describe("what one member may do to another", () => {
  it("is nothing for anyone below admin, and nothing to yourself", () => {
    for (const actor of ["viewer", "member", "manager"] as const) expect(allowedOn(actor, row("marcus"))).toEqual({ role: false, suspend: false, remove: false, owner: false });
    expect(allowedOn("owner", row("jordan"))).toEqual({ role: false, suspend: false, remove: false, owner: false });
    expect(allowedOn("manager", row("i1")).remove).toBe(false);
  });

  it("stops an admin at an owner, and nobody suspends an owner", () => {
    expect(allowedOn("admin", row("marcus"))).toEqual({ role: true, suspend: true, remove: true, owner: false });
    const someoneElsesView = personRows({ ...OVERVIEW, you: "elena", your_role: "admin" }, "", "all").find((person) => person.key === "m:jordan")!;
    expect(allowedOn("admin", someoneElsesView)).toEqual({ role: false, suspend: false, remove: false, owner: false });
    const anotherOwner: PersonRow = { kind: "member", key: "m:o2", member: member({ id: "o2", role: "owner" }), you: false };
    expect(allowedOn("owner", anotherOwner)).toEqual({ role: true, suspend: false, remove: true, owner: true });
    expect(allowedOn("admin", row("i1"))).toMatchObject({ remove: true, role: false });
  });

  it("lets only an owner hand out the owner role", () => {
    expect(grantableRoles("owner")).toEqual(["owner", "admin", "manager", "member", "viewer"]);
    expect(grantableRoles("admin")).toEqual(["admin", "manager", "member", "viewer"]);
  });
});

describe("an audit entry as a sentence", () => {
  const entry = (action: string, fields: Partial<AuditEntry> = {}): AuditEntry => ({
    id: "e", action, entity_type: null, entity_id: null, entity_label: null, metadata: null, source: "web", via: null, ip_address: null, created_at: "2026-10-10 14:12:00",
    actor: { id: "u", name: "Elena Vogt", email: "elena@acme.example" }, ...fields,
  });
  const read = (action: string, fields: Partial<AuditEntry> = {}) => {
    const sentence = auditSentence(entry(action, fields));
    return sentence.target ? `${sentence.phrase} ${sentence.target}` : sentence.phrase;
  };

  it("has its own wording for what people look for", () => {
    expect(read("workspace.member_role_changed", { entity_label: "Hannah Weiss", metadata: { role: "viewer", previous: "member" } })).toBe("changed the role of Hannah Weiss to Viewer");
    expect(read("workspace.member_role_changed", { entity_label: "Hannah Weiss" })).toBe("changed the role of Hannah Weiss");
    expect(read("workspace.member_suspended", { entity_label: "Sam Okafor" })).toBe("suspended Sam Okafor");
    expect(read("workspace.member_restored", { entity_label: "Sam Okafor" })).toBe("restored access for Sam Okafor");
    expect(read("workspace.member_removed")).toBe("removed from the workspace a member");
    expect(read("workspace.invitation_created", { metadata: { email: "tomas@acme.example", role: "member" } })).toBe("invited as member tomas@acme.example");
    expect(read("workspace.invitation_resent", { metadata: { email: "tomas@acme.example" } })).toBe("sent the invitation again to tomas@acme.example");
    expect(read("workspace.updated", { metadata: { name: "Acme EMEA" } })).toBe("renamed the workspace to Acme EMEA");
    expect(read("run.status_changed", { entity_label: "Series B push", metadata: { status: "paused" } })).toBe("paused the run of Series B push");
    expect(read("run.status_changed", { entity_label: "Series B push", metadata: { status: "running" } })).toBe("resumed the run of Series B push");
    expect(read("contact.bulk_deleted", { metadata: { deleted: 18 } })).toBe("deleted 18 contacts");
    expect(read("ai_config.updated", { metadata: { fields: ["tone", "monthly_budget_usd"] } })).toBe("changed the AI settings (tone, monthly budget)");
    expect(read("audit_log.downloaded", { metadata: { entries: 1 } })).toBe("downloaded the audit log 1 entry");
    expect(read("mcp.tool_used", { entity_id: "run_control" })).toBe("used the tool run_control");
    expect(read("integration.configured", { entity_id: "openrouter" })).toBe("set up the integration openrouter");
  });

  it("reads every other action off its name", () => {
    expect(read("workflow.created", { entity_type: "workflow", entity_label: "Series B push" })).toBe("created campaign Series B push");
    expect(read("account.connected", { entity_type: "account", entity_label: "Marcus" })).toBe("connected LinkedIn account Marcus");
    expect(read("api_key.created", { entity_type: "api_key", entity_label: "reporting" })).toBe("created API key reporting");
    expect(read("contact.created", { entity_type: "contact" })).toBe("created a contact");
    expect(read("api_key.revoked", { entity_type: "api_key" })).toBe("revoked an API key");
    expect(read("opportunity.updated", { entity_type: "opportunity" })).toBe("changed an opportunity");
    expect(read("workflow.sequence_settings_changed", { entity_type: "workflow", entity_label: "Series B push" })).toBe("campaign: sequence settings changed Series B push");
    expect(read("something_new.happened")).toBe("something new: happened");
  });

  it("names who did it, or what did when it was not a person", () => {
    expect(auditActor(entry("x"))).toEqual({ name: "Elena Vogt", person: true });
    expect(auditActor(entry("x", { actor: null, source: "api", via: "Production backend" }))).toEqual({ name: "API key", person: false });
    expect(auditActor(entry("x", { actor: null, source: "mcp" }))).toEqual({ name: "MCP client", person: false });
    expect(auditActor(entry("x", { actor: null, source: null }))).toEqual({ name: "Linki", person: false });
  });

  it("shows the time alone for today, and the day as well before that", () => {
    const now = new Date(2026, 9, 10, 18, 0, 0);
    const local = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");
    expect(auditTime(local(new Date(2026, 9, 10, 14, 12)), now)).toEqual({ time: "14:12", day: null });
    expect(auditTime(local(new Date(2026, 9, 9, 9, 5)), now)).toEqual({ time: "09:05", day: "Oct 9" });
    expect(auditTime("nonsense", now)).toEqual({ time: "—", day: null });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the roles comparison", () => {
  it("gives every role a line, and every higher role everything a lower one has", () => {
    expect(Object.keys(ROLE_SUMMARY).sort()).toEqual([...ROLE_ORDER].sort());
    for (const group of CAPABILITIES) {
      for (const capability of group.capabilities) {
        const yes = ROLE_ORDER.filter((role) => can(role, capability));
        expect(yes, capability.label).toEqual(ROLE_ORDER.filter((role) => ROLE_LEVEL[role] >= ROLE_LEVEL[capability.min]));
      }
    }
    const keys = CAPABILITIES.flatMap((group) => group.capabilities.map((capability) => capability.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  // One route that stands for each line of the comparison. If a route's guard changes, or
  // the comparison is edited to say something the routes do not do, this fails.
  const ROUTE_FOR: Record<string, { load: () => Promise<{ default: (req: NextApiRequest, res: NextApiResponse) => unknown }>; method: string; query?: Record<string, string> } | "rule" | "elsewhere"> = {
    read: { load: () => import("@/pages/api/shell"), method: "GET" },
    contacts: { load: () => import("@/pages/api/targets/index"), method: "POST" },
    inbox: { load: () => import("@/pages/api/inbox/reply"), method: "POST" },
    campaigns: { load: () => import("@/pages/api/workflows/index"), method: "POST" },
    "ai-steps": { load: () => import("@/pages/api/ai/steps"), method: "PUT" },
    pipeline: { load: () => import("@/pages/api/todos/index"), method: "POST" },
    runs: { load: () => import("@/pages/api/runs/index"), method: "POST" },
    imports: { load: () => import("@/pages/api/lists/[id]/import"), method: "POST", query: { id: "none" } },
    export: { load: () => import("@/pages/api/export/[resource]"), method: "GET", query: { resource: "none" } },
    rules: { load: () => import("@/pages/api/platform/signal-rules"), method: "POST" },
    "pause-account": { load: () => import("@/pages/api/accounts/[id]/pause"), method: "POST", query: { id: "none" } },
    senders: { load: () => import("@/pages/api/email-accounts/index"), method: "POST" },
    ai: { load: () => import("@/pages/api/platform/ai-config"), method: "PUT" },
    developers: { load: () => import("@/pages/api/platform/api-keys"), method: "POST" },
    members: { load: () => import("@/pages/api/platform/members"), method: "PATCH" },
    audit: { load: () => import("@/pages/api/platform/audit"), method: "GET", query: { view: "list" } },
    // Decided by a rule on who is being changed, not by a route's minimum role.
    owners: "rule",
    // Who may publish depends on whether contacts are part-way through the sequence; that
    // rule lives with the sequence builder.
    "publish-idle": "elsewhere",
    "publish-live": "elsewhere",
  };

  it("says what the routes ask for", async () => {
    const db = getDb();
    const ws = "ws-roles-matrix";
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
    for (const role of ROLE_ORDER) {
      db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')").run(`${ws}-${role}`, `${role}@matrix.test`);
      db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(ws, `${ws}-${role}`, role);
    }
    const ask = async (key: string, role: WorkspaceRole) => {
      const route = ROUTE_FOR[key];
      if (typeof route === "string") throw new Error("not a route");
      const res: Record<string, unknown> = { statusCode: 200, body: undefined, destroyed: false };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (payload: unknown) => { res.body = payload; return res; };
      for (const name of ["send", "end", "setHeader", "write", "once", "off"]) res[name] = () => res;
      const handler = (await route.load()).default;
      try {
        await handler({ method: route.method, body: {}, query: route.query ?? {}, socket: {}, headers: { host: "linki.test", ...signedHeaders({ workspaceId: ws, userId: `${ws}-${role}`, role, iat: "1" }) } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
      } catch {
        // Past the role check and tripping over the empty request: allowed in, which is all that is asked here.
      }
      return res as { statusCode: number; body?: { required_role?: string } };
    };

    for (const capability of CAPABILITIES.flatMap((group) => group.capabilities)) {
      const route = ROUTE_FOR[capability.key];
      expect(route, `no route stands for "${capability.label}"`).toBeDefined();
      if (typeof route === "string") continue;
      const allowed = await ask(capability.key, capability.min);
      expect(allowed.statusCode, `${capability.min} should be let in to: ${capability.label}`).not.toBe(403);
      const below = ROLE_ORDER[ROLE_ORDER.indexOf(capability.min) + 1];
      if (below) {
        const refused = await ask(capability.key, below);
        expect({ status: refused.statusCode, needs: refused.body?.required_role }, `${below} should be refused: ${capability.label}`).toEqual({ status: 403, needs: capability.min });
      }
    }

    // The one line that is a rule about the person being changed.
    expect(changeMember(db, ws, { userId: `${ws}-admin`, role: "admin" }, `${ws}-member`, { role: "owner" })).toMatchObject({ ok: false, status: 403 });
    expect(changeMember(db, ws, { userId: `${ws}-owner`, role: "owner" }, `${ws}-member`, { role: "owner" })).toMatchObject({ ok: true });
  });
});
