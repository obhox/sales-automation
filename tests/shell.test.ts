// The frame around every page: who may open a page at all, the counts and health the
// sidebar shows, search, notifications, and making another workspace. Real proxy, real
// routes, throwaway database.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

vi.mock("@/lib/linkedin/runner", () => ({ ensureGlobalRunnerStarted: vi.fn() }));

import { isPublicPage, proxy } from "@/proxy";
import shell, { nameFromEmail } from "@/pages/api/shell";
import search from "@/pages/api/search";
import notifications from "@/pages/api/notifications";
import workspaces from "@/pages/api/platform/workspaces";
import { listNotifications, notify, unreadNotificationCount } from "@/lib/platform/notifications";
import { readRunnerHealth } from "@/lib/system/health";
import { watchRunnerHealth } from "@/lib/system/health-watch";
import { evaluateSenderHealth } from "@/lib/email/infrastructure";
import { markNeedsReauth } from "@/lib/linkedin/session";
import { MAX_OWNED_WORKSPACES } from "@/lib/workspace";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
async function call(handler: Handler, req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await handler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> };
}

function workspace() {
  const n = ++seq;
  const ws = `ws-shell-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, `Shell ${n}`, ws);
  const ids = { owner: `shell-owner-${n}`, admin: `shell-admin-${n}`, member: `shell-member-${n}`, viewer: `shell-viewer-${n}` };
  return {
    ws, n, ids,
    owner: ctxHeaders(ws, { userId: ids.owner, role: "owner" }),
    admin: ctxHeaders(ws, { userId: ids.admin, role: "admin" }),
    member: ctxHeaders(ws, { userId: ids.member, role: "member" }),
    viewer: ctxHeaders(ws, { userId: ids.viewer, role: "viewer" }),
  };
}

const clearLeases = () => db().prepare("DELETE FROM worker_leases").run();
const lease = (name: string, minutesAgo: number) =>
  db().prepare("INSERT OR REPLACE INTO worker_leases (name, owner_id, expires_at, heartbeat_at) VALUES (?, 'test', datetime('now', '+1 minute'), datetime('now', ?))").run(name, `-${minutesAgo} minutes`);

afterEach(() => {
  delete process.env.LINKI_RUNNER;
  clearLeases();
});

// ── Who may open a page ───────────────────────────────────────────────────────
describe("opening a page", () => {
  const page = (path: string, cookie?: string) => proxy(new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} }));
  let cookie: string;
  beforeAll(async () => {
    cookie = `next-auth.session-token=${await encode({ token: { userId: "u-page", workspaceId: "ws-page", role: "member" }, secret: process.env.NEXTAUTH_SECRET! })}`;
  });

  it("sends a signed-out visitor to sign in, and remembers where they were going", async () => {
    const res = await page("/contacts/abc?tab=timeline");
    expect(res.status).toBe(307);
    const target = new URL(res.headers.get("location")!);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("callbackUrl")).toBe("/contacts/abc?tab=timeline");
  });

  it("does not add a return address for the home page", async () => {
    const res = await page("/");
    expect(new URL(res.headers.get("location")!).search).toBe("");
  });

  it("lets a signed-in member through", async () => {
    expect((await page("/contacts", cookie)).headers.get("location")).toBeNull();
    expect((await page("/dev/ui", cookie)).status).toBe(200);
  });

  it("leaves the sign-in flow, invitations and shared reports open to anyone", async () => {
    for (const path of ["/login", "/reset-password", "/verify-email", "/invite/some-token", "/r/some-token"]) {
      expect((await page(path)).headers.get("location"), path).toBeNull();
      expect(isPublicPage(path), path).toBe(true);
    }
    expect(isPublicPage("/logins")).toBe(false);
    expect(isPublicPage("/")).toBe(false);
  });

  it("serves files from /public without a session", async () => {
    for (const path of ["/logo_linki.svg", "/favicon.ico", "/linki-wordmark.svg"]) expect((await page(path)).headers.get("location"), path).toBeNull();
  });

  it("still answers a signed-out API call with 401, not a redirect", async () => {
    const res = await page("/api/shell");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });
});

// ── Notifications ─────────────────────────────────────────────────────────────
describe("notifications", () => {
  it("reach everyone at or above the role they are raised for, and no one below", () => {
    const w = workspace();
    notify({ workspaceId: w.ws, kind: "reply.positive", title: "For members" });
    notify({ workspaceId: w.ws, kind: "runner.stalled", title: "For admins", minRole: "admin" });
    const titles = (id: string, role: Parameters<typeof listNotifications>[2]) => listNotifications(w.ws, id, role).map(row => row.title).sort();
    expect(titles(w.ids.owner, "owner")).toEqual(["For admins", "For members"]);
    expect(titles(w.ids.admin, "admin")).toEqual(["For admins", "For members"]);
    expect(titles(w.ids.member, "member")).toEqual(["For members"]);
    expect(titles(w.ids.viewer, "viewer")).toEqual([]);
  });

  it("can be addressed to one member", () => {
    const w = workspace();
    notify({ workspaceId: w.ws, kind: "import.finished", title: "Yours", userId: w.ids.member });
    expect(listNotifications(w.ws, w.ids.member, "member").map(row => row.title)).toEqual(["Yours"]);
    expect(listNotifications(w.ws, w.ids.owner, "owner")).toEqual([]);
  });

  it("keep read state per member", async () => {
    const w = workspace();
    const id = notify({ workspaceId: w.ws, kind: "reply.positive", title: "A reply" })!;
    notify({ workspaceId: w.ws, kind: "reply.positive", title: "Another" });
    expect(unreadNotificationCount(w.ws, w.ids.member, "member")).toBe(2);

    const read = await call(notifications, { method: "POST", headers: w.member, body: { action: "read", id } });
    expect(read.body).toEqual({ unread: 1 });
    // The owner has not read anything.
    expect(unreadNotificationCount(w.ws, w.ids.owner, "owner")).toBe(2);

    const all = await call(notifications, { method: "POST", headers: w.member, body: { action: "read_all" } });
    expect(all.body).toEqual({ unread: 0 });
    const listed = await call(notifications, { method: "GET", headers: w.member });
    expect((listed.body.notifications as { read: boolean }[]).every(row => row.read)).toBe(true);
    expect(listed.body.unread).toBe(0);
  });

  it("raise a lasting condition once", () => {
    const w = workspace();
    expect(notify({ workspaceId: w.ws, kind: "mailbox.paused", title: "Paused", dedupeKey: "mailbox-paused:m1:2026-10-10" })).not.toBeNull();
    expect(notify({ workspaceId: w.ws, kind: "mailbox.paused", title: "Paused again", dedupeKey: "mailbox-paused:m1:2026-10-10" })).toBeNull();
    expect(listNotifications(w.ws, w.ids.owner, "owner")).toHaveLength(1);
    // The same key in another workspace is a different notification.
    const other = workspace();
    expect(notify({ workspaceId: other.ws, kind: "mailbox.paused", title: "Paused", dedupeKey: "mailbox-paused:m1:2026-10-10" })).not.toBeNull();
  });

  it("never cross workspaces, and cannot be marked read from another one", async () => {
    const a = workspace();
    const b = workspace();
    const id = notify({ workspaceId: a.ws, kind: "reply.positive", title: "In A" })!;
    expect(listNotifications(b.ws, b.ids.owner, "owner")).toEqual([]);
    await call(notifications, { method: "POST", headers: b.owner, body: { action: "read", id } });
    expect((db().prepare("SELECT COUNT(*) AS c FROM notification_reads WHERE notification_id = ?").get(id) as { c: number }).c).toBe(0);
  });

  it("are dropped after sixty days", () => {
    const w = workspace();
    const old = notify({ workspaceId: w.ws, kind: "reply.positive", title: "Old" })!;
    db().prepare("UPDATE notifications SET created_at = datetime('now', '-61 days') WHERE id = ?").run(old);
    notify({ workspaceId: w.ws, kind: "reply.positive", title: "New" });
    expect(listNotifications(w.ws, w.ids.owner, "owner").map(row => row.title)).toEqual(["New"]);
  });

  it("refuse an action they do not know", async () => {
    const w = workspace();
    expect((await call(notifications, { method: "POST", headers: w.member, body: { action: "delete" } })).statusCode).toBe(400);
    expect((await call(notifications, { method: "POST", headers: w.member, body: { action: "read" } })).statusCode).toBe(400);
  });
});

describe("what raises a notification", () => {
  it("a LinkedIn account losing its session, once", async () => {
    const w = workspace();
    db().prepare("INSERT INTO accounts (id, name, email, is_authenticated, workspace_id) VALUES (?, 'Priya Raghavan', 'p@example.test', 1, ?)").run(`acct-${w.n}`, w.ws);
    await markNeedsReauth(`acct-${w.n}`);
    await markNeedsReauth(`acct-${w.n}`);
    const rows = listNotifications(w.ws, w.ids.member, "member");
    expect(rows.map(row => row.title)).toEqual(["Priya Raghavan needs to sign in to LinkedIn again"]);
    expect(rows[0]).toMatchObject({ kind: "linkedin.signin_needed", tone: "bad" });
    const events = db().prepare("SELECT COUNT(*) AS c FROM domain_events WHERE workspace_id = ? AND type = 'linkedin.signin_needed'").get(w.ws) as { c: number };
    expect(events.c).toBe(1);
  });

  it("a mailbox paused for its bounce rate", () => {
    const w = workspace();
    const mailbox = `mb-${w.n}`;
    db().prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password, min_health_sample, bounce_threshold) VALUES (?, ?, 'Sender', 'ops@acme.test', 'smtp.test', 'u', 'p', 4, 0.2)").run(mailbox, w.ws);
    for (let i = 0; i < 5; i++) {
      const job = `job-${w.n}-${i}`;
      db().prepare("INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, recipient, subject, body_text, status) VALUES (?, ?, ?, ?, 'x@y.test', 's', 'b', 'sent')").run(job, w.ws, mailbox, job);
      db().prepare("INSERT INTO sent_messages (id, workspace_id, email_account_id, job_id, message_id, recipient, subject) VALUES (?, ?, ?, ?, ?, 'x@y.test', 's')").run(`sm-${job}`, w.ws, mailbox, job, `<${job}@acme.test>`);
    }
    for (let i = 0; i < 2; i++) db().prepare("INSERT INTO sender_events (id, workspace_id, email_account_id, provider, event_type, occurred_at) VALUES (?, ?, ?, 'imap', 'bounced', datetime('now'))").run(`ev-${w.n}-${i}`, w.ws, mailbox);

    expect(evaluateSenderHealth(mailbox)?.paused).toBe(true);
    evaluateSenderHealth(mailbox);
    const rows = listNotifications(w.ws, w.ids.member, "member");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "mailbox.paused", tone: "bad", title: "ops@acme.test was paused" });
    expect(rows[0].body).toMatch(/bounce rate 40\.00% exceeds 20\.00%/);
  });
});

// ── Runner health ─────────────────────────────────────────────────────────────
describe("runner health", () => {
  it("is idle before any loop has started, healthy when all report, degraded when one has not", () => {
    clearLeases();
    expect(readRunnerHealth(db())).toMatchObject({ status: "idle", loops: [] });
    lease("linkedin-runner", 1);
    lease("email-jobs-runner", 0);
    expect(readRunnerHealth(db())).toMatchObject({ status: "healthy", summary: "All runners healthy" });
    lease("email-jobs-runner", 20);
    const degraded = readRunnerHealth(db());
    expect(degraded).toMatchObject({ status: "degraded", summary: "Email sender stalled" });
    expect(degraded.loops.find(loop => loop.name === "email-jobs-runner")).toMatchObject({ stalled: true, label: "Email sender" });
    lease("linkedin-runner", 30);
    expect(readRunnerHealth(db()).summary).toBe("2 runners stalled");
  });

  it("says so when background work is switched off", () => {
    lease("linkedin-runner", 99);
    process.env.LINKI_RUNNER = "off";
    expect(readRunnerHealth(db())).toEqual({ status: "off", summary: "Background work is off", loops: [] });
  });

  it("tells each workspace's admins about a stalled loop, once a day", () => {
    const w = workspace();
    clearLeases();
    lease("linkedin-runner", 25);
    lease("email-jobs-runner", 0);
    expect(watchRunnerHealth(db())).toEqual(["linkedin-runner"]);
    expect(watchRunnerHealth(db())).toEqual(["linkedin-runner"]);
    const forAdmin = listNotifications(w.ws, w.ids.admin, "admin").filter(row => row.kind === "runner.stalled");
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0].title).toBe("LinkedIn runner has stalled");
    expect(listNotifications(w.ws, w.ids.member, "member").filter(row => row.kind === "runner.stalled")).toEqual([]);
  });

  it("raises nothing when all is well or when background work is off", () => {
    const w = workspace();
    clearLeases();
    lease("linkedin-runner", 1);
    expect(watchRunnerHealth(db())).toEqual([]);
    lease("linkedin-runner", 40);
    process.env.LINKI_RUNNER = "off";
    expect(watchRunnerHealth(db())).toEqual([]);
    expect(listNotifications(w.ws, w.ids.owner, "owner")).toEqual([]);
  });
});

// ── The frame's data ──────────────────────────────────────────────────────────
describe("the app frame", () => {
  it("names a member from their email until they set a name", () => {
    expect(nameFromEmail("jordan.mertens@acme.test")).toBe("Jordan Mertens");
    expect(nameFromEmail("priya@acme.test")).toBe("Priya");
    expect(nameFromEmail("a_b-c+d@acme.test")).toBe("A B C D");
  });

  it("returns the member, the workspaces they can switch to, and the counts", async () => {
    const w = workspace();
    const other = workspace();
    db().prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'viewer')").run(other.ws, w.ids.member);
    db().prepare("UPDATE users SET name = 'Mia Chen' WHERE id = ?").run(w.ids.member);

    db().prepare("INSERT INTO targets (id, workspace_id, full_name) VALUES (?, ?, 'Lee'), (?, ?, 'Mo')").run(`t1-${w.n}`, w.ws, `t2-${w.n}`, w.ws);
    const reply = db().prepare("INSERT INTO email_replies (id, workspace_id, target_id, from_email, body_text, received_at, inbox_status) VALUES (?, ?, ?, 'x@y.test', 'hi', ?, ?)");
    // Lee: an older closed reply and a newer open one count once. Mo: latest is closed.
    reply.run(`r1-${w.n}`, w.ws, `t1-${w.n}`, "2026-10-01T10:00:00Z", "closed");
    reply.run(`r2-${w.n}`, w.ws, `t1-${w.n}`, "2026-10-02T10:00:00Z", "open");
    reply.run(`r3-${w.n}`, w.ws, `t2-${w.n}`, "2026-10-01T10:00:00Z", "open");
    reply.run(`r4-${w.n}`, w.ws, `t2-${w.n}`, "2026-10-03T10:00:00Z", "closed");
    db().prepare("INSERT INTO todos (id, workspace_id, target_id, title, status) VALUES (?, ?, ?, 'Call', 'open'), (?, ?, ?, 'Done', 'done')").run(`td1-${w.n}`, w.ws, `t1-${w.n}`, `td2-${w.n}`, w.ws, `t1-${w.n}`);
    db().prepare("INSERT INTO signals (id, workspace_id, type, title, occurred_at) VALUES (?, ?, 'funding', 'Raised', datetime('now'))").run(`sg-${w.n}`, w.ws);
    notify({ workspaceId: w.ws, kind: "reply.positive", title: "A reply" });

    const res = await call(shell, { method: "GET", headers: w.member });
    expect(res.statusCode).toBe(200);
    expect(res.body.user).toMatchObject({ id: w.ids.member, name: "Mia Chen", role: "member" });
    expect(res.body.workspace).toEqual({ id: w.ws, name: `Shell ${w.n}` });
    expect((res.body.workspaces as { id: string; role: string }[]).map(item => `${item.id}:${item.role}`).sort()).toEqual([`${other.ws}:viewer`, `${w.ws}:member`].sort());
    expect(res.body.counts).toEqual({ inbox: 1, tasks: 1, signals: 1, notifications: 1 });
    expect(res.body.version).toHaveProperty("current");
  });

  it("counts only this workspace", async () => {
    const a = workspace();
    const b = workspace();
    db().prepare("INSERT INTO targets (id, workspace_id, full_name) VALUES (?, ?, 'Lee')").run(`ta-${a.n}`, a.ws);
    db().prepare("INSERT INTO todos (id, workspace_id, target_id, title) VALUES (?, ?, ?, 'Call')").run(`tda-${a.n}`, a.ws, `ta-${a.n}`);
    expect((await call(shell, { method: "GET", headers: b.owner })).body.counts).toEqual({ inbox: 0, tasks: 0, signals: 0, notifications: 0 });
  });

  it("tells admins which loop is behind and everyone else only that work is delayed", async () => {
    const w = workspace();
    clearLeases();
    lease("email-jobs-runner", 30);
    expect((await call(shell, { method: "GET", headers: w.admin })).body.health).toEqual({ status: "degraded", summary: "Email sender stalled" });
    expect((await call(shell, { method: "GET", headers: w.member })).body.health).toEqual({ status: "degraded", summary: "Background work is delayed" });
  });

  it("is refused for a call that is not a member's", async () => {
    const w = workspace();
    expect((await call(shell, { method: "GET", headers: ctxHeaders(w.ws, { role: "owner" }) })).statusCode).toBe(403);
    expect((await call(shell, { method: "POST", headers: w.owner })).statusCode).toBe(405);
  });
});

// ── Search ────────────────────────────────────────────────────────────────────
describe("search", () => {
  function seeded() {
    const w = workspace();
    const t = db().prepare("INSERT INTO targets (id, workspace_id, full_name, email, title, company) VALUES (?, ?, ?, ?, ?, ?)");
    t.run(`s1-${w.n}`, w.ws, "Marcus Oyelaran", "m.oyelaran@northwind.test", "VP Revenue Ops", "Northwind Logistics");
    t.run(`s2-${w.n}`, w.ws, "Anna Marcussen", "anna@fjord.test", null, "Fjord Maritime");
    t.run(`s3-${w.n}`, w.ws, "Li Wei", "li@100%real.test", "CRO", null);
    db().prepare("INSERT INTO companies (id, workspace_id, name, domain) VALUES (?, ?, 'Northwind Logistics', 'northwind.test')").run(`c1-${w.n}`, w.ws);
    db().prepare("INSERT INTO workflows (id, workspace_id, name, is_archived) VALUES (?, ?, 'Northwind push', 0), (?, ?, 'Northwind 2025', 1)").run(`w1-${w.n}`, w.ws, `w2-${w.n}`, w.ws);
    db().prepare("INSERT INTO lists (id, workspace_id, name) VALUES (?, ?, 'Northwind ICP')").run(`l1-${w.n}`, w.ws);
    db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(`l1-${w.n}`, `s1-${w.n}`);
    db().prepare("INSERT INTO templates (id, workspace_id, name, body) VALUES (?, ?, 'Northwind opener', 'Hi')").run(`tp-${w.n}`, w.ws);
    return w;
  }
  const find = async (headers: Record<string, string>, q: string) => ((await call(search, { method: "GET", headers, query: { q } })).body.results ?? []) as { kind: string; title: string; subtitle: string | null }[];

  it("finds contacts, companies, campaigns, lists and templates", async () => {
    const w = seeded();
    const results = await find(w.viewer, "northwind");
    expect(results.map(row => `${row.kind}:${row.title}`)).toEqual([
      "contact:Marcus Oyelaran", "company:Northwind Logistics", "campaign:Northwind push", "campaign:Northwind 2025", "list:Northwind ICP", "template:Northwind opener",
    ]);
    expect(results.find(row => row.kind === "contact")?.subtitle).toBe("VP Revenue Ops · Northwind Logistics");
    expect(results.find(row => row.title === "Northwind 2025")?.subtitle).toBe("Archived");
    expect(results.find(row => row.kind === "list")?.subtitle).toBe("1 contacts");
  });

  it("puts names that start with the text ahead of names that contain it", async () => {
    const w = seeded();
    expect((await find(w.member, "marcus")).map(row => row.title)).toEqual(["Marcus Oyelaran", "Anna Marcussen"]);
  });

  it("matches a contact by email", async () => {
    const w = seeded();
    expect((await find(w.member, "anna@fjord")).map(row => row.title)).toEqual(["Anna Marcussen"]);
  });

  it("treats % and _ as text, not wildcards", async () => {
    const w = seeded();
    expect(await find(w.member, "%%")).toEqual([]);
    expect(await find(w.member, "__")).toEqual([]);
    expect((await find(w.member, "100%real")).map(row => row.title)).toEqual(["Li Wei"]);
  });

  it("needs two characters, and stays inside the workspace", async () => {
    const w = seeded();
    const other = workspace();
    expect(await find(w.member, "n")).toEqual([]);
    expect(await find(other.owner, "northwind")).toEqual([]);
  });
});

// ── Another workspace ─────────────────────────────────────────────────────────
describe("making another workspace", () => {
  it("gives its creator a workspace they own, with pipeline stages, whatever their role here", async () => {
    const w = workspace();
    const res = await call(workspaces, { method: "POST", headers: w.viewer, body: { name: "  Acme   EMEA " } });
    expect(res.statusCode).toBe(201);
    expect(res.body.name).toBe("Acme EMEA");
    const id = String(res.body.id);
    expect(db().prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(id, w.ids.viewer)).toEqual({ role: "owner" });
    expect((db().prepare("SELECT COUNT(*) AS c FROM pipeline_stages WHERE workspace_id = ?").get(id) as { c: number }).c).toBeGreaterThan(3);
    expect(db().prepare("SELECT action FROM audit_logs WHERE workspace_id = ?").get(id)).toEqual({ action: "workspace.created" });

    const listed = await call(workspaces, { method: "GET", headers: w.viewer });
    expect((listed.body.workspaces as { id: string }[]).map(item => item.id).sort()).toEqual([id, w.ws].sort());
    expect(listed.body.current).toBe(w.ws);
  });

  it("needs a name, and stops at a sane number", async () => {
    const w = workspace();
    expect((await call(workspaces, { method: "POST", headers: w.member, body: { name: "   " } })).statusCode).toBe(400);
    for (let i = 0; i < MAX_OWNED_WORKSPACES; i++) expect((await call(workspaces, { method: "POST", headers: w.member, body: { name: `W ${i}` } })).statusCode).toBe(201);
    const over = await call(workspaces, { method: "POST", headers: w.member, body: { name: "One too many" } });
    expect(over.statusCode).toBe(400);
    expect(String(over.body.error)).toMatch(/already own/);
  });
});
