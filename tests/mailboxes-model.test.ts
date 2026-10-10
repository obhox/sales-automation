// How the Mailboxes screen words what it is given. Pure functions, no database.
import { describe, expect, it } from "vitest";
import {
  authLine, bounceLine, dnsBadges, domainMeta, inAbout, limitLine, metaLine, pauseConsequence, queueSub, rampLine, reputationLabel, reputationSpoken, resumeConsequence,
  signatureLines, statusBadge, testResult, totals, warmupBadge, warmupDetailBadge, warmupSub, windowLabel,
  type DomainView, type MailboxQueue, type MailboxView, type TestSend,
} from "@/components/mailboxes/model";

const NOW = new Date("2026-10-10T12:00:00Z");

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
    signature: "Mia Chen\nSenior Account Executive · Acme\nacme.test", signature_first_only: true,
    connection: { smtp_host: "smtp.gmail.com", smtp_port: 587, smtp_secure: false, imap_host: "imap.gmail.com", imap_port: 993, username: "mia@acme.test", imap_username: null, allow_self_signed: false },
    active_campaigns: 2, last_test: null, created_at: "2026-06-04 09:00:00",
    ...fields,
  };
}

const domain = (mailboxes: MailboxView[], dns: Partial<DomainView["dns"]> = {}): DomainView => ({ domain: "acme.test", dns: { spf: "pass", dkim: "pass", dmarc: "weak", mx: "pass", checked_at: "2026-10-10 04:00:00", ...dns }, mailboxes });

describe("a mailbox's row", () => {
  it("says who runs it, how it signs in and when it sends", () => {
    expect(metaLine(box())).toBe("Gmail · App password · 08:00–18:00 · Europe/Berlin");
    expect(windowLabel(box({ schedule: { start: 0, end: 24, days: "1,2,3,4,5,6,7", timezone: "UTC" } }))).toBe("All day");
  });

  it("names its state in one word", () => {
    expect(statusBadge(box())).toEqual({ tone: "good", label: "Active" });
    expect(statusBadge(box({ status: "at_limit" }))).toEqual({ tone: "warn", label: "At limit" });
    expect(statusBadge(box({ status: "auto_paused" }))).toEqual({ tone: "bad", label: "Auto-paused" });
    expect(statusBadge(box({ status: "paused" }))).toEqual({ tone: "warn", label: "Paused" });
    expect(statusBadge(box({ status: "disconnected" }))).toEqual({ tone: "bad", label: "Disconnected" });
    expect(statusBadge(box({ status: "untested" }))).toEqual({ tone: "neutral", label: "Not tested" });
  });

  it("shows today's sends against today's limit, amber at the limit and grey when nothing can go", () => {
    expect(limitLine(box())).toEqual({ text: "52 / 60 today", tone: "ink", meter: "mail" });
    expect(limitLine(box({ sending: { sent_today: 60, limit_today: 60, limit_full: 60 } }))).toMatchObject({ tone: "warn", meter: "warn" });
    expect(limitLine(box({ status: "auto_paused", sending: { sent_today: 0, limit_today: 30, limit_full: 30 } }))).toEqual({ text: "0 / 30 today", tone: "muted", meter: "neutral" });
  });

  it("says where the ramp is, or why nothing is going out", () => {
    expect(rampLine(box(), NOW)).toEqual({ text: "Ramp complete · day 14 of 14", bad: false });
    expect(rampLine(box({ ramp: { day: 9, days: 21, limit: 27, complete: false, start_date: "2026-10-02", custom_days: 21, start_limit: 5 } }), NOW).text).toBe("Ramping · day 9 of 21");
    expect(rampLine(box({ ramp: null }), NOW).text).toBe("No ramp · full limit");
    expect(rampLine(box({ status: "auto_paused", held: { at: "2026-10-10 10:00:00", reason: "Auto-paused: x" } }), NOW)).toEqual({ text: "Sending stopped 2 h ago", bad: true });
    expect(rampLine(box({ status: "disconnected", held: { at: "2026-10-10 09:00:00", reason: "Refused" } }), NOW)).toEqual({ text: "Sign-in refused 3 h ago", bad: true });
    expect(rampLine(box({ status: "paused", held: { at: "2026-10-10 11:56:00", reason: "Manually paused" } }), NOW)).toEqual({ text: "Paused 4 min ago", bad: false });
  });

  it("describes warm-up", () => {
    expect(warmupBadge(box())).toEqual({ tone: "good", label: "Warmed" });
    expect(warmupSub(box())).toBe("pool of 180 peers");
    const warming = box({ warmup: { ...box().warmup, state: "warming", sent_week: 41, rescued_week: 2 } });
    expect(warmupBadge(warming)).toEqual({ tone: "brand", label: "Warming up" });
    expect(warmupSub(warming)).toBe("41 sent · 2 rescued");
    expect(warmupSub(box({ warmup: { ...box().warmup, state: "paused" } }))).toBe("warm-up halted");
    expect(warmupSub(box({ warmup: { ...box().warmup, state: "off", enabled: false } }))).toBe("not in the pool");
    expect(warmupSub(box({ warmup: { ...box().warmup, peers: 0 } }))).toBe("no peers yet");
    expect(warmupDetailBadge(box()).label).toBe("Warmed · 14 of 14");
    expect(warmupDetailBadge(box({ warmup: { ...box().warmup, state: "off", enabled: false } })).label).toBe("Warm-up off");
    expect(warmupDetailBadge(box({ warmup: { ...box().warmup, state: "stopped" } })).label).toBe("Warm-up stopped");
  });

  it("gives the reputation and the bounce rate, and a dash where there is none", () => {
    expect(reputationLabel(box())).toBe("Rep 96");
    expect(reputationSpoken(box())).toBe("Reputation 96 out of 100");
    expect(reputationLabel(box({ reputation: null }))).toBe("Rep —");
    expect(bounceLine(box())).toEqual({ text: "0.8% bounce", bad: false });
    expect(bounceLine(box({ health: { ...box().health, bounce_rate: 0.048 } }))).toEqual({ text: "4.8% bounce", bad: true });
    expect(bounceLine(box({ health: { ...box().health, bounce_rate: null } }))).toEqual({ text: "— bounce", bad: false });
  });
});

