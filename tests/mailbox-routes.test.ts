// The Mailboxes screen's server side: the overview it reads, what a save accepts, the
// workspace's rotation and fail-over choices and what they do to who is given which
// mailbox, the disconnected state, and the upcoming sends. Real (throwaway) database, no
// network: the mail server is never reached.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { IMAP_FAILURES_TO_DISCONNECT, markConnected, markDisconnected, noteImapSignIn } from "@/lib/email/connection";
import { moveWaitingContacts } from "@/lib/email/failover";
import { evaluateSenderHealth, readSenderHealth, sendEmailDurably, SenderDisconnectedError } from "@/lib/email/infrastructure";
import { emailsSentToday, mailboxQueue, type MailboxView, type MailboxesOverview } from "@/lib/email/mailbox-list";
import { getMailboxRotation } from "@/lib/email/mailbox-settings";
import { domainsDueForCheck, lastSelector, recheckDueDomains } from "@/lib/email/upkeep";
import { assignEmailAccounts } from "@/lib/outreach/enroll";
import { processWarmupCycle } from "@/lib/platform/deliverability";
import { listNotifications } from "@/lib/platform/notifications";
import { setWorkspaceSwitch } from "@/lib/workspace-settings";
import accountsHandler from "@/pages/api/email-accounts/index";
import accountHandler from "@/pages/api/email-accounts/[id]/index";
import queueHandler from "@/pages/api/email-accounts/[id]/queue";
import settingsHandler from "@/pages/api/email-accounts/settings";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown> };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res as unknown as Res;
}

/** A workspace, a way to call a route as one of its members, and ways to fill it. */
function workspace() {
  const n = ++seq;
  const ws = `ws-mbx-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const call = async (handler: (req: NextApiRequest, res: NextApiResponse) => unknown, method: string, opts: { id?: string; body?: unknown; query?: Record<string, string>; role?: string } = {}) => {
    const res = mockRes();
    const role = opts.role ?? "admin";
    await handler({ method, body: opts.body ?? {}, query: { ...(opts.id ? { id: opts.id } : {}), ...(opts.query ?? {}) }, headers: ctxHeaders(ws, { userId: `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
    return res;
  };
  const mailbox = (address: string, fields: Record<string, unknown> = {}) => {
    const id = `mbx-${++seq}`;
    db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, imap_host, username, password, imap_password, is_verified, daily_email_limit, ramp_up_enabled, timezone, created_at)
      VALUES (?, ?, ?, ?, 'smtp.test', 'imap.test', ?, 'enc:smtp-secret', 'enc:imap-secret', 1, 50, 0, 'UTC', datetime('now', ?))`).run(id, ws, address, address, address, `-${1000 - seq} seconds`);
    for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE email_accounts SET ${column} = ? WHERE id = ?`).run(value, id);
    return id;
  };
  const overview = async () => (await call(accountsHandler, "GET", { query: { view: "overview" } })).body as unknown as MailboxesOverview;
  const view = async (id: string) => (await overview()).domains.flatMap((domain) => domain.mailboxes).find((mailbox) => mailbox.id === id) as MailboxView;
  return { ws, call, mailbox, overview, view };
}

type Workspace = ReturnType<typeof workspace>;

/** A running email campaign whose contacts are with the given mailboxes. */
function campaign(w: Workspace, contacts: Array<{ mailbox: string; company?: string; emailed?: "sent" | "pending" | "uncertain"; state?: string; nextAt?: string | null; step?: number }>, status = "running") {
  const n = ++seq;
  const workflow = `mbx-wf-${n}`;
  const run = `mbx-run-${n}`;
  db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, ?, ?)").run(workflow, `Campaign ${n}`, w.ws);
  for (const order of [1, 2, 3]) {
    db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body) VALUES (?, ?, ?, 'email', 'email', 0, 'Hi', 'Body')").run(`${workflow}-s${order}`, workflow, order);
  }
  db().prepare("INSERT INTO runs (id, workflow_id, status, workspace_id) VALUES (?, ?, ?, ?)").run(run, workflow, status, w.ws);
  const targets = contacts.map((contact, index) => {
    const target = `mbx-t-${n}-${index}`;
    if (contact.company) db().prepare("INSERT OR IGNORE INTO companies (id, name, workspace_id) VALUES (?, ?, ?)").run(`${w.ws}-${contact.company}`, contact.company, w.ws);
    db().prepare("INSERT INTO targets (id, workspace_id, full_name, company, company_id, email, linkedin_url) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(target, w.ws, `Contact ${n}-${index}`, contact.company ?? null, contact.company ? `${w.ws}-${contact.company}` : null, `c${n}-${index}@prospect.test`, `https://www.linkedin.com/in/mbx-${n}-${index}/`);
    db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`${target}-rp`, run, target, contact.mailbox);
    db().prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at) VALUES (?, ?, 'email', ?, ?, ?)")
      .run(`${target}-rt`, `${target}-rp`, contact.state ?? (contact.emailed === "sent" ? "in_progress" : "pending"), contact.step ?? (contact.emailed === "sent" ? 1 : 0), contact.nextAt ?? null);
    if (contact.emailed) {
      db().prepare(`INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, source, target_id, run_id, step_id, recipient, subject, body_text, status)
        VALUES (?, ?, ?, ?, 'campaign', ?, ?, ?, ?, 'Hi', 'Body', ?)`).run(`${target}-job`, w.ws, contact.mailbox, `${target}-key`, target, run, `${workflow}-s1`, `c${n}-${index}@prospect.test`, contact.emailed);
    }
    return target;
  });
  const mailboxOf = (target: string) => (db().prepare("SELECT email_account_id FROM run_profiles WHERE target_id = ? AND run_id = ?").get(target, run) as { email_account_id: string }).email_account_id;
  return { run, workflow, targets, mailboxOf };
}

