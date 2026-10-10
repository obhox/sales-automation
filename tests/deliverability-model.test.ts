// How the Deliverability screen words what it is given. Pure functions, no database.
import { describe, expect, it } from "vitest";
import {
  EVENT_KIND_LABEL, MANUAL_PLACEMENTS, STATUS_FILTERS, blockedLine, canSendTest, checkedLine, eventTime, eventWhen, figures, healthSubtitle, placementBadge, placementNote,
  rampCell, rampNote, recordRows, runIsLooking, runLine, scorePill, scoreSummary, suppressionMeta, warmupSubtitle,
  type DnsRecordView, type DomainDeliverability, type DomainDnsDetail, type PlacementRun, type PlacementSummary, type PlacementTest,
} from "@/components/deliverability/model";
import type { MailboxView } from "@/components/mailboxes/model";
import { GUARD_EVENT_KINDS } from "@/lib/email/guard-events";

const NOW = new Date("2026-10-10T12:00:00Z");
const pad = (value: number) => String(value).padStart(2, "0");
/** The same instant as the reader's own clock shows it, so the test passes in any time zone. */
const clock = (iso: string) => { const date = new Date(iso); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const OCT_4 = day("2026-10-04T12:00:00Z");

function box(fields: Partial<MailboxView> = {}): MailboxView {
  return {
    id: "m1", name: "Mia Chen", from_email: "mia@acme.test", from_name: "Mia Chen", reply_to: null, domain: "acme.test",
    provider: { key: "google", label: "Gmail", method: "App password" }, status: "active", held: null, reads_replies: true,
    schedule: { start: 8, end: 18, days: "1,2,3,4,5", timezone: "Europe/Berlin" },
    sending: { sent_today: 52, limit_today: 60, limit_full: 60 },
    ramp: { day: 14, days: 14, limit: 60, complete: true, start_date: "2026-09-27", custom_days: 14, start_limit: 10 }, ramp_enabled: true,
    warmup: { state: "warmed", enabled: true, daily_target: 10, reply_rate: 60, sent_today: 3, sent_week: 0, rescued_week: 0, peers: 180 },
    reputation: { score: 96, band: "good", losses: [] },
    health: { sent: 500, bounces: 4, complaints: 0, bounce_rate: 0.008, complaint_rate: 0, over_guard: false },
    guard: { bounce_threshold: 0.03, complaint_threshold: 0.001, min_health_sample: 50 },
    signature: null, signature_first_only: false,
    connection: { smtp_host: "smtp.gmail.com", smtp_port: 587, smtp_secure: false, imap_host: "imap.gmail.com", imap_port: 993, username: "mia@acme.test", imap_username: null, allow_self_signed: false },
    active_campaigns: 2, last_test: null, created_at: "2026-06-04 09:00:00",
    ...fields,
  };
}

const summary = (fields: Partial<PlacementSummary> = {}): PlacementSummary => ({ sent: 0, checked: 0, inbox: 0, tabs: 0, spam: 0, missing: 0, waiting: 0, inbox_rate: null, ...fields });
const record = (fields: Partial<DnsRecordView> = {}): DnsRecordView => ({ status: "pass", value: null, note: null, lookup_failed: false, ...fields });

function dns(fields: Partial<DomainDnsDetail> = {}): DomainDnsDetail {
  return {
    checked_at: "2026-10-10 12:00:00", dkim_selector: "google", dkim_selector_set: null, dkim_bits: 2048,
    records: {
      spf: record({ value: "v=spf1 include:_spf.google.com ~all" }), dkim: record({ value: "v=DKIM1; k=rsa; p=MIIB" }),
      dmarc: record({ status: "weak", value: "v=DMARC1; p=none; rua=mailto:dmarc@acme.test", note: "The policy is p=none, which only reports." }), mx: record({ value: "5 · aspmx.l.google.com (+1)" }),
    },
    score: { score: 86, band: "good", headline: "Good, one fix available", fixes: [{ key: "dmarc", score_after: 94, advice: "Moving DMARC from p=none to p=quarantine would raise acme.test to 94 and protect the domain from spoofing." }] },
    ...fields,
  };
}

function domain(fields: Partial<DomainDeliverability["figures"]> = {}, rest: Partial<DomainDeliverability> = {}): DomainDeliverability {
  return {
    domain: "acme.test",
    figures: { sent: 38_204, capacity_share: 0.82, sent_all: 40_000, bounces: 496, bounce_rate: 0.0124, complaints: 12, complaint_rate: 0.0003, placement: summary({ sent: 24, checked: 24, inbox: 22, spam: 2, inbox_rate: 22 / 24 }), ...fields },
    mailboxes: [box()], dns: dns(),
    warmup: { in_pool: 1, sent_week: 412, replied_week: 398, rescued_week: 9, ramping: null },
    placement_runs: [],
    ...rest,
  };
}

const test = (fields: Partial<PlacementTest> = {}): PlacementTest => ({ id: "t1", seed_email: "seed@acme.test", status: "checked", placement: "inbox", folder: "INBOX", auth: null, readable: true, error: null, sent_at: "2026-10-10 10:00:00", checked_at: "2026-10-10 10:01:00", ...fields });
const run = (tests: PlacementTest[], fields: Partial<PlacementRun> = {}): PlacementRun => ({ id: "r1", domain: "acme.test", mailbox: { id: "m1", from_email: "mia@acme.test" }, created_at: "2026-10-10 10:00:00", tests, ...fields });

describe("the four figures", () => {
  it("reads as the design does when a domain is healthy", () => {
    expect(figures(domain(), 30).map((figure) => [figure.label, figure.value, figure.note, figure.tone])).toEqual([
      ["Emails sent (30d)", "38,204", "82% of capacity", "muted"],
      ["Bounce rate", "1.24%", "Healthy · under 2.0%", "good"],
      ["Spam complaints", "0.03%", "Healthy · under 0.10%", "good"],
      ["Inbox placement", "92%", "2 of 24 seeds in spam", "warn"],
    ]);
    expect(figures(domain(), 7)[0].label).toBe("Emails sent (7d)");
  });

  it("grades the bounce rate at 2% and 3%, and complaints at 0.1%", () => {
    const of = (fields: Partial<DomainDeliverability["figures"]>) => figures(domain(fields), 30);
    expect(of({ bounce_rate: 0.0281 })[1]).toMatchObject({ note: "Watch · 2.0% or more", tone: "warn" });
    expect(of({ bounce_rate: 0.03 })[1]).toMatchObject({ note: "High · 3.0% or more", tone: "bad" });
    expect(of({ complaints: 5, complaint_rate: 0.001 })[2]).toMatchObject({ note: "High · 0.10% or more", tone: "bad" });
  });

  it("does not call zero complaints healthy, since most providers report none", () => {
    const figure = figures(domain({ complaints: 0, complaint_rate: 0 }), 30)[2];
    expect(figure).toMatchObject({ value: "0.00%", note: "None reported", tone: "muted" });
    expect(figure.why).toMatch(/zero means none were reported/);
  });

  it("shows a dash, not a zero, where there is nothing to measure", () => {
    const empty = figures(domain({ sent: 0, capacity_share: null, sent_all: 0, bounce_rate: null, complaint_rate: null, complaints: 0, placement: summary() }), 30);
    expect(empty.map((figure) => [figure.value, figure.note])).toEqual([
      ["0", "No mailbox on this domain can send"], ["—", "No emails sent in this period"], ["—", "No emails sent in this period"], ["—", "No placement test in this period"],
    ]);
    // The rates are out of every email, and the sent figure is campaign emails only: the hover says which.
    expect(figures(domain(), 30)[0].why).toMatch(/Campaign emails/);
    expect(figures(domain(), 30)[1].why).toMatch(/40,000 emails of every kind/);
  });

  it("says what a placement test found, spam first", () => {
    expect(placementNote(summary({ sent: 3, waiting: 3 }))).toEqual({ text: "3 copies still to be found", tone: "muted" });
    expect(placementNote(summary({ sent: 1, waiting: 1 })).text).toBe("1 copy still to be found");
    expect(placementNote(summary({ checked: 6, inbox: 4, spam: 1, missing: 1 }))).toEqual({ text: "1 of 6 seeds in spam", tone: "warn" });
    expect(placementNote(summary({ checked: 6, inbox: 5, missing: 1 }))).toEqual({ text: "1 of 6 seeds not found", tone: "warn" });
    expect(placementNote(summary({ checked: 6, inbox: 6 }))).toEqual({ text: "6 of 6 seeds in the inbox", tone: "good" });
    // A copy under a Gmail tab is delivered, but it is not the inbox.
    expect(placementNote(summary({ checked: 6, inbox: 5, tabs: 1 }))).toEqual({ text: "5 of 6 seeds in the inbox", tone: "muted" });
  });
});

describe("the mailbox table", () => {
  it("counts the mailboxes and the ones that are held, and names the rotation", () => {
    const settings = { rotation: "round_robin" as const, failover: false, shared_pool: false };
    expect(healthSubtitle([box()], settings)).toBe("1 mailbox · rotation in turn, by company");
    expect(healthSubtitle([box(), box({ status: "auto_paused" }), box({ status: "paused" }), box({ status: "disconnected" })], { ...settings, rotation: "capacity" }))
      .toBe("4 mailboxes · 1 auto-paused · 1 paused · 1 disconnected · rotation by capacity, by company");
  });

  it("says where each mailbox's ramp is", () => {
    expect(rampCell(box())).toEqual({ text: "Complete", share: 1 });
    expect(rampCell(box({ ramp: { day: 3, days: 21, limit: 12, complete: false, start_date: "2026-10-08", custom_days: 21, start_limit: 5 } }))).toEqual({ text: "Day 3 of 21", share: 3 / 21 });
    expect(rampCell(box({ status: "auto_paused", ramp: { day: 7, days: 14, limit: 30, complete: false, start_date: "2026-10-04", custom_days: 14, start_limit: 5 } }))).toEqual({ text: "Paused", share: 0.5 });
    expect(rampCell(box({ status: "disconnected" }))).toEqual({ text: "Stopped", share: 0 });
    expect(rampCell(box({ ramp: null }))).toEqual({ text: "No ramp", share: 1 });
    expect(rampCell(box({ ramp: null, warmup: { ...box().warmup, enabled: false } }))).toEqual({ text: "Off", share: 0 });
  });

  it("offers every state a mailbox can be in as a filter, in the words the Mailboxes screen uses", () => {
    expect(STATUS_FILTERS.map((filter) => filter.label)).toEqual(["All statuses", "Active", "At limit", "Auto-paused", "Paused", "Disconnected", "Not tested"]);
  });

  it("lets a test be sent only from a mailbox that can send", () => {
    expect((["active", "at_limit", "auto_paused", "paused", "disconnected", "untested"] as const).filter((status) => canSendTest(box({ status })))).toEqual(["active", "at_limit"]);
  });
});

describe("the guard log", () => {
  it("has a name for every kind of event that is recorded", () => {
    expect(Object.keys(EVENT_KIND_LABEL).sort()).toEqual([...GUARD_EVENT_KINDS].sort());
  });

  it("gives the time for today and the date for any other day, in the reader's own time", () => {
    expect(eventTime("2026-10-10 12:00:00", NOW)).toBe(clock("2026-10-10T12:00:00Z"));
    expect(eventTime("2026-10-04 12:00:00", NOW)).toBe(OCT_4);
    expect(eventWhen("2026-10-04 12:00:00", NOW)).toBe(`${OCT_4} · ${clock("2026-10-04T12:00:00Z")}`);
    expect(eventTime("not a time", NOW)).toBe("—");
  });
});

describe("domain authentication", () => {
  it("lists the four records with what is published and how it was judged", () => {
    expect(recordRows(dns()).map((row) => [row.name, row.value, row.badge.label])).toEqual([
      ["SPF", "v=spf1 include:_spf.google.com ~all", "Pass"],
      ["DKIM", "google._domainkey · 2048-bit", "Pass"],
      ["DMARC", "p=none; rua=mailto:dmarc@acme.test", "Weak"],
      ["MX", "5 · aspmx.l.google.com (+1)", "Pass"],
    ]);
    expect(recordRows(dns())[2].note).toMatch(/only reports/);
  });

  it("tells a record that is missing from one that could not be looked up", () => {
    const missing = record({ status: "fail" });
    const unknown = record({ status: "fail", lookup_failed: true });
    const rows = recordRows(dns({ dkim_selector: null, dkim_bits: null, records: { spf: missing, dkim: missing, dmarc: unknown, mx: unknown } }));
    expect(rows.map((row) => [row.value, row.badge.label, row.badge.tone])).toEqual([
      ["No record", "Missing", "bad"], ["No key found", "Missing", "bad"], ["The lookup got no answer", "Not known", "neutral"], ["The lookup got no answer", "Not known", "neutral"],
    ]);
    expect(recordRows(dns({ records: null }))).toEqual([]);
  });

  it("shortens a long record so the row stays on one line", () => {
    const long = `v=spf1 ${Array.from({ length: 8 }, (_, index) => `include:spf${index}.example.test`).join(" ")} ~all`;
    const value = recordRows(dns({ records: { ...dns().records!, spf: record({ value: long }) } }))[0].value;
    expect(value).toHaveLength(46);
    expect(value.endsWith("…")).toBe(true);
  });

  it("leads with the fix that gains most, and says so when there is nothing to fix or nothing known", () => {
    expect(scoreSummary("acme.test", dns())).toEqual({ headline: "Good, one fix available", body: "Moving DMARC from p=none to p=quarantine would raise acme.test to 94 and protect the domain from spoofing." });
    expect(scoreSummary("acme.test", dns({ score: { score: 100, band: "good", headline: "Good, nothing to fix", fixes: [] } })).body).toBe("SPF, DKIM, DMARC and MX are in place for acme.test, and its mail is being accepted.");
    expect(scoreSummary("acme.test", dns({ checked_at: null, records: null, score: null }))).toEqual({ headline: "Not checked yet", body: "Nothing is known about acme.test's DNS records. Check them to see what receiving servers see." });
  });

  it("colours the score at 80 and 60", () => {
    expect(scorePill(86)).toEqual({ tone: "good", label: "Domain score 86" });
    expect(scorePill(80)?.tone).toBe("good");
    expect(scorePill(79)?.tone).toBe("warn");
    expect(scorePill(59)?.tone).toBe("bad");
    expect(scorePill(null)).toBeNull();
  });

  it("says when the records were last looked at", () => {
    expect(checkedLine(dns(), NOW)).toBe(`DNS last checked ${clock("2026-10-10T12:00:00Z")}`);
    expect(checkedLine(dns({ checked_at: "2026-10-04 12:00:00" }), NOW)).toBe(`DNS last checked ${OCT_4}`);
    expect(checkedLine(dns({ checked_at: null }), NOW)).toBe("DNS not checked yet");
  });
});

describe("warm-up and the do-not-contact list", () => {
  it("counts the domain's mailboxes in the pool", () => {
    expect(warmupSubtitle(domain({}, { mailboxes: [box(), box({ id: "m2" })], warmup: { in_pool: 1, sent_week: 0, replied_week: 0, rescued_week: 0, ramping: null } }))).toBe("1 of 2 mailboxes in the warm-up pool");
    expect(warmupSubtitle(domain())).toBe("1 of 1 mailbox in the warm-up pool");
  });

  it("says where the least-ramped mailbox is and where its limit is going", () => {
    expect(rampNote({ from_email: "team@acme.test", day: 3, days: 21, limit: 12, limit_full: 40 })).toBe("team@acme.test is on day 3 of its ramp. Its daily limit rises from 12 to 40 over the next 18 days.");
    expect(rampNote({ from_email: "team@acme.test", day: 20, days: 21, limit: 38, limit_full: 40 })).toMatch(/over the next 1 day\.$/);
    expect(rampNote(null)).toBeNull();
  });

  it("counts the sends the list stopped", () => {
    const counts = { email: 0, domain: 0, linkedin: 0, phone: 0 };
    expect(blockedLine({ counts, total: 0, blocked_30d: 1420 })).toBe("1,420 sends blocked in the last 30 days");
    expect(blockedLine({ counts, total: 0, blocked_30d: 1 })).toBe("1 send blocked in the last 30 days");
  });

  it("says why an entry is on the list and since when", () => {
    const row = { id: "s1", kind: "email" as const, value: "a@b.test", source: null, created_at: "2026-10-04 12:00:00", protected: false };
    expect(suppressionMeta({ ...row, reason: "manual" }, NOW)).toBe(`Added by hand · ${OCT_4}`);
    expect(suppressionMeta({ ...row, reason: "unsubscribed" }, NOW)).toBe(`Unsubscribed · ${OCT_4}`);
    expect(suppressionMeta({ ...row, reason: "hard_bounce" }, NOW)).toBe(`Bounced · ${OCT_4}`);
    expect(suppressionMeta({ ...row, reason: "legal hold" }, NOW)).toBe(`Legal hold · ${OCT_4}`);
  });
});

describe("a placement test", () => {
  it("names where each copy landed", () => {
    expect(placementBadge(test())).toEqual({ tone: "good", label: "Inbox" });
    expect(placementBadge(test({ placement: "primary" }))).toEqual({ tone: "good", label: "Primary tab" });
    expect(placementBadge(test({ placement: "promotions" }))).toEqual({ tone: "warn", label: "Promotions tab" });
    expect(placementBadge(test({ placement: "spam" }))).toEqual({ tone: "bad", label: "Spam" });
    expect(placementBadge(test({ placement: "missing" }))).toEqual({ tone: "warn", label: "Not found" });
    // A filter's folder is named as the mailbox names it.
    expect(placementBadge(test({ placement: "other", folder: "Vendors" }))).toEqual({ tone: "warn", label: "Vendors" });
    expect(placementBadge(test({ placement: "other", folder: null })).label).toBe("Another folder");
  });

  it("says what a copy without a result is waiting for", () => {
    expect(placementBadge(test({ status: "sent", placement: null }))).toEqual({ tone: "brand", label: "Looking" });
    expect(placementBadge(test({ status: "sent", placement: null, readable: false }))).toEqual({ tone: "neutral", label: "Enter result" });
    expect(placementBadge(test({ status: "failed", placement: null, error: "550 No such user" }))).toEqual({ tone: "bad", label: "Not sent" });
  });

  it("sums a run up in a line, leaving out copies that were never sent", () => {
    const tests = [test(), test({ id: "t2", placement: "spam" }), test({ id: "t3", status: "sent", placement: null }), test({ id: "t4", status: "failed", placement: null })];
    expect(runLine(run(tests), NOW)).toBe("from mia@acme.test · 2 h ago · 1 of 2 in the inbox");
    expect(runLine(run([test({ status: "sent", placement: null })]), NOW)).toBe("from mia@acme.test · 2 h ago · no results yet");
    expect(runLine(run([test()], { mailbox: null }), NOW)).toBe("from a removed mailbox · 2 h ago · 1 of 1 in the inbox");
  });

  it("keeps looking only while a copy Linki can read has no result", () => {
    expect(runIsLooking(run([test(), test({ status: "sent", placement: null })]))).toBe(true);
    expect(runIsLooking(run([test(), test({ status: "sent", placement: null, readable: false })]))).toBe(false);
    expect(runIsLooking(run([test(), test({ status: "failed", placement: null })]))).toBe(false);
  });

  it("offers by hand only what a person looking in a mailbox can tell", () => {
    expect(MANUAL_PLACEMENTS).toEqual(["inbox", "promotions", "spam", "missing"]);
  });
});
