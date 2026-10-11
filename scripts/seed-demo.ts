/**
 * Demo data: a workspace with enough in it that every screen has something to show.
 *
 *   LINKI_DB_PATH=/path/to/linki-demo.db npm run seed:demo -- --fresh
 *
 * Then start the app against the same file with LINKI_RUNNER=off, so nothing in the
 * background tries to act on made-up accounts and contacts.
 *
 * Safety:
 *  - It refuses to run in production and refuses to run without LINKI_DB_PATH.
 *  - --fresh deletes the database file first, and only does so when the file name
 *    contains "demo". Without --fresh it adds the demo workspace beside whatever is
 *    there, and does nothing if the demo workspace already exists.
 *  - Nobody here is real. Every address is on a reserved domain (.example / .invalid)
 *    and no mailbox or LinkedIn account can sign in anywhere.
 *
 * The sign-in for the demo workspace is DEMO_LOGIN below; the password is DEMO_PASSWORD
 * (or the DEMO_PASSWORD environment variable).
 *
 * Each rebuild phase that adds tables or columns adds to this file, so the screen it
 * builds can be checked against data.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";

const DEMO_LOGIN = "jordan@acme.example";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "linki-demo-workspace";
const WORKSPACE_NAME = "Acme Growth";
const WORKSPACE_SLUG = "acme-growth-demo";

// ── A repeatable source of variety ────────────────────────────────────────────
let seed = 20261010;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (probability: number) => random() < probability;
const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** SQLite's own timestamp format, in UTC. */
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const ago = (ms: number) => stamp(NOW - ms);
const iso = (ms: number) => new Date(ms).toISOString();

type Db = ReturnType<typeof import("@/lib/db").getDb>;

/**
 * Put the inbox in every state its screen has to show: a conversation a teammate is
 * answering, snoozed ones, read and unread, answers due and overdue, a draft with a file,
 * a reply that came with files, LinkedIn answers waiting, failed and unconfirmed, a later
 * message, a follow-up put back for someone who is away, a reply whose contact was
 * deleted, and a contact only marked as having replied.
 */
