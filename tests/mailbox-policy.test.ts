// The rules that govern one mailbox, with no network and (mostly) no database: what it
// may send while it ramps up, when its signature goes on an email, how its DNS records
// are judged, and how its reputation score is worked out.
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { campaignSignature, effectiveEmailLimit, guardProblem, mailboxRamp, rampProblem, withSignature, type MailboxPolicyRow } from "@/lib/email/mailbox-policy";
import { dkimKeyBits, domainOf, evaluateDkim, evaluateDmarc, evaluateMx, evaluateSpf, lookupDomainDns, normaliseDomain, type DnsResolver } from "@/lib/email/dns";
import { reputation, reputationBand } from "@/lib/email/reputation";
import { providerOf } from "@/lib/email/mailbox-list";
import { mailboxSettingsProblem, withNumbers } from "@/lib/email/mailbox-settings";
import { checkDomainDeliverability } from "@/lib/platform/deliverability";
import { isImapAuthFailure, isSmtpAuthFailure } from "@/lib/email/auth-failure";

const DAY = 86_400_000;
const at = (date: string, plusDays = 0) => new Date(new Date(`${date}T10:00:00Z`).getTime() + plusDays * DAY);

/** The limit as the runner worked it out before a ramp could have a length, kept here word for word. */
function limitAsItWas(account: { daily_email_limit: number; ramp_up_enabled: number | null; ramp_start_date: string | null }, now: Date): number {
  if (!account.ramp_up_enabled || !account.ramp_start_date) return account.daily_email_limit;
  const daysActive = Math.max(1, Math.floor((now.getTime() - new Date(account.ramp_start_date).getTime()) / 86_400_000) + 1);
  const ramped = daysActive * 2;
  return Math.min(account.daily_email_limit, ramped);
}

