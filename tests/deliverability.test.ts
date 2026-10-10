// The Deliverability screen's server side: a domain's score and what would raise it, DNS
// changes between checks, the guard log and what writes to it, complaints that arrive as
// mail, placement tests against a seed list, the do-not-contact counts, and the routes.
// Real (throwaway) database. The network is never reached: DNS answers are handed in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { markConnected, markDisconnected } from "@/lib/email/connection";
import { deliverabilityOverview, deliverabilityReport, doNotContact, domainDns } from "@/lib/email/deliverability-overview";
import type { DnsResolver } from "@/lib/email/dns";
import { changeDetail, changeTitle, dnsChanges, getDomainSelector, setDomainSelector } from "@/lib/email/dns-changes";
import { domainRates } from "@/lib/email/domain-health";
import { domainScore, domainScoreOf, type DomainEvidence } from "@/lib/email/domain-score";
import { noteFeedbackReport, parseFeedbackReport } from "@/lib/email/feedback-reports";
import { listGuardEvents, pruneGuardEvents, recordGuardEvent } from "@/lib/email/guard-events";
import { evaluateSenderHealth } from "@/lib/email/infrastructure";
import { GIVE_UP_AFTER_MINUTES, MAX_SEEDS, addSeed, listSeeds, lookForPlacementRun, placementSummary, readPlacementRun, removeSeed, setPlacement, startPlacementRun, summarise } from "@/lib/email/placement";
import { recordDailyLimits, recordWarmupSummaries } from "@/lib/email/upkeep";
import { checkDomainDeliverability } from "@/lib/platform/deliverability";
import { listNotifications } from "@/lib/platform/notifications";
import overviewHandler from "@/pages/api/deliverability/index";
import dnsHandler from "@/pages/api/deliverability/dns";
import eventsHandler from "@/pages/api/deliverability/events";
import seedsHandler from "@/pages/api/deliverability/seeds";
import placementHandler from "@/pages/api/deliverability/placement";
import reportHandler from "@/pages/api/deliverability/report";
import warmupHandler from "@/pages/api/deliverability/warmup";
import suppressionsHandler from "@/pages/api/platform/suppressions";
import { ctxHeaders } from "./helpers/ctx";
import { opensslAvailable, startMailServer, type MailServer } from "./helpers/mail-server";

const db = () => getDb();
let seq = 0;

type Res = NextApiResponse & { statusCode: number; body: Record<string, unknown>; text: string; headers: Record<string, string> };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined, text: "", headers: {}, destroyed: false };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = (chunk?: string) => { if (chunk) res.text = `${res.text}${chunk}`; return res; };
  res.write = (chunk: string) => { res.text = `${res.text}${chunk}`; return true; };
  res.setHeader = (name: string, value: string) => { (res.headers as Record<string, string>)[name] = value; return res; };
  res.once = () => res;
  res.off = () => res;
  return res as unknown as Res;
}

