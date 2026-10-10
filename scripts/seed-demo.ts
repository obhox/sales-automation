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
  process.env.NEXTAUTH_SECRET ||= "demo-secret-not-used-to-sign-anything-real";
  const { getDb } = await import("@/lib/db");
  const { createWorkspaceForUser } = await import("@/lib/workspace");
  const { encryptSecret } = await import("@/lib/crypto");
  const { createApiKey } = await import("@/lib/api-keys");
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
      insert("users", { id: person.id, email: person.email, password_hash: passwordHash, email_verified_at: ago(90 * DAY) });
      count("users");
    }
    const owner = team[0];
    const { workspaceId: ws } = createWorkspaceForUser(owner.id, owner.email);
    db.prepare("UPDATE workspaces SET name = ?, slug = ? WHERE id = ?").run(WORKSPACE_NAME, WORKSPACE_SLUG, ws);
    for (const person of team.slice(1)) insert("workspace_members", { workspace_id: ws, user_id: person.id, role: person.role });
    const userId = (key: string) => team.find(person => person.key === key)!.id;

    // ── LinkedIn accounts ───────────────────────────────────────────────────
    const linkedinAccounts = [
      { name: "Priya Raghavan", email: "priya.raghavan@acme.example", authed: 1, tz: "Europe/Berlin", connect: 60, message: 80, visit: 150, start: 9, end: 17, pending: 412, connections: 2840 },
      { name: "Marcus Oyelaran", email: "marcus.oyelaran@acme.example", authed: 1, tz: "America/New_York", connect: 60, message: 80, visit: 150, start: 8, end: 17, pending: 388, connections: 1920 },
      { name: "Jordan Mertens", email: "jordan.mertens@acme.example", authed: 1, tz: "Europe/Madrid", connect: 40, message: 50, visit: 120, start: 9, end: 18, pending: 251, connections: 3310 },
      { name: "Daniel Hsu", email: "daniel.hsu@acme.example", authed: 0, tz: "Europe/Lisbon", connect: 30, message: 40, visit: 80, start: 9, end: 17, pending: 153, connections: 760 },
    ].map(account => ({ ...account, id: randomUUID() }));
    for (const account of linkedinAccounts) {
      insert("accounts", {
        id: account.id, workspace_id: ws, name: account.name, email: account.email, is_authenticated: account.authed,
        daily_connection_limit: account.connect, daily_message_limit: account.message, daily_visit_limit: account.visit,
        active_hours_start: account.start, active_hours_end: account.end, timezone: account.tz, working_days: "1,2,3,4,5",
        withdraw_stale_invites: 1, li_connections: account.connections, li_pending: account.pending, li_profile_views: between(40, 220),
        li_stats_synced_at: ago(between(2, 40) * 60_000), accepted_sync_at: ago(between(5, 90) * 60_000),
        inbox_synced_at: account.authed ? ago(between(1, 14) * 60_000) : null, created_at: ago(between(40, 120) * DAY),
      });
      count("LinkedIn accounts");
    }
    const liveLinkedin = linkedinAccounts.filter(account => account.authed);

    // ── Mailboxes on three sending domains ──────────────────────────────────
    const mailboxes = [
      { from: "jordan@acme.example", name: "Jordan Mertens", provider: "gmail_app_password", limit: 60, rampDays: 40, paused: null as string | null, verified: 1, tz: "Europe/Berlin" },
      { from: "priya@acme.example", name: "Priya Raghavan", provider: "gmail_app_password", limit: 60, rampDays: 9, paused: null, verified: 1, tz: "Europe/Berlin" },
      { from: "marcus@acme.example", name: "Marcus Oyelaran", provider: "gmail_app_password", limit: 60, rampDays: 30, paused: null, verified: 1, tz: "America/New_York" },
      { from: "elena@acme.example", name: "Elena Vogt", provider: "smtp", limit: 30, rampDays: 22, paused: "Bounce rate 4.8% exceeded 4.0%", verified: 1, tz: "Europe/Madrid" },
      { from: "outreach@getacme.example", name: "Acme Outreach", provider: "smtp", limit: 80, rampDays: 60, paused: null, verified: 1, tz: "Europe/Berlin" },
      { from: "daniel@getacme.example", name: "Daniel Hsu", provider: "smtp", limit: 50, rampDays: 45, paused: null, verified: 1, tz: "Europe/London" },
      { from: "hello@getacme.example", name: "Acme", provider: "smtp", limit: 80, rampDays: 4, paused: null, verified: 1, tz: "Europe/Berlin" },
      { from: "team@acme-mail.example", name: "Acme Team", provider: "gmail_app_password", limit: 40, rampDays: 6, paused: null, verified: 1, tz: "Europe/Lisbon" },
      { from: "support@acme-mail.example", name: "Acme Support", provider: "smtp", limit: 25, rampDays: 70, paused: null, verified: 0, tz: "UTC" },
    ].map(mailbox => ({ ...mailbox, id: randomUUID(), domain: mailbox.from.split("@")[1] }));
    for (const mailbox of mailboxes) {
      insert("email_accounts", {
        id: mailbox.id, workspace_id: ws, name: mailbox.name, from_email: mailbox.from, from_name: mailbox.name, provider: mailbox.provider,
        smtp_host: "smtp.invalid", smtp_port: 587, username: mailbox.from, password: encryptSecret("demo-no-such-mailbox"),
        imap_host: "imap.invalid", imap_username: mailbox.from, imap_password: encryptSecret("demo-no-such-mailbox"),
        daily_email_limit: mailbox.limit, is_verified: mailbox.verified, timezone: mailbox.tz,
        ramp_up_enabled: 1, ramp_start_date: stamp(NOW - mailbox.rampDays * DAY).slice(0, 10),
        paused_at: mailbox.paused ? ago(2 * HOUR) : null, paused_reason: mailbox.paused,
        signature: `${mailbox.name}\nAcme · acme.example`, inbox_synced_at: ago(between(1, 9) * 60_000), created_at: ago((mailbox.rampDays + 3) * DAY),
      });
      insert("warmup_settings", { email_account_id: mailbox.id, workspace_id: ws, enabled: mailbox.verified && !mailbox.paused ? 1 : 0, daily_target: between(8, 20), reply_rate: 60, started_at: ago(mailbox.rampDays * DAY) });
      count("mailboxes");
    }
    for (const [domain, dmarc, score] of [["acme.example", "weak", 86], ["getacme.example", "pass", 94], ["acme-mail.example", "weak", 71]] as const) {
      insert("deliverability_checks", {
        id: randomUUID(), workspace_id: ws, domain, spf_status: "pass", dkim_status: "pass", dmarc_status: dmarc, mx_status: "pass", score,
        details_json: JSON.stringify({ spf: "v=spf1 include:_spf.google.com ~all", dkim: "google._domainkey · 2048-bit", dmarc: dmarc === "pass" ? "p=quarantine; rua=mailto:dmarc@" + domain : "p=none; rua=mailto:dmarc@" + domain, mx: "5 · aspmx.l.google.com" }),
        checked_at: ago(8 * HOUR),
      });
    }
    const sendingMailboxes = mailboxes.filter(mailbox => mailbox.verified && !mailbox.paused);

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

    // ── Campaigns ───────────────────────────────────────────────────────────
    type Status = "running" | "paused" | "completed" | "draft";
    const campaignPlans: { name: string; list: number; status: Status; linkedin: boolean; email: boolean; age: number }[] = [
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
        if (linkedinSteps[1] && linkedinSteps[2]) {
          insert("workflow_branches", {
            id: randomUUID(), workspace_id: ws, workflow_id: workflowId, source_step_id: linkedinSteps[1].id,
            conditions_json: JSON.stringify({ mode: "all", conditions: [{ field: "connected", op: "is", value: true }] }),
            true_step_id: linkedinSteps[2].id, false_step_id: null,
          });
        }
      }
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
              insert("linkedin_messages", { id: randomUUID(), workspace_id: ws, account_id: linkedinAccount.id, target_id: contact.id, conversation_urn: `urn:li:demo:conversation:${contact.id}`, message_urn: `urn:li:demo:message:${randomUUID()}`, direction: "out", body: "Thanks for connecting. Worth 15 minutes to compare notes?", sent_at: iso(sentMs) });
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
            if (chance(0.3)) event("opened", sentMs + between(2, 12) * 1000, { is_bot: 1, bot_reason: pick(["security_scanner", "prefetch"]), user_agent: "Mozilla/5.0 (compatible; Proofpoint)" });
            if (chance(0.45)) {
              const opens = between(1, 4);
              for (let i = 0; i < opens; i++) event("opened", Math.min(NOW - 60_000, sentMs + between(1, 60) * HOUR));
              if (chance(0.15)) event("clicked", Math.min(NOW - 60_000, sentMs + between(1, 60) * HOUR), { payload_json: JSON.stringify({ url: "https://acme.example/pricing" }) });
              if (!replied && chance(0.14)) replied = { channel: "email", atMs: Math.min(NOW - between(2, 180) * 60_000, sentMs + between(1, 50) * HOUR) };
            }
          }
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
    for (const [url, events, enabled] of [
      ["https://hooks.acme.example/linki/replies", "reply.received,email.bounced", 1],
      ["https://etl.acme.example/ingest/linki", "*", 0],
    ] as const) {
      insert("webhook_endpoints", { id: randomUUID(), workspace_id: ws, url, secret: encryptSecret(`whsec_demo_${randomUUID()}`), event_types: events, enabled, created_by: owner.id });
      count("webhooks");
    }
    for (const [action, entity, who] of [
      ["workflow.created", "workflow", "priya"], ["run.paused", "run", "elena"], ["member.role_changed", "user", "jordan"], ["linkedin_account.connected", "account", "marcus"],
      ["api_key.created", "api_key", "jordan"], ["contacts.deleted", "target", "daniel"], ["export.created", "export", "priya"], ["suppression.added", "suppression", "elena"],
    ] as const) {
      insert("audit_logs", { id: randomUUID(), workspace_id: ws, user_id: userId(who), action, entity_type: entity, entity_id: randomUUID(), metadata_json: JSON.stringify({ demo: true }), created_at: ago(between(1, 96) * HOUR) });
      count("audit entries");
    }
    for (let day = 0; day < 14; day++) {
      const generations = between(3, 9);
      for (let i = 0; i < generations; i++) {
        insert("agent_sessions", {
          id: randomUUID(), workspace_id: ws, model: pick(["anthropic/claude-haiku-5.5", "anthropic/claude-opus-5.5"]), input_tokens: between(800, 2600), output_tokens: between(90, 260),
          cost_usd: Number((0.002 + random() * 0.02).toFixed(4)), generated_text: "Demo generation.", prompt: "Demo prompt.", created_at: ago(day * DAY + between(1, 20) * HOUR),
        });
      }
    }
  })();

  // Outside the transaction: createApiKey opens its own statement on the shared connection.
  const ws = (db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(WORKSPACE_SLUG) as { id: string }).id;
  const ownerId = (db.prepare("SELECT id FROM users WHERE email = ?").get(DEMO_LOGIN) as { id: string }).id;
  createApiKey({ workspaceId: ws, name: "Production backend", scopes: ["campaigns:write", "contacts:write", "contacts:read"], createdBy: ownerId, expiresAt: iso(NOW + 276 * DAY) });
  createApiKey({ workspaceId: ws, name: "Reporting read-only", scopes: ["campaigns:read", "events:read"], createdBy: ownerId, expiresAt: iso(NOW + 112 * DAY) });
  const revoked = createApiKey({ workspaceId: ws, name: "Zapier sandbox", scopes: ["contacts:read"], createdBy: ownerId });
  db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(ago(8 * DAY), revoked.id);
  counts["API keys"] = 3;

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