describe("a mailbox's daily limit while it ramps up", () => {
  it("is exactly what it was for every mailbox that has not been given a ramp length", () => {
    for (const limit of [1, 2, 5, 25, 50, 60, 200]) {
      for (const enabled of [1, 0, null]) {
        for (const start of ["2026-09-01", null]) {
          for (let day = -3; day < 130; day++) {
            const row = { daily_email_limit: limit, ramp_up_enabled: enabled, ramp_start_date: start };
            const now = at("2026-09-01", day);
            expect(effectiveEmailLimit(row, now), `limit ${limit}, ramp ${enabled}, start ${start}, day ${day}`).toBe(limitAsItWas(row, now));
            // A length that is not a length (0, 1, null) is no length.
            expect(effectiveEmailLimit({ ...row, ramp_days: null, ramp_start_limit: 9 }, now)).toBe(limitAsItWas(row, now));
            expect(effectiveEmailLimit({ ...row, ramp_days: 1 }, now)).toBe(limitAsItWas(row, now));
          }
        }
      }
    }
  });

  it("says where the original ramp is: two more each day, done when the limit is reached", () => {
    const row: MailboxPolicyRow = { daily_email_limit: 60, ramp_up_enabled: 1, ramp_start_date: "2026-09-01" };
    expect(mailboxRamp(row, at("2026-09-01"))).toEqual({ day: 1, days: 30, limit: 2, complete: false });
    expect(mailboxRamp(row, at("2026-09-01", 8))).toEqual({ day: 9, days: 30, limit: 18, complete: false });
    expect(mailboxRamp(row, at("2026-09-01", 29))).toEqual({ day: 30, days: 30, limit: 60, complete: true });
    expect(mailboxRamp(row, at("2026-09-01", 200))).toEqual({ day: 30, days: 30, limit: 60, complete: true });
    expect(mailboxRamp({ ...row, ramp_up_enabled: 0 }, at("2026-09-01"))).toBeNull();
  });

  it("rises in a straight line over a chosen number of days, from a chosen start", () => {
    const row: MailboxPolicyRow = { daily_email_limit: 40, ramp_up_enabled: 1, ramp_start_date: "2026-09-01", ramp_days: 21, ramp_start_limit: 9 };
    expect(mailboxRamp(row, at("2026-09-01"))).toEqual({ day: 1, days: 21, limit: 9, complete: false });
    expect(mailboxRamp(row, at("2026-09-01", 2))).toEqual({ day: 3, days: 21, limit: 12, complete: false });
    expect(mailboxRamp(row, at("2026-09-01", 10))?.limit).toBe(25);
    expect(mailboxRamp(row, at("2026-09-01", 19))?.limit).toBe(38);
    expect(mailboxRamp(row, at("2026-09-01", 20))).toEqual({ day: 21, days: 21, limit: 40, complete: true });
    expect(effectiveEmailLimit(row, at("2026-09-01", 300))).toBe(40);
    // Never above the limit, never a start above it, and never below one email.
    expect(effectiveEmailLimit({ ...row, ramp_start_limit: 500 }, at("2026-09-01"))).toBe(40);
    expect(effectiveEmailLimit({ ...row, ramp_start_limit: 0 }, at("2026-09-01"))).toBe(1);
    // With no start given it begins where the original ramp does.
    expect(effectiveEmailLimit({ ...row, ramp_start_limit: null }, at("2026-09-01"))).toBe(2);
  });

  it("only goes up through a ramp", () => {
    const row: MailboxPolicyRow = { daily_email_limit: 73, ramp_up_enabled: 1, ramp_start_date: "2026-09-01", ramp_days: 17, ramp_start_limit: 4 };
    let last = 0;
    for (let day = 0; day < 30; day++) {
      const limit = effectiveEmailLimit(row, at("2026-09-01", day));
      expect(limit).toBeGreaterThanOrEqual(last);
      last = limit;
    }
    expect(last).toBe(73);
  });

  it("refuses a ramp that cannot be", () => {
    expect(rampProblem({ ramp_days: 21, ramp_start_limit: 5, daily_email_limit: 40 })).toBeNull();
    expect(rampProblem({})).toBeNull();
    expect(rampProblem({ ramp_days: null, ramp_start_limit: null })).toBeNull();
    expect(rampProblem({ ramp_days: 1 })).toMatch(/between 2 and 90/);
    expect(rampProblem({ ramp_days: 400 })).toMatch(/between 2 and 90/);
    expect(rampProblem({ ramp_days: 2.5 })).toMatch(/between 2 and 90/);
    expect(rampProblem({ ramp_start_limit: 0 })).toMatch(/one email/);
    expect(rampProblem({ ramp_start_limit: 50, daily_email_limit: 40 })).toMatch(/above the daily limit/);
  });
});

describe("the guard's thresholds", () => {
  it("accepts what a person would set and refuses what would switch the guard off or trip it on nothing", () => {
    expect(guardProblem({})).toBeNull();
    expect(guardProblem({ bounce_threshold: 0.04, complaint_threshold: 0.001, min_health_sample: 50 })).toBeNull();
    expect(guardProblem({ bounce_threshold: 0 })).toMatch(/bounce guard/);
    expect(guardProblem({ bounce_threshold: 0.9 })).toMatch(/bounce guard/);
    expect(guardProblem({ bounce_threshold: "0.04" })).toMatch(/bounce guard/);
    expect(guardProblem({ complaint_threshold: 0.5 })).toMatch(/complaint guard/);
    expect(guardProblem({ min_health_sample: 3 })).toMatch(/between 10 and 5,000/);
  });
});