function workspace() {
  const n = ++seq;
  const ws = `ws-dlv-${n}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  const call = async (handler: (req: NextApiRequest, res: NextApiResponse) => unknown, method: string, opts: { body?: unknown; query?: Record<string, string>; role?: string } = {}) => {
    const res = mockRes();
    const role = opts.role ?? "admin";
    await handler({ method, body: opts.body ?? {}, query: opts.query ?? {}, headers: ctxHeaders(ws, { userId: `${ws}-${role}`, role }) } as unknown as NextApiRequest, res);
    return res;
  };
  const mailbox = (address: string, fields: Record<string, unknown> = {}) => {
    const id = `dlv-mb-${++seq}`;
    db().prepare(`INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, imap_host, username, password, is_verified, daily_email_limit, ramp_up_enabled, timezone, created_at)
      VALUES (?, ?, ?, ?, 'smtp.test', 'imap.test', ?, 'stored-secret', 1, 50, 0, 'UTC', datetime('now', ?))`).run(id, ws, address, address, address, `-${1000 - seq} seconds`);
    for (const [column, value] of Object.entries(fields)) db().prepare(`UPDATE email_accounts SET ${column} = ? WHERE id = ?`).run(value, id);
    return id;
  };
  return { ws, call, mailbox };
}
type Workspace = ReturnType<typeof workspace>;

/** Emails on record for a mailbox over the last few days, with so many bounces and complaints. */
function history(w: Workspace, mailbox: string, sent: number, bounces = 0, complaints = 0) {
  const ids: string[] = [];
  for (let i = 0; i < sent; i++) {
    const job = `dlv-job-${++seq}`;
    ids.push(job);
    db().prepare("INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, source, recipient, subject, body_text, status) VALUES (?, ?, ?, ?, 'campaign', ?, 's', 'b', 'sent')").run(job, w.ws, mailbox, job, `lead${i}@prospect.test`);
    db().prepare("INSERT INTO sent_messages (id, workspace_id, job_id, email_account_id, recipient, subject, message_id) VALUES (?, ?, ?, ?, ?, 's', ?)").run(`${job}-sm`, w.ws, job, mailbox, `lead${i}@prospect.test`, `<${job}@sender.test>`);
  }
  const event = (type: string) => db().prepare("INSERT INTO sender_events (id, workspace_id, email_account_id, provider, provider_event_id, event_type, occurred_at) VALUES (?, ?, ?, 'test', ?, ?, datetime('now'))").run(`dlv-ev-${++seq}`, w.ws, mailbox, `dlv-ev-${seq}`, type);
  for (let i = 0; i < bounces; i++) event("bounced");
  for (let i = 0; i < complaints; i++) event("complained");
  return ids;
}

const KEY = `v=DKIM1; k=rsa; p=${"A".repeat(392)}`;
/** DNS for a domain, as a lookup would find it. */
function resolver(domain: string, records: { spf?: string | null; dmarc?: string | null; dkim?: [string, string] | null; mx?: boolean }): DnsResolver {
  return {
    txt: async (name) => {
      if (name === domain) return records.spf ? [records.spf] : [];
      if (name === `_dmarc.${domain}`) return records.dmarc ? [records.dmarc] : [];
      if (records.dkim && name === `${records.dkim[0]}._domainkey.${domain}`) return [records.dkim[1]];
      return [];
    },
    mx: async () => (records.mx === false ? [] : [{ exchange: `mx.${domain}`, priority: 10 }]),
  };
}
const SOUND = { spf: "v=spf1 include:_spf.google.com ~all", dmarc: "v=DMARC1; p=none; rua=mailto:d@x.test", dkim: ["google", KEY] as [string, string] };

// ─────────────────────────────────────────────────────────────────────
describe("a sending domain's score", () => {
  const sound: DomainEvidence = { spf: "pass", dkim: "pass", dmarc: "pass", mx: "pass", bounce_rate: 0, complaint_rate: 0 };

  it("is 100 with every record sound and nothing bouncing, and the same with nothing sent at all", () => {
    expect(domainScoreOf(sound)).toBe(100);
    expect(domainScoreOf({ ...sound, bounce_rate: null, complaint_rate: null })).toBe(100);
    expect(domainScore("acme.test", sound)).toEqual({ score: 100, band: "good", headline: "Everything is in place", fixes: [] });
  });

  it("loses points for each record that is missing or weak, and for bounces and complaints", () => {
    expect(domainScoreOf({ ...sound, dmarc: "weak" })).toBe(92);
    expect(domainScoreOf({ ...sound, dmarc: "fail" })).toBe(75);
    expect(domainScoreOf({ ...sound, spf: "fail" })).toBe(80);
    expect(domainScoreOf({ ...sound, dkim: "fail" })).toBe(75);
    expect(domainScoreOf({ ...sound, mx: "fail" })).toBe(90);
    expect(domainScoreOf({ ...sound, bounce_rate: 0.012 })).toBe(94);
    expect(domainScoreOf({ ...sound, bounce_rate: 0.5 })).toBe(90);
    expect(domainScoreOf({ ...sound, complaint_rate: 0.0005 })).toBe(95);
    expect(domainScoreOf({ spf: "fail", dkim: "fail", dmarc: "fail", mx: "fail", bounce_rate: 1, complaint_rate: 1 })).toBe(0);
  });

  it("says what each fix would bring the score to, the biggest gain first", () => {
    const result = domainScore("acme.test", { ...sound, dmarc: "weak", bounce_rate: 0.012 });
    expect(result).toMatchObject({ score: 86, band: "good", headline: "Good, two fixes available" });
    expect(result.fixes.map((fix) => [fix.key, fix.score_after])).toEqual([["dmarc", 94], ["bounces", 92]]);
    expect(result.fixes[0].advice).toBe("Moving DMARC from p=none to p=quarantine would raise acme.test to 94 and protect the domain from being forged.");

    const poor = domainScore("acme.test", { ...sound, spf: "fail", dkim: "fail", dmarc: "fail" });
    expect(poor).toMatchObject({ score: 30, band: "poor", headline: "Poor, three fixes needed" });
    expect(poor.fixes.map((fix) => fix.key)).toEqual(["dkim", "dmarc", "spf"]);
    expect(domainScore("acme.test", { ...sound, dmarc: "weak" }).headline).toBe("Good, one fix available");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("DNS changes between two checks", () => {
  const record = (status: "pass" | "weak" | "fail", value: string | null = "v") => ({ status, value });

  it("are found record by record, and said to be for better or worse", () => {
    const before = { spf: record("pass", "v=spf1 a ~all"), dkim: record("fail", null), dmarc: record("weak", "v=DMARC1; p=none"), mx: record("pass", "10 · mx") };
    const after = { spf: record("pass", "v=spf1  a   ~all"), dkim: record("pass", "v=DKIM1; p=abc"), dmarc: record("pass", "v=DMARC1; p=quarantine"), mx: record("fail", null) };
    expect(dnsChanges(before, after)).toEqual([
      { record: "DKIM", kind: "added", before: null, after: "v=DKIM1; p=abc", worse: false },
      { record: "DMARC", kind: "stronger", before: "v=DMARC1; p=none", after: "v=DMARC1; p=quarantine", worse: false },
      { record: "MX", kind: "removed", before: "10 · mx", after: null, worse: true },
    ]);
    expect(dnsChanges(after, { ...after, dmarc: record("weak", "v=DMARC1; p=none") })).toEqual([{ record: "DMARC", kind: "weaker", before: "v=DMARC1; p=quarantine", after: "v=DMARC1; p=none", worse: true }]);
    expect(dnsChanges(before, { ...before, dmarc: record("weak", "v=DMARC1; p=none; rua=mailto:d@x.test") })[0]).toMatchObject({ record: "DMARC", kind: "updated", worse: false });
    expect(dnsChanges(before, before)).toEqual([]);
  });

  it("are not claimed where a check could not look, or was kept before records had a standing", () => {
    const now = { spf: record("fail", null), dkim: record("pass"), dmarc: record("pass"), mx: record("pass") };
    expect(dnsChanges(null, now)).toEqual([]);
    // The old shape: { ok, records } with no standing.
    expect(dnsChanges({ spf: { value: "v=spf1" } as never, dkim: "google._domainkey", dmarc: null, mx: undefined }, now)).toEqual([]);
    expect(dnsChanges({ ...now, spf: record("pass") }, { ...now, spf: { status: "fail", value: null, lookup_failed: true } })).toEqual([]);
  });

  it("are worded for the log", () => {
    const change = { record: "DMARC" as const, kind: "updated" as const, before: "v=DMARC1; p=none", after: "v=DMARC1; p=none; rua=mailto:d@acme.test", worse: false };
    expect(changeTitle(change, "acme.test")).toBe("DMARC record updated on acme.test");
    expect(changeDetail(change, 81, 86)).toBe("Was: v=DMARC1; p=none. Now: v=DMARC1; p=none; rua=mailto:d@acme.test. Domain score improved from 81 to 86.");
    expect(changeTitle({ ...change, kind: "removed" }, "acme.test")).toBe("DMARC record is gone from acme.test");
    expect(changeDetail({ ...change, kind: "removed" }, 92, 75)).toBe("It was: v=DMARC1; p=none. Domain score fell from 92 to 75.");
    expect(changeDetail({ ...change, kind: "added", before: null }, 80, 80)).toMatch(/Domain score still 80\.$/);
  });

  it("are logged, announced as an event, and told to the admins when the domain is worse off", async () => {
    const w = workspace();
    w.mailbox("mia@changes.test");
    const first = await checkDomainDeliverability({ workspaceId: w.ws, domain: "changes.test", resolver: resolver("changes.test", SOUND) });
    expect(first.changes).toEqual([]);
    expect(listGuardEvents(db(), w.ws).total).toBe(0);

    // DMARC is tightened: good news, logged, nobody is alerted.
    const better = await checkDomainDeliverability({ workspaceId: w.ws, domain: "changes.test", resolver: resolver("changes.test", { ...SOUND, dmarc: "v=DMARC1; p=reject" }) });
    expect(better.changes).toMatchObject([{ record: "DMARC", kind: "stronger", worse: false }]);
    expect(listGuardEvents(db(), w.ws).events[0]).toMatchObject({ kind: "dns_change", tone: "good", domain: "changes.test", title: "DMARC record strengthened on changes.test", detail: expect.stringMatching(/Domain score improved from 92 to 100\.$/) });
    expect(listNotifications(w.ws, "nobody", "owner").filter((note) => note.kind === "domain.dns_changed")).toHaveLength(0);

    // SPF disappears: logged in red, and the admins hear of it.
    await checkDomainDeliverability({ workspaceId: w.ws, domain: "changes.test", resolver: resolver("changes.test", { ...SOUND, spf: null, dmarc: "v=DMARC1; p=reject" }) });
    expect(listGuardEvents(db(), w.ws).events[0]).toMatchObject({ tone: "bad", title: "SPF record is gone from changes.test" });
    const notice = listNotifications(w.ws, "nobody", "owner").find((note) => note.kind === "domain.dns_changed");
    expect(notice).toMatchObject({ tone: "bad", title: "SPF record is gone from changes.test", link: "/deliverability?domain=changes.test" });
    expect(listNotifications(w.ws, "nobody", "member").filter((note) => note.kind === "domain.dns_changed")).toHaveLength(0);
    const events = db().prepare("SELECT payload_json FROM domain_events WHERE workspace_id = ? AND type = 'domain.dns_changed' ORDER BY rowid").all(w.ws) as Array<{ payload_json: string }>;
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1].payload_json)).toMatchObject({ domain: "changes.test", score_before: 100, score_after: 80 });

    // A lookup that gets no answer is not a record that went away.
    const broken: DnsResolver = { txt: async () => { throw new Error("ETIMEOUT"); }, mx: async () => { throw new Error("ETIMEOUT"); } };
    expect((await checkDomainDeliverability({ workspaceId: w.ws, domain: "changes.test", resolver: broken })).changes).toEqual([]);
    expect(listGuardEvents(db(), w.ws).total).toBe(2);
  });
});

describe("a domain's DKIM selector", () => {
  it("is kept once entered, tried first at every check, and refused if it is not one", async () => {
    const w = workspace();
    w.mailbox("mia@selector.test");
    expect(getDomainSelector(db(), w.ws, "selector.test")).toBeNull();
    expect(setDomainSelector(db(), w.ws, "selector.test", "not a selector!")).toMatch(/letters, digits, dots and dashes/);
    expect(setDomainSelector(db(), w.ws, "selector.test", " Acme2026 ")).toBeNull();
    expect(getDomainSelector(db(), w.ws, "selector.test")).toBe("acme2026");

    const asked: string[] = [];
    const custom: DnsResolver = { ...resolver("selector.test", { ...SOUND, dkim: ["acme2026", KEY] }), txt: async (name) => { asked.push(name); return resolver("selector.test", { ...SOUND, dkim: ["acme2026", KEY] }).txt(name); } };
    const result = await checkDomainDeliverability({ workspaceId: w.ws, domain: "selector.test", resolver: custom });
    expect(result.dkim).toMatchObject({ status: "pass", selector: "acme2026" });
    expect(asked.filter((name) => name.includes("_domainkey"))).toEqual(["acme2026._domainkey.selector.test"]);
    expect(domainDns(db(), w.ws, "selector.test")).toMatchObject({ dkim_selector: "acme2026", dkim_selector_set: "acme2026" });

    expect(setDomainSelector(db(), w.ws, "selector.test", "")).toBeNull();
    expect(getDomainSelector(db(), w.ws, "selector.test")).toBeNull();
    // With none entered, the one the last check found is still tried first.
    asked.length = 0;
    await checkDomainDeliverability({ workspaceId: w.ws, domain: "selector.test", resolver: custom });
    expect(asked.filter((name) => name.includes("_domainkey"))[0]).toBe("acme2026._domainkey.selector.test");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the guard log", () => {
  it("keeps what happened, newest first, a page at a time, and says a lasting thing once", () => {
    const w = workspace();
    const other = workspace();
    for (let i = 0; i < 5; i++) recordGuardEvent({ workspaceId: w.ws, kind: "daily_limit", title: `Limit ${i}`, domain: i < 3 ? "a.test" : "b.test", occurredAt: `2026-10-0${i + 1} 10:00:00` });
    recordGuardEvent({ workspaceId: other.ws, kind: "daily_limit", title: "Theirs" });
    expect(recordGuardEvent({ workspaceId: w.ws, kind: "auto_pause", title: "Paused", tone: "bad", dedupeKey: "pause:1" })).not.toBeNull();
    expect(recordGuardEvent({ workspaceId: w.ws, kind: "auto_pause", title: "Paused again", dedupeKey: "pause:1" })).toBeNull();
    expect(recordGuardEvent({ workspaceId: other.ws, kind: "auto_pause", title: "Paused", dedupeKey: "pause:1" })).not.toBeNull();

    const all = listGuardEvents(db(), w.ws);
    expect(all.total).toBe(6);
    expect(all.events[0]).toMatchObject({ kind: "auto_pause", tone: "bad", title: "Paused" });
    expect(listGuardEvents(db(), w.ws, { limit: 2, offset: 1 }).events.map((event) => event.title)).toEqual(["Limit 4", "Limit 3"]);
    expect(listGuardEvents(db(), w.ws, { domain: "a.test" }).total).toBe(3);
    expect(listGuardEvents(db(), w.ws, { kind: "auto_pause" }).total).toBe(1);
    expect(listGuardEvents(db(), w.ws, { hours: 24 }).total).toBe(1);

    db().prepare("UPDATE mailbox_guard_events SET occurred_at = datetime('now', '-200 days') WHERE workspace_id = ? AND kind = 'daily_limit'").run(w.ws);
    expect(pruneGuardEvents()).toBeGreaterThanOrEqual(5);
    expect(listGuardEvents(db(), w.ws).total).toBe(1);
  });

  it("is told when a guard pauses a mailbox, and when one loses or regains its sign-in", () => {
    const w = workspace();
    const id = w.mailbox("guarded@log.test");
    history(w, id, 100, 10);
    evaluateSenderHealth(id);
    evaluateSenderHealth(id);
    markDisconnected(id, "The mail server refused the sign-in used to send (535).");
    markConnected(id);
    const events = listGuardEvents(db(), w.ws).events;
    expect(events.map((event) => event.kind)).toEqual(["reconnected", "disconnected", "auto_pause"]);
    expect(events[2]).toMatchObject({ tone: "bad", domain: "log.test", email_account_id: id, title: "guarded@log.test auto-paused", detail: "Its 30-day bounce rate 10.00% exceeds 3.00%. Its contacts wait for it to resume." });
    expect(events[1]).toMatchObject({ tone: "bad", title: "guarded@log.test cannot sign in" });
    expect(events[0]).toMatchObject({ tone: "good", title: "guarded@log.test signs in again" });
  });

  it("gets one line a day for a mailbox at its limit, saying how many emails were put off", () => {
    const w = workspace();
    const full = w.mailbox("full@limit.test", { daily_email_limit: 2 });
    const room = w.mailbox("room@limit.test", { daily_email_limit: 5 });
    const paused = w.mailbox("paused@limit.test", { daily_email_limit: 1, paused_at: "2026-10-01 00:00:00" });
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'C', ?)").run(`${w.ws}-wf`, w.ws);
    db().prepare("INSERT INTO runs (id, workflow_id, status, workspace_id) VALUES (?, ?, 'running', ?)").run(`${w.ws}-run`, `${w.ws}-wf`, w.ws);
    [full, room, paused].forEach((mailbox, index) => {
      db().prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, 'T', ?)").run(`${w.ws}-t${index}`, w.ws, `https://www.linkedin.com/in/${w.ws}-${index}/`);
      db().prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(`${w.ws}-rp${index}`, `${w.ws}-run`, `${w.ws}-t${index}`, mailbox);
      for (let i = 0; i < 2; i++) db().prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, ?, 'info', 'Email sent to T')").run(`dlv-log-${++seq}`, `${w.ws}-run`, `${w.ws}-t${index}`);
    });
    for (let i = 0; i < 3; i++) db().prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, ?, 'warn', 'Daily email limit reached — rescheduled to tomorrow')").run(`dlv-log-${++seq}`, `${w.ws}-run`, `${w.ws}-t0`);

    recordDailyLimits();
    recordDailyLimits();
    const events = listGuardEvents(db(), w.ws, { kind: "daily_limit" }).events;
    // Only the mailbox that is sending and full. A paused mailbox is not "at its limit".
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tone: "warn", email_account_id: full, title: "full@limit.test reached its daily limit", detail: "2 of 2 sent. 3 more emails wait until tomorrow." });
  });

  it("gets one line a day saying what the day before's warm-up came to", () => {
    const w = workspace();
    const [a, b] = [w.mailbox("a@warm.test"), w.mailbox("b@warm.test")];
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const message = (from: string, to: string, when: string, extra: { rescued?: boolean; replied?: boolean } = {}) =>
      db().prepare("INSERT INTO warmup_messages (id, workspace_id, from_account_id, to_account_id, subject, body, status, scheduled_at, sent_at, rescued_at, replied_at) VALUES (?, ?, ?, ?, 's', 'b', 'sent', ?, ?, ?, ?)")
        .run(`dlv-wm-${++seq}`, w.ws, from, to, when, when, extra.rescued ? when : null, extra.replied ? when : null);
    message(a, b, `${yesterday} 09:00:00`, { replied: true });
    message(a, b, `${yesterday} 11:00:00`, { rescued: true });
    message(b, a, `${yesterday} 12:00:00`, { replied: true });
    message(b, a, new Date().toISOString().slice(0, 19).replace("T", " "));

    expect(recordWarmupSummaries()).toBeGreaterThanOrEqual(1);
    recordWarmupSummaries();
    const events = listGuardEvents(db(), w.ws, { kind: "warmup_cycle" }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tone: "mail", title: "Warm-up day completed", detail: "3 warm-up emails sent from 2 mailboxes yesterday, 2 replied to, 1 moved out of spam." });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a spam complaint that arrives as mail", () => {
  const report = (fields: string) => `This is an email abuse report for an email message received from IP 192.0.2.1.\r\n\r\n--b\r\nContent-Type: message/feedback-report\r\n\r\nFeedback-Type: abuse\r\nUser-Agent: SomeGenerator/1.0\r\nVersion: 1\r\n${fields}\r\n--b\r\nContent-Type: message/rfc822\r\n\r\n`;

  it("is read for who complained and about which email", () => {
    expect(parseFeedbackReport(`${report("Original-Rcpt-To: <Lee@Prospect.test>")}Message-ID: <job-1@sender.test>\r\nTo: lee@prospect.test\r\n`)).toEqual({ type: "abuse", recipient: "lee@prospect.test", messageId: "<job-1@sender.test>" });
    expect(parseFeedbackReport(report("Removal-Recipient: lee@prospect.test"))).toMatchObject({ recipient: "lee@prospect.test", messageId: null });
    expect(parseFeedbackReport("Hi, just following up on my last email.")).toBeNull();
  });

  it("counts against the mailbox that sent the email, puts the address on the do-not-contact list, and is logged once", () => {
    const w = workspace();
    const id = w.mailbox("sender@fbl.test");
    const [job] = history(w, id, 40);
    const body = `${report("Original-Rcpt-To: <lead0@prospect.test>")}Message-ID: <${job}@sender.test>\r\n`;

    expect(noteFeedbackReport({ workspaceId: w.ws, reportMessageId: "<report-1@provider.test>", body })).toBe(true);
    // The reply reader sees the same message again on its next pass.
    expect(noteFeedbackReport({ workspaceId: w.ws, reportMessageId: "<report-1@provider.test>", body })).toBe(false);

    expect(domainRates(db(), w.ws, "fbl.test")).toMatchObject({ sent: 40, complaints: 1, complaint_rate: 1 / 40 });
    expect(db().prepare("SELECT reason, source FROM suppressions WHERE workspace_id = ? AND value = 'lead0@prospect.test'").get(w.ws)).toEqual({ reason: "complained", source: "feedback-report" });
    const events = listGuardEvents(db(), w.ws, { kind: "complaint" }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tone: "warn", email_account_id: id, domain: "fbl.test", title: "An email from sender@fbl.test was marked as spam" });
    expect(db().prepare("SELECT COUNT(*) c FROM domain_events WHERE workspace_id = ? AND type = 'email.complained'").get(w.ws)).toEqual({ c: 1 });
  });

  it("is left alone when it is not a complaint, or is about nothing this workspace sent", () => {
    const w = workspace();
    w.mailbox("sender@fbl2.test");
    expect(noteFeedbackReport({ workspaceId: w.ws, reportMessageId: "<r2@p.test>", body: report("Original-Rcpt-To: <stranger@nowhere.test>") })).toBe(false);
    expect(noteFeedbackReport({ workspaceId: w.ws, reportMessageId: "<r3@p.test>", body: report("Original-Rcpt-To: <x@y.test>").replace("Feedback-Type: abuse", "Feedback-Type: not-spam") })).toBe(false);
    expect(noteFeedbackReport({ workspaceId: w.ws, reportMessageId: "<r4@p.test>", body: "No report here" })).toBe(false);
    expect(listGuardEvents(db(), w.ws).total).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("placement tests", () => {
  const sender = (sent: string[], fail?: (to: string) => Error | null) => (async (input: { to: string }) => {
    const refusal = fail?.(input.to);
    if (refusal) throw refusal;
    sent.push(input.to);
    return { messageId: `<${input.to}.${sent.length}@placement.test>`, jobId: `job-${sent.length}`, status: "sent" };
  }) as never;

  it("keeps a list of seed addresses, and knows which of them it can read", async () => {
    const w = workspace();
    w.mailbox("own@seeds.test");
    expect((await w.call(seedsHandler, "GET")).body).toEqual({ seeds: [] });
    expect((await w.call(seedsHandler, "POST", { body: { email: "nope" } })).statusCode).toBe(400);
    const own = await w.call(seedsHandler, "POST", { body: { email: "Own@Seeds.test", label: "Our own" } });
    expect(own.statusCode).toBe(201);
    expect(own.body).toMatchObject({ email: "own@seeds.test", label: "Our own", readable: true });
    expect((await w.call(seedsHandler, "POST", { body: { email: "panel@gmail.test" } })).body).toMatchObject({ readable: false });
    expect((await w.call(seedsHandler, "POST", { body: { email: "own@seeds.test" } })).body).toEqual({ error: "own@seeds.test is already a seed." });
    expect((await w.call(seedsHandler, "POST", { role: "manager", body: { email: "x@y.test" } })).statusCode).toBe(403);
    expect(((await w.call(seedsHandler, "GET", { role: "viewer" })).body.seeds as unknown[]).length).toBe(2);

    expect((await w.call(seedsHandler, "DELETE", { query: { id: String(own.body.id) } })).statusCode).toBe(204);
    expect((await w.call(seedsHandler, "DELETE", { query: { id: String(own.body.id) } })).statusCode).toBe(404);
    expect(listSeeds(db(), w.ws).map((seed) => seed.email)).toEqual(["panel@gmail.test"]);

    for (let i = listSeeds(db(), w.ws).length; i < MAX_SEEDS; i++) expect(typeof addSeed(db(), w.ws, { email: `seed${i}@panel.test` })).toBe("object");
    expect(addSeed(db(), w.ws, { email: "one-too-many@panel.test" })).toBe(`A workspace can have ${MAX_SEEDS} seed addresses.`);
    expect(removeSeed(db(), workspace().ws, listSeeds(db(), w.ws)[0].id)).toBe(false);
  });

  it("send the same email to every seed, and read back the ones Linki can read", async () => {
    const w = workspace();
    const from = w.mailbox("from@place.test");
    w.mailbox("inbox@place.test");
    w.mailbox("junk@place.test");
    for (const email of ["inbox@place.test", "junk@place.test", "late@place.test", "panel@elsewhere.test", "blocked@elsewhere.test", "refused@elsewhere.test"]) addSeed(db(), w.ws, { email });
    w.mailbox("late@place.test");
    db().prepare("INSERT INTO suppressions (id, workspace_id, kind, value, reason) VALUES (?, ?, 'email', 'blocked@elsewhere.test', 'manual')").run(`dlv-sup-${++seq}`, w.ws);

    const sent: string[] = [];
    const run = await startPlacementRun({ workspaceId: w.ws, emailAccountId: from }, db(), sender(sent, (to) => (to.startsWith("refused") ? new Error("550 No such user") : null)));
    if (typeof run === "string") throw new Error(run);
    expect(run).toMatchObject({ domain: "place.test", mailbox: { id: from, from_email: "from@place.test" } });
    expect(sent).toEqual(["inbox@place.test", "junk@place.test", "late@place.test", "panel@elsewhere.test"]);
    expect(run.tests.map((test) => [test.seed_email, test.status, test.readable, test.error])).toEqual([
      ["inbox@place.test", "sent", true, null], ["junk@place.test", "sent", true, null], ["late@place.test", "sent", true, null],
      ["panel@elsewhere.test", "sent", false, null],
      ["blocked@elsewhere.test", "failed", false, "This address is on the do-not-contact list."], ["refused@elsewhere.test", "failed", false, "550 No such user"],
    ]);

    const find = (async (_reader: unknown, messageId: string) => {
      if (messageId.includes("inbox@")) return { found: true, placement: "inbox", folder: "INBOX", auth: { spf: "pass", dkim: "pass", dmarc: "pass" } };
      if (messageId.includes("junk@")) return { found: true, placement: "spam", folder: "Junk", auth: { spf: "pass", dkim: "fail", dmarc: "fail" } };
      return { found: false, placement: null, folder: null, auth: null };
    }) as never;
    const looked = (await lookForPlacementRun(db(), w.ws, run.id, find))!;
    expect(looked.tests.slice(0, 4).map((test) => [test.status, test.placement])).toEqual([["checked", "inbox"], ["checked", "spam"], ["sent", null], ["sent", null]]);
    expect(looked.tests[1]).toMatchObject({ folder: "Junk", auth: { dkim: "fail" } });
    expect(placementSummary(db(), w.ws, "place.test", 30)).toEqual({ sent: 4, checked: 2, inbox: 1, tabs: 0, spam: 1, missing: 0, waiting: 2, inbox_rate: 0.5 });
    // Not settled yet, so not in the log yet.
    expect(listGuardEvents(db(), w.ws, { kind: "placement_test" }).total).toBe(0);

    // The copy that never turns up is missing once it has had its time; the one nobody can read is entered by hand.
    db().prepare("UPDATE inbox_placement_tests SET sent_at = datetime('now', ?) WHERE run_id = ?").run(`-${GIVE_UP_AFTER_MINUTES + 1} minutes`, run.id);
    await lookForPlacementRun(db(), w.ws, run.id, find);
    const panel = looked.tests[3];
    expect(setPlacement(db(), w.ws, panel.id, "promotions")).toMatchObject({ status: "checked", placement: "promotions" });
    expect(setPlacement(db(), workspace().ws, panel.id, "inbox")).toBeNull();
    // A copy that was never sent has no result to enter.
    expect(setPlacement(db(), w.ws, looked.tests[4].id, "inbox")).toMatchObject({ status: "failed", placement: null });

    expect(readPlacementRun(db(), w.ws, run.id)!.tests.map((test) => test.placement)).toEqual(["inbox", "spam", "missing", "promotions", null, null]);
    expect(placementSummary(db(), w.ws, "place.test", 30)).toEqual({ sent: 4, checked: 4, inbox: 1, tabs: 1, spam: 1, missing: 1, waiting: 0, inbox_rate: 0.25 });
    const logged = listGuardEvents(db(), w.ws, { kind: "placement_test" }).events;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ tone: "warn", domain: "place.test", title: "Placement test from from@place.test: 1 of 4 in the inbox", detail: "1 in spam, 1 in another tab or folder, 1 not found" });
  });

  it("are not started from a mailbox that cannot send, or with no seeds", async () => {
    const w = workspace();
    const from = w.mailbox("from@none.test");
    expect(await startPlacementRun({ workspaceId: w.ws, emailAccountId: from }, db(), sender([]))).toBe("Add at least one seed address first.");
    addSeed(db(), w.ws, { email: "seed@none.test" });
    expect(await startPlacementRun({ workspaceId: w.ws, emailAccountId: "no-such" }, db(), sender([]))).toBe("Choose a mailbox to send the test from.");
    expect(await startPlacementRun({ workspaceId: w.ws, emailAccountId: from, seedIds: ["no-such"] }, db(), sender([]))).toBe("None of those seeds exist.");
    db().prepare("UPDATE email_accounts SET paused_at = datetime('now') WHERE id = ?").run(from);
    expect(await startPlacementRun({ workspaceId: w.ws, emailAccountId: from }, db(), sender([]))).toBe("from@none.test is paused. Resume it to send a test from it.");
    db().prepare("UPDATE email_accounts SET paused_at = NULL, disconnected_at = datetime('now') WHERE id = ?").run(from);
    expect(await startPlacementRun({ workspaceId: w.ws, emailAccountId: from }, db(), sender([]))).toBe("from@none.test cannot sign in, so it cannot send a test.");
    expect(db().prepare("SELECT COUNT(*) c FROM placement_runs WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
  });

  it("count a single test sent the old way with its mailbox's domain", () => {
    const w = workspace();
    const from = w.mailbox("old@legacy.test");
    db().prepare("INSERT INTO inbox_placement_tests (id, workspace_id, email_account_id, seed_email, subject, status, placement, sent_at) VALUES (?, ?, ?, 'seed@x.test', 's', 'checked', 'inbox', datetime('now'))").run(`dlv-pt-${++seq}`, w.ws, from);
    db().prepare("INSERT INTO inbox_placement_tests (id, workspace_id, email_account_id, seed_email, subject, status, sent_at) VALUES (?, ?, ?, 'seed2@x.test', 's', 'sent', datetime('now'))").run(`dlv-pt-${++seq}`, w.ws, from);
    expect(placementSummary(db(), w.ws, "legacy.test", 30)).toMatchObject({ sent: 2, checked: 1, inbox: 1, waiting: 1, inbox_rate: 1 });
    expect(placementSummary(db(), w.ws, "other.test", 30)).toMatchObject({ sent: 0, inbox_rate: null });
    expect(summarise([])).toMatchObject({ sent: 0, checked: 0, inbox_rate: null });
  });

  it("the route sends, looks, and takes a result by hand, for an admin only", async () => {
    const w = workspace();
    const from = w.mailbox("from@route.test");
    addSeed(db(), w.ws, { email: "panel@elsewhere.test" });
    expect((await w.call(placementHandler, "POST", { body: {} })).statusCode).toBe(400);
    expect((await w.call(placementHandler, "POST", { role: "manager", body: { email_account_id: from } })).statusCode).toBe(403);
    expect((await w.call(placementHandler, "GET", { role: "viewer", query: { domain: "route.test" } })).body).toEqual({ runs: [] });
    // The real sender is used here; the mailbox is paused, so the run is refused before anything is sent.
    db().prepare("UPDATE email_accounts SET paused_at = datetime('now') WHERE id = ?").run(from);
    expect((await w.call(placementHandler, "POST", { body: { email_account_id: from } })).body).toEqual({ error: "from@route.test is paused. Resume it to send a test from it." });
    expect((await w.call(placementHandler, "PUT", { body: { run_id: "no-such" } })).statusCode).toBe(404);
    expect((await w.call(placementHandler, "PATCH", { body: { test_id: "x", placement: "somewhere" } })).statusCode).toBe(400);
    expect((await w.call(placementHandler, "PATCH", { body: { test_id: "no-such", placement: "inbox" } })).statusCode).toBe(404);
  });
});

describe.skipIf(!opensslAvailable())("a placement test against a mail server", () => {
  let server: MailServer;
  beforeAll(async () => {
    server = await startMailServer({ route: (message) => (message.to.startsWith("junk") ? "Spam" : "INBOX") });
  });
  afterAll(async () => { await server?.stop(); });

  it("is sent to every seed and found where each server put it", async () => {
    const w = workspace();
    const local = (address: string) => {
      server.addUser(address, "pw");
      return w.mailbox(address, { smtp_host: "localhost", smtp_port: server.smtpPort, smtp_secure: 0, imap_host: "localhost", imap_port: server.imapPort, password: encryptSecret("pw"), allow_self_signed: 1 });
    };
    const from = local("from@real.test");
    local("good@real.test");
    local("junk@real.test");
    addSeed(db(), w.ws, { email: "good@real.test" });
    addSeed(db(), w.ws, { email: "junk@real.test" });

    const started = await w.call(placementHandler, "POST", { body: { email_account_id: from } });
    expect(started.statusCode).toBe(201);
    const run = started.body.run as { id: string; tests: Array<{ status: string }> };
    expect(run.tests.map((test) => test.status)).toEqual(["sent", "sent"]);
    expect(server.received.map((message) => [message.to, message.folder, message.subject])).toEqual([
      ["good@real.test", "INBOX", `Placement check ${run.id.slice(0, 8)}`], ["junk@real.test", "Spam", `Placement check ${run.id.slice(0, 8)}`],
    ]);

    const looked = await w.call(placementHandler, "PUT", { body: { run_id: run.id } });
    expect((looked.body.run as { tests: unknown[] }).tests).toMatchObject([
      { seed_email: "good@real.test", status: "checked", placement: "inbox", folder: "INBOX", auth: { spf: "pass", dkim: "pass", dmarc: "pass" } },
      { seed_email: "junk@real.test", status: "checked", placement: "spam", folder: "Spam" },
    ]);
    const overview = deliverabilityOverview(db(), w.ws, { domain: "real.test" });
    expect(overview.domain?.figures.placement).toMatchObject({ sent: 2, checked: 2, inbox: 1, spam: 1, inbox_rate: 0.5 });
    expect(overview.domain?.placement_runs[0].id).toBe(run.id);
    expect(overview.guard.events[0]).toMatchObject({ kind: "placement_test", title: "Placement test from from@real.test: 1 of 2 in the inbox" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the overview the Deliverability screen reads", () => {
  it("has a tab for each sending domain and the figures of the one asked for", async () => {
    const w = workspace();
    const [a1, a2] = [w.mailbox("mia@big.test", { daily_email_limit: 60 }), w.mailbox("ravi@big.test", { daily_email_limit: 40, ramp_up_enabled: 1, ramp_start_date: new Date().toISOString().slice(0, 10), ramp_days: 21, ramp_start_limit: 12 })];
    const b1 = w.mailbox("hello@small.test");
    history(w, a1, 200, 2, 0);
    history(w, a2, 50, 1, 1);
    history(w, b1, 10);
    for (let i = 0; i < 30; i++) db().prepare("INSERT INTO step_sends (id, workspace_id, channel, action, email_account_id, sent_at) VALUES (?, ?, 'email', 'email', ?, datetime('now', ?))").run(`dlv-ss-${++seq}`, w.ws, i < 20 ? a1 : b1, `-${i} days`);
    await checkDomainDeliverability({ workspaceId: w.ws, domain: "big.test", resolver: resolver("big.test", SOUND) });
    for (const id of [a1, a2]) db().prepare("INSERT INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate) VALUES (?, ?, 1, 10, 60)").run(id, w.ws);
    db().prepare("INSERT INTO warmup_messages (id, workspace_id, from_account_id, to_account_id, subject, body, status, scheduled_at, sent_at, replied_at, rescued_at) VALUES (?, ?, ?, ?, 's', 'b', 'sent', datetime('now'), datetime('now'), datetime('now'), datetime('now'))").run(`dlv-wm-${++seq}`, w.ws, a1, a2);
    db().prepare("INSERT INTO warmup_messages (id, workspace_id, from_account_id, to_account_id, subject, body, status, scheduled_at, sent_at) VALUES (?, ?, ?, ?, 's', 'b', 'sent', datetime('now'), datetime('now', '-10 days'))").run(`dlv-wm-${++seq}`, w.ws, a1, a2);

    const res = await w.call(overviewHandler, "GET", { role: "viewer" });
    const data = res.body as unknown as ReturnType<typeof deliverabilityOverview>;
    expect(data.domains).toEqual([{ domain: "big.test", mailboxes: 2, score: expect.any(Number) }, { domain: "small.test", mailboxes: 1, score: null }]);
    expect(data.range).toBe(30);
    expect(data.domain).toMatchObject({
      domain: "big.test",
      figures: { sent: 20, capacity_share: 20 / (100 * 30), sent_all: 250, bounces: 3, bounce_rate: 3 / 250, complaints: 1, complaint_rate: 1 / 250, placement: { sent: 0, inbox_rate: null } },
      warmup: { in_pool: 2, sent_week: 1, replied_week: 1, rescued_week: 1, ramping: { from_email: "ravi@big.test", day: 1, days: 21, limit: 12, limit_full: 40 } },
    });
    expect(data.domain!.mailboxes.map((mailbox) => mailbox.from_email)).toEqual(["mia@big.test", "ravi@big.test"]);
    // SPF, DKIM and MX sound, DMARC p=none: 92. Less 6 for 1.2% bounced, and all 10 for 0.4% reported as spam.
    expect(data.domain!.dns).toMatchObject({ dkim_selector: "google", dkim_selector_set: null, records: { spf: { status: "pass" }, dmarc: { status: "weak", value: "v=DMARC1; p=none; rua=mailto:d@x.test" }, mx: { value: "10 · mx.big.test" } } });
    expect(data.domain!.dns.score).toMatchObject({ score: 76, band: "fair", headline: "Fair, three fixes available" });
    expect(JSON.stringify(data)).not.toMatch(/"password"|stored-secret/);

    const small = (await w.call(overviewHandler, "GET", { query: { domain: "SMALL.test", range: "7" } })).body as unknown as ReturnType<typeof deliverabilityOverview>;
    // Its ten campaign emails were all sent more than a week ago.
    expect(small).toMatchObject({ range: 7, domain: { domain: "small.test", figures: { sent: 0, sent_all: 10 }, dns: { checked_at: null, records: null, score: null }, warmup: { in_pool: 0, ramping: null } } });
    // A domain nobody sends from is not shown; the first one is.
    expect(((await w.call(overviewHandler, "GET", { query: { domain: "stranger.test", range: "45" } })).body as unknown as ReturnType<typeof deliverabilityOverview>)).toMatchObject({ range: 30, domain: { domain: "big.test" } });
    expect((await workspace().call(overviewHandler, "GET")).body).toMatchObject({ domains: [], domain: null, seeds: [], do_not_contact: { total: 0, blocked_30d: 0 } });
  });

  it("reads a check kept in the older shape without inventing what it did not record", () => {
    const w = workspace();
    w.mailbox("mia@older.test");
    db().prepare("INSERT INTO deliverability_checks (id, workspace_id, domain, spf_status, dkim_status, dmarc_status, mx_status, score, details_json) VALUES (?, ?, 'older.test', 'pass', 'fail', 'pass', 'pass', 65, ?)")
      .run(`dlv-chk-${++seq}`, w.ws, JSON.stringify({ spf: { ok: true, records: ["v=spf1 a ~all"] }, dkim: { ok: false, records: [], selectors_checked: ["default"] }, dmarc: { ok: true, records: ["v=DMARC1; p=none"] }, mx: { ok: true, records: [{ exchange: "mx.older.test", priority: 5 }] } }));
    expect(domainDns(db(), w.ws, "older.test")).toMatchObject({
      dkim_selector: null,
      records: { spf: { status: "pass", value: "v=spf1 a ~all", note: null }, dkim: { status: "fail", value: null }, dmarc: { status: "pass", value: "v=DMARC1; p=none" }, mx: { status: "pass", value: null } },
      score: { score: 75 },
    });
  });

  it("counts the do-not-contact list by kind, and the sends it stopped in 30 days", async () => {
    const w = workspace();
    const add = (kind: string, value: string, reason = "manual", source: string | null = "manual") => db().prepare("INSERT INTO suppressions (id, workspace_id, kind, value, reason, source) VALUES (?, ?, ?, ?, ?, ?)").run(`dlv-sup-${++seq}`, w.ws, kind, value, reason, source);
    add("email", "a@x.test"); add("email", "b@x.test", "unsubscribed", "reply"); add("email", "c@x.test", "bounced", "bounce");
    add("domain", "competitor.test"); add("linkedin", "https://www.linkedin.com/in/someone/"); add("phone", "+441234567890");
    const mailbox = w.mailbox("s@dnc.test");
    db().prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'C', ?)").run(`${w.ws}-wf`, w.ws);
    db().prepare("INSERT INTO runs (id, workflow_id, status, workspace_id) VALUES (?, ?, 'running', ?)").run(`${w.ws}-run`, `${w.ws}-wf`, w.ws);
    const log = (message: string, when = "+0 seconds") => db().prepare("INSERT INTO logs (id, run_id, level, message, created_at) VALUES (?, ?, 'warn', ?, datetime('now', ?))").run(`dlv-log-${++seq}`, `${w.ws}-run`, message, when);
    log("Lee Lead is suppressed (Recipient is suppressed: manual) — unenrolling email track");
    log("Ada is suppressed (Recipient is suppressed: unsubscribed) — unenrolling email track");
    log("Old Timer is suppressed (Recipient is suppressed: manual) — unenrolling email track", "-40 days");
    log("Email sent to Lee Lead");
    db().prepare("INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, source, recipient, subject, body_text, status, last_error) VALUES (?, ?, ?, ?, 'test', 'a@x.test', 's', 'b', 'failed', 'Recipient is suppressed: manual')").run(`dlv-job-${++seq}`, w.ws, mailbox, `dlv-job-${seq}`);
    db().prepare("INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, source, recipient, subject, body_text, status, last_error) VALUES (?, ?, ?, ?, 'test', 'z@x.test', 's', 'b', 'failed', '550 mailbox unavailable')").run(`dlv-job-${++seq}`, w.ws, mailbox, `dlv-job-${seq}`);

    expect(doNotContact(db(), w.ws)).toEqual({ counts: { email: 3, domain: 1, linkedin: 1, phone: 1 }, total: 6, blocked_30d: 3 });

    // The manager reads the list a page at a time, with what a member may not remove marked.
    const page = (await w.call(suppressionsHandler, "GET", { role: "viewer", query: { view: "page", limit: "2" } })).body as { rows: Array<{ value: string; protected: boolean }>; total: number };
    expect(page.total).toBe(6);
    expect(page.rows).toHaveLength(2);
    const emails = (await w.call(suppressionsHandler, "GET", { query: { view: "page", kind: "email" } })).body as { rows: Array<{ value: string; protected: boolean }>; total: number };
    expect(emails.total).toBe(3);
    expect(Object.fromEntries(emails.rows.map((row) => [row.value, row.protected]))).toEqual({ "a@x.test": false, "b@x.test": true, "c@x.test": true });
    expect(((await w.call(suppressionsHandler, "GET", { query: { view: "page", q: "COMPET" } })).body as { total: number }).total).toBe(1);
    expect(((await w.call(suppressionsHandler, "GET", { query: { view: "page", limit: "2", offset: "4" } })).body as { rows: unknown[] }).rows).toHaveLength(2);
    // And the bare list is the array it always was.
    expect(Array.isArray((await w.call(suppressionsHandler, "GET")).body)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the deliverability routes", () => {
  it("re-check a domain's DNS and keep its selector, for an admin, for a domain the workspace sends from", async () => {
    const w = workspace();
    w.mailbox("mia@routes.test");
    expect((await w.call(dnsHandler, "POST", { role: "manager", body: { domain: "routes.test" } })).statusCode).toBe(403);
    expect((await w.call(dnsHandler, "POST", { body: { domain: "stranger.test" } })).statusCode).toBe(404);
    expect((await w.call(dnsHandler, "POST", { body: {} })).statusCode).toBe(404);
    expect((await w.call(dnsHandler, "POST", { body: { domain: "routes.test", selector: "bad selector" } })).statusCode).toBe(400);
    expect((await w.call(dnsHandler, "POST", { body: { domain: "routes.test", selector: 5 } })).statusCode).toBe(400);
    expect(db().prepare("SELECT COUNT(*) c FROM deliverability_checks WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
    expect(getDomainSelector(db(), w.ws, "routes.test")).toBeNull();
  });

  it("page through the guard log", async () => {
    const w = workspace();
    for (let i = 0; i < 4; i++) recordGuardEvent({ workspaceId: w.ws, kind: i % 2 ? "daily_limit" : "dns_change", title: `Event ${i}`, domain: "log.test", occurredAt: `2026-10-0${i + 1} 10:00:00` });
    const all = (await w.call(eventsHandler, "GET", { role: "viewer" })).body as { events: Array<{ title: string }>; total: number };
    expect(all.total).toBe(4);
    expect(all.events.map((event) => event.title)).toEqual(["Event 3", "Event 2", "Event 1", "Event 0"]);
    expect(((await w.call(eventsHandler, "GET", { query: { kind: "daily_limit" } })).body as { total: number }).total).toBe(2);
    expect(((await w.call(eventsHandler, "GET", { query: { kind: "nonsense", limit: "1", offset: "3" } })).body as { events: Array<{ title: string }> }).events.map((event) => event.title)).toEqual(["Event 0"]);
    expect(((await w.call(eventsHandler, "GET", { query: { domain: "other.test" } })).body as { total: number }).total).toBe(0);
    expect(((await workspace().call(eventsHandler, "GET")).body as { total: number }).total).toBe(0);
  });

  it("put a whole domain's mailboxes in the warm-up pool or take them out, keeping each one's own numbers", async () => {
    const w = workspace();
    const [a, b] = [w.mailbox("a@pool.test"), w.mailbox("b@pool.test")];
    const elsewhere = w.mailbox("c@elsewhere.test");
    db().prepare("INSERT INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate) VALUES (?, ?, 1, 17, 40)").run(a, w.ws);
    db().prepare("INSERT INTO warmup_settings (email_account_id, workspace_id, enabled, daily_target, reply_rate) VALUES (?, ?, 1, 9, 60)").run(elsewhere, w.ws);
    expect((await w.call(warmupHandler, "POST", { role: "manager", body: { domain: "pool.test", enabled: false } })).statusCode).toBe(403);
    expect((await w.call(warmupHandler, "POST", { body: { domain: "pool.test", enabled: "no" } })).statusCode).toBe(400);
    expect((await w.call(warmupHandler, "POST", { body: { domain: "stranger.test", enabled: false } })).statusCode).toBe(404);

    expect((await w.call(warmupHandler, "POST", { body: { domain: "pool.test", enabled: false } })).body).toEqual({ ok: true, mailboxes: 2, enabled: false });
    const settings = () => db().prepare("SELECT email_account_id AS id, enabled, daily_target, reply_rate FROM warmup_settings WHERE workspace_id = ? ORDER BY email_account_id").all(w.ws);
    expect(settings()).toEqual([{ id: a, enabled: 0, daily_target: 17, reply_rate: 40 }, { id: b, enabled: 0, daily_target: 5, reply_rate: 60 }, { id: elsewhere, enabled: 1, daily_target: 9, reply_rate: 60 }].sort((x, y) => x.id.localeCompare(y.id)));
    await w.call(warmupHandler, "POST", { body: { domain: "pool.test", enabled: true } });
    expect((settings() as Array<{ enabled: number }>).every((row) => row.enabled === 1)).toBe(true);
  });

  it("export the report as a CSV file, a row per mailbox", async () => {
    const w = workspace();
    const a = w.mailbox("mia@report.test", { daily_email_limit: 60 });
    w.mailbox("=cmd@other.test");
    history(w, a, 100, 2);
    await checkDomainDeliverability({ workspaceId: w.ws, domain: "report.test", resolver: resolver("report.test", SOUND) });

    const rows = deliverabilityReport(db(), w.ws, 30);
    expect(rows.map((row) => row.mailbox)).toEqual(["=cmd@other.test", "mia@report.test"]);
    expect(rows[1]).toMatchObject({ domain: "report.test", domain_score: 82, spf: "pass", dmarc: "weak", mailbox: "mia@report.test", status: "active", daily_limit: 60, emails_30d: 100, bounces_30d: 2, bounce_rate_30d_percent: 2, domain_bounce_rate_percent: 2 });
    expect(rows[0]).toMatchObject({ domain: "other.test", domain_score: null, spf: null, dns_checked_at: null });

    const res = await w.call(reportHandler, "GET", { role: "viewer", query: { domain: "report.test", range: "7" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["Content-Disposition"]).toMatch(/^attachment; filename="linki-deliverability-report.test-7d-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = res.text.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Domain,Domain score,SPF,DKIM,DMARC,MX,DNS checked,/);
    expect(lines[1]).toMatch(/^report\.test,82,pass,pass,weak,pass,/);
    // Every domain, and a cell that would run as a formula is written as text.
    const all = await w.call(reportHandler, "GET", { role: "viewer" });
    expect(all.text).toContain("'=cmd@other.test");
    expect(db().prepare("SELECT COUNT(*) c FROM audit_logs WHERE workspace_id = ? AND action = 'export.created'").get(w.ws)).toEqual({ c: 2 });
    expect((await w.call(reportHandler, "POST")).statusCode).toBe(405);
  });
});
