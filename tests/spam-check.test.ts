// The spam scan: what it finds, what it leaves alone, and what cleaning does to the text.
import { describe, expect, it } from "vitest";
import { checkSpam, cleanSpam, describeFindings, scoreOf } from "@/lib/email/spam-check";

const rules = (subject: string, body = "") => checkSpam({ subject, body }).findings.map((finding) => finding.rule);

describe("what is flagged", () => {
  it("passes plain one-to-one outreach", () => {
    const report = checkSpam({ subject: "Question about Initech's hiring", body: "Hi Lee,\n\nI saw you are hiring four AEs. We help teams ramp reps faster. Worth a 15 minute call on Thursday?\n\nAda" });
    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({ score: 0, level: "clean" });
  });

  it("finds pressure phrases, guarantees and prizes, and says where", () => {
    const body = "You have been selected. Act now to claim your 100% free trial, guaranteed.";
    const report = checkSpam({ subject: "", body });
    const texts = report.findings.map((finding) => finding.text.toLowerCase());
    expect(texts).toEqual(expect.arrayContaining(["act now", "100% free", "guaranteed"]));
    for (const finding of report.findings) expect(body.slice(finding.start, finding.end)).toBe(finding.text);
    expect(report.level).not.toBe("clean");
  });

  it("is stricter in a subject line, where it is read first", () => {
    expect(checkSpam({ subject: "Your account is urgent", body: "" }).findings[0]).toMatchObject({ rule: "urgency", severity: "high", field: "subject" });
    expect(checkSpam({ subject: "", body: "This is urgent" }).findings[0]).toMatchObject({ rule: "urgency", severity: "medium", field: "body" });
  });

  it("flags shouting, repeated punctuation and exclamation marks, but not what things are called", () => {
    expect(rules("Quick question!")).toEqual(["exclamation"]);
    expect(rules("", "This is AMAZING!!! Really")).toEqual(expect.arrayContaining(["shouting", "repeated-punctuation"]));
    expect(rules("", "We are HIPAA and GDPR ready, built for SaaS and B2B teams on AWS.")).toEqual([]);
    // Two exclamation marks in a body are fine; the third is flagged.
    expect(rules("", "Great! Nice! Wow!")).toEqual(["exclamation"]);
  });

  it("flags link shorteners and an email that is mostly links", () => {
    expect(rules("", "See bit.ly/3xyz for the deck")).toEqual(["shortener"]);
    expect(rules("", "https://a.test/1 https://a.test/2 https://a.test/3 https://a.test/4")).toEqual(["many-links"]);
  });

  it("does not read merge tags, which are filled in later", () => {
    expect(rules("{{first_name}}, {{FREE_TRIAL}} idea", "Hi {{first_name}}, {{unsubscribe|Click here to opt out}}")).toEqual([]);
    // But the words inside a {choice|of|words} are all read.
    expect(rules("", "{Hi|Act now} Lee")).toEqual(["pressure"]);
  });

  it("counts a phrase once when two rules would both match it", () => {
    const findings = checkSpam({ subject: "", body: "It is 100% free, no strings attached." }).findings;
    expect(findings.map((finding) => finding.text.toLowerCase())).toEqual(["100% free", "no strings attached"]);
  });

  it("scores more findings as worse, with diminishing weight, and tops out at 100", () => {
    const one = checkSpam({ subject: "", body: "act now" });
    const many = checkSpam({ subject: "", body: "act now, buy now, order now, call now, click here, guaranteed, risk-free, make money fast, viagra, casino, jackpot, winner" });
    expect(many.score).toBeGreaterThan(one.score);
    expect(many.score).toBeLessThanOrEqual(100);
    expect(many.level).toBe("risky");
    expect(scoreOf([]).level).toBe("clean");
  });
});

describe("cleaning", () => {
  it("takes out a pressure phrase and mends the sentence round it", () => {
    const cleaned = cleanSpam({ subject: "Quick question!", body: "Hi Lee,\n\nAct now to see how we help.\n\nWe work with hiring teams. Buy now and save time." });
    expect(cleaned.subject).toBe("Quick question");
    expect(cleaned.body).toBe("Hi Lee,\n\nTo see how we help.\n\nWe work with hiring teams. And save time.");
    expect(cleaned.removed.map((entry) => entry.text.toLowerCase())).toEqual(["!", "act now", "buy now"]);
  });

  it("takes an alarm word off the front of a subject", () => {
    expect(cleanSpam({ subject: "URGENT: Quick question", body: "" }).subject).toBe("Quick question");
    expect(cleanSpam({ subject: "Action required - your invoice", body: "" }).subject).toBe("Your invoice");
    // In the middle of a sentence it is left, because removing it could change what is said.
    expect(cleanSpam({ subject: "Is this urgent for you?", body: "" })).toMatchObject({ subject: "Is this urgent for you?", removed: [] });
  });

  it("lowers shouting and cuts a run of punctuation to one", () => {
    const cleaned = cleanSpam({ subject: "", body: "This is AMAZING!!! Really." });
    expect(cleaned.body).toBe("This is Amazing! Really.");
  });

  it("softens \"100% free\" to \"free\"", () => {
    expect(cleanSpam({ subject: "", body: "Try the 100% free plan." }).body).toBe("Try the free plan.");
  });

  it("leaves what cannot be mended without changing the meaning, and says so", () => {
    const cleaned = cleanSpam({ subject: "", body: "Results are guaranteed. Click here to book." });
    expect(cleaned.body).toBe("Results are guaranteed. Click here to book.");
    expect(cleaned.removed).toEqual([]);
    expect(cleaned.left.map((finding) => finding.text.toLowerCase())).toEqual(["guaranteed", "click here"]);
  });

  it("keeps merge tags and an unsubscribe tag exactly", () => {
    const body = "Hi {{first_name}}, ACT NOW.\n\n{{unsubscribe|Opt out}}";
    expect(cleanSpam({ subject: "", body }).body).toBe("Hi {{first_name}}.\n\n{{unsubscribe|Opt out}}");
  });

  it("never leaves an email with nothing in it", () => {
    expect(cleanSpam({ subject: "Act now", body: "Buy now" })).toMatchObject({ subject: "Act now", body: "Buy now", removed: [] });
  });

  it("changes nothing in a clean email", () => {
    const input = { subject: "Hiring plans at Initech", body: "Hi Lee,\n\nWorth a quick call?" };
    expect(cleanSpam(input)).toMatchObject({ ...input, removed: [], left: [] });
  });
});

describe("describing findings", () => {
  it("names a few and counts the rest", () => {
    const findings = checkSpam({ subject: "", body: "act now, buy now, order now, call now" }).findings;
    expect(describeFindings(findings)).toBe('"act now", "buy now", "order now" and 1 more');
    expect(describeFindings([])).toBe("nothing flagged");
  });
});