describe("a mailbox's settings as saved", () => {
  it("are checked only where they were sent", () => {
    expect(mailboxSettingsProblem({})).toBeNull();
    expect(mailboxSettingsProblem({ name: "Ada", signature: null, reply_to: null })).toBeNull();
    expect(mailboxSettingsProblem({ daily_email_limit: 0 })).toMatch(/daily limit/);
    expect(mailboxSettingsProblem({ active_hours_start: 9, active_hours_end: 9 })).toMatch(/end after it starts/);
    expect(mailboxSettingsProblem({ active_hours_end: 8 }, { active_hours_start: 9, active_hours_end: 18 })).toMatch(/end after it starts/);
    expect(mailboxSettingsProblem({ active_hours_end: 24 }, { active_hours_start: 9 })).toBeNull();
    expect(mailboxSettingsProblem({ timezone: "Mars/Olympus" })).toMatch(/time zone/);
    expect(mailboxSettingsProblem({ timezone: "Europe/Berlin" })).toBeNull();
    expect(mailboxSettingsProblem({ working_days: "" })).toMatch(/at least one day/);
    expect(mailboxSettingsProblem({ working_days: "1,2,8" })).toMatch(/at least one day/);
    expect(mailboxSettingsProblem({ from_email: "not an address" })).toMatch(/address this mailbox sends from/);
    expect(mailboxSettingsProblem({ reply_to: "nope" })).toMatch(/reply-to/);
    expect(mailboxSettingsProblem({ ramp_start_limit: 30 }, { daily_email_limit: 20 })).toMatch(/above the daily limit/);
  });

  it("take a number that arrived as text, as the API always has", () => {
    expect(withNumbers({ daily_email_limit: "50", smtp_port: "587", name: "12", bounce_threshold: "0.04", imap_port: "" })).toEqual({ daily_email_limit: 50, smtp_port: 587, name: "12", bounce_threshold: 0.04, imap_port: "" });
  });
});

describe("a mailbox's signature on a campaign email", () => {
  const db = getDb();
  let seq = 0;
  /** A run with one contact, who has (or has not) already had a campaign email. */
  function contact(emailed: "sent" | "pending" | null) {
    const n = ++seq;
    const ws = `ws-sig-${n}`;
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
    db.prepare("INSERT INTO email_accounts (id, workspace_id, name, from_email, smtp_host, username, password) VALUES (?, ?, 'S', ?, 'smtp.test', 'u', 'p')").run(`sig-mb-${n}`, ws, `s${n}@sig.test`);
    db.prepare("INSERT INTO workflows (id, name, workspace_id) VALUES (?, 'C', ?)").run(`sig-wf-${n}`, ws);
    db.prepare("INSERT INTO runs (id, workflow_id, status, workspace_id) VALUES (?, ?, 'running', ?)").run(`sig-run-${n}`, `sig-wf-${n}`, ws);
    db.prepare("INSERT INTO targets (id, workspace_id, full_name, linkedin_url) VALUES (?, ?, 'Lee', ?)").run(`sig-t-${n}`, ws, `https://www.linkedin.com/in/sig-${n}/`);
    if (emailed) {
      db.prepare(`INSERT INTO email_jobs (id, workspace_id, email_account_id, idempotency_key, source, target_id, run_id, recipient, subject, body_text, status)
        VALUES (?, ?, ?, ?, 'campaign', ?, ?, 'lee@x.test', 'Hi', 'Body', ?)`).run(`sig-job-${n}`, ws, `sig-mb-${n}`, `k-${n}`, `sig-t-${n}`, `sig-run-${n}`, emailed);
    }
    return { run: `sig-run-${n}`, target: `sig-t-${n}` };
  }

  it("goes on every email, as it always has, unless the mailbox says first email only", () => {
    const first = contact(null);
    const later = contact("sent");
    for (const mailbox of [{ signature: " Ada\nAcme " }, { signature: " Ada\nAcme ", signature_first_only: 0 }, { signature: " Ada\nAcme ", signature_first_only: null }]) {
      expect(campaignSignature(db, mailbox, null, first.run, first.target)).toBe("Ada\nAcme");
      expect(campaignSignature(db, mailbox, null, later.run, later.target)).toBe("Ada\nAcme");
    }
  });

  it("goes on the first email only when the mailbox says so", () => {
    const mailbox = { signature: "Ada\nAcme", signature_first_only: 1 };
    const first = contact(null);
    const later = contact("sent");
    const queued = contact("pending");
    expect(campaignSignature(db, mailbox, null, first.run, first.target)).toBe("Ada\nAcme");
    expect(campaignSignature(db, mailbox, null, later.run, later.target)).toBeNull();
    // An email that has not gone yet is not an email the contact has had.
    expect(campaignSignature(db, mailbox, null, queued.run, queued.target)).toBe("Ada\nAcme");
  });

  it("is always the step's own signature when the step has one", () => {
    const later = contact("sent");
    const mailbox = { signature: "Ada\nAcme", signature_first_only: 1 };
    expect(campaignSignature(db, mailbox, "Step sig", later.run, later.target)).toBe("Step sig");
    // A step signature left empty means "no signature on this step".
    expect(campaignSignature(db, mailbox, "", later.run, later.target)).toBeNull();
    expect(campaignSignature(db, { signature: null }, null, later.run, later.target)).toBeNull();
  });

  it("is set off from the body the way it always was", () => {
    expect(withSignature("Hello", "Ada")).toBe("Hello\n\n--\nAda");
    expect(withSignature("Hello", null)).toBe("Hello");
  });
});

