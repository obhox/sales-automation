import type { RecordStatus } from "@/lib/email/dns";

// A sending domain's score, and what would raise it.
//
// Out of 100: 80 for the four DNS records being in place and sound, 20 for how its mail
// has been received over the last 30 days. Like a mailbox's reputation it is Linki's own
// reading of what it can see, not a figure any mail provider publishes. It is a pure
// function, so "what would the score be if DMARC were fixed" is the same sum with one
// input changed.

export interface DomainEvidence {
  spf: RecordStatus;
  dkim: RecordStatus;
  dmarc: RecordStatus;
  mx: RecordStatus;
  /** 30-day rates across the domain's mailboxes. Null when nothing was sent: no evidence either way. */
  bounce_rate: number | null;
  complaint_rate: number | null;
}

type RecordKey = "spf" | "dkim" | "dmarc" | "mx";

const RECORD_POINTS: Record<RecordKey, Record<RecordStatus, number>> = {
  spf: { pass: 20, weak: 12, fail: 0 },
  dkim: { pass: 25, weak: 15, fail: 0 },
  dmarc: { pass: 25, weak: 17, fail: 0 },
  mx: { pass: 10, weak: 10, fail: 0 },
};

/** Ten points, less five for each 1% of bounces. */
const bouncePoints = (rate: number | null) => (rate === null ? 10 : Math.max(0, 10 - rate * 500));
/** Ten points, less ten for each 0.1% of complaints. */
const complaintPoints = (rate: number | null) => (rate === null ? 10 : Math.max(0, 10 - rate * 10_000));

export function domainScoreOf(evidence: DomainEvidence): number {
  const records = (Object.keys(RECORD_POINTS) as RecordKey[]).reduce((sum, key) => sum + RECORD_POINTS[key][evidence[key]], 0);
  return Math.max(0, Math.min(100, Math.round(records + bouncePoints(evidence.bounce_rate) + complaintPoints(evidence.complaint_rate))));
}

export interface DomainFix {
  key: RecordKey | "bounces" | "complaints";
  /** The score once this alone is put right. */
  score_after: number;
  /** One sentence: what to do and what it gets. */
  advice: string;
}

export interface DomainScore {
  score: number;
  band: "good" | "fair" | "poor";
  /** "Good, one fix available". */
  headline: string;
  /** What would raise the score, the biggest gain first. */
  fixes: DomainFix[];
}

const ADVICE: Record<RecordKey, Partial<Record<RecordStatus, (domain: string, after: number) => string>>> = {
  spf: {
    fail: (domain, after) => `Publishing an SPF record that names every server sending for ${domain} would raise it to ${after}.`,
    weak: (domain, after) => `Tidying the SPF record (one record, ending in ~all or -all) would raise ${domain} to ${after}.`,
  },
  dkim: {
    fail: (domain, after) => `Switching DKIM signing on at the mail provider and publishing its key would raise ${domain} to ${after}. If it is already on, enter the selector the provider uses.`,
    weak: (domain, after) => `Replacing the DKIM key with a 2048-bit one would raise ${domain} to ${after}.`,
  },
  dmarc: {
    fail: (domain, after) => `Publishing a DMARC record would raise ${domain} to ${after}. Start with p=none and a reporting address, then tighten it.`,
    weak: (domain, after) => `Moving DMARC from p=none to p=quarantine would raise ${domain} to ${after} and protect the domain from being forged.`,
  },
  mx: {
    fail: (domain, after) => `Adding an MX record would raise ${domain} to ${after}. Without one, replies and bounces have nowhere to go.`,
  },
};

const COUNT_WORD = ["no", "one", "two", "three", "four", "five", "six"];

/** The score, and each thing that would raise it with the score it would give. */
export function domainScore(domain: string, evidence: DomainEvidence): DomainScore {
  const score = domainScoreOf(evidence);
  const fixes: DomainFix[] = [];
  for (const key of Object.keys(RECORD_POINTS) as RecordKey[]) {
    const advice = ADVICE[key][evidence[key]];
    if (!advice) continue;
    const after = domainScoreOf({ ...evidence, [key]: "pass" });
    if (after > score) fixes.push({ key, score_after: after, advice: advice(domain, after) });
  }
  if (evidence.bounce_rate !== null && bouncePoints(evidence.bounce_rate) < 9.5) {
    const after = domainScoreOf({ ...evidence, bounce_rate: 0 });
    if (after > score) fixes.push({ key: "bounces", score_after: after, advice: `${(evidence.bounce_rate * 100).toFixed(1)}% of emails from ${domain} bounced in 30 days. Verifying addresses before they are emailed would raise it towards ${after}.` });
  }
  if (evidence.complaint_rate !== null && evidence.complaint_rate > 0) {
    const after = domainScoreOf({ ...evidence, complaint_rate: 0 });
    if (after > score) fixes.push({ key: "complaints", score_after: after, advice: `${(evidence.complaint_rate * 100).toFixed(2)}% of emails from ${domain} were marked as spam in 30 days. Narrower lists and an easy way to opt out would raise it towards ${after}.` });
  }
  fixes.sort((a, b) => b.score_after - a.score_after);

  const band = score >= 80 ? "good" : score >= 60 ? "fair" : "poor";
  const count = fixes.length;
  const available = `${COUNT_WORD[count] ?? count} ${count === 1 ? "fix" : "fixes"} ${band === "poor" ? "needed" : "available"}`;
  const headline = count === 0 ? "Everything is in place" : `${band === "good" ? "Good" : band === "fair" ? "Fair" : "Poor"}, ${available}`;
  return { score, band, headline, fixes };
}