describe("a domain's header", () => {
  it("colours each record by its state, grey when it was never checked", () => {
    expect(dnsBadges(domain([])).map((badge) => [badge.label, badge.tone])).toEqual([["SPF", "good"], ["DKIM", "good"], ["DMARC", "warn"]]);
    expect(dnsBadges(domain([], { spf: "fail", dkim: null, dmarc: null })).map((badge) => badge.tone)).toEqual(["bad", "neutral", "neutral"]);
    expect(dnsBadges(domain([]))[2].title).toBe("DMARC is in place but weak");
  });

  it("counts today's sends against what its sending mailboxes may send", () => {
    const paused = box({ id: "m2", status: "auto_paused", sending: { sent_today: 0, limit_today: 30, limit_full: 30 } });
    expect(domainMeta(domain([box(), paused]))).toBe("2 mailboxes · 52 of 60 sent today");
    expect(domainMeta(domain([box()]))).toBe("1 mailbox · 52 of 60 sent today");
  });
});

describe("the four figures", () => {
  it("add up the mailboxes that can send, and say what needs someone", () => {
    const low = box({ id: "m2", reputation: { score: 72, band: "poor", losses: [] }, sending: { sent_today: 24, limit_today: 80, limit_full: 80 }, health: { ...box().health, sent: 500, bounces: 9 } });
    const paused = box({ id: "m3", status: "auto_paused", sending: { sent_today: 0, limit_today: 30, limit_full: 30 }, reputation: { score: 88, band: "fair", losses: [] } });
    const gone = box({ id: "m4", status: "disconnected", reputation: null, sending: { sent_today: 0, limit_today: 25, limit_full: 25 }, health: { sent: 0, bounces: 0, complaints: 0, bounce_rate: null, complaint_rate: null, over_guard: false } });
    const figures = totals([domain([box(), low]), { ...domain([paused, gone]), domain: "getacme.test" }]);
    expect(figures).toMatchObject({
      mailboxes: 4, mailboxesNote: "2 domains · 1 paused · 1 disconnected", mailboxesTone: "warn",
      capacity: 140, capacityNote: "76 sent today · 54% used",
      reputation: 85, reputationNote: "1 mailbox below 80", reputationTone: "warn",
      bounceNote: "healthy · under 2.0%", bounceTone: "good",
      problem: "1 auto-paused · 1 disconnected",
    });
    expect(figures.bounceRate).toBeCloseTo(17 / 1500);
  });

  it("have something true to say with no mailboxes at all", () => {
    expect(totals([])).toMatchObject({ mailboxes: 0, mailboxesNote: "None connected yet", capacity: 0, reputation: null, reputationNote: "Nothing to score yet", bounceRate: null, bounceNote: "No emails sent in 30 days", problem: null });
  });
});