describe("a sending domain's DNS records", () => {
  it("reads a domain out of an address", () => {
    expect(domainOf("Mia.Chen@Acme.IO")).toBe("acme.io");
    expect(domainOf("nobody")).toBeNull();
    expect(domainOf(null)).toBeNull();
    expect(normaliseDomain(" https://www.Acme.io/path ")).toBe("acme.io");
  });

  it("judges SPF", () => {
    expect(evaluateSpf(["v=spf1 include:_spf.google.com ~all"])).toMatchObject({ status: "pass", value: "v=spf1 include:_spf.google.com ~all", note: null });
    expect(evaluateSpf(["google-site-verification=abc"])).toMatchObject({ status: "fail", value: null });
    expect(evaluateSpf(["v=spf1 a ~all", "v=spf1 mx -all"]).status).toBe("weak");
    expect(evaluateSpf(["v=spf1 +all"]).status).toBe("weak");
    expect(evaluateSpf(["v=spf1 include:x.test ?all"]).status).toBe("weak");
    expect(evaluateSpf(["v=spf1 include:x.test -all"]).status).toBe("pass");
  });

  it("judges DMARC by its policy", () => {
    expect(evaluateDmarc(["v=DMARC1; p=quarantine; rua=mailto:d@acme.io"])).toMatchObject({ status: "pass", policy: "quarantine" });
    expect(evaluateDmarc(["v=DMARC1; p=reject"])).toMatchObject({ status: "pass", policy: "reject" });
    expect(evaluateDmarc(["v=DMARC1; p=none; rua=mailto:d@acme.io"])).toMatchObject({ status: "weak", policy: "none" });
    expect(evaluateDmarc([])).toMatchObject({ status: "fail", policy: null, value: null });
  });

  it("judges a DKIM key, and tells its size", () => {
    const key2048 = `v=DKIM1; k=rsa; p=${"A".repeat(392)}`;
    const key1024 = `v=DKIM1; k=rsa; p=${"A".repeat(216)}`;
    const key512 = `v=DKIM1; k=rsa; p=${"A".repeat(128)}`;
    expect(dkimKeyBits(key2048)).toBe(2048);
    expect(dkimKeyBits(key1024)).toBe(1024);
    expect(evaluateDkim([key2048], "google", ["google"])).toMatchObject({ status: "pass", selector: "google", bits: 2048 });
    expect(evaluateDkim([key512], "s1", ["s1"])).toMatchObject({ status: "weak", bits: 512 });
    expect(evaluateDkim(["v=DKIM1; p="], "old", ["old"])).toMatchObject({ status: "fail" });
    expect(evaluateDkim([], null, ["google", "selector1"])).toMatchObject({ status: "fail", selector: null, selectors_checked: ["google", "selector1"] });
    expect(dkimKeyBits("v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=")).toBeNull();
  });

  it("judges MX", () => {
    expect(evaluateMx([{ exchange: "alt1.aspmx.l.google.com", priority: 10 }, { exchange: "aspmx.l.google.com", priority: 5 }])).toMatchObject({ status: "pass", value: "5 · aspmx.l.google.com (+1)" });
    expect(evaluateMx([])).toMatchObject({ status: "fail" });
  });

  const records: Record<string, string[]> = {
    "acme.test": ["v=spf1 include:_spf.google.com ~all"],
    "_dmarc.acme.test": ["v=DMARC1; p=none; rua=mailto:dmarc@acme.test"],
    "pm._domainkey.acme.test": [`v=DKIM1; k=rsa; p=${"B".repeat(392)}`],
  };
  const resolver: DnsResolver = {
    txt: async (name) => records[name] ?? [],
    mx: async (name) => (name === "acme.test" ? [{ exchange: "mx.acme.test", priority: 10 }] : []),
  };

  it("looks all four up, finding the DKIM key under whichever selector holds it", async () => {
    const dns = await lookupDomainDns("WWW.Acme.test", { resolver });
    expect(dns).toMatchObject({
      domain: "acme.test",
      spf: { status: "pass" },
      dkim: { status: "pass", selector: "pm", bits: 2048 },
      dmarc: { status: "weak", policy: "none" },
      mx: { status: "pass", value: "10 · mx.acme.test" },
    });
    // A selector that is named is tried first.
    expect((await lookupDomainDns("acme.test", { resolver, selector: "PM" })).dkim.selectors_checked[0]).toBe("pm");
  });

  it("says a lookup failed instead of saying the record is missing", async () => {
    const broken: DnsResolver = { txt: async () => { throw new Error("queryTxt ETIMEOUT"); }, mx: async () => { throw new Error("queryMx ESERVFAIL"); } };
    const dns = await lookupDomainDns("acme.test", { resolver: broken });
    for (const record of [dns.spf, dns.dkim, dns.dmarc, dns.mx]) {
      expect(record).toMatchObject({ status: "fail", lookup_failed: true });
      expect(record.note).toMatch(/could not be looked up/);
    }
  });

  it("keeps a check, with the three-way status, and scores it as it always has", async () => {
    const db = getDb();
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-dns', 'ws-dns', 'ws-dns')").run();
    const result = await checkDomainDeliverability({ workspaceId: "ws-dns", domain: "acme.test", resolver });
    // SPF 25 + DKIM 25 + DMARC 30 + MX 10: a weak record still counts as there, as before.
    expect(result.score).toBe(90);
    expect(result).toMatchObject({ domain: "acme.test", spf: { ok: true, status: "pass" }, dmarc: { ok: true, status: "weak" }, dkim: { ok: true, selector: "pm" }, mx: { ok: true } });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatch(/p=none/);
    const stored = db.prepare("SELECT spf_status, dkim_status, dmarc_status, mx_status, score FROM deliverability_checks WHERE id = ?").get(result.id);
    expect(stored).toEqual({ spf_status: "pass", dkim_status: "pass", dmarc_status: "weak", mx_status: "pass", score: 90 });

    const empty = await checkDomainDeliverability({ workspaceId: "ws-dns", domain: "nothing.test", resolver });
    expect(empty.score).toBe(0);
    expect(empty.recommendations).toHaveLength(4);
  });
});

