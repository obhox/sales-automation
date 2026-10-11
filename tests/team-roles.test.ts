// Team & roles: suspending a member (and that a suspended member is refused everywhere),
// changing roles, when a member was last active, invitations, the audit log's source,
// filters, download and twelve-month keep, and a member's own account.
// Real (throwaway) database. No email is sent: the mailer is a stub.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ctxHeaders, signedHeaders } from "./helpers/ctx";

const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; body: string }>, fail: false }));
vi.mock("@/lib/email/sender", () => ({
  sendEmail: async (_account: unknown, to: string, subject: string, body: string) => {
    if (mail.fail) throw new Error("SMTP refused the message");
    mail.sent.push({ to, subject, body });
    return { messageId: "<test@linki>" };
  },
}));

import { AUDIT_KEEP_MONTHS, auditSourceCounts, countAudit, listAudit, pruneAuditLog } from "@/lib/audit";
import { apiWriteAction } from "@/lib/api/v1-audit";
import { createApiKey } from "@/lib/api-keys";
import { hashToken, verifyAccessToken } from "@/lib/mcp/auth";
import { campaignCounts, changeMember, cleanWorkspaceName, listMembers, nameFromEmail } from "@/lib/team";
import { CLIENT_IP_HEADER, SOURCE_HEADER, VIA_HEADER, getMembership, getMemberships, getPrimaryMembership, recordAudit, requireWorkspace } from "@/lib/workspace";
import { acceptWorkspaceInvitation, createWorkspaceInvitation, getInvitationByToken, reissueWorkspaceInvitation } from "@/lib/workspace-invitations";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import accountHandler from "@/pages/api/account";
import auditHandler, { type AuditPage } from "@/pages/api/platform/audit";
import invitationsHandler from "@/pages/api/platform/invitations";
import membersHandler, { type TeamOverview } from "@/pages/api/platform/members";
import workspaceHandler from "@/pages/api/platform/workspace";
import v1Handler from "@/pages/api/v1/[...path]";

const db = () => getDb();
let seq = 0;

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown>; headers: Record<string, string>; text: string };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined, headers: {}, text: "", destroyed: false };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.send = (payload: unknown) => { res.body = payload; return res; };
  res.end = (chunk?: unknown) => { if (typeof chunk === "string") res.text += chunk; return res; };
  res.write = (chunk: unknown) => { res.text = String(res.text) + String(chunk); return true; };
  res.setHeader = (name: string, value: string) => { (res.headers as Record<string, string>)[name.toLowerCase()] = String(value); return res; };
  res.once = () => res;
  res.off = () => res;
  return res as unknown as Res;
}