describe("the last test send", () => {
  const test = (fields: Partial<TestSend>): TestSend => ({ id: "t1", email_account_id: "m1", recipient: "mia@acme.test", status: "found", readable: true, placement: "inbox", folder: "INBOX", auth: { spf: "pass", dkim: "pass", dmarc: "pass" }, sent_at: "2026-10-10 11:58:00", checked_at: "2026-10-10 11:58:30", ...fields });

  it("says where it landed and what the receiving server made of it", () => {
    expect(testResult(test({}), NOW)).toEqual({ tone: "good", looking: false, text: "Delivered to the inbox, sent 2 min ago · SPF, DKIM and DMARC passed" });
    expect(testResult(test({ placement: "primary" }), NOW).text).toMatch(/^Delivered to the Primary tab/);
    expect(testResult(test({ placement: "promotions" }), NOW)).toMatchObject({ tone: "warn", text: expect.stringMatching(/^Landed in the Promotions tab/) });
    expect(testResult(test({ placement: "spam", auth: { spf: "pass", dkim: "fail", dmarc: null } }), NOW)).toEqual({ tone: "bad", looking: false, text: "Landed in spam, sent 2 min ago · SPF passed, DKIM failed" });
    expect(testResult(test({ placement: "other", folder: "Receipts", auth: null }), NOW).text).toBe("Filed in the folder Receipts, sent 2 min ago");
    expect(authLine(test({ auth: { spf: "softfail", dkim: "pass", dmarc: "none" } }))).toBe("SPF softfail, DKIM passed, DMARC none");
  });

  it("does not claim to know what it does not", () => {
    expect(testResult(test({ status: "sent", placement: null }), NOW)).toMatchObject({ tone: "info", looking: true, text: "Sent 2 min ago. Looking for it in mia@acme.test…" });
    expect(testResult(test({ status: "sent", readable: false, placement: null, recipient: "x@elsewhere.test" }), NOW)).toMatchObject({ tone: "neutral", looking: false, text: expect.stringMatching(/accepted by the mail server\. Linki can say where a test landed only when/) });
    expect(testResult(test({ status: "not_found", placement: null }), NOW)).toMatchObject({ tone: "warn", text: expect.stringMatching(/not found in the inbox or spam/) });
  });
});

describe("upcoming sends", () => {
  const queue = (fields: Partial<MailboxQueue>): MailboxQueue => ({ due_today: 18, room_today: 8, waiting: 0, next_at: "2026-10-10T12:04:00Z", items: [], ...fields });

  it("says how many are due, how many there is room for, and roughly when the next is", () => {
    expect(queueSub(box(), queue({}), NOW)).toBe("18 due today · room for 8 · next in about 4 min");
    expect(queueSub(box(), queue({ due_today: 3 }), NOW)).toBe("3 due today · next in about 4 min");
    expect(queueSub(box(), queue({ due_today: 0, next_at: "2026-10-12T09:00:00Z" }), NOW)).toMatch(/^None due today · next /);
    expect(queueSub(box(), queue({ due_today: 0, next_at: null }), NOW)).toBe("Nothing scheduled");
    expect(queueSub(box(), queue({ due_today: 0, next_at: null, waiting: 12 }), NOW)).toBe("12 waiting to start · nothing timed yet");
    expect(queueSub(box({ status: "paused" }), queue({}), NOW)).toBe("Nothing is sent while this mailbox is paused");
    expect(queueSub(box({ status: "disconnected" }), queue({}), NOW)).toBe("Nothing is sent until this mailbox signs in again");
    expect(inAbout("2026-10-10T11:00:00Z", NOW)).toBe("due now");
    expect(inAbout("2026-10-10T15:00:00Z", NOW)).toBe("next in about 3 h");
  });
});

describe("what a person is told before they act", () => {
  it("pausing: what stops and what does not", () => {
    expect(pauseConsequence(box())).toBe("Nothing is sent from mia@acme.test until it is resumed: campaign emails, warm-up mail and tests. 2 campaigns have contacts with this mailbox. They stay where they are in their sequence and carry on when it resumes. Replies are still read.");
    expect(pauseConsequence(box({ active_campaigns: 0 }))).toMatch(/Contacts with this mailbox stay where they are/);
  });

  it("resuming: a warning only when the guard would pause it again", () => {
    expect(resumeConsequence(box({ status: "paused", held: { at: "x", reason: "Manually paused" } }))).toBeNull();
    expect(resumeConsequence(box({ status: "auto_paused", held: { at: "x", reason: "Auto-paused: 30-day bounce rate 4.80% exceeds 4.00%" }, health: { ...box().health, over_guard: false } }))).toBeNull();
    expect(resumeConsequence(box({ status: "auto_paused", held: { at: "x", reason: "Auto-paused: 30-day bounce rate 4.80% exceeds 4.00%" }, health: { ...box().health, over_guard: true } })))
      .toMatch(/^It was paused because its 30-day bounce rate 4\.80% exceeds 4\.00%\. That has not changed, so it will be paused again/);
  });

  it("a signature is shown as a first line and the rest", () => {
    expect(signatureLines("Mia Chen\n\n Senior AE · Acme \nacme.test")).toEqual({ first: "Mia Chen", rest: ["Senior AE · Acme", "acme.test"] });
    expect(signatureLines("  \n ")).toBeNull();
    expect(signatureLines(null)).toBeNull();
  });
});