describe("a mailbox's reputation score", () => {
  const clean = { sent: 400, bounces: 0, complaints: 0, warmup_checked: 60, warmup_spam: 0, dns: { spf: "pass", dkim: "pass", dmarc: "pass" } as const };

  it("is 100 with nothing against it, and nothing at all with nothing to judge by", () => {
    expect(reputation(clean)).toEqual({ score: 100, losses: [] });
    expect(reputation({ sent: 0, bounces: 0, complaints: 0, warmup_checked: 0, warmup_spam: 0, dns: null })).toBeNull();
  });

  it("loses ten points for each 1% of bounces, up to 40", () => {
    expect(reputation({ ...clean, bounces: 4 })?.score).toBe(90);
    expect(reputation({ ...clean, bounces: 8 })?.score).toBe(80);
    expect(reputation({ ...clean, bounces: 100 })?.score).toBe(60);
    // One bounce in three emails is not a 33% bounce rate.
    expect(reputation({ ...clean, sent: 3, bounces: 1 })?.score).toBe(60);
    expect(reputation({ ...clean, sent: 3, bounces: 1 })?.losses[0]).toMatchObject({ reason: "bounces", points: 40 });
  });

  it("loses points for complaints, warm-up mail in spam, and DNS that is missing or weak", () => {
    expect(reputation({ ...clean, sent: 1000, complaints: 1 })?.score).toBe(80);
    expect(reputation({ ...clean, warmup_checked: 100, warmup_spam: 10 })?.score).toBe(90);
    expect(reputation({ ...clean, dns: { spf: "pass", dkim: "pass", dmarc: "weak" } })?.score).toBe(97);
    expect(reputation({ ...clean, dns: { spf: "fail", dkim: "fail", dmarc: "fail" } })?.score).toBe(75);
    expect(reputation({ ...clean, dns: { spf: "fail", dkim: "fail", dmarc: "fail" } })?.losses).toEqual([{ reason: "dns", points: 25, detail: "SPF missing, DKIM missing, DMARC missing" }]);
  });

  it("never leaves 0 to 100, and lists what cost the most first", () => {
    const worst = reputation({ sent: 100, bounces: 50, complaints: 20, warmup_checked: 50, warmup_spam: 50, dns: { spf: "fail", dkim: "fail", dmarc: "fail" } });
    expect(worst?.score).toBe(0);
    expect(worst?.losses.map((loss) => loss.reason)).toEqual(["bounces", "complaints", "dns", "spam"]);
    expect(reputationBand(96)).toBe("good");
    expect(reputationBand(88)).toBe("fair");
    expect(reputationBand(69)).toBe("poor");
  });
});