/** Record campaign emails as the runner does: a line in the run log, and a row in step_sends. */
function recordSends(w: Workspace, c: ReturnType<typeof campaign>, target: string, mailbox: string, count: number, when = "+0 seconds") {
  for (let i = 0; i < count; i++) {
    db().prepare("INSERT INTO logs (id, run_id, target_id, level, message, created_at) VALUES (?, ?, ?, 'info', 'Email sent to someone', datetime('now', ?))").run(`mbx-log-${++seq}`, c.run, target, when);
    db().prepare("INSERT INTO step_sends (id, workspace_id, run_id, workflow_id, step_id, target_id, channel, action, email_account_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'email', 'email', ?, datetime('now', ?))")
      .run(`mbx-ss-${++seq}`, w.ws, c.run, c.workflow, `${c.workflow}-s1`, target, mailbox, when);
  }
}

/** Thirty days of sending on record for a mailbox, with so many bounces. */
function history(w: Workspace, mailbox: string, sent: number, bounces: number) {
  for (let i = 0; i < sent; i++) {
    const job = `mbx-hj-${++seq}`;
    db().prepare("INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, source, recipient, subject, body_text, status) VALUES (?, ?, ?, ?, 'campaign', 'x@y.test', 's', 'b', 'sent')").run(job, w.ws, mailbox, job);
    db().prepare("INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, recipient, subject, message_id) VALUES (?, ?, ?, ?, 'x@y.test', 's', ?)").run(`${job}-sm`, w.ws, job, mailbox, `<${job}@test>`);
  }
  for (let i = 0; i < bounces; i++) {
    db().prepare("INSERT INTO sender_events (id, workspace_id, email_account_id, provider, provider_event_id, event_type, occurred_at) VALUES (?, ?, ?, 'imap', ?, 'bounced', datetime('now'))").run(`mbx-ev-${++seq}`, w.ws, mailbox, `mbx-ev-${seq}`);
  }
}

const profileMailboxes = (run: string) => (db().prepare("SELECT target_id, email_account_id FROM run_profiles WHERE run_id = ? ORDER BY rowid").all(run) as Array<{ target_id: string; email_account_id: string }>);

beforeEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────
describe("the overview the Mailboxes screen reads", () => {
  it("groups mailboxes by the domain they send from, the largest first, with the domain's last DNS check", async () => {
    const w = workspace();
    const [a1, a2, b1] = [w.mailbox("mia@acme.test"), w.mailbox("ravi@acme.test"), w.mailbox("hello@getacme.test")];
    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, domain, spf_status, dkim_status, dmarc_status, mx_status, score, checked_at) VALUES (?, ?, 'acme.test', 'fail', 'fail', 'fail', 'fail', 0, datetime('now', '-2 days'))").run(`chk-${++seq}`, w.ws);
    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, domain, spf_status, dkim_status, dmarc_status, mx_status, score) VALUES (?, ?, 'acme.test', 'pass', 'pass', 'weak', 'pass', 90)").run(`chk-${++seq}`, w.ws);
    const data = await w.overview();
    expect(data.domains.map((domain) => [domain.domain, domain.mailboxes.map((mailbox) => mailbox.id)])).toEqual([["acme.test", [a1, a2]], ["getacme.test", [b1]]]);
    expect(data.domains[0].dns).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "weak", mx: "pass" });
    expect(data.domains[0].dns.checked_at).not.toBeNull();
    // Never checked: nothing is claimed about it.
    expect(data.domains[1].dns).toEqual({ spf: null, dkim: null, dmarc: null, mx: null, checked_at: null });
    expect(data.settings).toEqual({ rotation: "round_robin", failover: false, shared_pool: true });
  });

  it("never carries a password, to anyone", async () => {
    const w = workspace();
    w.mailbox("secret@acme.test");
    for (const role of ["owner", "admin", "viewer"]) {
      const text = JSON.stringify((await w.call(accountsHandler, "GET", { query: { view: "overview" }, role })).body);
      expect(text).not.toMatch(/smtp-secret|imap-secret|"password"|"imap_password"/);
      expect(JSON.stringify((await w.call(accountsHandler, "GET", { role })).body)).not.toMatch(/smtp-secret|imap-secret|"password"|"imap_password"/);
    }
  });

  it("says what a mailbox is: who runs it, its hours, and whether replies to it can be read", async () => {
    const w = workspace();
    const id = w.mailbox("ada@acme.test", { smtp_host: "smtp.gmail.com", imap_host: "imap.gmail.com", provider: "gmail_app_password", active_hours_start: 8, active_hours_end: 17, timezone: "Europe/Berlin", working_days: "1,2,3" });
    const sendOnly = w.mailbox("out@acme.test", { imap_host: null });
    expect(await w.view(id)).toMatchObject({
      from_email: "ada@acme.test", domain: "acme.test", provider: { key: "google", label: "Gmail", method: "App password" },
      schedule: { start: 8, end: 17, days: "1,2,3", timezone: "Europe/Berlin" }, reads_replies: true, status: "active", held: null,
      connection: { smtp_host: "smtp.gmail.com", imap_host: "imap.gmail.com", username: "ada@acme.test" },
      guard: { bounce_threshold: 0.03, complaint_threshold: 0.001, min_health_sample: 50 }, signature_first_only: false,
    });
    expect(await w.view(sendOnly)).toMatchObject({ reads_replies: false, provider: { method: "SMTP only" }, connection: { imap_host: null, imap_port: null } });
  });

  it("counts today's campaign emails as the runner does, on the mailbox's own day, against today's limit", async () => {
    const w = workspace();
    const id = w.mailbox("count@acme.test", { daily_email_limit: 3 });
    const other = w.mailbox("other@acme.test");
    const c = campaign(w, [{ mailbox: id }, { mailbox: other }]);
    recordSends(w, c, c.targets[0], id, 2);
    recordSends(w, c, c.targets[0], id, 4, "-2 days");
    recordSends(w, c, c.targets[1], other, 1);
    expect((await w.view(id)).sending).toEqual({ sent_today: 2, limit_today: 3, limit_full: 3 });
    expect((await w.view(id)).status).toBe("active");
    recordSends(w, c, c.targets[0], id, 1);
    expect(await w.view(id)).toMatchObject({ status: "at_limit", sending: { sent_today: 3 }, active_campaigns: 1 });
    expect((await w.view(other)).sending.sent_today).toBe(1);

    // A mailbox far to the west is still in yesterday when it is early morning in UTC.
    const west = w.mailbox("west@acme.test", { timezone: "Pacific/Honolulu" });
    const c2 = campaign(w, [{ mailbox: west }]);
    db().prepare("INSERT INTO logs (id, run_id, target_id, level, message, created_at) VALUES (?, ?, ?, 'info', 'Email sent to someone', '2026-10-10 01:00:00')").run(`mbx-log-${++seq}`, c2.run, c2.targets[0]);
    const earlyUtc = new Date("2026-10-10T03:00:00Z");
    expect(emailsSentToday(db(), [{ id: west, timezone: "Pacific/Honolulu" }], earlyUtc).get(west)).toBe(1);
    expect(emailsSentToday(db(), [{ id: west, timezone: "Pacific/Honolulu" }], new Date("2026-10-10T12:00:00Z")).get(west) ?? 0).toBe(0);
  });

  it("shows where a mailbox is in its ramp and its warm-up", async () => {
    const w = workspace();
    const today = new Date().toISOString().slice(0, 10);
    const ramping = w.mailbox("ramp@acme.test", { ramp_up_enabled: 1, ramp_start_date: today, ramp_days: 21, ramp_start_limit: 10, daily_email_limit: 40 });
    const warmed = w.mailbox("warmed@acme.test");
    const off = w.mailbox("off@acme.test");
    for (const id of [ramping, warmed]) db().prepare("INSERT INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate) VALUES (?, ?, 1, 12, 70)").run(id, w.ws);
    db().prepare("INSERT INTO warmup_messages (id, workspace_id, from_account_id, to_account_id, subject, body, status, scheduled_at, sent_at, engaged_at, rescued_at) VALUES (?, ?, ?, ?, 's', 'b', 'sent', datetime('now'), datetime('now'), datetime('now'), datetime('now'))").run(`wm-${++seq}`, w.ws, warmed, ramping);
    db().prepare("INSERT INTO warmup_messages (id, workspace_id, from_account_id, to_account_id, subject, body, status, scheduled_at, sent_at, engaged_at) VALUES (?, ?, ?, ?, 's', 'b', 'sent', datetime('now'), datetime('now', '-3 days'), datetime('now'))").run(`wm-${++seq}`, w.ws, warmed, ramping);

    expect(await w.view(ramping)).toMatchObject({
      ramp: { day: 1, days: 21, limit: 10, complete: false, custom_days: 21, start_limit: 10 }, ramp_enabled: true,
      sending: { limit_today: 10, limit_full: 40 }, warmup: { state: "warming", enabled: true, daily_target: 12, reply_rate: 70, peers: 1 },
    });
    expect(await w.view(warmed)).toMatchObject({ ramp: null, ramp_enabled: false, warmup: { state: "warmed", sent_today: 1, sent_week: 2, rescued_week: 1, peers: 1 } });
    expect((await w.view(off)).warmup).toMatchObject({ state: "off", enabled: false, peers: 2 });
    db().prepare("UPDATE email_accounts SET paused_at = datetime('now'), paused_reason = 'Manually paused' WHERE id = ?").run(warmed);
    expect(await w.view(warmed)).toMatchObject({ status: "paused", warmup: { state: "paused" }, held: { reason: "Manually paused" } });
  });

  it("scores reputation from what is on record, and has none for a mailbox that cannot be judged", async () => {
    const w = workspace();
    const good = w.mailbox("good@acme.test");
    const bouncy = w.mailbox("bouncy@acme.test", { min_health_sample: 5000 });
    const untested = w.mailbox("new@acme.test", { is_verified: 0 });
    const gone = w.mailbox("gone@acme.test", { disconnected_at: "2026-10-10 08:00:00", disconnect_reason: "Refused" });
    history(w, good, 100, 0);
    history(w, bouncy, 100, 2);
    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, domain, spf_status, dkim_status, dmarc_status, mx_status, score) VALUES (?, ?, 'acme.test', 'pass', 'pass', 'weak', 'pass', 90)").run(`chk-${++seq}`, w.ws);

    expect((await w.view(good)).reputation).toMatchObject({ score: 97, band: "good", losses: [{ reason: "dns", points: 3 }] });
    expect(await w.view(bouncy)).toMatchObject({ reputation: { score: 77, band: "fair" }, health: { sent: 100, bounces: 2, bounce_rate: 0.02, over_guard: false } });
    expect(await w.view(untested)).toMatchObject({ status: "untested", reputation: null, health: { bounce_rate: null } });
    expect(await w.view(gone)).toMatchObject({ status: "disconnected", reputation: null, warmup: { state: "off" }, held: { at: "2026-10-10 08:00:00", reason: "Refused" } });
  });

  it("is the same answer however often it is asked: reading it pauses nothing", async () => {
    const w = workspace();
    const id = w.mailbox("over@acme.test");
    history(w, id, 100, 10);
    await w.overview();
    await w.overview();
    expect(await w.view(id)).toMatchObject({ status: "active", health: { over_guard: true, bounce_rate: 0.1 } });
    expect(db().prepare("SELECT paused_at FROM email_accounts WHERE id = ?").get(id)).toEqual({ paused_at: null });
    expect(readSenderHealth(id)?.trip).toMatch(/bounce rate 10.00% exceeds 3.00%/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("saving a mailbox", () => {
  it("takes the new settings, and leaves alone what was not sent", async () => {
    const w = workspace();
    const id = w.mailbox("save@acme.test", { signature: "Ada" });
    const saved = await w.call(accountHandler, "PUT", { id, body: { ramp_up_enabled: true, ramp_days: 21, ramp_start_limit: 5, signature_first_only: true, bounce_threshold: 0.04, complaint_threshold: 0.002, min_health_sample: 80, daily_email_limit: "60" } });
    expect(saved.statusCode).toBe(200);
    expect(db().prepare("SELECT ramp_up_enabled, ramp_days, ramp_start_limit, signature_first_only, bounce_threshold, complaint_threshold, min_health_sample, daily_email_limit, signature, imap_host FROM email_accounts WHERE id = ?").get(id))
      .toEqual({ ramp_up_enabled: 1, ramp_days: 21, ramp_start_limit: 5, signature_first_only: 1, bounce_threshold: 0.04, complaint_threshold: 0.002, min_health_sample: 80, daily_email_limit: 60, signature: "Ada", imap_host: "imap.test" });

    // Back to the original ramp, and a guard threshold is never unset.
    await w.call(accountHandler, "PUT", { id, body: { ramp_days: null, ramp_start_limit: null, bounce_threshold: null } });
    expect(db().prepare("SELECT ramp_days, ramp_start_limit, bounce_threshold FROM email_accounts WHERE id = ?").get(id)).toEqual({ ramp_days: null, ramp_start_limit: null, bounce_threshold: 0.04 });
    const got = (await w.call(accountHandler, "GET", { id, role: "viewer" })).body;
    expect(got).toMatchObject({ signature_first_only: 1, bounce_threshold: 0.04, ramp_days: null });
    expect(JSON.stringify(got)).not.toMatch(/secret|"password"/);
  });

  it("refuses what could never work, and changes nothing when it does", async () => {
    const w = workspace();
    const id = w.mailbox("check@acme.test");
    for (const body of [{ daily_email_limit: 0 }, { ramp_days: 1 }, { ramp_start_limit: 80 }, { bounce_threshold: 0.9 }, { active_hours_start: 20, active_hours_end: 8 }, { timezone: "Nowhere/Land" }, { working_days: "" }, { name: "Renamed", min_health_sample: 1 }]) {
      const res = await w.call(accountHandler, "PUT", { id, body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
    expect(db().prepare("SELECT name, daily_email_limit, timezone FROM email_accounts WHERE id = ?").get(id)).toEqual({ name: "check@acme.test", daily_email_limit: 50, timezone: "UTC" });
  });

  it("stores a new password encrypted and never hands it back", async () => {
    const w = workspace();
    const id = w.mailbox("pw@acme.test");
    await w.call(accountHandler, "PUT", { id, body: { password: "new-smtp-password", imap_password: "new-imap-password" } });
    const stored = db().prepare("SELECT password, imap_password FROM email_accounts WHERE id = ?").get(id) as { password: string; imap_password: string };
    expect(stored.password).not.toContain("new-smtp-password");
    expect(decryptSecret(stored.password)).toBe("new-smtp-password");
    expect(decryptSecret(stored.imap_password)).toBe("new-imap-password");
    expect(JSON.stringify(await w.view(id))).not.toMatch(/new-smtp-password|new-imap-password/);
  });

  it("is an admin's to do: a manager, a member and a viewer can only read", async () => {
    const w = workspace();
    const id = w.mailbox("roles@acme.test");
    for (const role of ["manager", "member", "viewer"]) {
      expect((await w.call(accountHandler, "PUT", { id, role, body: { name: "x" } })).statusCode).toBe(403);
      expect((await w.call(accountHandler, "PATCH", { id, role, body: { paused: true } })).statusCode).toBe(403);
      expect((await w.call(accountHandler, "DELETE", { id, role })).statusCode).toBe(403);
      expect((await w.call(accountsHandler, "POST", { role, body: {} })).statusCode).toBe(403);
      expect((await w.call(settingsHandler, "PUT", { role, body: { rotation: "capacity" } })).statusCode).toBe(403);
      expect((await w.call(accountsHandler, "GET", { role, query: { view: "overview" } })).statusCode).toBe(200);
      expect((await w.call(queueHandler, "GET", { id, role })).statusCode).toBe(200);
      expect((await w.call(settingsHandler, "GET", { role })).statusCode).toBe(200);
    }
    // Nor can anyone reach another workspace's mailbox.
    const other = workspace();
    expect((await other.call(accountHandler, "PUT", { id, body: { name: "x" } })).statusCode).toBe(404);
    expect((await other.call(queueHandler, "GET", { id })).statusCode).toBe(404);
    expect(db().prepare("SELECT name, paused_at FROM email_accounts WHERE id = ?").get(id)).toEqual({ name: "roles@acme.test", paused_at: null });
  });

  it("checks a mailbox connected through the plain route the same way", async () => {
    const w = workspace();
    const base = { name: "New", from_email: "new@acme.test", smtp_host: "smtp.test", username: "new@acme.test", password: "pw" };
    expect((await w.call(accountsHandler, "POST", { body: { ...base, ramp_days: 500 } })).statusCode).toBe(400);
    expect((await w.call(accountsHandler, "POST", { body: { ...base, from_email: "nope" } })).statusCode).toBe(400);
    const created = await w.call(accountsHandler, "POST", { body: { ...base, ramp_days: 14, ramp_start_limit: 4, signature_first_only: true } });
    expect(created.statusCode).toBe(201);
    expect(db().prepare("SELECT ramp_days, ramp_start_limit, signature_first_only, is_verified, ramp_up_enabled, daily_email_limit FROM email_accounts WHERE id = ?").get(created.body.id))
      .toEqual({ ramp_days: 14, ramp_start_limit: 4, signature_first_only: 1, is_verified: 0, ramp_up_enabled: 1, daily_email_limit: 50 });
    // And with nothing new sent, exactly the row it always made.
    const plain = await w.call(accountsHandler, "POST", { body: { ...base, from_email: "plain@acme.test" } });
    expect(db().prepare("SELECT ramp_days, ramp_start_limit, signature_first_only, allow_self_signed, disconnected_at FROM email_accounts WHERE id = ?").get(plain.body.id))
      .toEqual({ ramp_days: null, ramp_start_limit: null, signature_first_only: 0, allow_self_signed: 0, disconnected_at: null });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the workspace's mailbox settings", () => {
  it("start as things have always been, and are an admin's to change", async () => {
    const w = workspace();
    expect((await w.call(settingsHandler, "GET")).body).toEqual({ rotation: "round_robin", failover: false, shared_pool: true });
    expect((await w.call(settingsHandler, "PUT", { body: { rotation: "capacity", failover: true, shared_pool: false } })).body).toEqual({ rotation: "capacity", failover: true, shared_pool: false });
    expect(getMailboxRotation(w.ws)).toBe("capacity");
    expect((await workspace().call(settingsHandler, "GET")).body).toEqual({ rotation: "round_robin", failover: false, shared_pool: true });
    expect((await w.call(settingsHandler, "PUT", { body: { rotation: "random" } })).statusCode).toBe(400);
    expect((await w.call(settingsHandler, "PUT", { body: { failover: "yes" } })).statusCode).toBe(400);
    expect((await w.call(settingsHandler, "PUT", { body: {} })).statusCode).toBe(400);
    expect((await w.call(settingsHandler, "GET")).body).toEqual({ rotation: "capacity", failover: true, shared_pool: false });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("sharing a campaign's contacts out between its mailboxes", () => {
  /** The share-out as it was before a rotation could be chosen, kept here word for word. */
  function assignAsItWas(targetIds: string[], pool: string[]): Map<string, string | null> {
    const assignment = new Map<string, string | null>();
    if (pool.length === 0 || targetIds.length === 0) return assignment;
    const rows = db().prepare(`SELECT id, company_id FROM targets WHERE id IN (${targetIds.map(() => "?").join(",")})`).all(...targetIds) as Array<{ id: string; company_id: string | null }>;
    const byCompany = new Map<string, string>();
    let cursor = 0;
    for (const row of rows) {
      if (row.company_id) {
        if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, pool[cursor++ % pool.length]);
        assignment.set(row.id, byCompany.get(row.company_id)!);
      } else {
        assignment.set(row.id, pool[cursor++ % pool.length]);
      }
    }
    return assignment;
  }

  function contacts(w: Workspace, companies: Array<string | null>) {
    return companies.map((company, index) => {
      const id = `mbx-rot-${++seq}`;
      if (company) db().prepare("INSERT OR IGNORE INTO companies (id, name, workspace_id) VALUES (?, ?, ?)").run(`${w.ws}-${company}`, company, w.ws);
      db().prepare("INSERT INTO targets (id, workspace_id, full_name, company_id, linkedin_url) VALUES (?, ?, ?, ?, ?)").run(id, w.ws, `Rot ${index}`, company ? `${w.ws}-${company}` : null, `https://www.linkedin.com/in/${id}/`);
      return id;
    });
  }

  it("is exactly as it was for a workspace that has chosen nothing", () => {
    const w = workspace();
    const pool = [w.mailbox("a@acme.test"), w.mailbox("b@acme.test", { paused_at: "2026-10-01 00:00:00" }), w.mailbox("c@acme.test", { daily_email_limit: 5 })];
    const ids = contacts(w, ["Initech", null, "Globex", "Initech", null, "Hooli", "Globex", null, null, "Umbrella", "Initech"]);
    expect([...assignEmailAccounts(db(), ids, pool)]).toEqual([...assignAsItWas(ids, pool)]);
    expect([...assignEmailAccounts(db(), ids, pool, "round_robin")]).toEqual([...assignAsItWas(ids, pool)]);
    expect([...assignEmailAccounts(db(), ids, pool.slice(0, 1))]).toEqual([...assignAsItWas(ids, pool.slice(0, 1))]);
    expect(assignEmailAccounts(db(), ids, []).size).toBe(0);
    expect(assignEmailAccounts(db(), [], pool).size).toBe(0);
  });

  it("by capacity gives each mailbox contacts in proportion to what it may send today", () => {
    const w = workspace();
    const [big, small, paused] = [w.mailbox("big@acme.test", { daily_email_limit: 60 }), w.mailbox("small@acme.test", { daily_email_limit: 20 }), w.mailbox("paused@acme.test", { daily_email_limit: 60, paused_at: "2026-10-01 00:00:00" })];
    const ids = contacts(w, Array.from({ length: 40 }, () => null));
    const tally = (assignment: Map<string, string | null>) => [big, small, paused].map((id) => [...assignment.values()].filter((value) => value === id).length);
    expect(tally(assignEmailAccounts(db(), ids, [big, small, paused], "capacity"))).toEqual([30, 10, 0]);
    // The workspace's own choice is what applies when none is passed.
    expect(tally(assignEmailAccounts(db(), ids, [big, small, paused]))).toEqual([14, 13, 13]);
    db().prepare("INSERT INTO workspace_settings (workspace_id, key, value) VALUES (?, 'mailbox_rotation', 'capacity')").run(w.ws);
    expect(tally(assignEmailAccounts(db(), ids, [big, small, paused]))).toEqual([30, 10, 0]);
  });

  it("by capacity still keeps a company with one mailbox, and copes when no mailbox can send", () => {
    const w = workspace();
    const [a, b] = [w.mailbox("a@acme.test", { daily_email_limit: 50 }), w.mailbox("b@acme.test", { daily_email_limit: 50 })];
    const ids = contacts(w, ["Initech", "Globex", "Initech", "Initech", "Globex", null]);
    const assignment = assignEmailAccounts(db(), ids, [a, b], "capacity");
    expect(new Set([ids[0], ids[2], ids[3]].map((id) => assignment.get(id))).size).toBe(1);
    expect(new Set([ids[1], ids[4]].map((id) => assignment.get(id))).size).toBe(1);
    expect(assignment.get(ids[0])).not.toBe(assignment.get(ids[1]));
    db().prepare("UPDATE email_accounts SET disconnected_at = datetime('now') WHERE id IN (?, ?)").run(a, b);
    const stuck = assignEmailAccounts(db(), ids, [a, b], "capacity");
    expect([...stuck.values()].every((value) => value === a || value === b)).toBe(true);
    expect(stuck.size).toBe(ids.length);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a mailbox its guard pauses", () => {
  it("keeps every contact waiting for it, as it always has, unless the workspace chose otherwise", () => {
    const w = workspace();
    const [paused, other] = [w.mailbox("p@acme.test"), w.mailbox("o@acme.test")];
    const c = campaign(w, [{ mailbox: paused }, { mailbox: paused, emailed: "sent" }, { mailbox: paused, emailed: "pending" }, { mailbox: other }]);
    const before = profileMailboxes(c.run);
    history(w, paused, 100, 10);
    const health = evaluateSenderHealth(paused);
    expect(health).toMatchObject({ paused: true, sent: 100, bounces: 10 });
    expect(health?.reason).toMatch(/^Auto-paused: 30-day bounce rate 10.00% exceeds 3.00%$/);
    expect(profileMailboxes(c.run)).toEqual(before);
    expect(moveWaitingContacts(db(), paused)).toEqual({ moved: 0, waiting: 0 });
    expect(db().prepare("SELECT COUNT(*) c FROM email_jobs WHERE run_id = ? AND status = 'pending'").get(c.run)).toEqual({ c: 1 });
    const notice = listNotifications(w.ws, "nobody", "owner").find((note) => note.kind === "mailbox.paused");
    expect(notice).toMatchObject({ title: "p@acme.test was paused", body: "30-day bounce rate 10.00% exceeds 3.00%", link: "/mailboxes" });
    const event = db().prepare("SELECT payload_json FROM domain_events WHERE workspace_id = ? AND type = 'sender.auto_paused'").get(w.ws) as { payload_json: string };
    expect(JSON.parse(event.payload_json)).toEqual({ reason: health?.reason, sent: 100, bounce_rate: 0.1, complaint_rate: 0 });
  });

  it("with fail-over on, hands on only the contacts it has not emailed", async () => {
    const w = workspace();
    setWorkspaceSwitch(w.ws, "mailbox_failover", true);
    const [paused, other, third] = [w.mailbox("p@acme.test"), w.mailbox("o@acme.test"), w.mailbox("t@acme.test")];
    const c = campaign(w, [
      { mailbox: paused },                                        // 0 never emailed → moves
      { mailbox: paused, emailed: "sent" },                       // 1 had an email → stays
      { mailbox: paused, emailed: "pending" },                    // 2 an email queued, never sent → moves, and the queued email is dropped
      { mailbox: paused, emailed: "uncertain" },                  // 3 an email that may have gone → stays
      { mailbox: paused, company: "Initech", emailed: "sent" },   // 4 had an email → stays
      { mailbox: paused, company: "Initech" },                    // 5 a colleague of 4 → stays with the company's mailbox
      { mailbox: paused, company: "Globex" },                     // 6 → moves
      { mailbox: paused, company: "Globex" },                     // 7 → moves, to the same mailbox as 6
      { mailbox: paused, state: "completed" },                    // 8 finished → not touched
      { mailbox: other },                                         // 9 another mailbox's contact
      { mailbox: third }, { mailbox: third }, { mailbox: third }, // 10–12: `third` already has more waiting
    ]);
    history(w, paused, 100, 10);
    evaluateSenderHealth(paused);

    const now = c.targets.map(c.mailboxOf);
    expect([now[1], now[3], now[4], now[5], now[8]]).toEqual([paused, paused, paused, paused, paused]);
    for (const index of [0, 2, 6, 7]) expect(now[index], `contact ${index}`).not.toBe(paused);
    expect(now[6]).toBe(now[7]);
    expect(now.slice(9)).toEqual([other, third, third, third]);
    // The lighter mailbox fills first: `other` had one waiting, `third` had three.
    expect([now[0], now[2]]).toEqual([other, other]);

    // The email queued for the paused mailbox is gone, so the step is written afresh for the new one.
    expect(db().prepare("SELECT status FROM email_jobs WHERE id = ?").get(`${c.targets[2]}-job`)).toBeUndefined();
    expect(db().prepare("SELECT status FROM email_jobs WHERE id = ?").get(`${c.targets[1]}-job`)).toEqual({ status: "sent" });
    expect(db().prepare("SELECT status FROM email_jobs WHERE id = ?").get(`${c.targets[3]}-job`)).toEqual({ status: "uncertain" });
    expect(db().prepare("SELECT message FROM logs WHERE run_id = ? AND target_id = ?").get(c.run, c.targets[0])).toMatchObject({ message: expect.stringMatching(/^Moved to .+@acme\.test: p@acme\.test was paused before this contact had been emailed$/) });

    const notice = listNotifications(w.ws, "nobody", "owner").find((note) => note.kind === "mailbox.paused");
    expect(notice?.body).toBe("30-day bounce rate 10.00% exceeds 3.00%. 4 contacts not emailed yet moved to other mailboxes.");
    const event = db().prepare("SELECT payload_json FROM domain_events WHERE workspace_id = ? AND type = 'sender.auto_paused'").get(w.ws) as { payload_json: string };
    expect(JSON.parse(event.payload_json)).toMatchObject({ contacts_moved: 4 });
  });

  it("with fail-over on, leaves contacts where they are when the campaign has nowhere else to send from", () => {
    const w = workspace();
    setWorkspaceSwitch(w.ws, "mailbox_failover", true);
    const [paused, alsoPaused, gone, untested] = [w.mailbox("p@acme.test"), w.mailbox("p2@acme.test", { paused_at: "2026-10-01 00:00:00" }), w.mailbox("g@acme.test", { disconnected_at: "2026-10-01 00:00:00" }), w.mailbox("u@acme.test", { is_verified: 0 })];
    const alone = campaign(w, [{ mailbox: paused }, { mailbox: paused }]);
    const noGood = campaign(w, [{ mailbox: paused }, { mailbox: alsoPaused }, { mailbox: gone }, { mailbox: untested }]);
    const finished = campaign(w, [{ mailbox: paused }, { mailbox: w.mailbox("fine@acme.test") }], "completed");
    db().prepare("UPDATE email_accounts SET paused_at = datetime('now'), paused_reason = 'Auto-paused: test' WHERE id = ?").run(paused);
    expect(moveWaitingContacts(db(), paused)).toEqual({ moved: 0, waiting: 3 });
    for (const c of [alone, noGood, finished]) expect(c.mailboxOf(c.targets[0])).toBe(paused);
  });

  it("is not paused twice, and a manual pause moves nobody", async () => {
    const w = workspace();
    setWorkspaceSwitch(w.ws, "mailbox_failover", true);
    const [paused, other] = [w.mailbox("p@acme.test"), w.mailbox("o@acme.test")];
    const c = campaign(w, [{ mailbox: paused }, { mailbox: other }]);
    await w.call(accountHandler, "PATCH", { id: paused, body: { paused: true } });
    expect(c.mailboxOf(c.targets[0])).toBe(paused);
    expect(await w.view(paused)).toMatchObject({ status: "paused", held: { reason: "Manually paused" } });
    history(w, paused, 100, 10);
    evaluateSenderHealth(paused);
    evaluateSenderHealth(paused);
    // Already paused by a person: the guard records nothing more and moves nobody.
    expect(c.mailboxOf(c.targets[0])).toBe(paused);
    expect(listNotifications(w.ws, "nobody", "owner").filter((note) => note.kind === "mailbox.paused")).toHaveLength(0);
    await w.call(accountHandler, "PATCH", { id: paused, body: { paused: false } });
    evaluateSenderHealth(paused);
    expect(await w.view(paused)).toMatchObject({ status: "auto_paused" });
    expect(c.mailboxOf(c.targets[0])).toBe(other);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a mailbox that cannot sign in", () => {
  it("is disconnected by three refused sign-ins to read it in a row, and by nothing less", () => {
    const w = workspace();
    const id = w.mailbox("imap@acme.test");
    const refused = Object.assign(new Error("Invalid credentials (Failure)"), { source: "authentication" });
    const state = () => db().prepare("SELECT disconnected_at, imap_auth_failures FROM email_accounts WHERE id = ?").get(id) as { disconnected_at: string | null; imap_auth_failures: number };

    noteImapSignIn(id, Object.assign(new Error("Timed out while authenticating with server"), { source: "timeout-auth" }));
    noteImapSignIn(id, new Error("read ECONNRESET"));
    expect(state()).toEqual({ disconnected_at: null, imap_auth_failures: 0 });

    noteImapSignIn(id, refused);
    noteImapSignIn(id, refused);
    expect(state()).toMatchObject({ disconnected_at: null, imap_auth_failures: 2 });
    // One good sign-in and the count starts again.
    noteImapSignIn(id, null);
    expect(state().imap_auth_failures).toBe(0);
    for (let i = 0; i < IMAP_FAILURES_TO_DISCONNECT; i++) noteImapSignIn(id, refused);
    expect(state().disconnected_at).not.toBeNull();
    expect(db().prepare("SELECT disconnect_reason FROM email_accounts WHERE id = ?").get(id)).toEqual({ disconnect_reason: "The mail server refused the sign-in used to read replies (Invalid credentials (Failure))." });
    noteImapSignIn(id, refused);
    expect(listNotifications(w.ws, "nobody", "owner").filter((note) => note.kind === "mailbox.disconnected")).toHaveLength(1);
  });

  it("sends nothing and fails nothing: its emails wait, and go when it is back", async () => {
    const w = workspace();
    const id = w.mailbox("held@acme.test");
    expect(markDisconnected(id, "The mail server refused the sign-in.")).toBe(true);
    expect(markDisconnected(id, "Again")).toBe(false);
    await expect(sendEmailDurably({ workspaceId: w.ws, emailAccountId: id, idempotencyKey: "held-1", to: "lee@prospect.test", subject: "s", body: "b" })).rejects.toBeInstanceOf(SenderDisconnectedError);
    expect(db().prepare("SELECT status, attempt FROM email_jobs WHERE workspace_id = ? AND idempotency_key = 'held-1'").get(w.ws)).toEqual({ status: "pending", attempt: 0 });
    expect(await w.view(id)).toMatchObject({ status: "disconnected", held: { reason: "The mail server refused the sign-in." } });
    expect(markConnected(id)).toBe(true);
    expect(markConnected(id)).toBe(false);
    expect(await w.view(id)).toMatchObject({ status: "active", held: null });
  });

  it("is left out of warm-up, both as a sender and as a peer", async () => {
    const w = workspace();
    setWorkspaceSwitch(w.ws, "warmup_shared_pool", false);
    const [gone, fine] = [w.mailbox("gone@acme.test", { active_hours_start: 0, active_hours_end: 24 }), w.mailbox("fine@acme.test", { active_hours_start: 0, active_hours_end: 24 })];
    for (const id of [gone, fine]) db().prepare("INSERT INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate) VALUES (?, ?, 1, 5, 60)").run(id, w.ws);
    markDisconnected(gone, "Refused");
    // `fine` has no peer left and `gone` may not send: the cycle does nothing for this workspace.
    await processWarmupCycle();
    expect(db().prepare("SELECT COUNT(*) c FROM warmup_messages WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
    expect(db().prepare("SELECT COUNT(*) c FROM email_jobs WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
    expect((await w.view(fine)).warmup.peers).toBe(0);
    expect((await w.view(gone)).warmup.state).toBe("stopped");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a mailbox's upcoming sends", () => {
  it("lists what went today and whose step is next, soonest first, and says how many are due", async () => {
    const w = workspace();
    const id = w.mailbox("queue@acme.test", { daily_email_limit: 10 });
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const later = new Date(Date.now() + 25 * 60_000).toISOString();
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const c = campaign(w, [
      { mailbox: id, state: "in_progress", nextAt: later, step: 1, company: "Initech" },
      { mailbox: id, state: "in_progress", nextAt: soon, step: 0 },
      { mailbox: id, state: "in_progress", nextAt: nextWeek, step: 2 },
      { mailbox: id, state: "pending" },
      { mailbox: id, state: "completed", nextAt: soon },
    ]);
    const paused = campaign(w, [{ mailbox: id, state: "in_progress", nextAt: soon }], "paused");
    recordSends(w, c, c.targets[4], id, 1, "-1 minute");

    const queue = mailboxQueue(db(), w.ws, id)!;
    expect(queue).toMatchObject({ due_today: expect.any(Number), room_today: 9, waiting: 1, next_at: soon });
    expect(queue.items.map((item) => [item.status, item.contact.id, item.step])).toEqual([
      ["sent", c.targets[4], 1], ["due", c.targets[1], 1], ["due", c.targets[0], 2], ["due", c.targets[2], 3],
    ]);
    expect(queue.items[2]).toMatchObject({ contact: { company: "Initech" }, campaign: { id: c.workflow } });
    // A paused campaign sends nothing, so its contacts are not "next".
    expect(queue.items.some((item) => item.contact.id === paused.targets[0])).toBe(false);
    expect((await w.call(queueHandler, "GET", { id, role: "viewer" })).body).toMatchObject({ waiting: 1, room_today: 9 });
  });

  it("is empty of what is next while the mailbox is held", () => {
    const w = workspace();
    const id = w.mailbox("held-q@acme.test", { paused_at: "2026-10-10 08:00:00", paused_reason: "Manually paused" });
    campaign(w, [{ mailbox: id, state: "in_progress", nextAt: new Date(Date.now() + 60_000).toISOString() }]);
    expect(mailboxQueue(db(), w.ws, id)).toMatchObject({ due_today: 0, next_at: null, items: [] });
    expect(mailboxQueue(db(), w.ws, "no-such-mailbox")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the daily DNS check", () => {
  it("is due for a domain never checked or checked more than a day ago, once per domain", async () => {
    const w = workspace();
    w.mailbox("a@fresh.test");
    w.mailbox("b@stale.test");
    w.mailbox("c@stale.test");
    w.mailbox("d@never.test");
    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, domain, score, checked_at) VALUES (?, ?, 'fresh.test', 90, datetime('now', '-2 hours'))").run(`chk-${++seq}`, w.ws);
    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, domain, score, details_json, checked_at) VALUES (?, ?, 'stale.test', 90, ?, datetime('now', '-25 hours'))").run(`chk-${++seq}`, w.ws, JSON.stringify({ dkim: { selector: "pm" } }));
    const due = domainsDueForCheck().filter((domain) => domain.workspace_id === w.ws);
    expect(due).toEqual([{ workspace_id: w.ws, domain: "never.test", selector: null }, { workspace_id: w.ws, domain: "stale.test", selector: "pm" }]);

    // Checking one takes it off the list; the selector found last time is tried first.
    const asked: Array<{ domain: string; selector?: string }> = [];
    const checked = await recheckDueDomains(db(), (async (input: { workspaceId: string; domain: string; selector?: string }) => {
      asked.push({ domain: input.domain, selector: input.selector });
      db().prepare("INSERT INTO deliverability_checks (id, workspace_id, domain, score) VALUES (?, ?, ?, 0)").run(`chk-${++seq}`, input.workspaceId, input.domain);
    }) as never);
    expect(checked).toBeGreaterThan(0);
    const mine = asked.filter((item) => item.domain.endsWith(".test") && ["never.test", "stale.test"].includes(item.domain));
    expect(domainsDueForCheck().filter((domain) => domain.workspace_id === w.ws).length).toBe(2 - mine.length);
    if (mine.some((item) => item.domain === "stale.test")) expect(mine.find((item) => item.domain === "stale.test")?.selector).toBe("pm");
  });

  it("reads the selector the last check found", () => {
    expect(lastSelector(JSON.stringify({ dkim: { selector: "google" } }))).toBe("google");
    expect(lastSelector(JSON.stringify({ dkim: "google._domainkey" }))).toBeNull();
    expect(lastSelector("{not json")).toBeNull();
    expect(lastSelector(null)).toBeNull();
  });
});