/** A workspace with one member of each role, and a way to call a route as any of them. */
function workspace() {
  const n = ++seq;
  const ws = `ws-team-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, `Team ${n}`, ws);
  const id = (role: string) => `${ws}-${role}`;
  for (const role of ["owner", "admin", "manager", "member", "viewer"]) {
    db().prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', ?)").run(id(role), `${role}${n}@team.test`, `${role[0].toUpperCase()}${role.slice(1)} Person`);
    db().prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(ws, id(role), role);
  }
  const call = async (handler: Handler, method: string, request: { body?: unknown; query?: Record<string, string>; as?: string; headers?: Record<string, string>; iat?: string } = {}) => {
    const res = mockRes();
    const userId = id(request.as ?? "admin");
    // Signed for the role the member has now, as proxy.ts would from a live session.
    const role = (db().prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ws, userId) as { role: string } | undefined)?.role ?? "viewer";
    await handler({
      method, body: request.body ?? {}, query: request.query ?? {}, socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "linki.test", ...signedHeaders({ workspaceId: ws, userId, role, iat: request.iat ?? "1760000000" }), ...(request.headers ?? {}) },
    } as unknown as NextApiRequest, res);
    return res;
  };
  const member = (role: string) => db().prepare("SELECT role, suspended_at, suspended_by, last_active_at FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(ws, id(role)) as { role: string; suspended_at: string | null; suspended_by: string | null; last_active_at: string | null };
  const suspend = (role: string) => db().prepare("UPDATE workspace_members SET suspended_at = datetime('now') WHERE workspace_id = ? AND user_id = ?").run(ws, id(role));
  const audit = () => db().prepare("SELECT action, entity_type, entity_id, user_id, metadata_json, source, via, ip_address FROM audit_logs WHERE workspace_id = ? ORDER BY rowid").all(ws) as Array<Record<string, string | null>>;
  return { ws, id, call, member, suspend, audit };
}

beforeEach(() => {
  mail.sent.length = 0;
  mail.fail = false;
});

// ─────────────────────────────────────────────────────────────────────
describe("a suspended member", () => {
  // Routes that do not act for a member of a workspace, and so have nothing to refuse.
  // Every other route under pages/api must turn a suspended member away.
  const NOT_FOR_MEMBERS: Record<string, string> = {
    "auth/[...nextauth]": "signing in: the session it issues is moved off a suspended workspace (tested below)",
    "auth/change-password": "a person's own password, by their session",
    "auth/forgot-password": "signed out",
    "auth/resend-verification": "signed out",
    "auth/reset-password": "signed out",
    "auth/signup": "signed out",
    "auth/verify-email": "signed out",
    "invitations/[token]": "an invitation, by its token",
    "oauth/authorize": "by session: the session is moved off a suspended workspace",
    "oauth/metadata-authorization-server": "public discovery document",
    "oauth/metadata-protected-resource": "public discovery document",
    "oauth/register": "client registration, no member involved",
    "oauth/revoke": "by token",
    "oauth/token": "by code or refresh token; the access token is refused when used (tested below)",
    mcp: "by MCP access token, which a suspended membership invalidates (tested below)",
    "v1/[...path]": "by API key, which belongs to the workspace and not to a member",
    "t/c/[token]": "a link inside a sent email",
    "t/o/[token]": "a pixel inside a sent email",
    "t/u/[token]": "the unsubscribe page",
    health: "liveness probe",
    hello: "diagnostic, returns nothing of a workspace's",
    "premium-status": "which optional parts this build has; nothing of a workspace's",
    "lists/[id]/csv-template": "a blank file of column headings for an import; nothing of a workspace's",
    "admin/overview": "instance admin, decided by the superadmin allowlist",
    "admin/workspaces": "instance admin, decided by the superadmin allowlist",
    "system/update": "instance admin, decided by the superadmin allowlist",
  };

  const modules = import.meta.glob<{ default: Handler }>("../pages/api/**/*.ts");
  const routes = Object.keys(modules).map((file) => file.replace("../pages/api/", "").replace(/\.ts$/, "").replace(/\/index$/, "")).sort();

  it("is covered route by route: nothing is exempt that is not listed with a reason", () => {
    expect(routes.length).toBeGreaterThan(120);
    for (const name of Object.keys(NOT_FOR_MEMBERS)) expect(routes, `${name} is listed as exempt but is not a route`).toContain(name);
  });

  it("is refused by every route that acts for a member, whatever the method", async () => {
    const w = workspace();
    w.suspend("manager");
    const headers = { host: "linki.test", ...signedHeaders({ workspaceId: w.ws, userId: w.id("manager"), role: "manager", iat: "1760000000" }) };
    const refusedBy: string[] = [];
    const letThrough: string[] = [];

    for (const [file, load] of Object.entries(modules)) {
      const name = file.replace("../pages/api/", "").replace(/\.ts$/, "").replace(/\/index$/, "");
      if (NOT_FOR_MEMBERS[name]) continue;
      const handler = (await load()).default;
      let refused = false;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const res = mockRes();
        await handler({
          method, headers, body: {}, socket: { remoteAddress: "127.0.0.1" }, url: `/api/${name}`,
          query: { id: "none", token: "none", replyId: "none", stepId: "none", resource: "contacts", workflow_id: "none", user_id: "none" },
        } as unknown as NextApiRequest, res);
        if (res.statusCode === 403 && res.body?.code === "workspace_access") refused = true;
        // A method the route does not take at all is the only other acceptable answer.
        else if (res.statusCode !== 405) letThrough.push(`${method} ${name} → ${res.statusCode}`);
      }
      if (refused) refusedBy.push(name);
      else letThrough.push(`${name} never refused`);
    }

    expect(letThrough).toEqual([]);
    expect(refusedBy.length).toBe(routes.length - Object.keys(NOT_FOR_MEMBERS).length);
    // And nothing they tried left a mark.
    expect(w.audit()).toEqual([]);
    expect(w.member("manager").last_active_at).toBeNull();
  }, 60_000);

  it("is told why, and a member who was removed is told that instead", () => {
    const w = workspace();
    w.suspend("member");
    const resolve = (userId: string) => {
      const res = mockRes();
      const ctx = requireWorkspace({ headers: signedHeaders({ workspaceId: w.ws, userId, role: "member", iat: "1" }) } as unknown as NextApiRequest, res);
      return { ctx, status: res.statusCode, body: res.body };
    };
    expect(resolve(w.id("member"))).toMatchObject({ ctx: null, status: 403, body: { error: "Your access to this workspace is suspended. An admin of the workspace can restore it.", code: "workspace_access" } });
    db().prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(w.ws, w.id("viewer"));
    expect(resolve(w.id("viewer"))).toMatchObject({ ctx: null, status: 403, body: { error: "You do not have access to this workspace", code: "workspace_access" } });
    expect(resolve(w.id("admin")).ctx).toMatchObject({ role: "admin" });
  });

  it("is refused whatever role the session cookie still claims", () => {
    const w = workspace();
    w.suspend("admin");
    const res = mockRes();
    expect(requireWorkspace({ headers: signedHeaders({ workspaceId: w.ws, userId: w.id("admin"), role: "owner", iat: "1" }) } as unknown as NextApiRequest, res)).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it("counts as no member wherever membership is asked about", () => {
    const w = workspace();
    w.suspend("member");
    expect(getMembership(w.id("member"), w.ws)).toBeNull();
    expect(getMembership(w.id("member"), w.ws, { includeSuspended: true })).toMatchObject({ role: "member", suspended: true });
    expect(getPrimaryMembership(w.id("member"))).toBeNull();
    // Still listed among their workspaces, marked, so the app can say so.
    expect(getMemberships(w.id("member"))).toEqual([expect.objectContaining({ id: w.ws, suspended: 1 })]);
    expect(getMembership(w.id("admin"), w.ws)).toMatchObject({ role: "admin", suspended: false });
  });

  it("has their session moved to another workspace they can use", async () => {
    const w = workspace();
    const other = workspace();
    db().prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'viewer')").run(other.ws, w.id("member"));
    const jwt = authOptions.callbacks!.jwt!;
    const token = { userId: w.id("member"), workspaceId: w.ws, role: "member", email: "member@team.test" };

    expect(await jwt({ token: { ...token } } as never)).toMatchObject({ workspaceId: w.ws, role: "member" });
    w.suspend("member");
    expect(await jwt({ token: { ...token } } as never)).toMatchObject({ workspaceId: other.ws, role: "viewer" });
    // Asking for the suspended workspace by name does not get it back.
    expect(await jwt({ token: { ...token, workspaceId: other.ws }, trigger: "update", session: { workspaceId: w.ws } } as never)).not.toMatchObject({ workspaceId: w.ws });
  });

  it("with nowhere else to go lands in a workspace of their own, never in the one that suspended them", async () => {
    const w = workspace();
    w.suspend("viewer");
    const moved = await authOptions.callbacks!.jwt!({ token: { userId: w.id("viewer"), workspaceId: w.ws, role: "viewer", email: "viewer@team.test" } } as never);
    expect(moved.workspaceId).toBeTruthy();
    expect(moved.workspaceId).not.toBe(w.ws);
    expect(moved.role).toBe("owner");
  });

  it("cannot use an MCP token for that workspace", () => {
    const w = workspace();
    const resource = "http://linki.test/api/mcp";
    db().prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, 'Test agent', '[]')").run(`client-${w.ws}`);
    db().prepare(`INSERT INTO oauth_tokens (id, access_hash, refresh_hash, client_id, user_id, scope, resource, workspace_id, expires_at, refresh_expires_at)
      VALUES (?, ?, ?, ?, ?, 'mcp:read mcp:write', ?, ?, ?, ?)`).run(`tok-${w.ws}`, hashToken(`access-${w.ws}`), hashToken(`refresh-${w.ws}`), `client-${w.ws}`, w.id("manager"), resource, w.ws, new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString());

    expect(verifyAccessToken(`access-${w.ws}`, resource)?.extra).toMatchObject({ workspaceId: w.ws, workspaceRole: "manager", clientName: "Test agent" });
    w.suspend("manager");
    expect(verifyAccessToken(`access-${w.ws}`, resource)).toBeNull();
  });

  it("keeps the role they had, and has it back the moment they are restored", async () => {
    const w = workspace();
    expect((await w.call(membersHandler, "PATCH", { as: "admin", body: { user_id: w.id("manager"), suspended: true } })).statusCode).toBe(200);
    expect((await w.call(membersHandler, "GET", { as: "manager" })).statusCode).toBe(403);
    expect((await w.call(membersHandler, "PATCH", { as: "admin", body: { user_id: w.id("manager"), suspended: false } })).statusCode).toBe(200);
    const back = await w.call(membersHandler, "GET", { as: "manager" });
    expect(back.statusCode).toBe(200);
    expect((back.body as unknown as TeamOverview).your_role).toBe("manager");
  });

  it("leaves the workspace's API keys working, including ones they created", async () => {
    const w = workspace();
    const key = createApiKey({ workspaceId: w.ws, name: "Their key", scopes: ["contacts:read"], createdBy: w.id("admin") });
    w.suspend("admin");
    const res = mockRes();
    await v1Handler({ method: "GET", headers: { authorization: `Bearer ${key.key}` }, query: { path: ["contacts"] }, body: {} } as unknown as NextApiRequest, res);
    expect(res.statusCode).toBe(200);
    // The screen is told how many, so whoever suspends them can decide.
    const overview = (await w.call(membersHandler, "GET", { as: "owner" })).body as unknown as TeamOverview;
    expect(overview.active_api_keys).toEqual({ [w.id("admin")]: 1 });
    expect(((await w.call(membersHandler, "GET", { as: "viewer" })).body as unknown as TeamOverview).active_api_keys).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a workspace that suspends nobody", () => {
  it("answers every member as it did before", () => {
    const w = workspace();
    for (const role of ["owner", "admin", "manager", "member", "viewer"]) {
      const res = mockRes();
      const ctx = requireWorkspace({ headers: signedHeaders({ workspaceId: w.ws, userId: w.id(role), role: "viewer", iat: "1" }) } as unknown as NextApiRequest, res);
      // Still the role in the database, not the one the cookie claims.
      expect(ctx).toMatchObject({ workspaceId: w.ws, userId: w.id(role), role });
      expect(getPrimaryMembership(w.id(role))).toMatchObject({ workspaceId: w.ws, role });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("changing a member", () => {
  it("lets an admin change a role, and records who it was changed from and to", async () => {
    const w = workspace();
    const res = await w.call(membersHandler, "PATCH", { as: "admin", body: { user_id: w.id("member"), role: "manager" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.member).toMatchObject({ id: w.id("member"), role: "manager", suspended: false });
    expect(w.member("member").role).toBe("manager");
    expect(w.audit()).toEqual([expect.objectContaining({ action: "workspace.member_role_changed", entity_type: "user", entity_id: w.id("member"), user_id: w.id("admin"), metadata_json: JSON.stringify({ role: "manager", previous: "member" }) })]);
  });

  it("records who suspended a member and when, and clears it when they are restored", async () => {
    const w = workspace();
    await w.call(membersHandler, "PATCH", { as: "owner", body: { user_id: w.id("viewer"), suspended: true } });
    expect(w.member("viewer")).toMatchObject({ role: "viewer", suspended_by: w.id("owner") });
    expect(w.member("viewer").suspended_at).not.toBeNull();
    await w.call(membersHandler, "PATCH", { as: "owner", body: { user_id: w.id("viewer"), suspended: false } });
    expect(w.member("viewer")).toMatchObject({ suspended_at: null, suspended_by: null });
    expect(w.audit().map((entry) => entry.action)).toEqual(["workspace.member_suspended", "workspace.member_restored"]);
  });

  it("is for admins and owners", async () => {
    const w = workspace();
    for (const as of ["viewer", "member", "manager"]) {
      expect((await w.call(membersHandler, "PATCH", { as, body: { user_id: w.id("viewer"), suspended: true } })).statusCode, as).toBe(403);
    }
    expect(w.member("viewer").suspended_at).toBeNull();
  });

  it("keeps an owner out of an admin's reach", async () => {
    const w = workspace();
    const patch = (as: string, body: Record<string, unknown>) => w.call(membersHandler, "PATCH", { as, body });
    expect(await patch("admin", { user_id: w.id("owner"), role: "viewer" })).toMatchObject({ statusCode: 403 });
    expect(await patch("admin", { user_id: w.id("owner"), suspended: true })).toMatchObject({ statusCode: 403 });
    expect(await patch("admin", { user_id: w.id("member"), role: "owner" })).toMatchObject({ statusCode: 403 });
    // The older route for adding someone by email follows the same rules now.
    expect(await w.call(workspaceHandler, "POST", { as: "admin", body: { email: `owner${w.ws.split("-").pop()}@team.test`, role: "viewer" } })).toMatchObject({ statusCode: 403 });
    expect(w.member("owner")).toMatchObject({ role: "owner", suspended_at: null });
    expect(w.member("member").role).toBe("member");
  });

  it("never leaves a workspace without an owner", async () => {
    const w = workspace();
    const patch = (as: string, body: Record<string, unknown>) => w.call(membersHandler, "PATCH", { as, body });
    // Nobody changes themselves, so the only owner cannot step down alone…
    expect(await patch("owner", { user_id: w.id("owner"), role: "admin" })).toMatchObject({ statusCode: 400, body: { error: expect.stringContaining("your own role") } });
    // …and with a second owner, one can change the other, but not both.
    expect((await patch("owner", { user_id: w.id("admin"), role: "owner" })).statusCode).toBe(200);
    expect((await patch("admin", { user_id: w.id("owner"), role: "member" })).statusCode).toBe(200);
    expect(changeMember(db(), w.ws, { userId: "someone-else", role: "owner" }, w.id("admin"), { role: "member" })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("at least one owner") });
    expect(w.member("admin").role).toBe("owner");
  });

  it("does not suspend an owner, or let anyone suspend themselves", async () => {
    const w = workspace();
    db().prepare("UPDATE workspace_members SET role = 'owner' WHERE user_id = ?").run(w.id("admin"));
    expect(await w.call(membersHandler, "PATCH", { as: "owner", body: { user_id: w.id("admin"), suspended: true } })).toMatchObject({ statusCode: 400, body: { error: "An owner cannot be suspended. Change their role first." } });
    expect(await w.call(membersHandler, "PATCH", { as: "owner", body: { user_id: w.id("owner"), suspended: true } })).toMatchObject({ statusCode: 400 });
  });

  it("says what is wrong with a request", async () => {
    const w = workspace();
    const patch = (body: Record<string, unknown>) => w.call(membersHandler, "PATCH", { as: "owner", body });
    expect((await patch({ role: "member" })).statusCode).toBe(400);
    expect((await patch({ user_id: w.id("member") })).statusCode).toBe(400);
    expect((await patch({ user_id: w.id("member"), role: "emperor" })).statusCode).toBe(400);
    expect((await patch({ user_id: w.id("member"), suspended: "yes" })).statusCode).toBe(400);
    expect((await patch({ user_id: "nobody-here", role: "member" })).statusCode).toBe(404);
    expect((await patch({ user_id: workspace().id("member"), role: "admin" })).statusCode).toBe(404);
    expect((await w.call(membersHandler, "DELETE", { as: "owner" })).statusCode).toBe(405);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the members list", () => {
  it("gives each member's name, role, state and campaigns, the most senior first", async () => {
    const w = workspace();
    db().prepare("UPDATE users SET name = NULL WHERE id = ?").run(w.id("viewer"));
    w.suspend("member");
    const campaign = (name: string, by: string, archived = 0) => {
      const id = `camp-${++seq}`;
      db().prepare("INSERT INTO workflows (id, name, workspace_id, is_archived) VALUES (?, ?, ?, ?)").run(id, name, w.ws, archived);
      recordAudit({ workspaceId: w.ws, userId: w.id(by), role: "manager" }, "workflow.created", "workflow", id);
    };
    campaign("One", "manager");
    campaign("Two", "manager");
    campaign("Archived", "manager", 1);
    campaign("Three", "admin");

    const res = await w.call(membersHandler, "GET", { as: "viewer" });
    const body = res.body as unknown as TeamOverview;

    expect(res.statusCode).toBe(200);
    expect(body.you).toBe(w.id("viewer"));
    expect(body.your_role).toBe("viewer");
    expect(body.members.map((member) => [member.role, member.name, member.suspended, member.campaigns])).toEqual([
      ["owner", "Owner Person", false, 0], ["admin", "Admin Person", false, 1], ["manager", "Manager Person", false, 2],
      ["member", "Member Person", true, 0], ["viewer", `Viewer${w.ws.split("-").pop()}`, false, 0],
    ]);
    expect(body.workspaces).toEqual([{ id: w.ws, name: body.workspace.name, role: "viewer", suspended: false, members: 5 }]);
    expect(campaignCounts(db(), w.ws).get(w.id("manager"))).toBe(2);
  });

  it("notes when a member was last active, at their first request and not on a suspended one's", async () => {
    const w = workspace();
    expect(w.member("member").last_active_at).toBeNull();
    await w.call(membersHandler, "GET", { as: "member" });
    expect(w.member("member").last_active_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(listMembers(db(), w.ws).find((member) => member.id === w.id("member"))?.last_active_at).not.toBeNull();
    expect(w.member("viewer").last_active_at).toBeNull();
  });

  it("lists invitations still waiting, and not the ones that were accepted or revoked", async () => {
    const w = workspace();
    createWorkspaceInvitation({ workspaceId: w.ws, email: "Waiting@Example.test", role: "member", invitedBy: w.id("admin") });
    const revoked = createWorkspaceInvitation({ workspaceId: w.ws, email: "gone@example.test", role: "viewer", invitedBy: w.id("admin") });
    db().prepare("UPDATE workspace_invitations SET revoked_at = datetime('now') WHERE id = ?").run(revoked.invitation.id);
    const expired = createWorkspaceInvitation({ workspaceId: w.ws, email: "late@example.test", role: "manager", invitedBy: w.id("admin") });
    db().prepare("UPDATE workspace_invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(expired.invitation.id);

    const body = (await w.call(membersHandler, "GET", { as: "manager" })).body as unknown as TeamOverview;
    expect(body.invitations.map((invitation) => [invitation.email, invitation.role, invitation.status]).sort()).toEqual([
      ["late@example.test", "manager", "expired"], ["waiting@example.test", "member", "pending"],
    ]);
    expect(JSON.stringify(body)).not.toContain("token");
  });

  it("names a member with no name from their address", () => {
    expect(nameFromEmail("jordan.mertens@acme.example")).toBe("Jordan Mertens");
    expect(nameFromEmail("sam_o-brien+test@x.test")).toBe("Sam O Brien Test");
    expect(nameFromEmail("@nowhere")).toBe("@nowhere");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("an invitation still waiting", () => {
  it("can be given a new link, which is the only one that then works", async () => {
    const w = workspace();
    const first = createWorkspaceInvitation({ workspaceId: w.ws, email: "new@example.test", role: "member", invitedBy: w.id("admin") });
    db().prepare("UPDATE workspace_invitations SET expires_at = '2020-01-01T00:00:00.000Z', last_sent_at = '2020-01-01 00:00:00' WHERE id = ?").run(first.invitation.id);

    const res = await w.call(invitationsHandler, "PUT", { as: "admin", body: { id: first.invitation.id } });

    expect(res.statusCode).toBe(200);
    const link = String(res.body.invite_url);
    expect(link).toMatch(/^http:\/\/linki\.test\/invite\/linki_inv_/);
    const token = decodeURIComponent(link.split("/invite/")[1]);
    expect(token).not.toBe(first.token);
    expect(getInvitationByToken(first.token)).toBeNull();
    // Good for another seven days; copying a link is not sending one.
    expect(getInvitationByToken(token)).toMatchObject({ id: first.invitation.id, status: "pending", last_sent_at: "2020-01-01 00:00:00" });
    expect(res.body).toMatchObject({ email_sent: false, delivery_warning: null });
    expect(mail.sent).toEqual([]);
    expect(w.audit().map((entry) => entry.action)).toEqual(["workspace.invitation_link_renewed"]);
  });

  it("can be sent again from one of the workspace's mailboxes", async () => {
    const w = workspace();
    db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified) VALUES (?, ?, 'Sender', 'team@acme.test', 'smtp.test', 'u', 'p', 1)").run(`mb-${w.ws}`, w.ws);
    const first = createWorkspaceInvitation({ workspaceId: w.ws, email: "again@example.test", role: "viewer", invitedBy: w.id("admin") });

    const res = await w.call(invitationsHandler, "PUT", { as: "owner", body: { id: first.invitation.id, send_email: true } });

    expect(res.body).toMatchObject({ email_sent: true, delivery_warning: null });
    expect(mail.sent).toEqual([expect.objectContaining({ to: "again@example.test", body: expect.stringContaining(String(res.body.invite_url)) })]);
    expect(getInvitationByToken(first.token)).toBeNull();
    expect(w.audit()).toEqual([expect.objectContaining({ action: "workspace.invitation_resent", metadata_json: JSON.stringify({ email: "again@example.test", email_sent: true }) })]);
  });

  it("still gives the link when the email cannot be sent, and says why", async () => {
    const w = workspace();
    const first = createWorkspaceInvitation({ workspaceId: w.ws, email: "nomail@example.test", role: "viewer", invitedBy: w.id("admin") });
    const none = await w.call(invitationsHandler, "PUT", { as: "admin", body: { id: first.invitation.id, send_email: true } });
    expect(none.body).toMatchObject({ email_sent: false, delivery_warning: expect.stringContaining("No email sender") });
    expect(String(none.body.invite_url)).toContain("/invite/");

    db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, is_verified) VALUES (?, ?, 'Sender', 'team@acme.test', 'smtp.test', 'u', 'p', 1)").run(`mb-${w.ws}`, w.ws);
    mail.fail = true;
    const failed = await w.call(invitationsHandler, "PUT", { as: "admin", body: { id: first.invitation.id, send_email: true } });
    expect(failed.body).toMatchObject({ email_sent: false, delivery_warning: "SMTP refused the message" });
  });

  it("cannot be renewed once it has been accepted or revoked, or from another workspace, or by anyone but an admin", async () => {
    const w = workspace();
    const other = workspace();
    const invitation = createWorkspaceInvitation({ workspaceId: w.ws, email: "joiner@example.test", role: "member", invitedBy: w.id("admin") });
    const put = (as: string, from = w) => from.call(invitationsHandler, "PUT", { as, body: { id: invitation.invitation.id } });

    expect((await put("manager")).statusCode).toBe(403);
    expect((await put("admin", other)).statusCode).toBe(404);
    expect((await w.call(invitationsHandler, "PUT", { as: "admin", body: {} })).statusCode).toBe(400);

    db().prepare("INSERT INTO users (id, email, password_hash) VALUES ('joiner', 'joiner@example.test', 'x')").run();
    acceptWorkspaceInvitation(invitation.token, "joiner", "joiner@example.test");
    expect((await put("admin")).statusCode).toBe(404);
    expect(reissueWorkspaceInvitation(invitation.invitation.id, w.ws, { sent: false })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the workspace's name", () => {
  it("is changed by an admin, tidied, and the change is recorded with what it was", async () => {
    const w = workspace();
    const before = (db().prepare("SELECT name FROM workspaces WHERE id = ?").get(w.ws) as { name: string }).name;
    const res = await w.call(workspaceHandler, "PATCH", { as: "admin", body: { name: "  Acme    EMEA  " } });
    expect(res).toMatchObject({ statusCode: 200, body: { ok: true, name: "Acme EMEA" } });
    expect(db().prepare("SELECT name FROM workspaces WHERE id = ?").get(w.ws)).toEqual({ name: "Acme EMEA" });
    expect(w.audit()).toEqual([expect.objectContaining({ action: "workspace.updated", metadata_json: JSON.stringify({ name: "Acme EMEA", previous: before }) })]);
  });

  it("cannot be empty, is cut at eighty characters, and is not a manager's to change", async () => {
    const w = workspace();
    expect((await w.call(workspaceHandler, "PATCH", { as: "admin", body: { name: "   " } })).statusCode).toBe(400);
    expect((await w.call(workspaceHandler, "PATCH", { as: "admin", body: {} })).statusCode).toBe(400);
    expect((await w.call(workspaceHandler, "PATCH", { as: "manager", body: { name: "Mine" } })).statusCode).toBe(403);
    expect(cleanWorkspaceName("x".repeat(200))).toHaveLength(80);
    expect(cleanWorkspaceName(42)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("an audit entry", () => {
  it("says it was made in the app, and from where, for a browser's request", async () => {
    const w = workspace();
    await w.call(workspaceHandler, "PATCH", { as: "admin", body: { name: "Renamed" }, headers: { "x-forwarded-for": "203.0.113.17, 10.0.0.1" } });
    expect(w.audit()).toEqual([expect.objectContaining({ source: "web", ip_address: "203.0.113.17", via: null, user_id: w.id("admin") })]);
  });

  it("says it came through MCP, by which client and from where, for the MCP server's own calls", async () => {
    const w = workspace();
    // No session issue time: this is a call made with the internal secret.
    await w.call(workspaceHandler, "PATCH", {
      as: "admin", iat: "", body: { name: "Renamed by an agent" },
      headers: { [SOURCE_HEADER]: "mcp", [VIA_HEADER]: "Claude", [CLIENT_IP_HEADER]: "198.51.100.7", "x-forwarded-for": "127.0.0.1" },
    });
    expect(w.audit()).toEqual([expect.objectContaining({ source: "mcp", via: "Claude", ip_address: "198.51.100.7", user_id: w.id("admin") })]);
  });

  it("cannot be passed off as MCP by a browser sending those headers", async () => {
    const w = workspace();
    await w.call(workspaceHandler, "PATCH", { as: "admin", body: { name: "Renamed" }, headers: { [SOURCE_HEADER]: "mcp", [VIA_HEADER]: "Not really", [CLIENT_IP_HEADER]: "1.2.3.4", "x-real-ip": "203.0.113.9" } });
    expect(w.audit()).toEqual([expect.objectContaining({ source: "web", via: null, ip_address: "203.0.113.9" })]);
  });

  it("is written for a change made with an API key, naming the key", async () => {
    const w = workspace();
    const key = createApiKey({ workspaceId: w.ws, name: "Production backend", scopes: ["contacts:write", "contacts:read"] });
    const post = async (path: string[], method: string, body: unknown) => {
      const res = mockRes();
      await v1Handler({ method, headers: { authorization: `Bearer ${key.key}`, "x-forwarded-for": "198.51.100.44" }, query: { path }, body, socket: {} } as unknown as NextApiRequest, res);
      return res;
    };

    const created = await post(["contacts"], "POST", { full_name: "Ada Lovelace", linkedin_url: "https://www.linkedin.com/in/ada-api/" });
    expect(created.statusCode).toBe(201);
    const contactId = String(created.body.id);
    expect((await post(["contacts", contactId], "PATCH", { title: "Countess" })).statusCode).toBe(200);
    // A read, and a write that is refused, leave nothing.
    const read = mockRes();
    await v1Handler({ method: "GET", headers: { authorization: `Bearer ${key.key}` }, query: { path: ["contacts"] }, body: {} } as unknown as NextApiRequest, read);
    expect((await post(["contacts"], "POST", {})).statusCode).toBe(400);
    expect((await post(["opportunities"], "POST", { name: "Deal" })).statusCode).toBe(403);

    expect(w.audit()).toEqual([
      { action: "contact.created", entity_type: "contact", entity_id: contactId, user_id: null, metadata_json: null, source: "api", via: "Production backend", ip_address: "198.51.100.44" },
      { action: "contact.updated", entity_type: "contact", entity_id: contactId, user_id: null, metadata_json: null, source: "api", via: "Production backend", ip_address: "198.51.100.44" },
    ]);
    expect(listAudit(db(), w.ws, { source: "api" }, 10, 0)[0]).toMatchObject({ entity_label: "Ada Lovelace", actor: null, via: "Production backend" });
  });

  it("is named after what the public API was asked to do", () => {
    expect(apiWriteAction("POST", "contacts")).toEqual({ action: "contact.created", entityType: "contact" });
    expect(apiWriteAction("PATCH", "contacts", "c1")).toEqual({ action: "contact.updated", entityType: "contact" });
    expect(apiWriteAction("POST", "contacts", "verify")).toEqual({ action: "contact.emails_verified", entityType: "contact" });
    expect(apiWriteAction("POST", "contacts", "c1", "send")).toEqual({ action: "contact.email_sent", entityType: "contact" });
    expect(apiWriteAction("POST", "signals")).toEqual({ action: "signal.created", entityType: "signal" });
    expect(apiWriteAction("POST", "events")).toEqual({ action: "domain_event.emitted", entityType: "domain_event" });
    expect(apiWriteAction("PATCH", "opportunities", "o1")).toEqual({ action: "opportunity.updated", entityType: "opportunity" });
  });

  it("from before sources were recorded still reads, with no source", () => {
    const w = workspace();
    db().prepare("INSERT INTO audit_logs (id, workspace_id, user_id, action, entity_type, entity_id) VALUES (?, ?, ?, 'list.created', 'list', 'l1')").run(`old-${w.ws}`, w.ws, w.id("member"));
    expect(listAudit(db(), w.ws, {}, 10, 0)).toEqual([expect.objectContaining({ action: "list.created", source: null, via: null, ip_address: null, actor: expect.objectContaining({ name: "Member Person" }) })]);
    expect(auditSourceCounts(db(), w.ws)).toEqual({ all: 1, web: 0, api: 0, mcp: 0 });
    expect(countAudit(db(), w.ws, { source: "web" })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the audit log", () => {
  /** Entries from three sources, at known times. */
  function logged() {
    const w = workspace();
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'Series B push', ?)").run(`wf-${w.ws}`, w.ws);
    const add = (at: string, action: string, fields: { by?: string | null; source?: string | null; via?: string; ip?: string; type?: string; id?: string; meta?: unknown }) =>
      db().prepare("INSERT INTO audit_logs (id, workspace_id, user_id, action, entity_type, entity_id, metadata_json, ip_address, source, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(`a-${++seq}`, w.ws, fields.by === null ? null : w.id(fields.by ?? "admin"), action, fields.type ?? null, fields.id ?? null, fields.meta ? JSON.stringify(fields.meta) : null, fields.ip ?? null, fields.source ?? null, fields.via ?? null, at);
    add("2026-10-08 09:00:00", "workflow.created", { by: "manager", source: "web", ip: "92.168.4.21", type: "workflow", id: `wf-${w.ws}` });
    add("2026-10-09 10:00:00", "run.status_changed", { by: "admin", source: "mcp", via: "Claude", ip: "198.51.100.7", type: "run", id: "gone", meta: { status: "paused" } });
    add("2026-10-09 11:00:00", "contact.created", { by: null, source: "api", via: "Production backend", ip: "203.0.113.17", type: "contact", id: "c-gone" });
    add("2026-10-10 12:00:00", "workspace.member_role_changed", { by: "owner", source: "web", ip: "92.168.4.8", type: "user", id: w.id("viewer"), meta: { role: "viewer", previous: "member" } });
    add("2026-10-10 12:00:00", "api_key.created", { by: "owner", source: "web", type: "api_key", id: "k-gone" });
    return w;
  }
  const page = async (w: ReturnType<typeof workspace>, query: Record<string, string> = {}, as = "admin") => (await w.call(auditHandler, "GET", { as, query: { view: "list", ...query } })).body as unknown as AuditPage;

  it("is read newest first, a page at a time, with names and a count per source", async () => {
    const w = logged();
    const first = await page(w, { limit: "2" });
    expect(first).toMatchObject({ total: 5, page: 1, page_size: 2, keep_months: 12, counts: { all: 5, web: 3, api: 1, mcp: 1 } });
    expect(first.entries.map((entry) => entry.action)).toEqual(["api_key.created", "workspace.member_role_changed"]);
    const second = await page(w, { limit: "2", page: "2" });
    expect(second.entries.map((entry) => entry.action)).toEqual(["contact.created", "run.status_changed"]);
    const third = await page(w, { limit: "2", page: "3" });
    expect(third.entries).toEqual([expect.objectContaining({ action: "workflow.created", entity_label: "Series B push", source: "web", ip_address: "92.168.4.21", actor: expect.objectContaining({ name: "Manager Person" }) })]);
    // Who a role change was about, by name; and what it said.
    expect(first.entries[1]).toMatchObject({ entity_label: "Viewer Person", metadata: { role: "viewer", previous: "member" } });
  });

  it("can be narrowed by source, person, text and date", async () => {
    const w = logged();
    const actions = async (query: Record<string, string>) => (await page(w, query)).entries.map((entry) => entry.action);
    expect(await actions({ source: "mcp" })).toEqual(["run.status_changed"]);
    expect(await actions({ source: "api" })).toEqual(["contact.created"]);
    expect(await actions({ source: "web" })).toHaveLength(3);
    expect(await actions({ source: "carrier-pigeon" })).toHaveLength(5);
    expect(await actions({ user_id: w.id("owner") })).toEqual(["api_key.created", "workspace.member_role_changed"]);
    expect(await actions({ q: "role changed" })).toEqual(["workspace.member_role_changed"]);
    expect(await actions({ q: "Production" })).toEqual(["contact.created"]);
    expect(await actions({ q: "198.51" })).toEqual(["run.status_changed"]);
    expect(await actions({ q: "manager" })).toEqual(["workflow.created"]);
    expect(await actions({ q: "100%" })).toEqual([]);
    expect(await actions({ from: "2026-10-09", to: "2026-10-09" })).toEqual(["contact.created", "run.status_changed"]);
    expect(await actions({ from: "2026-10-10" })).toHaveLength(2);
    expect((await page(w, { source: "mcp" })).total).toBe(1);
  });

  it("is an admin's to read, in the app or as a file", async () => {
    const w = logged();
    for (const as of ["viewer", "member", "manager"]) {
      expect((await w.call(auditHandler, "GET", { as, query: { view: "list" } })).statusCode, as).toBe(403);
      expect((await w.call(auditHandler, "GET", { as, query: { format: "csv" } })).statusCode, as).toBe(403);
    }
    expect((await w.call(auditHandler, "GET", { as: "owner", query: { view: "list" } })).statusCode).toBe(200);
    expect((await w.call(auditHandler, "POST", { as: "owner" })).statusCode).toBe(405);
  });

  it("shows only its own workspace's entries", async () => {
    const w = logged();
    const other = logged();
    const entries = (await page(w)).entries;
    expect(entries).toHaveLength(5);
    expect(entries.every((entry) => entry.entity_id !== `wf-${other.ws}`)).toBe(true);
  });

  it("downloads what is being looked at as a spreadsheet file, and notes that it was taken", async () => {
    const w = logged();
    db().prepare("INSERT INTO audit_logs (id, workspace_id, user_id, action, entity_type, entity_id, source, created_at) VALUES (?, ?, NULL, '=cmd|calc', 'x', 'y', 'web', '2026-10-01 00:00:00')").run(`evil-${w.ws}`, w.ws);

    const res = await w.call(auditHandler, "GET", { as: "admin", query: { format: "csv", source: "web" } });

    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="linki-audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = res.text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Time (UTC),Who,Email,Action,What,Name,Id,Source,Through,IP address,Details");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain("workspace.member_role_changed,user,Viewer Person");
    expect(lines[2]).toContain('"{""role"":""viewer"",""previous"":""member""}"');
    expect(lines.some((line) => line.includes("run.status_changed"))).toBe(false);
    // Text a spreadsheet would run as a formula is written as text.
    expect(lines[4]).toContain("'=cmd|calc");
    expect(w.audit().at(-1)).toMatchObject({ action: "audit_log.downloaded", metadata_json: JSON.stringify({ entries: 4, source: "web" }), user_id: w.id("admin") });
  });

  it("still answers the plain request with stored rows, as the MCP tool reads them", async () => {
    const w = logged();
    const res = await w.call(auditHandler, "GET", { as: "admin", query: { limit: "2" } });
    expect(Array.isArray(res.body)).toBe(true);
    const rows = res.body as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ action: "workspace.member_role_changed", user_email: expect.stringContaining("owner"), metadata_json: JSON.stringify({ role: "viewer", previous: "member" }), source: "web", ip_address: "92.168.4.8" });
  });

  it("keeps twelve months and no more", () => {
    const w = workspace();
    const add = (id: string, at: string) => db().prepare("INSERT INTO audit_logs (id, workspace_id, action, created_at) VALUES (?, ?, 'list.created', ?)").run(`${w.ws}-${id}`, w.ws, at);
    const monthsAgo = (months: number, days = 0) => {
      const date = new Date();
      date.setUTCMonth(date.getUTCMonth() - months);
      date.setUTCDate(date.getUTCDate() - days);
      return date.toISOString().slice(0, 19).replace("T", " ");
    };
    add("fresh", monthsAgo(0));
    add("eleven", monthsAgo(11));
    add("nearly", monthsAgo(12, -2));
    add("past", monthsAgo(12, 2));
    add("ancient", "2020-01-01 00:00:00");

    expect(AUDIT_KEEP_MONTHS).toBe(12);
    expect(pruneAuditLog(db())).toBeGreaterThanOrEqual(2);
    expect((db().prepare("SELECT id FROM audit_logs WHERE workspace_id = ? ORDER BY created_at DESC").all(w.ws) as Array<{ id: string }>).map((row) => row.id.replace(`${w.ws}-`, ""))).toEqual(["fresh", "eleven", "nearly"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a member's own account", () => {
  it("shows who they are and where they belong", async () => {
    const w = workspace();
    const other = workspace();
    db().prepare("INSERT INTO workspace_members (workspace_id, user_id, role, suspended_at) VALUES (?, ?, 'admin', datetime('now'))").run(other.ws, w.id("member"));
    const res = await w.call(accountHandler, "GET", { as: "member" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: w.id("member"), name: "Member Person", shown_as: "Member Person", email_verified: false });
    expect((res.body.workspaces as unknown[])).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: w.ws, role: "member", current: true, suspended: false }),
      expect.objectContaining({ id: other.ws, role: "admin", current: false, suspended: true }),
    ]));
    expect(JSON.stringify(res.body)).not.toContain("password");
  });

  it("lets anyone, a viewer too, change their own name and nobody else's", async () => {
    const w = workspace();
    const res = await w.call(accountHandler, "PUT", { as: "viewer", body: { name: "  Hannah   Weiss " } });
    expect(res.body).toMatchObject({ name: "Hannah Weiss", shown_as: "Hannah Weiss" });
    expect(db().prepare("SELECT name FROM users WHERE id = ?").get(w.id("viewer"))).toEqual({ name: "Hannah Weiss" });
    expect(db().prepare("SELECT name FROM users WHERE id = ?").get(w.id("admin"))).toEqual({ name: "Admin Person" });
  });

  it("goes back to the address when the name is cleared, and refuses one that is too long or not text", async () => {
    const w = workspace();
    const cleared = await w.call(accountHandler, "PUT", { as: "member", body: { name: "   " } });
    expect(cleared.body).toMatchObject({ name: "", shown_as: `Member${w.ws.split("-").pop()}` });
    expect((await w.call(accountHandler, "PUT", { as: "member", body: { name: "x".repeat(81) } })).statusCode).toBe(400);
    expect((await w.call(accountHandler, "PUT", { as: "member", body: {} })).statusCode).toBe(400);
    expect((await w.call(accountHandler, "DELETE", { as: "member" })).statusCode).toBe(405);
  });

  it("is not there for a call made on no member's behalf", async () => {
    const w = workspace();
    const res = mockRes();
    await accountHandler({ method: "GET", headers: ctxHeaders(w.ws, { role: "admin" }), query: {}, body: {} } as unknown as NextApiRequest, res);
    expect(res.statusCode).toBe(403);
  });
});