describe("who runs a mailbox", () => {
  it("is read from how it was connected and where it connects to", () => {
    expect(providerOf({ provider: "gmail_app_password", smtp_host: "smtp.gmail.com", imap_host: "imap.gmail.com" })).toEqual({ key: "google", label: "Gmail", method: "App password" });
    expect(providerOf({ provider: "smtp", smtp_host: "smtp.office365.com", imap_host: "outlook.office365.com" })).toEqual({ key: "microsoft", label: "Microsoft 365", method: "SMTP/IMAP" });
    expect(providerOf({ provider: "smtp", smtp_host: "smtp.eu.mailgun.org", imap_host: null })).toEqual({ key: "smtp", label: "SMTP · Mailgun", method: "SMTP only" });
    expect(providerOf({ provider: null, smtp_host: "mail.acme.test", imap_host: "mail.acme.test" })).toEqual({ key: "smtp", label: "SMTP · mail.acme.test", method: "SMTP/IMAP" });
    expect(providerOf({ provider: "microsoft", smtp_host: "x", imap_host: null }).label).toBe("Microsoft 365");
  });
});

describe("a refused sign-in", () => {
  it("is told apart from a server that could not be reached or is only busy", () => {
    expect(isSmtpAuthFailure({ code: "EAUTH", responseCode: 535 })).toBe(true);
    expect(isSmtpAuthFailure({ code: "EAUTH" })).toBe(true);
    expect(isSmtpAuthFailure({ code: "EAUTH", responseCode: 454 })).toBe(false);
    expect(isSmtpAuthFailure({ code: "ETIMEDOUT" })).toBe(false);
    expect(isSmtpAuthFailure(new Error("socket hang up"))).toBe(false);
    expect(isImapAuthFailure({ source: "authentication" })).toBe(true);
    expect(isImapAuthFailure({ textCode: "AUTHENTICATIONFAILED" })).toBe(true);
    expect(isImapAuthFailure({ source: "timeout-auth" })).toBe(false);
    expect(isImapAuthFailure(null)).toBe(false);
  });
});