function seedInboxStates(db: Db, ws: string, insert: (table: string, row: Record<string, unknown>) => void, reconcile: (db: Db, ws: string) => unknown, refresh: (db: Db, conversationId: string) => void) {
  const user = (name: string) => (db.prepare("SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id WHERE wm.workspace_id = ? AND u.email LIKE ?").get(ws, `${name}@%`) as { id: string }).id;
  const jordan = user("jordan"), priya = user("priya"), marcus = user("marcus");
  type Row = { id: string; target_id: string; last_reply_id: string | null; last_message_channel: string | null; verdict: string | null; last_inbound_at: string };
  const open = db.prepare(`SELECT c.id, c.target_id, c.last_reply_id, c.last_message_channel, c.verdict, c.last_inbound_at FROM conversations c
    WHERE c.workspace_id = ? AND c.status = 'open' ORDER BY c.last_message_at DESC`).all(ws) as Row[];
  const take = (wanted: (row: Row) => boolean): Row => {
    const at = open.findIndex(wanted);
    return open.splice(at === -1 ? 0 : at, 1)[0];
  };
  const set = (id: string, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE conversations SET ${keys.map(key => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map(key => fields[key]), id);
  };
  const tag = (name: string) => (db.prepare("SELECT id FROM inbox_tags WHERE workspace_id = ? AND name = ?").get(ws, name) as { id: string }).id;
  const mailbox = db.prepare("SELECT id FROM email_accounts WHERE workspace_id = ? ORDER BY created_at LIMIT 1").get(ws) as { id: string };
  const linkedin = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND is_authenticated = 1 ORDER BY name LIMIT 1").get(ws) as { id: string };

  db.transaction(() => {
    // A reply stops a campaign, so nothing a campaign sent on LinkedIn can come after one.
    db.prepare(`DELETE FROM linkedin_messages WHERE workspace_id = ? AND direction = 'out' AND created_by IS NULL
      AND EXISTS (SELECT 1 FROM email_replies er WHERE er.target_id = linkedin_messages.target_id AND datetime(er.received_at) < datetime(linkedin_messages.sent_at))`).run(ws);
    // Answers due: a few overdue, a few due later today, and none for the rest (answered).
    db.prepare("UPDATE conversations SET sla_due_at = NULL WHERE workspace_id = ?").run(ws);
    db.prepare("DELETE FROM conversation_tags WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = ?)").run(ws);

    // The one a teammate is answering right now: assigned, tagged, due soon, held by Priya.
    const hero = take(row => row.verdict === "positive" && row.last_message_channel === "linkedin");
    set(hero.id, { assigned_to: jordan, temperature: "hot", sla_due_at: iso(NOW + 2 * HOUR), locked_by: priya, locked_at: iso(NOW - 2 * 60_000) });
    insert("conversation_tags", { conversation_id: hero.id, tag_id: tag("Enterprise · RFP") });

    // A conversation with a draft the owner has not sent, with a file on it.
    const drafted = take(row => row.verdict === "positive" && row.last_message_channel === "email");
    set(drafted.id, { assigned_to: jordan, temperature: "hot", sla_due_at: iso(NOW + 5 * HOUR) });
    insert("conversation_tags", { conversation_id: drafted.id, tag_id: tag("Pricing question") });
    insert("conversation_drafts", { conversation_id: drafted.id, user_id: jordan, channel: "email", subject: null, body: "Hi {{first_name}}, appreciate the straight answer.\n\nFor nine seats it is $740 a month, LinkedIn seats included. Would Tuesday at 10:00 or Wednesday at 09:30 work?", updated_at: iso(NOW - 8_000) });
    insert("conversation_attachments", { id: randomUUID(), workspace_id: ws, conversation_id: drafted.id, draft_user_id: jordan, filename: "Acme pricing 2026.pdf", content_type: "application/pdf", size_bytes: 21, content: Buffer.from("%PDF-1.7 demo pricing"), created_by: jordan });
    // Their reply came with files: one kept, one too large to keep.
    if (drafted.last_reply_id) {
      insert("conversation_attachments", { id: randomUUID(), workspace_id: ws, conversation_id: drafted.id, reply_id: drafted.last_reply_id, filename: "Requirements.docx", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size_bytes: 18, content: Buffer.from("demo requirements") });
      insert("conversation_attachments", { id: randomUUID(), workspace_id: ws, conversation_id: drafted.id, reply_id: drafted.last_reply_id, filename: "Onboarding walkthrough.mov", content_type: "video/quicktime", size_bytes: 48_300_000, content: null });
    }

    // Overdue, due today, and somebody else's.
    for (const [index, hours] of [-30, -9, -3, -1].entries()) {
      const row = take(() => true);
      set(row.id, { sla_due_at: iso(NOW + hours * HOUR), assigned_to: [priya, marcus, null, jordan][index] });
      if (index === 0) insert("conversation_tags", { conversation_id: row.id, tag_id: tag("Referral") });
    }
    for (const hours of [1, 3, 6]) set(take(() => true).id, { sla_due_at: iso(NOW + hours * HOUR), assigned_to: hours === 3 ? jordan : null });

    // Snoozed: one until tomorrow morning, one until they write.
    const tomorrow = new Date(NOW + DAY); tomorrow.setHours(9, 0, 0, 0);
    set(take(row => row.verdict === "out_of_office").id, { status: "snoozed", snoozed_until: tomorrow.toISOString(), snoozed_by: jordan, assigned_to: jordan });
    set(take(() => true).id, { status: "snoozed", snoozed_until: null, snoozed_by: priya, assigned_to: priya });

    // LinkedIn answers typed in the inbox: one waiting to go, one that failed, one that could not be confirmed.
    for (const [status, body, error] of [
      ["queued", "Happy to. I will send two times over in a moment.", null],
      ["failed", "Thanks for the reply. Does Thursday suit?", "LinkedIn will not deliver this: the contact is not a connection of this account"],
      ["uncertain", "Great, sending the case study now.", "Send was pressed but LinkedIn did not show the message. It may have gone. Check the conversation on LinkedIn before sending it again."],
    ] as const) {
      const row = take(found => found.last_message_channel === "linkedin");
      insert("linkedin_messages", { id: randomUUID(), workspace_id: ws, account_id: linkedin.id, target_id: row.target_id, direction: "out", body, sent_at: iso(NOW - 4 * 60_000), status, error, created_by: jordan });
      set(row.id, { assigned_to: jordan });
    }

    // A later message: they wrote again after the first reply was dealt with.
    const again = take(row => row.last_message_channel === "email" && row.verdict !== "out_of_office");
    const first = db.prepare("SELECT * FROM email_replies WHERE id = ?").get(again.last_reply_id) as Record<string, unknown>;
    const laterId = randomUUID();
    insert("email_replies", {
      id: laterId, workspace_id: ws, target_id: again.target_id, run_id: first.run_id, channel: "email", from_email: first.from_email, subject: first.subject, email_account_id: first.email_account_id,
      body_text: "One more thing: could you include how the LinkedIn limits work with several seats?", received_at: iso(NOW - 11 * 60_000), later: 1, conversation_id: again.id,
      dispatched_at: iso(NOW - 11 * 60_000), dispatch_result_json: JSON.stringify({ action: "none", note: "A later message: the contact's campaigns were already settled by an earlier reply" }),
    });
    set(again.id, { assigned_to: marcus, sla_due_at: iso(NOW + 4 * HOUR) });

    // Someone who is away: their next campaign email was put back and is still waiting.
    const away = db.prepare(`SELECT c.id, c.target_id FROM conversations c WHERE c.workspace_id = ? AND c.verdict = 'out_of_office' AND c.status = 'open' LIMIT 1`).get(ws) as { id: string; target_id: string } | undefined;
    if (away) {
      db.prepare(`UPDATE run_profile_tracks SET state = 'in_progress', next_step_at = ?, pending_reply_context = ? WHERE track = 'email' AND run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)`)
        .run(iso(NOW + 5 * DAY), JSON.stringify({ summary: "Out of office" }), away.target_id);
    }

    // A reply whose contact was deleted: it stays, by the address it came from.
    const orphan = randomUUID();
    insert("email_replies", { id: orphan, workspace_id: ws, target_id: null, channel: "email", from_email: "ayan.rao@former-contact.example", subject: "Re: a quick idea", email_account_id: mailbox.id, body_text: "Interested, but I have moved teams. Who should I point you to?", received_at: iso(NOW - 26 * HOUR) });

    // A contact marked as replied by hand: known to have answered, with no message stored.
    const marked = db.prepare(`SELECT t.id FROM targets t WHERE t.workspace_id = ? AND t.last_replied_at IS NULL AND t.email_replied_at IS NULL AND t.linkedin_url IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM email_replies er WHERE er.target_id = t.id) LIMIT 1`).get(ws) as { id: string } | undefined;
    if (marked) db.prepare("UPDATE targets SET last_replied_at = ? WHERE id = ?").run(iso(NOW - 50 * 60_000), marked.id);
  })();
  // File what was just stored without a conversation: the reply with no contact, and the contact marked as replied.
  reconcile(db, ws);
  for (const row of db.prepare("SELECT id FROM conversations WHERE workspace_id = ?").all(ws) as { id: string }[]) refresh(db, row.id);

  // What the owner has read: everything but the newest dozen or so.
  const unread = new Set((db.prepare("SELECT id FROM conversations WHERE workspace_id = ? AND status = 'open' ORDER BY last_inbound_at DESC LIMIT 14").all(ws) as { id: string }[]).map(row => row.id));
  for (const row of db.prepare("SELECT id FROM conversations WHERE workspace_id = ? AND status = 'open'").all(ws) as { id: string }[]) {
    if (!unread.has(row.id)) insert("conversation_reads", { conversation_id: row.id, user_id: jordan, read_at: iso(NOW) });
  }

  // The owner's saved views, and the workspace's booking link.
  for (const [position, [name, state]] of ([
    ["My hot replies", { filters: { assignee: "me", temperature: "hot" } }],
    ["Unassigned positive", { filters: { assignee: "none", verdict: "positive" } }],
    ["Awaiting my answer", { filters: { view: "mine", status: "open" }, sort: "due:asc" }],
  ] as const).entries()) {
    insert("saved_views", { id: randomUUID(), workspace_id: ws, user_id: jordan, resource: "inbox", name, state_json: JSON.stringify(state), position, created_by: jordan });
  }
  insert("workspace_settings", { workspace_id: ws, key: "booking_url", value: "https://cal.example/acme-growth/intro" });
}

/** NEXTAUTH_SECRET as the app would find it in this checkout's env files, and nothing else from them. */
function secretFromEnvFiles(): string | null {
  for (const name of [".env.development.local", ".env.local", ".env.development", ".env"]) {
    try {
      const line = fs.readFileSync(path.join(process.cwd(), name), "utf8").split(/\r?\n/).find(entry => /^\s*NEXTAUTH_SECRET\s*=/.test(entry));
      const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
      if (value) return value;
    } catch {
      // No such file: try the next.
    }
  }
  return null;
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("seed-demo does not run in production.");
  const dbPath = process.env.LINKI_DB_PATH;
  if (!dbPath) throw new Error("Set LINKI_DB_PATH to the database file the demo data should go into.");
  const fresh = process.argv.includes("--fresh");
  if (fresh) {
    if (!path.basename(dbPath).includes("demo")) throw new Error(`--fresh deletes the database, so it only works on a file with "demo" in its name (got ${path.basename(dbPath)}).`);
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  }

  // lib/db reads LINKI_DB_PATH when it is first imported, so import only after the file is settled.
  // Stored secrets are encrypted under NEXTAUTH_SECRET. The app started from this checkout
  // takes its own from .env.local, so the same one is used here: otherwise the app cannot
  // read what this wrote, and every page that shows a stored key fails.
  process.env.NEXTAUTH_SECRET ||= secretFromEnvFiles() ?? "demo-secret-not-used-to-sign-anything-real";
  const { getDb } = await import("@/lib/db");
  const { createWorkspaceForUser } = await import("@/lib/workspace");
  const { encryptSecret } = await import("@/lib/crypto");
  const { createApiKey } = await import("@/lib/api-keys");
  const { TOUR_IDS, seenKey } = await import("@/lib/client/tours");
  const { evaluateDkim, evaluateDmarc, evaluateMx, evaluateSpf } = await import("@/lib/email/dns");
  const { localDayBoundsUtc } = await import("@/lib/outreach/schedule");
  const { reconcileConversations } = await import("@/lib/conversations/reconcile");
  const { refreshLastMessage } = await import("@/lib/conversations/rows");
  const db = getDb();

  if (db.prepare("SELECT 1 FROM workspaces WHERE slug = ?").get(WORKSPACE_SLUG)) {
    console.log(`The demo workspace is already in ${dbPath}. Use --fresh to rebuild it.`);
    return;
  }

  /** Insert one row from an object; undefined values are left to the column default. */
  const insert = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row).filter(key => row[key] !== undefined);
    db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map(key => row[key]));
  };

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const counts: Record<string, number> = {};
  const count = (name: string, by = 1) => (counts[name] = (counts[name] ?? 0) + by);

  db.transaction(() => {
    // ── People ──────────────────────────────────────────────────────────────
    const team = [
      { key: "jordan", name: "Jordan Mertens", email: DEMO_LOGIN, role: "owner" },
      { key: "elena", name: "Elena Vogt", email: "elena@acme.example", role: "admin" },
      { key: "priya", name: "Priya Raghavan", email: "priya@acme.example", role: "manager" },
      { key: "marcus", name: "Marcus Oyelaran", email: "marcus@acme.example", role: "member" },
      { key: "daniel", name: "Daniel Hsu", email: "daniel@acme.example", role: "member" },
      { key: "hannah", name: "Hannah Weiss", email: "hannah@acme.example", role: "viewer" },
    ].map(person => ({ ...person, id: randomUUID() }));
    for (const person of team) {
      insert("users", { id: person.id, email: person.email, name: person.name, password_hash: passwordHash, email_verified_at: ago(90 * DAY) });
      count("users");
    }
    const owner = team[0];
    const { workspaceId: ws } = createWorkspaceForUser(owner.id, owner.email);
    db.prepare("UPDATE workspaces SET name = ?, slug = ? WHERE id = ?").run(WORKSPACE_NAME, WORKSPACE_SLUG, ws);
    for (const person of team.slice(1)) insert("workspace_members", { workspace_id: ws, user_id: person.id, role: person.role });
    const userId = (key: string) => team.find(person => person.key === key)!.id;

    // ── LinkedIn accounts ───────────────────────────────────────────────────
    // One in each state the accounts screen has to show: held by LinkedIn's weekly limit,
    // running, warming up, and signed out. None holds a session that could be used.
    const builtIn = { viewport: { width: 1920, height: 1080 }, userAgent: "Mozilla/5.0 (demo)", locale: "en-US" };
    const linkedinAccounts = [
      { name: "Priya Raghavan", email: "priya.raghavan@acme.example", owner: "priya", plan: "Sales Navigator Core", method: "cookie", authed: 1, tz: "Europe/Berlin", connect: 60, message: 80, visit: 150, start: 9, end: 17, pending: 412, connections: 2840, proxy: "Frankfurt, DE", weeklyHit: true, today: [58, 34, 120, 4] },
      { name: "Marcus Oyelaran", email: "marcus.oyelaran@acme.example", owner: "marcus", plan: "Recruiter Lite", method: "login", authed: 1, tz: "America/New_York", connect: 60, message: 80, visit: 150, start: 8, end: 17, pending: 388, connections: 1920, proxy: "New York, US", today: [42, 28, 96, 3] },
      { name: "Jordan Mertens", email: "jordan.mertens@acme.example", owner: "jordan", plan: "Sales Navigator Advanced", method: "login", authed: 1, tz: "Europe/Madrid", connect: 40, message: 50, visit: 120, start: 9, end: 18, pending: 251, connections: 3310, proxy: null, rampDay: 6, today: [9, 12, 31, 0] },
      { name: "Daniel Hsu", email: "daniel.hsu@acme.example", owner: "daniel", plan: null, method: "cookie", authed: 0, tz: "Europe/Lisbon", connect: 30, message: 40, visit: 80, start: 9, end: 17, pending: 153, connections: 760, proxy: null, today: [0, 0, 0, 0] },
    ].map(account => ({ ...account, id: randomUUID() }));
    for (const account of linkedinAccounts) {
      const proxyUrl = account.proxy ? `http://${account.proxy.split(",")[0].toLowerCase().replace(/\s+/g, "-")}.proxy.example:8080` : null;
      insert("accounts", {
        id: account.id, workspace_id: ws, name: account.name, email: account.email, is_authenticated: account.authed,
        owner_id: userId(account.owner), plan: account.plan, auth_method: account.method,
        session_state: account.authed ? "healthy" : "needs_signin", session_changed_at: account.authed ? ago(between(6, 30) * DAY) : ago(3 * HOUR),
        // Not a session anyone could use: it only marks that this account has been signed in before.
        cookies_json: account.authed ? null : encryptSecret(JSON.stringify({ cookies: [], origins: [] })),
        daily_connection_limit: account.connect, daily_message_limit: account.message, daily_visit_limit: account.visit,
        weekly_connection_limit: account.weeklyHit ? 200 : null, weekly_limit_hit_at: account.weeklyHit ? iso(NOW - 42 * 60_000) : null,
        daily_withdraw_limit: 25, invite_max_wait_days: 14,
        ramp_start_date: account.rampDay ? new Date(NOW - (account.rampDay - 1) * DAY).toISOString().slice(0, 10) : null,
        ramp_days: account.rampDay ? 21 : null, ramp_start_limit: account.rampDay ? 10 : null,
        proxy_url: proxyUrl, proxy_label: account.proxy,
        session_context_json: account.authed ? JSON.stringify({ ...builtIn, timezoneId: proxyUrl ? account.tz : "America/New_York", proxy: proxyUrl ? { server: proxyUrl } : null }) : null,
        active_hours_start: account.start, active_hours_end: account.end, timezone: account.tz, working_days: "1,2,3,4,5",
        withdraw_stale_invites: 1, li_connections: account.connections, li_pending: account.pending, li_profile_views: between(40, 220),
        li_stats_synced_at: ago(between(2, 40) * 60_000), accepted_sync_at: ago(between(5, 90) * 60_000),
        inbox_synced_at: account.authed ? ago(between(1, 14) * 60_000) : null, created_at: ago(between(40, 120) * DAY),
      });
      // What each has done so far today, so the limit meters have something to show.
      const [connects, messages, visits, withdrawals] = account.today;
      for (const [action, n] of [["connect", connects], ["message", messages], ["visit", visits]] as const) {
        for (let i = 0; i < n; i++) insert("step_sends", { id: randomUUID(), workspace_id: ws, channel: "linkedin", action, account_id: account.id, sent_at: ago(between(1, 55) * 60_000) });
      }
      for (let i = 0; i < withdrawals; i++) insert("linkedin_withdrawals", { id: randomUUID(), account_id: account.id, source: "cleanup", outcome: "withdrawn", created_at: ago(between(1, 55) * 60_000) });
      count("LinkedIn accounts");
    }
    const liveLinkedin = linkedinAccounts.filter(account => account.authed);

    // ── Mailboxes on three sending domains, one in each state the screen can show ──
    // `state` is what is wrong with it, if anything. `ramp` is a chosen ramp (days, start);
    // without one the mailbox is on the original ramp of two more emails a day.
    type MailboxState = "ok" | "auto_paused" | "disconnected" | "untested";
    const mailboxes = ([
      { from: "jordan@acme.example", name: "Jordan Mertens", provider: "gmail_app_password", limit: 60, rampDays: 40, ramp: [14, 10], sentToday: 52, tz: "Europe/Berlin", hours: [8, 18], firstOnly: 1 },
      { from: "priya@acme.example", name: "Priya Raghavan", provider: "gmail_app_password", limit: 60, rampDays: 8, ramp: [21, 5], sentToday: 14, tz: "Europe/Berlin", hours: [8, 17] },
      { from: "marcus@acme.example", name: "Marcus Oyelaran", provider: "gmail_app_password", limit: 60, rampDays: 30, ramp: [21, 5], sentToday: 60, tz: "America/New_York", hours: [0, 24] },
      { from: "elena@acme.example", name: "Elena Vogt", provider: "smtp", limit: 30, rampDays: 22, state: "auto_paused", tz: "Europe/Madrid", hours: [9, 18] },
      { from: "outreach@getacme.example", name: "Acme Outreach", provider: "smtp", limit: 80, rampDays: 60, sentToday: 64, tz: "Europe/Berlin", hours: [7, 19] },
      { from: "daniel@getacme.example", name: "Daniel Hsu", provider: "smtp", limit: 50, rampDays: 45, sentToday: 41, tz: "Europe/London", hours: [9, 17] },
      { from: "hello@getacme.example", name: "Acme", provider: "smtp", limit: 80, rampDays: 3, ramp: [21, 5], sentToday: 9, tz: "Europe/Berlin", hours: [8, 18] },
      { from: "team@acme-mail.example", name: "Acme Team", provider: "gmail_app_password", limit: 40, rampDays: 5, ramp: [21, 4], sentToday: 5, tz: "Europe/Lisbon", hours: [9, 17] },
      { from: "support@acme-mail.example", name: "Acme Support", provider: "smtp", limit: 25, rampDays: 70, state: "disconnected", tz: "UTC", hours: [0, 24] },
      { from: "billing@acme-mail.example", name: "Acme Billing", provider: "smtp", limit: 25, rampDays: 0, state: "untested", tz: "UTC", hours: [9, 18], sendOnly: true },
    ] as Array<{ from: string; name: string; provider: string; limit: number; rampDays: number; ramp?: [number, number]; sentToday?: number; state?: MailboxState; tz: string; hours: [number, number]; firstOnly?: number; sendOnly?: boolean }>)
      .map(mailbox => ({ ...mailbox, id: randomUUID(), domain: mailbox.from.split("@")[1], state: mailbox.state ?? ("ok" as MailboxState) }));
    for (const mailbox of mailboxes) {
      const gmail = mailbox.provider === "gmail_app_password";
      insert("email_accounts", {
        id: mailbox.id, workspace_id: ws, name: mailbox.name, from_email: mailbox.from, from_name: mailbox.name, provider: mailbox.provider,
        // Hosts on a reserved domain: nothing here can ever be connected to.
        smtp_host: gmail ? "smtp.gmail.invalid" : `smtp.${mailbox.domain}`, smtp_port: 587, username: mailbox.from, password: encryptSecret("demo-no-such-mailbox"),
        imap_host: mailbox.sendOnly ? null : gmail ? "imap.gmail.invalid" : `imap.${mailbox.domain}`, imap_username: mailbox.from, imap_password: encryptSecret("demo-no-such-mailbox"),
        daily_email_limit: mailbox.limit, is_verified: mailbox.state === "untested" ? 0 : 1, timezone: mailbox.tz,
        active_hours_start: mailbox.hours[0], active_hours_end: mailbox.hours[1],
        ramp_up_enabled: 1, ramp_start_date: stamp(NOW - mailbox.rampDays * DAY).slice(0, 10), ramp_days: mailbox.ramp?.[0] ?? null, ramp_start_limit: mailbox.ramp?.[1] ?? null,
        // The guard that tripped was set a little looser than the default, as the reason says.
        bounce_threshold: mailbox.state === "auto_paused" ? 0.04 : 0.03,
        paused_at: mailbox.state === "auto_paused" ? ago(2 * HOUR) : null, paused_reason: mailbox.state === "auto_paused" ? "Auto-paused: 30-day bounce rate 4.80% exceeds 4.00%" : null,
        disconnected_at: mailbox.state === "disconnected" ? ago(3 * HOUR) : null, imap_auth_failures: mailbox.state === "disconnected" ? 3 : 0,
        disconnect_reason: mailbox.state === "disconnected" ? "The mail server refused the sign-in used to read replies (Invalid credentials)." : null,
        connection_checked_at: mailbox.state === "disconnected" ? ago(12 * 60_000) : null,
        signature: `${mailbox.name}\n${mailbox.name.startsWith("Acme") ? "Acme" : "Account Executive · Acme"}\n${mailbox.domain} · +49 30 5550 0142`, signature_first_only: mailbox.firstOnly ?? 0,
        inbox_synced_at: ago(between(1, 9) * 60_000), created_at: ago((mailbox.rampDays + 3) * DAY),
      });
      insert("warmup_settings", { email_account_id: mailbox.id, workspace_id: ws, enabled: mailbox.state === "untested" ? 0 : 1, daily_target: between(8, 20), reply_rate: 60, started_at: ago(mailbox.rampDays * DAY) });
      count("mailboxes");
    }
    // Each domain's last DNS check, judged by the same code a real check uses.
    const dkimKey = `v=DKIM1; k=rsa; p=${"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A".repeat(13).slice(0, 392)}`;
    for (const [domain, policy] of [["acme.example", "none"], ["getacme.example", "quarantine"], ["acme-mail.example", "none"]] as const) {
      const dns = {
        spf: evaluateSpf(["v=spf1 include:_spf.google.com ~all"]), dkim: evaluateDkim([dkimKey], "google", ["google"]),
        dmarc: evaluateDmarc([`v=DMARC1; p=${policy}; rua=mailto:dmarc@${domain}`]), mx: evaluateMx([{ exchange: "aspmx.l.google.com", priority: 5 }, { exchange: "alt1.aspmx.l.google.com", priority: 10 }]),
      };
      const described = <T extends { status: string; value: string | null }>(record: T) => ({ ...record, ok: record.status !== "fail", records: record.value ? [record.value] : [] });
      insert("deliverability_checks", {
        id: randomUUID(), workspace_id: ws, domain, spf_status: dns.spf.status, dkim_status: dns.dkim.status, dmarc_status: dns.dmarc.status, mx_status: dns.mx.status, score: 90,
        details_json: JSON.stringify({ domain, spf: described(dns.spf), dkim: described(dns.dkim), dmarc: described(dns.dmarc), mx: described(dns.mx), bounce_rate: 0, recommendations: [dns.spf, dns.dkim, dns.dmarc, dns.mx].map(record => record.note).filter(Boolean) }),
        checked_at: ago(8 * HOUR),
      });
    }
    const sendingMailboxes = mailboxes.filter(mailbox => mailbox.state === "ok");

    // ── Companies and contacts ──────────────────────────────────────────────
    const industries = ["Freight & logistics", "SaaS", "FinTech", "Healthcare", "E-commerce", "Developer tools", "Cybersecurity", "Manufacturing", "Legal tech", "Energy"];
    const companyNames = [
      "Northwind Logistics", "Lumen Analytics", "Brightpath Health", "Veltrix", "Fjord Maritime", "Soltera Energy", "Arcadia Labs", "Meridian Freight", "Pivot Retail Group", "Halcyon Studios",
      "Orchard Financial", "Zephyr Mobility", "Fairmont Retail Co", "Castellan Group", "Keystone Build", "Kestrel Analytics", "Harbor & Co", "Atlas Freight", "Fieldstone Capital", "Verda Systems",
      "Cobalt Retail", "Meridian Labs", "Brightline Health", "Bergen Freight", "Nordic POS", "Kelvin Labs", "Vireo Health", "Finwell", "Delta Cargo Group", "Lighthouse Partners",
      "Quanta Robotics", "Sable Payments", "Ironclad Security", "Juniper Legal", "Tidewater Energy", "Maple Commerce", "Polaris Devtools", "Granite ERP", "Silverline Clinics", "Emberly",
    ];
    const tech = ["Salesforce", "HubSpot", "Outreach", "Sales Navigator", "Marketo", "Snowflake", "Workday", "Segment", "Zoom", "SAP TM", "Stripe", "Datadog"];
    const cities = [["Rotterdam", "Netherlands"], ["Berlin", "Germany"], ["London", "United Kingdom"], ["Stockholm", "Sweden"], ["New York", "United States"], ["Madrid", "Spain"], ["Oslo", "Norway"], ["Dublin", "Ireland"], ["Paris", "France"], ["Lisbon", "Portugal"]] as const;
    const companies = companyNames.map((name, index) => {
      const [city, country] = cities[index % cities.length];
      const domain = name.toLowerCase().replace(/[^a-z0-9]+/g, "") + ".example";
      return { id: randomUUID(), name, domain, city, country, industry: industries[index % industries.length], employees: between(80, 5400) };
    });
    for (const [index, company] of companies.entries()) {
      insert("companies", {
        id: company.id, workspace_id: ws, name: company.name, domain: company.domain, website: `https://${company.domain}`, industry: company.industry,
        location: `${company.city}, ${company.country}`, city: company.city, country: company.country, employee_count: company.employees,
        founded_year: between(1988, 2019), annual_revenue: `$${between(8, 400)}M`,
        description: `${company.name} is a ${company.industry.toLowerCase()} company based in ${company.city}.`,
        technology_names: JSON.stringify(Array.from(new Set(Array.from({ length: between(3, 8) }, () => pick(tech))))),
        keywords: JSON.stringify(["b2b", company.industry.toLowerCase(), company.country.toLowerCase()]),
        email_domain_invalid: index === 0 || index === 14 ? 1 : 0, created_at: ago(between(10, 80) * DAY),
      });
      count("companies");
    }

    const firstNames = ["Marcus", "Elena", "Tobias", "Priyanka", "Darren", "Amara", "Kenji", "Sofia", "Sanne", "Pieter", "Noor", "Dana", "Omar", "Luca", "Nina", "Tom", "Aisha", "Ivan", "Lena", "Jonas", "Sara", "Ravi", "Mia", "Hugo", "Ines", "Felix", "Yara", "Anton", "Greta", "Samir"];
    const lastNames = ["Oyelaran", "Vasquez", "Lindqvist", "Shah", "Whitlock", "Nwosu", "Nakamura", "Bergström", "Visser", "Graaf", "Jansen", "Whitfield", "Haddad", "Bianchi", "Kowalski", "Berger", "Bello", "Petrov", "Fischer", "Keller", "Lindgren", "Patel", "Chen", "Moreau", "Duarte", "Brandt", "Haddad", "Novak", "Olsen", "Rahimi"];
    const titles = ["VP Revenue Ops", "Head of Demand Gen", "Director of Sales", "CRO", "RevOps Manager", "VP Marketing", "Sales Enablement Lead", "Growth Lead", "Head of Carrier Ops", "VP Sales", "Head of RevOps", "COO", "CFO", "Director of Procurement", "VP Customer Operations"];
    const seniorities = ["vp", "director", "manager", "c_suite", "head"];

    interface Contact { id: string; name: string; email: string; companyId: string; company: string; emailStatus: string | null; ownerId: string; intent: number }
    const contacts: Contact[] = [];
    const usedNames = new Set<string>();
    while (contacts.length < 320) {
      const first = pick(firstNames);
      const last = pick(lastNames);
      const name = `${first} ${last}`;
      const company = pick(companies);
      const key = `${name}@${company.domain}`;
      if (usedNames.has(key)) continue;
      usedNames.add(key);
      const roll = random();
      const emailStatus = roll < 0.74 ? "verified" : roll < 0.84 ? "catchall" : roll < 0.9 ? "invalid" : roll < 0.95 ? "unverified" : null;
      const hasEmail = emailStatus !== null || chance(0.5);
      const contact: Contact = {
        id: randomUUID(), name, companyId: company.id, company: company.name, emailStatus,
        email: hasEmail ? `${first[0].toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}@${company.domain}` : "",
        ownerId: pick(team.slice(0, 5)).id, intent: chance(0.35) ? between(40, 95) : between(0, 39),
      };
      contacts.push(contact);
      insert("targets", {
        id: contact.id, workspace_id: ws, full_name: name, first_name: first, last_name: last, title: pick(titles), seniority: pick(seniorities),
        company: company.name, company_id: company.id, company_industry: company.industry, company_size: company.employees,
        location: `${company.city}, ${company.country}`, city: company.city, country: company.country,
        time_zone: company.country === "United States" ? "America/New_York" : "Europe/Berlin",
        linkedin_url: `https://www.linkedin.com/in/demo-${first.toLowerCase()}-${last.toLowerCase().replace(/[^a-z]/g, "")}-${contacts.length}/`,
        email: contact.email || null, email_status: contact.emailStatus, email_verified_at: contact.emailStatus ? ago(between(2, 30) * DAY) : null,
        phone: chance(0.3) ? `+31 6 ${between(1000, 9999)} ${between(1000, 9999)}` : null,
        owner_id: contact.ownerId, intent_score: contact.intent, degree: 2, apollo_enriched_at: chance(0.85) ? ago(between(1, 40) * DAY) : null,
        created_at: ago(between(3, 70) * DAY),
      });
      count("contacts");
    }

    // ── Lists ───────────────────────────────────────────────────────────────
    const listNames = [
      "Enterprise VP Sales", "FinTech Ops", "Ecom Tier 1", "Platform Eng", "RCM Directors", "Nordics ICP", "Webinar Q3", "Logistics MM", "RevOps Warm", "CISO Tier 1", "Trial churn", "ERP APAC", "Partners", "Legal ICP",
    ];
    const lists = listNames.map(name => ({ id: randomUUID(), name, members: [] as Contact[] }));
    let cursor = 0;
    for (const [index, list] of lists.entries()) {
      insert("lists", { id: list.id, workspace_id: ws, name: list.name, description: `Demo list ${index + 1}`, purpose: index % 5 === 0 ? "email" : "linkedin", created_at: ago(between(8, 60) * DAY) });
      const size = between(16, 30);
      for (let i = 0; i < size; i++) {
        const contact = contacts[cursor % contacts.length];
        cursor += 1;
        list.members.push(contact);
        db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)").run(list.id, contact.id);
      }
      count("lists");
    }

    // ── Templates ───────────────────────────────────────────────────────────
    const templateIds: string[] = [];
    for (const [name, body] of [
      ["Connection note — hiring signal", "Hi {{first_name}}, saw {{company}} is growing the sales team. Worth connecting?"],
      ["Post-accept follow-up", "Thanks for connecting, {{first_name}}. How is {{company}} handling outbound across LinkedIn and email today?"],
      ["Follow-up DM", "{{first_name|Hi there}}, floating this back up in case it got buried."],
      ["Event follow-up", "Good to meet you at the event, {{first_name}}. Happy to share what we covered."],
    ] as const) {
      const id = randomUUID();
      templateIds.push(id);
      insert("templates", { id, workspace_id: ws, name, body, created_at: ago(between(10, 50) * DAY) });
      count("templates");
    }
    // Email templates, grouped so a step can take the whole set as its pool.
    for (const [index, [name, subject, body]] of ([
      ["Enterprise intro — hiring", "{{company}} + the hiring signal", "Hi {{first_name}},\n\n{{company}} is hiring across sales. Teams that size usually feel the pipeline gap about six weeks later.\n\nWorth 15 minutes?\n\n{{sender.first_name}}\n\n{{unsubscribe}}"],
      ["Enterprise intro — peer proof", "How a team like {{company}} added meetings", "Hi {{first_name}},\n\nA revenue team your size added nine meetings per rep by running LinkedIn and email from one sequence.\n\nOpen to a short call?\n\n{{sender.first_name}}\n\n{{unsubscribe}}"],
      ["Enterprise intro — direct ask", "A quick question, {{first_name}}", "Hi {{first_name}},\n\nWho owns outbound tooling at {{company}}? Happy to send a two-line summary first.\n\n{{sender.first_name}}\n\n{{unsubscribe}}"],
    ] as const).entries()) {
      insert("templates", { id: randomUUID(), workspace_id: ws, name, body, channel: "email", subject, category: "Enterprise intros", created_at: ago((12 + index) * DAY) });
      count("templates");
    }

    // ── Campaigns ───────────────────────────────────────────────────────────
    type Status = "running" | "paused" | "completed" | "draft";
    const campaignPlans: { name: string; list: number; status: Status; linkedin: boolean; email: boolean; age: number; archived?: boolean }[] = [
      { name: "Q4 Enterprise — VP Sales (US)", list: 0, status: "running", linkedin: true, email: true, age: 21 },
      { name: "Series B FinTech — Ops Leaders", list: 1, status: "running", linkedin: true, email: true, age: 18 },
      { name: "Shopify Plus Merchants — H2", list: 2, status: "paused", linkedin: false, email: true, age: 26 },
      { name: "DevTools ICP — Platform Eng", list: 3, status: "running", linkedin: true, email: true, age: 14 },
      { name: "Healthcare RCM — Directors", list: 4, status: "draft", linkedin: true, email: true, age: 1 },
      { name: "Nordic SaaS Expansion", list: 5, status: "running", linkedin: true, email: false, age: 16 },
      { name: "Webinar No-Shows — Reactivation", list: 6, status: "completed", linkedin: false, email: true, age: 30 },
      { name: "Logistics Ops — Mid-Market", list: 7, status: "running", linkedin: true, email: true, age: 19 },
      { name: "RevOps Community — Warm Intros", list: 8, status: "paused", linkedin: true, email: false, age: 24 },
      { name: "Cybersecurity CISO — Tier 1", list: 9, status: "running", linkedin: true, email: true, age: 9 },
      { name: "PLG Trial Abandoners", list: 10, status: "completed", linkedin: false, email: true, age: 34 },
      { name: "Manufacturing ERP — APAC", list: 11, status: "draft", linkedin: false, email: true, age: 2 },
      { name: "Agency Partners — Co-sell", list: 12, status: "running", linkedin: true, email: true, age: 12 },
      { name: "Legal Tech — GC & Deputy GC", list: 13, status: "paused", linkedin: true, email: true, age: 22 },
      // One that has been put away, so the Archived tab has something in it.
      { name: "Summer Launch — Beta Waitlist", list: 6, status: "completed", linkedin: false, email: true, age: 58, archived: true },
    ];

    const replyBodies: Record<string, string[]> = {
      positive: [
        "Makes sense — we're mid-RFP but I'd take a look at the LinkedIn side of this. What does seat pricing look like for a team of nine?",
        "Let's do it. Can you send over times for next Tuesday or Wednesday AM?",
        "Interesting timing — we just lost two SDRs. What does onboarding look like?",
      ],
      human_review: ["Who handles this on your side? Happy to loop in our ops lead before Thursday.", "Can you clarify how the LinkedIn limits work with multiple seats?"],
      out_of_office: ["Thanks for reaching out. I'm out of office until the 20th with limited access to email."],
      negative: ["We already run Outreach and Sales Nav, so not a fit for us this quarter.", "Not something we're looking at right now, thanks."],
      unsubscribe: ["Please remove me from this list and any future sequences. Thanks."],
    };
    const verdictSummary: Record<string, string> = {
      positive: "Open to a conversation; asked a concrete question.",
      human_review: "Asked a question that needs a person to answer.",
      out_of_office: "Out-of-office automatic response.",
      negative: "Not interested at this time.",
      unsubscribe: "Explicit opt-out request.",
    };

    for (const plan of campaignPlans) {
      const workflowId = randomUUID();
      const list = lists[plan.list];
      insert("workflows", {
        id: workflowId, workspace_id: ws, name: plan.name, description: `${list.name} · ${list.members.length} contacts`,
        prompt: "We help revenue teams run LinkedIn and email outreach from one sequence. Be direct and peer-to-peer.",
        send_in_recipient_tz: plan.email ? 1 : 0, created_at: ago((plan.age + 2) * DAY),
        owner_id: pick(team.slice(0, 4)).id, is_archived: plan.archived ? 1 : 0,
      });
      count("campaigns");

      // Steps. Delays are their own rows, as the app stores them.
      interface Step { id: string; track: "linkedin" | "email"; type: string; day: number; order: number }
      const steps: Step[] = [];
      const addTrack = (track: "linkedin" | "email", definitions: { type: string; day: number; row: Record<string, unknown> }[]) => {
        let order = 0;
        let previousDay = 0;
        for (const [index, definition] of definitions.entries()) {
          if (index > 0 || definition.day > 1) {
            order += 1;
            insert("workflow_steps", { id: randomUUID(), workflow_id: workflowId, track, step_type: "delay", step_order: order, delay_seconds: Math.max(1, definition.day - Math.max(previousDay, 1)) * 86_400 });
          }
          order += 1;
          const id = randomUUID();
          insert("workflow_steps", { id, workflow_id: workflowId, track, step_type: definition.type, step_order: order, delay_seconds: 0, ...definition.row });
          steps.push({ id, track, type: definition.type, day: definition.day, order });
          previousDay = definition.day;
        }
      };
      if (plan.linkedin) {
        addTrack("linkedin", [
          { type: "visit", day: 1, row: {} },
          { type: "connect", day: 2, row: { connect_note: "Hi {{first_name}}, working with teams like {{company}} on outbound — thought this might be relevant." } },
          { type: "message", day: 5, row: { message_body: "Thanks for connecting, {{first_name}}. Worth 15 minutes to compare notes?", message_position: 1, template_id: templateIds[1] } },
          { type: "message", day: 11, row: { message_body: "{{first_name}}, floating this back up in case it got buried.", message_position: 2 } },
        ]);
      }
      if (plan.email) {
        addTrack("email", [
          { type: "email", day: 2, row: { email_subject: "{{company}} + 4 new AE reqs", email_body: "Hi {{first_name}} — {{company}} just posted 4 new AE roles. Worth 15 minutes on Thursday?\n\n{{unsubscribe}}", email_position: 1, email_delivery_mode: "enhanced", email_track_opens: 1, email_track_clicks: 1 } },
          { type: "email", day: 5, row: { email_subject: "Re: {{company}} + 4 new AE reqs", email_body: "Hi {{first_name}}, a short case study on how a team your size added nine meetings per rep.", email_position: 2, email_in_thread: 1, email_delivery_mode: "enhanced", email_track_opens: 1 } },
          { type: "email", day: 10, row: { email_subject: "Should I close the loop?", email_body: "{{first_name}}, I'll stop here unless the timing is better later this quarter.", email_position: 3, email_in_thread: 1, email_delivery_mode: "enhanced", email_track_opens: 1 } },
        ]);
      }
      const linkedinSteps = steps.filter(step => step.track === "linkedin");
      const emailSteps = steps.filter(step => step.track === "email");

      // The first campaign is the one the design shows in detail: four versions of its first email.
      const variantIds: string[] = [];
      if (plan.name.startsWith("Q4 Enterprise") && emailSteps[0]) {
        for (const [position, subject] of ["The hiring signal nobody acts on", "Quick question on {{title}} capacity", "Ramp added 9 meetings per rep"].entries()) {
          const id = randomUUID();
          variantIds.push(id);
          insert("workflow_step_email_variants", { id, step_id: emailSteps[0].id, subject, body: `Hi {{first_name}} — version ${String.fromCharCode(66 + position)} of the opener.\n\n{{unsubscribe}}`, position });
        }
        // And the four conditions the design draws on it, one of each kind.
        const gate = (stepId: string | undefined, kind: string, onTrue: object, onFalse: object, conditions: object = {}) => {
          if (!stepId) return;
          insert("workflow_branches", {
            id: randomUUID(), workspace_id: ws, workflow_id: workflowId, source_step_id: stepId, kind, conditions_json: JSON.stringify(conditions),
            true_step_id: null, false_step_id: null, true_outcome_json: JSON.stringify(onTrue), false_outcome_json: JSON.stringify(onFalse),
          });
        };
        gate(linkedinSteps[1]?.id, "connected", { then: "continue" }, { then: "handover_email" });
        gate(linkedinSteps[2]?.id, "no_reply", { then: "continue" }, { then: "leave" });
        gate(emailSteps[0]?.id, "verified_email", { then: "continue" }, { then: "end_track" });
        gate(emailSteps[1]?.id, "conditions", { then: "continue", effects: [{ type: "create_task", title: "Call {{first_name}} at {{company}}" }] }, { then: "end_track" },
          { mode: "all", conditions: [{ field: "intent_score", operator: "gte", value: 70 }] });
      }
      const showcase = plan.name.startsWith("Q4 Enterprise");
      if (plan.status === "draft") continue;

      // The run and everyone enrolled in it.
      const runId = randomUUID();
      const linkedinAccount = plan.linkedin ? pick(liveLinkedin) : null;
      const startedMs = NOW - plan.age * DAY;
      insert("runs", {
        id: runId, workspace_id: ws, workflow_id: workflowId, list_id: list.id, account_id: linkedinAccount?.id ?? null,
        status: plan.status, started_at: stamp(startedMs), last_tick_at: plan.status === "running" ? ago(between(20, 50) * 1000) : ago(between(2, 30) * HOUR),
        completed_at: plan.status === "completed" ? ago(between(2, 6) * DAY) : null, created_at: stamp(startedMs - HOUR),
      });

      for (const contact of list.members) {
        const profileId = randomUUID();
        const mailbox = plan.email ? pick(sendingMailboxes) : null;
        insert("run_profiles", { id: profileId, run_id: runId, target_id: contact.id, email_account_id: mailbox?.id ?? null, created_at: stamp(startedMs) });
        count("enrolments");

        const finished = plan.status === "completed";
        let lastTouchMs = startedMs;
        let replied: { channel: "linkedin" | "email"; atMs: number } | null = null;

        // LinkedIn track.
        let linkedinDone = 0;
        let accepted = false;
        if (linkedinSteps.length && linkedinAccount) {
          const reach = finished ? linkedinSteps.length : Math.min(linkedinSteps.length, Math.floor(((NOW - startedMs) / DAY + between(-3, 2)) / 3));
          accepted = chance(0.4);
          for (const step of linkedinSteps) {
            if (linkedinDone >= Math.max(0, reach)) break;
            if (step.type === "message" && !accepted) break;
            const sentMs = Math.min(NOW - between(1, 20) * HOUR, startedMs + step.day * DAY + between(0, 6) * HOUR);
            insert("step_sends", { id: randomUUID(), workspace_id: ws, run_id: runId, workflow_id: workflowId, step_id: step.id, target_id: contact.id, channel: "linkedin", action: step.type, account_id: linkedinAccount.id, sent_at: stamp(sentMs) });
            count("LinkedIn actions");
            lastTouchMs = Math.max(lastTouchMs, sentMs);
            linkedinDone += 1;
            if (step.type === "connect") db.prepare("UPDATE targets SET connection_requested_at = ?, connected_at = ?, degree = ? WHERE id = ?").run(stamp(sentMs), accepted ? stamp(sentMs + between(4, 60) * HOUR) : null, accepted ? 1 : 2, contact.id);
            if (step.type === "message") {
              db.prepare("UPDATE targets SET message_sent_at = ? WHERE id = ?").run(stamp(sentMs), contact.id);
              insert("linkedin_messages", { id: randomUUID(), workspace_id: ws, account_id: linkedinAccount.id, target_id: contact.id, conversation_urn: `urn:li:demo:conversation:${contact.id}`, message_urn: `urn:li:demo:message:${randomUUID()}`, direction: "out", body: "Thanks for connecting. Worth 15 minutes to compare notes?", sent_at: iso(sentMs), run_id: runId, step_id: step.id });
              if (!replied && chance(0.16)) replied = { channel: "linkedin", atMs: Math.min(NOW - between(2, 90) * 60_000, sentMs + between(2, 40) * HOUR) };
            }
          }
        }

        // Email track.
        let emailDone = 0;
        const canEmail = Boolean(mailbox && contact.email && contact.emailStatus !== "invalid");
        if (emailSteps.length && mailbox && canEmail) {
          const reach = finished ? emailSteps.length : Math.min(emailSteps.length, Math.floor(((NOW - startedMs) / DAY + between(-2, 3)) / 4));
          for (const step of emailSteps) {
            if (emailDone >= Math.max(0, reach) || replied) break;
            const sentMs = Math.min(NOW - between(1, 30) * HOUR, startedMs + step.day * DAY + between(0, 8) * HOUR);
            const jobId = randomUUID();
            const messageId = `<${jobId}@${mailbox.domain}>`;
            const variantId = emailDone === 0 && variantIds.length ? pick([null, ...variantIds]) : null;
            const subject = emailDone === 0 ? `${contact.company} + 4 new AE reqs` : emailDone === 1 ? `Re: ${contact.company} + 4 new AE reqs` : "Should I close the loop?";
            insert("email_jobs", {
              id: jobId, workspace_id: ws, email_account_id: mailbox.id, idempotency_key: `demo:${jobId}`, source: "campaign", target_id: contact.id, run_id: runId, step_id: step.id,
              recipient: contact.email, subject, body_text: `Hi ${contact.name.split(" ")[0]} — ${contact.company} just posted 4 new AE roles. Worth 15 minutes on Thursday?`,
              email_delivery_mode: "enhanced", track_opens: 1, track_clicks: 1, status: "sent", attempt: 1, variant_id: variantId, created_at: stamp(sentMs), updated_at: stamp(sentMs),
            });
            const bounced = chance(0.015);
            const sentMessageId = randomUUID();
            insert("sent_messages", {
              id: sentMessageId, workspace_id: ws, email_account_id: mailbox.id, job_id: jobId, message_id: messageId, recipient: contact.email, subject,
              run_id: runId, target_id: contact.id, status: bounced ? "bounced" : "delivered", accepted_at: stamp(sentMs),
              delivered_at: bounced ? null : stamp(sentMs + 4000), bounced_at: bounced ? stamp(sentMs + 90_000) : null,
            });
            insert("step_sends", { id: randomUUID(), workspace_id: ws, run_id: runId, workflow_id: workflowId, step_id: step.id, target_id: contact.id, channel: "email", action: "email", email_account_id: mailbox.id, email_job_id: jobId, variant_id: variantId, sent_at: stamp(sentMs) });
            count("emails");
            lastTouchMs = Math.max(lastTouchMs, sentMs);
            emailDone += 1;
            const event = (type: string, atMs: number, extra: Record<string, unknown> = {}) =>
              insert("sender_events", { id: randomUUID(), workspace_id: ws, email_account_id: mailbox.id, provider: "linki", event_type: type, message_id: messageId, sent_message_id: sentMessageId, recipient: contact.email, occurred_at: stamp(atMs), ...extra });
            if (bounced) {
              event("bounced", sentMs + 90_000);
              db.prepare("UPDATE targets SET email_status = 'invalid' WHERE id = ?").run(contact.id);
              break;
            }
            if (chance(0.3)) event("opened", sentMs + between(2, 12) * 1000, { is_bot: 1, bot_reason: pick(["scanner_user_agent", "scanner_user_agent", "prefetch", "prefetch", "automation_user_agent"]), user_agent: "Mozilla/5.0 (compatible; Proofpoint)" });
            if (chance(0.45)) {
              const opens = between(1, 4);
              for (let i = 0; i < opens; i++) event("opened", Math.min(NOW - 60_000, sentMs + between(1, 60) * HOUR));
              if (chance(0.15)) event("clicked", Math.min(NOW - 60_000, sentMs + between(1, 60) * HOUR), { payload_json: JSON.stringify({ url: "https://acme.example/pricing" }) });
              if (!replied && chance(0.14)) replied = { channel: "email", atMs: Math.min(NOW - between(2, 180) * 60_000, sentMs + between(1, 50) * HOUR) };
            }
          }
        }

        // Which way each contact went at the showcase campaign's conditions, from what happened to them above.
        if (showcase) {
          const went = (stepId: string | undefined, kind: string, side: boolean, outcome: string) => {
            if (stepId) insert("step_outcomes", { id: randomUUID(), workspace_id: ws, workflow_id: workflowId, run_id: runId, target_id: contact.id, step_id: stepId, kind, side: side ? "true" : "false", outcome });
          };
          if (linkedinDone >= 2) went(linkedinSteps[1]?.id, "connected", accepted, accepted ? "continue" : "handover_email");
          if (linkedinDone >= 3) went(linkedinSteps[2]?.id, "no_reply", replied?.channel !== "linkedin", replied?.channel === "linkedin" ? "leave" : "continue");
          if (emailDone >= 1 || !canEmail) went(emailSteps[0]?.id, "verified_email", canEmail, canEmail ? "continue" : "end_track");
          if (emailDone >= 2) went(emailSteps[1]?.id, "conditions", contact.intent >= 70, contact.intent >= 70 ? "continue" : "end_track");
        }

        // A reply stops both tracks, as it does in the app.
        if (replied) {
          const roll = random();
          const kind = roll < 0.42 ? "positive" : roll < 0.55 ? "human_review" : roll < 0.7 ? "out_of_office" : roll < 0.93 ? "negative" : "unsubscribe";
          const body = pick(replyBodies[kind]);
          const replyId = randomUUID();
          const received = iso(replied.atMs);
          const assignee = chance(0.55) ? pick(team.slice(0, 4)).id : null;
          insert("email_replies", {
            id: replyId, workspace_id: ws, target_id: contact.id, run_id: runId, channel: replied.channel,
            from_email: replied.channel === "email" ? contact.email : "", subject: replied.channel === "email" ? `Re: ${contact.company} + 4 new AE reqs` : null, body_text: body,
            received_at: received, classified_at: received, dispatched_at: received,
            classification_json: JSON.stringify({ kind, confidence: Number((0.7 + random() * 0.29).toFixed(2)), summary: verdictSummary[kind], suggested_action: kind === "positive" ? "Offer two concrete times and attach the relevant case study." : null }),
            dispatch_result_json: JSON.stringify({ action: kind === "out_of_office" ? "rescheduled" : "unenrolled" }),
            sentiment: kind === "positive" ? "positive" : kind === "negative" || kind === "unsubscribe" ? "negative" : "neutral",
            inbox_status: kind === "negative" || kind === "unsubscribe" ? "closed" : "open", assigned_to: assignee,
            sla_due_at: stamp(replied.atMs + 4 * HOUR), email_account_id: replied.channel === "email" ? mailbox?.id ?? null : null,
            linkedin_account_id: replied.channel === "linkedin" ? linkedinAccount?.id ?? null : null,
            conversation_urn: replied.channel === "linkedin" ? `urn:li:demo:conversation:${contact.id}` : null,
            external_id: replied.channel === "linkedin" ? `urn:li:demo:message:${replyId}` : null,
          });
          count("replies");
          if (replied.channel === "linkedin" && linkedinAccount) {
            insert("linkedin_messages", { id: randomUUID(), workspace_id: ws, account_id: linkedinAccount.id, target_id: contact.id, conversation_urn: `urn:li:demo:conversation:${contact.id}`, message_urn: `urn:li:demo:message:${replyId}`, direction: "in", body, sent_at: received });
            db.prepare("UPDATE targets SET last_replied_at = ?, reply_kind = ? WHERE id = ?").run(received, kind, contact.id);
          } else {
            db.prepare("UPDATE targets SET email_replied_at = ?, reply_kind = ? WHERE id = ?").run(received, kind, contact.id);
          }
          if (kind === "unsubscribe") {
            db.prepare("UPDATE targets SET unsubscribed_at = ? WHERE id = ?").run(received, contact.id);
            if (contact.email) db.prepare("INSERT OR IGNORE INTO suppressions (id, workspace_id, kind, value, reason, source, target_id) VALUES (?, ?, 'email', ?, 'unsubscribed', 'reply', ?)").run(randomUUID(), ws, contact.email, contact.id);
          }
        }

        // Where each track now stands.
        const trackRow = (track: "linkedin" | "email", done: number, total: number, waiting: boolean) => {
          const complete = done >= total;
          const state = replied ? "skipped" : complete ? "completed" : waiting ? "in_progress" : "pending";
          insert("run_profile_tracks", {
            id: randomUUID(), run_profile_id: profileId, track, state, current_step: done, attempts: 0,
            error_message: replied ? "Lead replied" : null, last_step_at: done ? stamp(lastTouchMs) : null,
            next_step_at: state === "pending" || state === "in_progress" ? stamp(NOW + between(2, 70) * HOUR) : null, created_at: stamp(startedMs),
          });
        };
        if (linkedinSteps.length) trackRow("linkedin", linkedinDone, linkedinSteps.length, linkedinDone === 2 && !accepted);
        if (emailSteps.length) {
          if (canEmail) trackRow("email", emailDone, emailSteps.length, false);
          else insert("run_profile_tracks", { id: randomUUID(), run_profile_id: profileId, track: "email", state: "skipped", current_step: 0, error_message: contact.email ? "Email address is invalid" : "No email address", created_at: stamp(startedMs) });
        }
      }

      insert("logs", { id: randomUUID(), run_id: runId, level: "info", message: `Campaign started with ${list.members.length} contacts`, created_at: stamp(startedMs) });

      // The run log, as the runner would have written it: one line for each of the latest sends, oldest first.
      const LOG_WORDS: Record<string, string> = { visit: "Profile visited", connect: "Connection request sent", message: "Message sent", sales_inmail: "InMail sent", email: "Email sent" };
      const sends = db.prepare("SELECT action, target_id, sent_at FROM step_sends WHERE run_id = ? ORDER BY datetime(sent_at) DESC LIMIT 90").all(runId) as Array<{ action: string; target_id: string; sent_at: string }>;
      for (const send of sends.reverse()) insert("logs", { id: randomUUID(), run_id: runId, target_id: send.target_id, level: "info", message: LOG_WORDS[send.action] ?? send.action, created_at: send.sent_at });
      if (showcase) {
        // A few prospects a step has failed on, for the Prospects tab's retry.
        const stuck = db.prepare(
          "SELECT rt.id, rp.target_id FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id WHERE rp.run_id = ? AND rt.track = 'linkedin' AND rt.state IN ('in_progress', 'pending') LIMIT 4",
        ).all(runId) as Array<{ id: string; target_id: string }>;
        for (const [index, track] of stuck.entries()) {
          const reason = ["Profile not found", "LinkedIn did not accept the request. Try again later", "Profile not found", "Timed out opening the profile"][index];
          db.prepare("UPDATE run_profile_tracks SET state = 'failed', error_message = ?, next_step_at = NULL WHERE id = ?").run(reason, track.id);
          insert("logs", { id: randomUUID(), run_id: runId, target_id: track.target_id, level: "error", message: `Step failed: ${reason}`, created_at: ago((index + 1) * 3 * HOUR) });
        }
        insert("logs", { id: randomUUID(), run_id: runId, level: "warn", message: "Daily invitation limit reached on one account. Its remaining invitations wait until tomorrow", created_at: ago(2 * HOUR) });
      }
    }

    // ── What each mailbox has done today and is about to do ─────────────────
    for (const mailbox of mailboxes) {
      // Its contacts in running campaigns, and the email step each one is on.
      const profiles = db.prepare(`SELECT rp.id AS profile_id, rp.run_id, rp.target_id, r.workflow_id, rt.id AS track_id, rt.current_step, t.full_name
        FROM run_profiles rp JOIN runs r ON r.id = rp.run_id JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id AND rt.track = 'email' JOIN targets t ON t.id = rp.target_id
        WHERE rp.email_account_id = ? AND r.status = 'running' AND rt.state IN ('pending', 'in_progress')`).all(mailbox.id) as { profile_id: string; run_id: string; target_id: string; workflow_id: string; track_id: string; current_step: number; full_name: string }[];
      // Today's campaign emails, as the runner records them: a line in the run log and a
      // row in step_sends, inside the mailbox's own calendar day.
      const dayStart = Date.parse(`${localDayBoundsUtc(mailbox.tz).start.replace(" ", "T")}Z`);
      const earliest = Math.max(dayStart + 60_000, NOW - 9 * HOUR);
      for (let i = 0; i < (profiles.length ? mailbox.sentToday ?? 0 : 0); i++) {
        const profile = profiles[i % profiles.length];
        const sentMs = Math.round(earliest + ((NOW - 4 * 60_000 - earliest) * (i + 1)) / (mailbox.sentToday ?? 1));
        const stepId = (db.prepare("SELECT id FROM workflow_steps WHERE workflow_id = ? AND track = 'email' ORDER BY step_order LIMIT 1 OFFSET ?").get(profile.workflow_id, Math.max(0, profile.current_step - 1)) as { id: string } | undefined)?.id ?? null;
        insert("logs", { id: randomUUID(), run_id: profile.run_id, target_id: profile.target_id, level: "info", message: `Email sent to ${profile.full_name}`, created_at: stamp(sentMs) });
        insert("step_sends", { id: randomUUID(), workspace_id: ws, run_id: profile.run_id, workflow_id: profile.workflow_id, step_id: stepId, target_id: profile.target_id, channel: "email", action: "email", email_account_id: mailbox.id, sent_at: stamp(sentMs) });
      }
      // The next few contacts due, minutes apart. The times are what the runner would have
      // set; the screen calls them estimates.
      profiles.slice(0, 7).forEach((profile, index) => {
        db.prepare("UPDATE run_profile_tracks SET state = 'in_progress', next_step_at = ? WHERE id = ?").run(iso(NOW + (4 + index * 14 + between(0, 6)) * 60_000), profile.track_id);
      });

      // Thirty days of sending for the two mailboxes whose figures are the point of them:
      // the one its guard paused, and the new one with a poor start.
      const history = mailbox.state === "auto_paused" ? { sent: 250, bounces: 12 } : mailbox.from.startsWith("team@") ? { sent: 60, bounces: 2 } : null;
      for (let i = 0; i < (history?.sent ?? 0); i++) {
        const jobId = randomUUID();
        const sentMs = NOW - between(3, 20 * 24) * HOUR;
        insert("email_jobs", { id: jobId, workspace_id: ws, email_account_id: mailbox.id, idempotency_key: `demo:${jobId}`, source: "campaign", recipient: `lead${i}@prospect.example`, subject: "Quick question", body_text: "Demo.", status: "sent", attempt: 1, created_at: stamp(sentMs), updated_at: stamp(sentMs) });
        const sentMessageId = randomUUID();
        const bounced = i < (history?.bounces ?? 0);
        insert("sent_messages", { id: sentMessageId, workspace_id: ws, email_account_id: mailbox.id, job_id: jobId, message_id: `<${jobId}@${mailbox.domain}>`, recipient: `lead${i}@prospect.example`, subject: "Quick question", status: bounced ? "bounced" : "delivered", accepted_at: stamp(sentMs), bounced_at: bounced ? stamp(sentMs + 90_000) : null });
        if (bounced) insert("sender_events", { id: randomUUID(), workspace_id: ws, email_account_id: mailbox.id, provider: "imap", provider_event_id: `demo-bounce:${jobId}`, event_type: "bounced", sent_message_id: sentMessageId, recipient: `lead${i}@prospect.example`, occurred_at: stamp(sentMs + 90_000) });
      }

      // A week of warm-up mail to the other mailboxes in the pool. A few were found in spam
      // and moved back; the new mailbox on the third domain has more of those.
      if (mailbox.state === "ok") {
        const peers = mailboxes.filter(peer => peer.id !== mailbox.id && peer.state === "ok");
        const spamShare = mailbox.from.startsWith("team@") ? 0.22 : 0.03;
        for (let i = 0; i < between(38, 64); i++) {
          const sentMs = NOW - between(20, 7 * 24 * 60) * 60_000;
          const rescued = chance(spamShare);
          insert("warmup_messages", {
            id: randomUUID(), workspace_id: ws, from_account_id: mailbox.id, to_account_id: pick(peers).id, subject: pick(["Quick project update", "Checking in", "Notes from earlier", "Following up"]), body: "Demo warm-up mail.",
            status: "sent", scheduled_at: stamp(sentMs), sent_at: stamp(sentMs), message_id: `<${randomUUID()}@${mailbox.domain}>`,
            engaged_at: stamp(sentMs + 6 * 60_000), rescued_at: rescued ? stamp(sentMs + 6 * 60_000) : null, replied_at: chance(0.6) ? stamp(sentMs + 40 * 60_000) : null,
          });
        }
      }
    }
    // Two test sends whose landing place was read back: one fine, one not.
    const testSend = (from: string, minutesAgo: number, placement: string, folder: string, auth: Record<string, string>) => {
      const mailbox = mailboxes.find(candidate => candidate.from === from)!;
      insert("mailbox_test_sends", {
        id: randomUUID(), workspace_id: ws, email_account_id: mailbox.id, recipient: mailbox.from, message_id: `<${randomUUID()}@${mailbox.domain}>`, reader_account_id: mailbox.id,
        status: "found", placement, folder, auth_json: JSON.stringify(auth), sent_at: ago(minutesAgo * 60_000), checked_at: ago((minutesAgo - 1) * 60_000),
      });
    };
    testSend("jordan@acme.example", 2, "primary", "INBOX", { spf: "pass", dkim: "pass", dmarc: "pass" });
    testSend("team@acme-mail.example", 26 * 60, "spam", "[Gmail]/Spam", { spf: "pass", dkim: "pass", dmarc: "fail" });

    // ── Deliverability: what the guards did lately, seeds, a placement test, complaints ──
    const mailboxOf = (from: string) => mailboxes.find(candidate => candidate.from === from)!;
    const guardEvent = (minutesAgo: number, kind: string, tone: string, title: string, detail: string, from: string | null, domain: string | null) =>
      insert("mailbox_guard_events", { id: randomUUID(), workspace_id: ws, email_account_id: from ? mailboxOf(from).id : null, domain: domain ?? (from ? mailboxOf(from).domain : null), kind, tone, title, detail, occurred_at: ago(minutesAgo * 60_000) });
    guardEvent(118, "auto_pause", "bad", "elena@acme.example auto-paused", "Its 30-day bounce rate 4.80% exceeds 4.00%. Its contacts wait for it to resume.", "elena@acme.example", null);
    guardEvent(180, "disconnected", "bad", "support@acme-mail.example cannot sign in", "The mail server refused the sign-in used to read replies (Invalid credentials). Nothing is sent from it and its contacts wait until it is reconnected.", "support@acme-mail.example", null);
    guardEvent(205, "daily_limit", "warn", "marcus@acme.example reached its daily limit", "60 of 60 sent. 31 more emails wait until tomorrow.", "marcus@acme.example", null);
    guardEvent(8 * 60, "dns_change", "good", "DMARC record updated on acme.example", "Was: v=DMARC1; p=none. Now: v=DMARC1; p=none; rua=mailto:dmarc@acme.example. The policy is unchanged, so the domain's score is too.", null, "acme.example");
    guardEvent(11 * 60, "warmup_cycle", "mail", "Warm-up day completed", "412 warm-up emails sent from 7 mailboxes yesterday, 247 replied to, 9 moved out of spam.", null, null);
    guardEvent(3 * 24 * 60, "complaint", "warn", "An email from team@acme-mail.example was marked as spam", "lead7@prospect.example reported it, and their mail provider told this mailbox. The address is now on the do-not-contact list.", "team@acme-mail.example", null);
    guardEvent(5 * 24 * 60, "reconnected", "good", "daniel@getacme.example signs in again", "Sending from it has resumed and the emails that were waiting will go.", "daniel@getacme.example", null);
    // The complaint itself, so the figure and the log agree.
    insert("sender_events", { id: randomUUID(), workspace_id: ws, email_account_id: mailboxOf("team@acme-mail.example").id, provider: "feedback-report", provider_event_id: `demo-complaint:${randomUUID()}`, event_type: "complained", recipient: "lead7@prospect.example", occurred_at: ago(3 * DAY) });

    // Sends the do-not-contact list stopped, as the runner writes them in a campaign's log.
    const anyRun = db.prepare("SELECT id FROM runs WHERE workspace_id = ? AND status = 'running' LIMIT 1").get(ws) as { id: string } | undefined;
    for (let i = 0; anyRun && i < 37; i++) {
      insert("logs", { id: randomUUID(), run_id: anyRun.id, level: "warn", message: `A contact is suppressed (Recipient is suppressed: ${pick(["unsubscribed", "manual", "bounced", "customer"])}) — unenrolling email track`, created_at: ago(between(1, 29 * 24) * HOUR) });
    }

    insert("mail_domains", { workspace_id: ws, domain: "acme.example", dkim_selector: "google" });
    // Seeds: three of the workspace's own mailboxes, which Linki reads, and two it cannot.
    const seedAddresses = ["jordan@acme.example", "outreach@getacme.example", "team@acme-mail.example", "seed.panel@gmail.example", "seed.panel@outlook.example"];
    for (const [index, email] of seedAddresses.entries()) insert("placement_seeds", { id: randomUUID(), workspace_id: ws, email, label: index > 2 ? "Seed panel" : null, created_by: owner.id, created_at: ago((30 - index) * DAY) });
    const placementRun = (from: string, hoursAgo: number, results: Array<[string, string | null]>) => {
      const sender = mailboxOf(from);
      const runId = randomUUID();
      insert("placement_runs", { id: runId, workspace_id: ws, email_account_id: sender.id, domain: sender.domain, created_by: owner.id, created_at: ago(hoursAgo * HOUR) });
      for (const [index, [placement, folder]] of results.entries()) {
        const seed = seedAddresses[index];
        const reader = mailboxes.find(candidate => candidate.from === seed);
        insert("inbox_placement_tests", {
          id: randomUUID(), workspace_id: ws, email_account_id: sender.id, seed_email: seed, subject: `Placement check ${runId.slice(0, 8)}`, message_id: `<${randomUUID()}@${sender.domain}>`,
          status: placement === "waiting" ? "sent" : "checked", placement: placement === "waiting" ? null : placement, folder, run_id: runId, reader_account_id: reader?.id ?? null,
          auth_json: reader && placement !== "waiting" ? JSON.stringify({ spf: "pass", dkim: "pass", dmarc: placement === "spam" ? "fail" : "pass" }) : null,
          sent_at: ago(hoursAgo * HOUR), checked_at: placement === "waiting" ? null : ago(hoursAgo * HOUR - 2 * 60_000), created_at: ago(hoursAgo * HOUR),
        });
      }
    };
    placementRun("jordan@acme.example", 3, [["primary", "INBOX"], ["inbox", "INBOX"], ["spam", "[Gmail]/Spam"], ["inbox", null], ["waiting", null]]);
    placementRun("priya@acme.example", 6 * 24, [["primary", "INBOX"], ["inbox", "INBOX"], ["inbox", "INBOX"], ["promotions", null], ["inbox", null]]);
    placementRun("outreach@getacme.example", 2 * 24, [["primary", "INBOX"], ["inbox", "INBOX"], ["inbox", "INBOX"], ["inbox", null], ["inbox", null]]);


    // The guided tours are for someone's first visit. The demo's members have had theirs,
    // so opening the demo does not start one over whatever is being looked at.
    for (const member of team) {
      for (const tour of TOUR_IDS) insert("user_settings", { user_id: member.id, key: `tour_seen_${seenKey(tour)}`, value: "1" });
    }
    // ── Pipeline, tasks, meetings, activity ─────────────────────────────────
    const stages = db.prepare("SELECT id, name FROM pipeline_stages WHERE workspace_id = ? ORDER BY position").all(ws) as { id: string; name: string }[];
    const positiveContacts = db.prepare("SELECT id, company, company_id, full_name FROM targets WHERE workspace_id = ? AND reply_kind = 'positive' LIMIT 18").all(ws) as { id: string; company: string; company_id: string; full_name: string }[];
    const opportunityIds: string[] = [];
    for (const [index, contact] of positiveContacts.entries()) {
      const stage = stages[index % stages.length];
      const id = randomUUID();
      opportunityIds.push(id);
      const closed = /won|lost/i.test(stage.name);
      insert("opportunities", {
        id, workspace_id: ws, target_id: contact.id, company_id: contact.company_id, stage_id: stage.id, owner_id: pick(team.slice(0, 4)).id,
        name: contact.company, amount: between(8, 52) * 1000, currency: "USD", source: pick(["linkedin", "email"]),
        expected_close_date: stamp(NOW + between(-10, 40) * DAY).slice(0, 10), closed_at: closed ? ago(between(1, 20) * DAY) : null,
        created_at: ago(between(5, 30) * DAY), updated_at: ago(between(0, 5) * DAY),
      });
      count("opportunities");
    }
    for (const [index, contact] of positiveContacts.slice(0, 8).entries()) {
      insert("todos", {
        id: randomUUID(), workspace_id: ws, target_id: contact.id,
        title: pick(["Send the pricing one-pager", "Answer the proposal questions", "Call about pilot scope", "Share the logistics case study", "Follow up after the RFP closes"]),
        description: `${contact.company} · ${contact.full_name}`, due_date: stamp(NOW + (index - 2) * DAY).slice(0, 10), status: index === 7 ? "done" : "open", created_at: ago(between(1, 6) * DAY),
      });
      count("tasks");
      insert("activity_logs", { id: randomUUID(), workspace_id: ws, target_id: contact.id, type: pick(["call", "note", "meeting"]), body: "Mid-RFP with an incumbent; decision owner is the CFO. Re-engage after the RFP closes.", logged_at: ago(between(1, 10) * DAY) });
    }
    for (const [index, contact] of positiveContacts.slice(0, 5).entries()) {
      insert("meetings", {
        id: randomUUID(), workspace_id: ws, target_id: contact.id, opportunity_id: opportunityIds[index] ?? null, title: `${pick(["Discovery", "Pilot scope", "Proposal review"])} — ${contact.company}`,
        starts_at: iso(NOW + (index - 1) * DAY + 3 * HOUR), ends_at: iso(NOW + (index - 1) * DAY + 4 * HOUR), status: "confirmed",
        attendees_json: JSON.stringify([{ name: contact.full_name }]), external_id: `demo-meeting-${index}`,
      });
      count("meetings");
    }

    // ── Signals and rules ───────────────────────────────────────────────────
    const signalTitles: Record<string, string[]> = {
      hiring: ["3 RevOps roles posted", "Hiring 4 account executives"], funding: ["Raised Series D — $120M", "Closed a $30M Series B"],
      job_change: ["New CRO appointed", "New VP Sales joined"], technology: ["Added Snowflake to stack", "Adopted Salesforce"], product_intent: ["Viewed pricing twice this week"],
    };
    for (let i = 0; i < 24; i++) {
      const type = pick(Object.keys(signalTitles));
      const contact = pick(contacts);
      insert("signals", {
        id: randomUUID(), workspace_id: ws, target_id: chance(0.7) ? contact.id : null, company_id: contact.companyId, type, title: pick(signalTitles[type]),
        description: `${contact.company} · detected from a demo source`, score: between(20, 90), source: pick(["api", "manual", "mcp"]),
        occurred_at: ago(between(1, 20 * 24) * HOUR), processed_at: i < 3 ? null : ago(between(1, 10) * HOUR),
      });
      count("signals");
    }
    insert("signal_rules", { id: randomUUID(), workspace_id: ws, name: "Funding → Enterprise list", signal_type: "funding", min_score: 50, list_id: lists[0].id, enabled: 1 });
    insert("signal_rules", { id: randomUUID(), workspace_id: ws, name: "Hiring → Nordics list", signal_type: "hiring", min_score: 40, list_id: lists[5].id, enabled: 0 });

    // ── Do-not-contact, saved replies, tags ─────────────────────────────────
    for (let i = 0; i < 26; i++) {
      const kind = pick(["email", "email", "email", "domain", "linkedin", "phone"]);
      const value = kind === "email" ? `blocked${i}@former-customer.example` : kind === "domain" ? `competitor${i}.example` : kind === "linkedin" ? `https://www.linkedin.com/in/demo-blocked-${i}/` : `+1555010${String(i).padStart(4, "0")}`;
      db.prepare("INSERT OR IGNORE INTO suppressions (id, workspace_id, kind, value, reason, source, created_by) VALUES (?, ?, ?, ?, ?, 'manual', ?)").run(randomUUID(), ws, kind, value, pick(["manual", "customer", "bounced", "complaint"]), owner.id);
      count("suppressions");
    }
    for (const [name, body] of [
      ["Seat pricing (9 seats)", "For nine seats it's $740/mo on the Growth plan, LinkedIn seats included."],
      ["Propose two times", "Would Tuesday 10:00 or Wednesday 09:30 CET work?"],
      ["Logistics case study", "Here is how a mid-market freight team added nine meetings per rep in a quarter."],
    ] as const) insert("saved_replies", { id: randomUUID(), workspace_id: ws, name, body, created_by: owner.id });
    const tagIds = [["Enterprise · RFP", "#5e6ad2"], ["Pricing question", "#b4690e"], ["Referral", "#1f8a5c"]].map(([name, color]) => {
      const id = randomUUID();
      insert("inbox_tags", { id, workspace_id: ws, name, color });
      return id;
    });
    const openReplies = db.prepare("SELECT id FROM email_replies WHERE workspace_id = ? AND inbox_status = 'open' LIMIT 9").all(ws) as { id: string }[];
    for (const [index, reply] of openReplies.entries()) db.prepare("INSERT OR IGNORE INTO email_reply_tags (reply_id, tag_id) VALUES (?, ?)").run(reply.id, tagIds[index % tagIds.length]);

    // ── Developer surface and history ───────────────────────────────────────
    // Four endpoints, each in a different state. Every address is on a reserved domain, so a
    // test or a redelivery pressed in the demo finds no host and goes nowhere.
    //   [name, url, events, enabled, delivered, given up, retrying, minutes since the last delivery]
    const HOOK_EVENT = ["reply.received", "email.bounced", "contact.created", "meeting.booked", "email.sent", "linkedin.connected"];
    let hookNumber = 0; // each endpoint a day older than the one before, so the list keeps this order
    for (const [name, url, events, enabled, delivered, dead, retrying, lastMinutes] of [
      ["Reply router", "https://hooks.acme.example/linki/replies", "reply.received,email.bounced", 1, 499, 1, 0, 2],
      ["CRM bridge", "https://crm.acme.example/hooks/linki-sync", "contact.created,opportunity.stage_changed", 1, 66, 2, 0, 11],
      ["Slack alerts", "https://alerts.acme.example/hooks/linki", "sender.auto_paused,linkedin.signin_needed", 1, 10, 4, 2, 34],
      ["Data warehouse", "https://etl.acme.example/ingest/linki", "*", 0, 120, 0, 0, 60],
    ] as const) {
      const endpointId = randomUUID();
      insert("webhook_endpoints", { id: endpointId, workspace_id: ws, name, url, secret: encryptSecret(`whsec_demo_${randomUUID()}`), event_types: events, enabled, created_by: owner.id, created_at: ago((120 + hookNumber++) * DAY) });
      count("webhooks");
      const types = events === "*" ? HOOK_EVENT : events.split(",");
      const deliveries: Array<{ status: "delivered" | "dead_letter" | "retrying"; minutes: number }> = [];
      if (retrying > 0) {
        // Went wrong today: the failures are its newest deliveries, the ones given up on from earlier in the outage.
        for (let index = 0; index < retrying; index++) deliveries.push({ status: "retrying", minutes: lastMinutes + index * 12 });
        for (let index = 0; index < dead; index++) deliveries.push({ status: "dead_letter", minutes: lastMinutes + 300 + index * 95 });
        for (let index = 0; index < delivered; index++) deliveries.push({ status: "delivered", minutes: lastMinutes + 1_500 + index * 410 });
      } else {
        // Fine now: what was given up on is from an outage four days ago.
        for (let index = 0; index < delivered; index++) deliveries.push({ status: "delivered", minutes: lastMinutes + index * 47 });
        for (let index = 0; index < dead; index++) deliveries.push({ status: "dead_letter", minutes: 4 * 1_440 + index * 35 });
      }
      const total = deliveries.length;
      for (const [index, delivery] of deliveries.entries()) {
        const eventId = randomUUID();
        const type = types[index % types.length];
        const at = ago(delivery.minutes * 60_000);
        insert("domain_events", { id: eventId, workspace_id: ws, type, entity_type: type.split(".")[0], entity_id: randomUUID(), payload_json: "{}", occurred_at: at, processed_at: delivery.status === "retrying" ? null : at });
        insert("webhook_deliveries", {
          id: randomUUID(), workspace_id: ws, event_id: eventId, endpoint_id: endpointId, created_at: at,
          ...(delivery.status === "delivered"
            ? { status: "delivered", attempt: 1, response_status: 200, response_body: "ok", delivered_at: at }
            : { status: delivery.status, attempt: delivery.status === "retrying" ? 3 : 8, response_status: 503, last_error: "HTTP 503: upstream connect error", next_attempt_at: stamp(NOW + 6 * 60_000) }),
        });
      }
      count("webhook deliveries", total);
    }

    // ── Integrations ────────────────────────────────────────────────────────
    // Tokens that open nothing. With LINKI_RUNNER=off nothing syncs; pressing "Sync now" in
    // the demo would ask the real provider and be refused.
    insert("integrations", { workspace_id: ws, key: "apollo", api_key: encryptSecret("apollo-demo-key-that-opens-nothing-4f1a"), updated_at: ago(63 * DAY) });
    const hubspotId = randomUUID();
    insert("external_connections", { id: hubspotId, workspace_id: ws, provider: "hubspot", name: "HubSpot", config_json: JSON.stringify({ last_contact_export_at: iso(NOW - 6 * 60_000) }), secret_value: encryptSecret("pat-demo-token-that-opens-nothing"), enabled: 1, last_synced_at: ago(6 * 60_000), created_at: ago(58 * DAY) });
    insert("external_connections", { id: randomUUID(), workspace_id: ws, provider: "google_calendar", name: "Jordan's calendar", config_json: JSON.stringify({ calendar_id: "primary", sync_token: "demo" }), secret_value: encryptSecret("ya29.demo-token-that-opens-nothing"), enabled: 1, last_synced_at: ago(9 * 60_000), created_at: ago(40 * DAY) });
    const synced = db.prepare("SELECT id FROM targets WHERE workspace_id = ? AND email IS NOT NULL LIMIT 180").all(ws) as { id: string }[];
    for (const [index, target] of synced.entries()) {
      insert("external_sync_records", { id: randomUUID(), workspace_id: ws, connection_id: hubspotId, entity_type: "contact", local_id: target.id, external_id: String(90_000 + index), direction: "outbound", status: "synced", synced_at: ago(6 * 60_000) });
    }
    count("connections", 2);

    // ── Instance: MCP use, for the Developer page's card ────────────────────
    for (const [tool, minutes] of [["contacts_search", 14], ["workflow_get", 15], ["inbox_list", 190], ["run_control", 1460], ["list_create", 2900], ["contacts_search", 4400]] as const) {
      insert("mcp_audit_logs", { id: randomUUID(), workspace_id: ws, user_id: owner.id, client_id: "claude-code", tool_name: tool, request_json: "{}", success: 1, duration_ms: between(40, 400), created_at: ago(minutes * 60_000) });
    }
    for (const [kind, tone, title, body, link, minRole, minutes] of [
      ["reply.positive", "good", "Marcus Oyelaran replied positively", "Open to a conversation; asked about seat pricing.", "/inbox", "member", 2],
      ["mailbox.paused", "bad", "elena@acme.example was paused", "30-day bounce rate 4.80% exceeds 4.00%", "/mailboxes", "member", 124],
      ["mailbox.disconnected", "bad", "support@acme-mail.example cannot sign in", "The mail server refused the sign-in used to read replies (Invalid credentials). Nothing is sent from it and its contacts wait until it is reconnected.", "/mailboxes", "member", 180],
      ["linkedin.signin_needed", "bad", "Daniel Hsu needs to sign in to LinkedIn again", "LinkedIn ended the session. Steps for this account are on hold.", "/linkedin-accounts", "member", 190],
      ["import.finished", "good", "Import into Enterprise VP Sales finished", "24 new contacts, 3 already there.", "/lists", "member", 1500],
    ] as const) {
      insert("notifications", { id: randomUUID(), workspace_id: ws, kind, tone, title, body, link, min_role: minRole, created_at: ago(minutes * 60_000) });
    }
    // ── AI & models ─────────────────────────────────────────────────────────
    // A key that opens nothing: it only makes the provider read as connected.
    insert("integrations", { workspace_id: ws, key: "openrouter", api_key: encryptSecret("sk-or-v1-demo-key-that-opens-nothing-7d2c"), updated_at: ago(41 * DAY) });
    const OPUS = "anthropic/claude-opus-5.5";
    const SONNET = "anthropic/claude-sonnet-5.5";
    const HAIKU = "anthropic/claude-haiku-5.5";
    insert("workspace_ai_config", {
      workspace_id: ws, default_model: OPUS, fallback_model: HAIKU, tone: "direct", monthly_budget_usd: 100,
      system_prompt: "Write like a senior AE who has done the homework. Open with one specific, verifiable observation about the company: a funding round, a job posting, a product launch. Never compliment the prospect. One idea per paragraph, no more than three sentences each. Ask for a 15-minute call, not a demo. Avoid the words \"solution\", \"synergy\", \"circle back\" and \"just checking in\".",
      email_examples: JSON.stringify([
        { title: "Series B congrats, VP Sales", body: "Subject: After the round\n\nHi Dana, the Series B announcement mentioned doubling the sales team by June. Teams at that stage usually find their outbound tooling was built for five reps, not twenty.\n\nWorth 15 minutes next week to compare notes?" },
        { title: "Hiring-signal opener", body: "Subject: Four AE roles\n\nHi Sam, Northwind posted four AE roles this month. New reps ramp faster when the first sequences are already written.\n\nOpen to a 15-minute call on Thursday?" },
        { title: "Break-up email", body: "Subject: Closing the loop\n\nHi Priya, I have not heard back, so I will stop here. If outbound becomes a priority later this year, I am easy to find." },
        { title: "Warm referral intro", body: "Subject: Jordan suggested I write\n\nHi Alex, Jordan Mertens mentioned you are rebuilding the SDR playbook. We did the same with a team your size last quarter.\n\nWould 15 minutes on Tuesday work?" },
      ]),
      linkedin_examples: JSON.stringify([
        { title: "Connection note, founders", body: "Hi Maya, I follow what you are building at Fernhill. I work with early revenue teams and would like to stay in touch." },
        { title: "Post-accept follow-up", body: "Thanks for connecting, Tom. I noticed you are hiring two SDRs. How are you planning to ramp them?" },
        { title: "Event follow-up", body: "Good to meet you at SaaStr, Lina. You mentioned reply rates had dropped since spring. Happy to share what we changed." },
      ]),
    });

    // Steps written by AI, on three campaigns. `nth` counts steps of that type from the start of the campaign.
    const writeWithAi = db.prepare(`UPDATE workflow_steps SET ai_enabled = 1, ai_model = ?, ai_prompt = ?, ai_max_words = ?, ai_language = ? WHERE id = (
      SELECT s.id FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
      WHERE w.workspace_id = ? AND w.name = ? AND s.step_type = ? ORDER BY s.step_order LIMIT 1 OFFSET ?)`);
    for (const [campaign, type, nth, model, instruction, words, language] of [
      // The first email of the Q4 campaign is left as written: it is the A/B test, which compares wordings, not what the AI wrote for each contact.
      ["Logistics Ops — Mid-Market", "email", 0, OPUS, "Lead with the funding signal, one line of proof", 90, "English"],
      ["Q4 Enterprise — VP Sales (US)", "email", 1, HAIKU, "Reference the first email in a single clause", 70, "English"],
      ["Q4 Enterprise — VP Sales (US)", "message", 0, null, "Ask about their hiring plans for the SDR team", 80, "German"],
      ["Q4 Enterprise — VP Sales (US)", "email", 2, SONNET, "Short, no guilt, leave the door open", 55, "English"],
      ["Series B FinTech — Ops Leaders", "email", 0, null, "Open with the Series B and what it means for the ops team", 90, "English"],
      ["DevTools ICP — Platform Eng", "message", 0, HAIKU, "Mention one thing from their engineering blog", 60, "English"],
    ] as const) writeWithAi.run(model, instruction, words, language, ws, campaign, type, nth);

    // What those steps, and sorting replies, have cost over the last six weeks.
    const aiRun = db.prepare("SELECT r.id FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE w.workspace_id = ? AND w.name = ? LIMIT 1").get(ws, "Q4 Enterprise — VP Sales (US)") as { id: string } | undefined;
    const aiStepId = (type: string, nth: number) => (db.prepare(`SELECT s.id FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
      WHERE w.workspace_id = ? AND w.name = ? AND s.step_type = ? ORDER BY s.step_order LIMIT 1 OFFSET ?`).get(ws, "Q4 Enterprise — VP Sales (US)", type, nth) as { id: string } | undefined)?.id;
    const kinds = [
      { purpose: "email_opener", perDay: 40, model: OPUS, cost: [0.03, 0.06], tokens: [1800, 2600], step: aiStepId("email", 0) },
      { purpose: "email_followup", perDay: 32, model: HAIKU, cost: [0.014, 0.03], tokens: [1500, 2400], step: aiStepId("email", 1) },
      { purpose: "linkedin_message", perDay: 26, model: OPUS, cost: [0.02, 0.04], tokens: [1200, 2000], step: aiStepId("message", 0) },
      { purpose: "classification", perDay: 20, model: OPUS, cost: [0.008, 0.016], tokens: [400, 900], step: undefined },
      { purpose: "test", perDay: 2, model: SONNET, cost: [0.03, 0.07], tokens: [1800, 2600], step: undefined },
    ] as const;
    for (let day = 0; day < 45; day++) {
      const weekday = new Date(NOW - day * DAY).getUTCDay();
      // Quieter at weekends, and a little busier before this month began.
      const volume = (weekday === 0 || weekday === 6 ? 0.25 : 1) * (day >= new Date(NOW).getUTCDate() ? 1.12 : 1);
      for (const kind of kinds) {
        const requests = Math.round(kind.perDay * volume * (0.7 + random() * 0.6));
        for (let i = 0; i < requests; i++) {
          // Now and then the default model is rate-limited and the fallback answers.
          const fellBack = kind.model === OPUS && chance(0.03);
          const inRun = kind.purpose !== "classification" && kind.purpose !== "test";
          // Never in the future: today's requests fall between midnight UTC and now.
          const at = day === 0 ? NOW - Math.floor(random() * (NOW % DAY)) : NOW - day * DAY + between(-11, 11) * HOUR;
          insert("agent_sessions", {
            id: randomUUID(), workspace_id: ws, purpose: kind.purpose, model: fellBack ? HAIKU : kind.model, used_fallback: fellBack ? 1 : 0,
            run_id: inRun ? aiRun?.id : undefined, step_id: kind.step,
            input_tokens: between(kind.tokens[0], kind.tokens[1]), output_tokens: between(60, 240),
            cost_usd: Number(((kind.cost[0] + random() * (kind.cost[1] - kind.cost[0])) * (fellBack ? 0.3 : 1)).toFixed(4)),
            generated_text: "Demo generation.", prompt: "Demo prompt.", created_at: stamp(Math.min(at, NOW - 60_000)),
          });
        }
      }
    }

    // ── Team & roles ────────────────────────────────────────────────────────
    // When each member was last here, one member whose access is suspended, and an
    // invitation still waiting.
    for (const [key, minutes] of [["jordan", 1], ["elena", 12], ["priya", 64], ["marcus", 21 * 60], ["daniel", 3 * 24 * 60], ["hannah", 3 * 24 * 60 + 200]] as const) {
      db.prepare("UPDATE workspace_members SET last_active_at = ? WHERE workspace_id = ? AND user_id = ?").run(ago(minutes * 60_000), ws, userId(key));
    }
    const sam = randomUUID();
    insert("users", { id: sam, email: "sam@acme.example", name: "Sam Okafor", password_hash: passwordHash, email_verified_at: ago(120 * DAY) });
    insert("workspace_members", { workspace_id: ws, user_id: sam, role: "member", created_at: ago(110 * DAY), last_active_at: ago(21 * DAY), suspended_at: ago(20 * DAY), suspended_by: owner.id });
    count("users");
    insert("workspace_invitations", {
      id: randomUUID(), workspace_id: ws, email: "tomas@acme.example", role: "member", token_hash: `demo-${randomUUID()}`, invited_by: userId("elena"),
      expires_at: iso(NOW + 5 * DAY), last_sent_at: ago(2 * DAY), created_at: ago(2 * DAY),
    });

    // The audit log: who made each campaign (which is also how campaigns are counted per
    // member), and a few days of changes from the app, the API and an MCP client.
    const campaignRows = db.prepare("SELECT id, created_at FROM workflows WHERE workspace_id = ? ORDER BY created_at").all(ws) as Array<{ id: string; created_at: string }>;
    const makers = ["priya", "priya", "elena", "marcus", "priya", "daniel", "elena", "marcus", "jordan", "priya", "elena", "daniel", "marcus", "jordan"];
    for (const [index, campaign] of campaignRows.entries()) {
      insert("audit_logs", { id: randomUUID(), workspace_id: ws, user_id: userId(makers[index % makers.length]), action: "workflow.created", entity_type: "workflow", entity_id: campaign.id, source: "web", ip_address: "92.168.4.21", created_at: campaign.created_at });
    }
    db.prepare("UPDATE audit_logs SET source = 'web', ip_address = COALESCE(ip_address, '92.168.4.' || (abs(random()) % 200 + 10)) WHERE workspace_id = ? AND source IS NULL").run(ws);
    const firstCampaign = campaignRows[0]?.id;
    const firstRun = (db.prepare("SELECT id FROM runs WHERE workspace_id = ? ORDER BY created_at LIMIT 1").get(ws) as { id: string } | undefined)?.id;
    const firstList = (db.prepare("SELECT id FROM lists WHERE workspace_id = ? ORDER BY created_at LIMIT 1").get(ws) as { id: string } | undefined)?.id;
    const firstAccount = (db.prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY created_at LIMIT 1").get(ws) as { id: string } | undefined)?.id;
    for (const [minutes, who, action, type, id, source, via, ip, meta] of [
      [38, "elena", "run.status_changed", "run", firstRun, "web", null, "92.168.4.21", { status: "paused" }],
      [62, "priya", "mcp.tool_used", "mcp_tool", "run_membership_manage", "mcp", "Claude", "198.51.100.7", null],
      [95, "priya", "workflow.published", "workflow", firstCampaign, "mcp", "Claude", "198.51.100.7", null],
      [225, "jordan", "workspace.member_role_changed", "user", userId("hannah"), "web", null, "92.168.4.8", { role: "viewer", previous: "member" }],
      [319, "marcus", "account.connected", "account", firstAccount, "web", null, "84.22.110.5", null],
      [393, null, "contact.created", "contact", null, "api", "Production backend", "203.0.113.17", null],
      [468, "daniel", "contact.bulk_deleted", "contact", null, "web", null, "92.168.4.44", { deleted: 18 }],
      [26 * 60, "elena", "ai_config.updated", "workspace", ws, "web", null, "92.168.4.21", { fields: ["tone", "monthly_budget_usd"] }],
      [27 * 60, "jordan", "workspace.invitation_created", "workspace_invitation", null, "web", null, "92.168.4.8", { email: "tomas@acme.example", role: "member", email_sent: true }],
      [30 * 60, null, "contact.updated", "contact", null, "api", "Production backend", "203.0.113.17", null],
      [49 * 60, "priya", "list.created", "list", firstList, "web", null, "92.168.4.30", null],
      [20 * 24 * 60, "jordan", "workspace.member_suspended", "user", sam, "web", null, "92.168.4.8", null],
    ] as const) {
      insert("audit_logs", {
        id: randomUUID(), workspace_id: ws, user_id: who ? userId(who) : null, action, entity_type: type, entity_id: id ?? randomUUID(),
        metadata_json: meta ? JSON.stringify(meta) : null, source, via, ip_address: ip, created_at: ago(minutes * 60_000),
      });
      count("audit entries");
    }
    // ── Contact tags and custom fields ──────────────────────────────────────
    // Last in the transaction, so the variety drawn above stays what it was.
    const contactTags = [["Champion", "good"], ["Decision maker", "brand"], ["Event lead", "warn"], ["Customer", "mail"], ["Do not call", "bad"]].map(([name, color]) => ({ id: randomUUID(), name, color }));
    for (const tag of contactTags) insert("contact_tags", { id: tag.id, workspace_id: ws, name: tag.name, color: tag.color, created_by: owner.id, created_at: ago(between(5, 40) * DAY) });
    count("contact tags", contactTags.length);
    const customFields = [
      { name: "Renewal date", key: "renewal_date", type: "date" }, { name: "Plan", key: "plan", type: "text" },
      { name: "Seats", key: "seats", type: "number" }, { name: "Has budget", key: "has_budget", type: "boolean" },
    ].map(field => ({ ...field, id: randomUUID() }));
    for (const field of customFields) insert("custom_field_definitions", { id: field.id, workspace_id: ws, name: field.name, key: field.key, field_type: field.type, options_json: "null" });
    count("custom fields", customFields.length);
    for (const contact of contacts) {
      if (chance(0.3)) {
        const first = pick(contactTags);
        insert("target_tags", { target_id: contact.id, tag_id: first.id });
        const second = pick(contactTags);
        if (second.id !== first.id && chance(0.3)) insert("target_tags", { target_id: contact.id, tag_id: second.id });
      }
      if (!chance(0.4)) continue;
      for (const field of customFields) {
        if (!chance(0.7)) continue;
        insert("contact_custom_values", {
          workspace_id: ws, target_id: contact.id, field_id: field.id,
          value_text: field.type === "date" ? new Date(NOW + between(20, 300) * DAY).toISOString().slice(0, 10) : field.type === "text" ? pick(["Starter", "Team", "Scale"]) : undefined,
          value_number: field.type === "number" ? between(5, 250) : undefined,
          value_boolean: field.type === "boolean" ? (chance(0.6) ? 1 : 0) : undefined,
        });
      }
    }

    // ── What the contact profile shows ──────────────────────────────────────
    // List history is written by the database as memberships are made, so every row above
    // is dated "now". Move each to a little after its contact arrived.
    db.prepare("UPDATE list_membership_events SET created_at = datetime((SELECT t.created_at FROM targets t WHERE t.id = list_membership_events.target_id), '+3 minutes') WHERE workspace_id = ?").run(ws);
    // Logged activities say who logged them.
    for (const row of db.prepare("SELECT id FROM activity_logs WHERE workspace_id = ?").all(ws) as { id: string }[]) {
      db.prepare("UPDATE activity_logs SET created_by = ? WHERE id = ?").run(pick(team.slice(0, 5)).id, row.id);
    }
    const noteLines = [
      "Mid-RFP with two other vendors; the CFO signs. Cares about one inbox for both channels.",
      "Met at the spring conference. Asked to be contacted again after the reorganisation.",
      "Champion on the ops side. Budget is set in November.",
    ];
    const roles = ["Director of Sales Ops", "Senior RevOps Analyst", "Head of Growth", "Account Executive", "Operations Lead"];
    for (const contact of contacts) {
      if (chance(0.25)) {
        const author = pick(team.slice(0, 5));
        db.prepare("UPDATE targets SET notes = ?, notes_updated_at = ?, notes_updated_by = ? WHERE id = ?").run(pick(noteLines), ago(between(1, 9) * DAY), author.id, contact.id);
      }
      if (chance(0.6)) {
        const current = db.prepare("SELECT title FROM targets WHERE id = ?").get(contact.id) as { title: string };
        const startYear = between(2019, 2023);
        const earlier = pick(companyNames);
        db.prepare("UPDATE targets SET positions_json = ?, headline = ?, sales_nav_url = ? WHERE id = ?").run(
          JSON.stringify([
            { title: current.title, companyName: contact.company, current: true, startDate: `${startYear}-0${between(1, 9)}-01` },
            { title: pick(roles), companyName: earlier, startDate: `${startYear - between(2, 4)}-0${between(1, 9)}-01`, endDate: `${startYear}-01-01` },
            { title: pick(roles), companyName: pick(companyNames), startDate: `${startYear - between(6, 8)}-0${between(1, 9)}-01`, endDate: `${startYear - 4}-01-01` },
          ]),
          `${current.title} at ${contact.company}`, `https://www.linkedin.com/sales/lead/demo-${contact.id.slice(0, 8)}`, contact.id,
        );
      }
    }
    // ── What the Lists screen shows ─────────────────────────────────────────
    // Who looks after each list, where it was filled from and when. Imports are seeded
    // finished only: a queued or running one would be picked up by a real runner.
    for (const [index, list] of lists.entries()) {
      const owner = index === 7 ? null : pick(team.slice(0, 5)).id;
      const filled = ago(between(1, 30) * HOUR);
      if (index % 3 === 0) {
        const url = `https://www.linkedin.com/sales/lists/people/demo-${list.id.slice(0, 8)}`;
        db.prepare("UPDATE lists SET owner_id = ?, source = 'sales_navigator', sales_nav_url = ? WHERE id = ?").run(owner, url, list.id);
        insert("list_imports", {
          id: randomUUID(), list_id: list.id, status: "done", phase: "done", page: 2, total_pages: 2, count: list.members.length, total: list.members.length,
          imported: list.members.length, skipped: 0, sales_nav_url: url, started_at: filled, finished_at: filled,
        });
      } else if (index % 3 === 1) {
        const file = `${list.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
        db.prepare("UPDATE lists SET owner_id = ?, source = 'csv', source_detail = ?, last_synced_at = ? WHERE id = ?").run(owner, file, filled, list.id);
      } else {
        db.prepare("UPDATE lists SET owner_id = ?, source = 'manual' WHERE id = ?").run(owner, list.id);
      }
    }
    // One list nobody is using any more, kept for its history.
    db.prepare("UPDATE lists SET archived_at = ? WHERE id = (SELECT l.id FROM lists l WHERE l.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.list_id = l.id) ORDER BY l.created_at LIMIT 1)").run(ago(6 * DAY), ws);

    // ── Templates and Signals (R22) ─────────────────────────────────────────
    // Which template each send used, so the library has figures: a share of the LinkedIn
    // messages and of the emails already seeded is credited to a template, and the steps
    // they came from are made to offer it.
    const libraryTemplates = db.prepare("SELECT id, channel FROM templates WHERE workspace_id = ? ORDER BY created_at, rowid").all(ws) as Array<{ id: string; channel: string }>;
    const creditSends = db.prepare(
      `UPDATE step_sends SET template_id = ? WHERE id IN (
         SELECT id FROM step_sends WHERE workspace_id = ? AND action = ? AND template_id IS NULL AND step_id IS NOT NULL ORDER BY rowid LIMIT ?)`,
    );
    const shares: Record<string, number[]> = { linkedin: [64, 38, 22, 9], email: [120, 85, 12] };
    const seenOf: Record<string, number> = { linkedin: 0, email: 0 };
    for (const template of libraryTemplates) {
      const amount = shares[template.channel]?.[seenOf[template.channel]++] ?? 0;
      if (amount > 0) creditSends.run(template.id, ws, template.channel === "email" ? "email" : "message", amount);
    }
    db.prepare(
      `INSERT OR IGNORE INTO workflow_step_templates (step_id, template_id)
       SELECT DISTINCT ss.step_id, ss.template_id FROM step_sends ss JOIN workflow_steps st ON st.id = ss.step_id WHERE ss.workspace_id = ? AND ss.template_id IS NOT NULL`,
    ).run(ws);
    // Categories on the LinkedIn ones, and two templates nothing has sent yet.
    const linkedinTemplates = libraryTemplates.filter((template) => template.channel === "linkedin");
    for (const [index, category] of ["Openers", "Follow-ups", "Follow-ups"].entries()) {
      if (linkedinTemplates[index]) db.prepare("UPDATE templates SET category = ? WHERE id = ?").run(category, linkedinTemplates[index].id);
    }
    insert("templates", { id: randomUUID(), workspace_id: ws, name: "Break-up note", body: "{{first_name}}, I will stop here. If outbound comes back onto the list at {{company}}, I am easy to find.", category: "Follow-ups", created_at: ago(2 * DAY) });
    insert("templates", { id: randomUUID(), workspace_id: ws, name: "Funding congratulations", body: "Hi {{first_name}},\n\nCongratulations on the round. Teams usually rebuild outbound in the two quarters after one.\n\nWorth comparing notes?\n\n{{sender.first_name}}\n\n{{unsubscribe}}", channel: "email", subject: "Congratulations on the round, {{first_name}}", category: "Signal follow-ups", created_at: ago(1 * DAY) });
    count("templates", 2);

    // Accounts watched for changes, with what an earlier check found. Detection itself is
    // left off, with a cap already chosen: nothing is asked of Apollo unless someone turns it on.
    const watched = companies.slice(2, 14);
    const found: Array<[string, string, string, number, number]> = [
      ["funding", "raised a Series C round", "Round dated this month · $64M raised in all", 70, 2],
      ["hiring", "went from 4 to 11 open roles", "Open roles include Account Executive, Sales Development Rep, RevOps Analyst", 50, 5],
      ["technology", "started using Snowflake, dbt", "2 technologies Apollo did not list at the last check", 40, 5],
      ["hiring", "has 7 open roles", "Open roles include Enterprise AE, Solutions Engineer", 50, 29],
      ["funding", "raised a Series A round", "Round dated last month · $12M raised in all", 70, 29],
    ];
    for (const [index, company] of watched.entries()) {
      const hit = found[index];
      const checked = index === 11 ? null : ago((index < 6 ? 5 : 29) * HOUR + index * 60_000);
      insert("signal_watch", {
        workspace_id: ws, company_id: company.id, added_by: owner.id, added_at: ago((20 + index) * DAY), last_checked_at: checked,
        last_result: checked === null ? null : hit ? `${company.name} ${hit[1]}` : index === 9 ? "Apollo does not know this company" : "Nothing new",
        snapshot_json: checked === null ? null : JSON.stringify({ checked_at: checked, headcount: company.employees, funding_stage: null, funding_date: null, funding_total: null, technologies: ["Salesforce", "Slack"], open_roles: 4 }),
      });
      if (hit) {
        insert("signals", {
          id: randomUUID(), workspace_id: ws, target_id: null, company_id: company.id, type: hit[0], title: `${company.name} ${hit[1]}`, description: hit[2], score: hit[3], source: "apollo",
          occurred_at: ago(hit[4] * HOUR + index * 60_000), processed_at: hit[4] > 24 ? ago(20 * HOUR) : null, metadata_json: "{}",
        });
        count("signals");
      }
    }
    count("watched accounts", watched.length);
    insert("signal_detection_config", { workspace_id: ws, enabled: 0, kinds: "funding,hiring,technology", interval_days: 7, monthly_credit_cap: 400, updated_by: owner.id });
    insert("signal_detection_runs", { id: randomUUID(), workspace_id: ws, trigger: "manual", status: "done", accounts_checked: 6, credits_spent: 12, signals_found: 3, started_by: owner.id, started_at: ago(5 * HOUR), finished_at: ago(5 * HOUR - 40_000) });
    insert("signal_detection_runs", { id: randomUUID(), workspace_id: ws, trigger: "manual", status: "done", accounts_checked: 11, credits_spent: 21, signals_found: 2, started_by: owner.id, started_at: ago(29 * HOUR), finished_at: ago(29 * HOUR - 70_000) });
    // A rule that enrols, to stand beside the two that only add to a list.
    const signalCampaign = db.prepare("SELECT w.id FROM workflows w WHERE w.workspace_id = ? AND EXISTS (SELECT 1 FROM workflow_steps st WHERE st.workflow_id = w.id AND st.track = 'linkedin') ORDER BY w.created_at LIMIT 1").get(ws) as { id: string } | undefined;
    const signalAccount = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND is_authenticated = 1 ORDER BY created_at LIMIT 1").get(ws) as { id: string } | undefined;
    if (signalCampaign && signalAccount) {
      insert("signal_rules", { id: randomUUID(), workspace_id: ws, name: "New VP Sales → enrol in outreach", signal_type: "job_change", min_score: 60, list_id: lists[1].id, workflow_id: signalCampaign.id, account_id: signalAccount.id, enabled: 1, auto_start: 0 });
    }

    // ── What the Companies screen shows ─────────────────────────────────────
    // What a look-up of the company brings back: funding, people per department, growth,
    // rank. A few companies have never been looked up, and a quarter are target accounts.
    const departmentNames = ["operations", "sales", "engineering", "finance", "marketing", "customer_service", "human_resources", "information_technology"];
    const rounds = [["Series D", "$120M", "$410M"], ["Series B", "$30M", "$44M"], ["Series A", "$12M", "$15M"], ["Seed", "$4M", "$4M"], ["Private equity", "$250M", "$300M"]];
    for (const [index, company] of companies.entries()) {
      const lookedUp = index % 9 !== 8;
      const headcount: Record<string, number> = {};
      let left = company.employees;
      for (const department of departmentNames.slice(0, between(4, 8))) {
        const people = Math.max(1, Math.round(left * (between(15, 45) / 100)));
        headcount[department] = people;
        left = Math.max(0, left - people);
      }
      const [stage, amount, raised] = rounds[index % rounds.length];
      const funded = lookedUp && index % 5 !== 4;
      const listed = lookedUp && index % 11 === 5;
      db.prepare(
        `UPDATE companies SET is_target = ?, intent_score = ?, funding_stage = ?, funding_amount = ?, funding_at = ?, funding_total = ?, department_headcount = ?, headcount_growth = ?,
                domain_rank = ?, stock_symbol = ?, stock_exchange = ?, enrichment_source = 'apollo', enriched_at = ? WHERE id = ?`,
      ).run(
        index % 4 === 0 ? 1 : 0, index % 6 === 1 ? between(40, 92) : 0,
        funded ? stage : null, funded ? amount : null, funded ? ago(between(20, 500) * DAY) : null, funded ? raised : null,
        lookedUp ? JSON.stringify(headcount) : null, lookedUp ? between(-6, 24) / 100 : null, lookedUp ? between(4_000, 900_000) : null,
        listed ? company.name.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase() : null, listed ? "nasdaq" : null,
        lookedUp ? ago(between(1, 40) * DAY) : null, company.id,
      );
    }
    // The first company is the one the design shows: enough technologies and keywords to fold.
    db.prepare("UPDATE companies SET technology_names = ?, keywords = ?, description = ?, headcount_growth = 0.08, enriched_at = ? WHERE id = ?").run(
      JSON.stringify(["Salesforce", "Outreach", "Sales Navigator", "Marketo", "SAP TM", "Snowflake", "Workday", "Segment", "Zoom", "Slack", "Datadog", "Okta", "Tableau", "NetSuite", "Jira", "Stripe"]),
      JSON.stringify(["freight forwarding", "cold chain", "customs brokerage", "last-mile", "intermodal", "carrier network", "TMS", "reefer", "pharma logistics", "port operations", "rail freight"]),
      `${companies[0].name} is a ${companies[0].city}-based freight forwarder operating cold-chain and intermodal routes across the EU and North Sea corridor, serving grocery and pharmaceutical shippers.`,
      ago(3 * DAY), companies[0].id,
    );

    // People Apollo named and nobody has added yet. A search hides part of a surname until the person is looked up.
    const suggested = [["Pieter Gr***f", "Director of Procurement", "director"], ["Noor Ja***n", "VP Customer Operations", "vp"], ["Dana Re***s", "Chief Revenue Officer", "c_suite"], ["Tomas Li***n", "Head of Partnerships", "head"]];
    for (const [index, company] of companies.slice(0, 6).entries()) {
      for (const [offset, [name, title, seniority]] of suggested.slice(index % 2, (index % 2) + 2).entries()) {
        insert("company_suggestions", { id: randomUUID(), workspace_id: ws, company_id: company.id, external_id: `demo-apollo-${index}-${offset}`, name, title, seniority, created_at: ago(between(1, 6) * DAY) });
      }
    }

    // The bounces behind the two flagged companies: one address bounced at each, and at the
    // first a colleague was marked invalid along with it, as the mailbox reader does.
    const bounceMailbox = mailboxes.find(mailbox => mailbox.state === "auto_paused") ?? mailboxes[0];
    for (const company of companies.filter((_, index) => index === 0 || index === 14)) {
      const staff = contacts.filter(contact => contact.companyId === company.id && contact.email);
      for (const [index, contact] of staff.slice(0, company === companies[0] ? 3 : 1).entries()) {
        insert("sender_events", {
          id: randomUUID(), workspace_id: ws, email_account_id: bounceMailbox.id, provider: "imap", provider_event_id: `demo-company-bounce:${contact.id}`, event_type: "bounced",
          recipient: contact.email, occurred_at: ago(between(1, 6) * DAY + index * HOUR),
        });
        db.prepare("UPDATE targets SET email_status = 'invalid' WHERE id = ?").run(contact.id);
        db.prepare("INSERT OR IGNORE INTO suppressions (id, workspace_id, kind, value, reason, source, target_id) VALUES (?, ?, 'email', ?, 'Hard bounce (DSN received)', 'bounce', ?)").run(randomUUID(), ws, contact.email.toLowerCase(), contact.id);
      }
      if (staff[3]) db.prepare("UPDATE targets SET email_status = 'invalid' WHERE id = ?").run(staff[3].id);
    }
  })();

  // Outside the transaction: createApiKey opens its own statement on the shared connection.
  const ws = (db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(WORKSPACE_SLUG) as { id: string }).id;
  // Each contact's replies become their conversation, as the inbox would make them on its first read.
  counts["conversations"] = reconcileConversations(db, ws);
  seedInboxStates(db, ws, insert, reconcileConversations, refreshLastMessage);
  const ownerId = (db.prepare("SELECT id FROM users WHERE email = ?").get(DEMO_LOGIN) as { id: string }).id;
  // Made oldest first, so the list (newest first) reads as the design does.
  const used = db.prepare("UPDATE api_keys SET last_used_at = ?, created_at = ? WHERE id = ?");
  const revoked = createApiKey({ workspaceId: ws, name: "Zapier sandbox", scopes: ["contacts:read"], createdBy: ownerId });
  db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(ago(8 * DAY), revoked.id);
  used.run(ago(21 * DAY), ago(140 * DAY), revoked.id);
  const reporting = createApiKey({ workspaceId: ws, name: "Reporting read-only", scopes: ["campaigns:read", "events:read"], createdBy: ownerId, expiresAt: stamp(NOW + 112 * DAY) });
  used.run(ago(19 * HOUR), ago(96 * DAY), reporting.id);
  const staging = createApiKey({ workspaceId: ws, name: "Staging importer", scopes: ["contacts:write", "signals:write"], createdBy: ownerId, expiresAt: stamp(NOW + 10 * DAY), rateLimitPerMinute: 120 });
  used.run(ago(2 * 60_000), ago(89 * DAY), staging.id);
  const production = createApiKey({ workspaceId: ws, name: "Production backend", scopes: ["campaigns:read", "contacts:write", "contacts:read"], createdBy: ownerId, expiresAt: stamp(NOW + 276 * DAY), rateLimitPerMinute: 600 });
  used.run(ago(4 * 60_000), ago(80 * DAY), production.id);
  counts["API keys"] = 4;

  // Two more workspaces the demo owner belongs to, so the workspace lists have something in them.
  const { createAdditionalWorkspace } = await import("@/lib/workspace");
  const idOf = (email: string) => (db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  const emea = createAdditionalWorkspace(ownerId, "Acme EMEA");
  for (const [email, role] of [["elena@acme.example", "admin"], ["marcus@acme.example", "member"]] as const) {
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(emea.workspaceId, idOf(email), role);
  }
  const partners = createAdditionalWorkspace(idOf("priya@acme.example"), "Lighthouse Partners");
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'manager')").run(partners.workspaceId, ownerId);
  counts["workspaces"] = 3;

  // A CSV import that was started and not run, so Lists has one to continue and the import
  // page has something to show on every step: columns Linki knows and columns it does not,
  // people who are contacts already, a repeated row, and rows that cannot go in. It is a
  // draft: no contact is made from it, so nothing drawn above changes.
  {
    const { createImport } = await import("@/lib/csv-import-store");
    const known = db.prepare("SELECT first_name, last_name, email, linkedin_url, company, title FROM targets WHERE workspace_id = ? AND email IS NOT NULL AND linkedin_url IS NOT NULL ORDER BY rowid LIMIT 4")
      .all(ws) as Array<{ first_name: string | null; last_name: string | null; email: string; linkedin_url: string; company: string | null; title: string | null }>;
    const row = (cells: Array<string | null | undefined>) => cells.map((cell) => (cell && /[",]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell ?? "")).join(",");
    const fresh: string[][] = [
      ["Marcus", "Halvorsen", "m.halvorsen@northwind.example", "Northwind Logistics", "VP Revenue Operations", "linkedin.com/in/demo-mhalvorsen", "640", "Norway", "+47 902 11 448", "$50M–$100M", "2025-08-14", "Met at a trade fair", ""],
      ["Ines", "Carvalho", "ines.carvalho@lumenfreight.example", "Lumen Freight", "Head of Sales", "https://www.linkedin.com/in/demo-ines-carvalho/", "210", "Portugal", "+351 21 000 0000", "$10M–$50M", "2025-09-02", "", ""],
      ["Tomasz", "Wrobel", "tomasz@baltictransit.example", "Baltic Transit", "COO", "", "95", "Poland", "ask for Tomasz", "$1M–$10M", "2025-06-30", "Prefers a call", ""],
      ["Sofia", "Lindqvist", "", "Nordkap Shipping", "Director of Operations", "https://www.linkedin.com/in/demo-sofia-lindqvist/", "1,204", "Sweden", "+46 8 123 456 78", "$100M+", "2025-07-19", "", ""],
      ["Ines", "Carvalho", "ines.carvalho@lumenfreight.example", "Lumen Freight", "Head of Sales", "", "210", "Portugal", "", "$10M–$50M", "2025-09-02", "Listed twice in the export", ""],
      ["Dmitri", "Sokolov", "dmitri.sokolov(at)volgacargo.example", "Volga Cargo", "Sales Director", "", "380", "Estonia", "+372 600 0000", "$10M–$50M", "2025-05-11", "", ""],
      ["Aiko", "Tanaka", "aiko.tanaka@harborline.example", "", "Regional Manager", "https://www.linkedin.com/in/demo-aiko-tanaka/", "72", "Japan", "+81 3 0000 0000", "$1M–$10M", "2025-08-01", "", ""],
      ["", "", "", "Unnamed Haulage", "", "", "15", "Ireland", "", "", "", "No contact details in the source", ""],
    ];
    const file = [
      "first_name,last_name,email,company,title,linkedin_url,employees,country,phone_raw,arr_band,last_touch,notes_internal,utm_source",
      ...fresh.slice(0, 4).map(row),
      ...known.slice(0, 2).map((person) => row([person.first_name, person.last_name, person.email.toUpperCase(), person.company, person.title, "", "", "", "", "", "", "Already a contact, by email", ""])),
      ...known.slice(2, 4).map((person) => row([person.first_name, person.last_name, "", person.company, person.title, person.linkedin_url.replace("https://www.", ""), "", "", "", "", "", "Already a contact, by profile", ""])),
      ...fresh.slice(4).map(row),
    ].join("\n");
    const list = (db.prepare("SELECT id FROM lists WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 1").get(ws) as { id: string } | undefined)?.id;
    const draft = createImport(db, ws, idOf("marcus@acme.example"), { csv: file, filename: "acme_q4_prospects.csv", encoding: "utf-8", list_id: list });
    if (!("error" in draft)) {
      db.prepare("UPDATE csv_imports SET created_at = ?, updated_at = ? WHERE id = ?").run(ago(2 * HOUR), ago(2 * HOUR), draft.id);
      counts["CSV imports not finished"] = 1;
    }
  }

  console.log(`Demo workspace "${WORKSPACE_NAME}" written to ${dbPath}`);
  console.log(Object.entries(counts).map(([name, value]) => `  ${String(value).padStart(5)}  ${name}`).join("\n"));
  console.log(`Sign in as ${DEMO_LOGIN}; the password is DEMO_PASSWORD in scripts/seed-demo.ts.`);
  console.log("Start the app on this database with LINKI_RUNNER=off.");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
