import type { RecordStatus } from "@/lib/email/dns";

// A mailbox's reputation score.
//
// This is Linki's own reading of the evidence it holds, on a scale of 0 to 100. It is not
// a figure from Google, Microsoft or any blocklist: nobody outside those companies can
// see theirs. It starts at 100 and loses points for the four things that are known to
// cost a mailbox its place in the inbox.

export interface ReputationEvidence {
  /** Emails this mailbox sent in the last 30 days, of every kind. */
  sent: number;
  bounces: number;
  complaints: number;
  /** Warm-up emails from this mailbox that the receiving mailbox was looked in for. */
  warmup_checked: number;
  /** Of those, the ones found in spam. */
  warmup_spam: number;
  /** The sending domain's records at the last check. Null when it has never been checked. */
  dns: { spf: RecordStatus; dkim: RecordStatus; dmarc: RecordStatus } | null;
}

export interface Reputation {
  score: number;
  /** What cost points, most costly first: for showing why. */
  losses: Array<{ reason: "bounces" | "complaints" | "spam" | "dns"; points: number; detail: string }>;
}

/** Below this many emails a rate is measured as if this many had been sent, so one bounce in three does not read as 33%. */
export const MIN_SAMPLE = 20;

const DNS_COST: Record<"spf" | "dkim" | "dmarc", { fail: number; weak: number; name: string }> = {
  spf: { fail: 8, weak: 3, name: "SPF" },
  dkim: { fail: 8, weak: 3, name: "DKIM" },
  dmarc: { fail: 9, weak: 3, name: "DMARC" },
};

const percent = (ratio: number, digits = 1) => `${(ratio * 100).toFixed(digits)}%`;

/**
 * The score for a mailbox, or null when there is nothing to judge it by: no email sent,
 * no warm-up mail looked for and no DNS check.
 */
export function reputation(evidence: ReputationEvidence): Reputation | null {
  if (evidence.sent === 0 && evidence.warmup_checked === 0 && !evidence.dns) return null;
  const losses: Reputation["losses"] = [];

  // Bounces: ten points for each 1%, up to 40.
  const bounceRate = evidence.bounces / Math.max(evidence.sent, MIN_SAMPLE);
  if (evidence.bounces > 0) losses.push({ reason: "bounces", points: Math.min(40, bounceRate * 1000), detail: `${percent(bounceRate)} of emails bounced in 30 days` });

  // Complaints: twenty points for each 0.1%, up to 30.
  const complaintRate = evidence.complaints / Math.max(evidence.sent, MIN_SAMPLE);
  if (evidence.complaints > 0) losses.push({ reason: "complaints", points: Math.min(30, complaintRate * 20_000), detail: `${percent(complaintRate, 2)} marked as spam in 30 days` });

  // Warm-up mail found in spam: one point for each 1%, up to 20.
  if (evidence.warmup_spam > 0 && evidence.warmup_checked > 0) {
    const spamRate = evidence.warmup_spam / Math.max(evidence.warmup_checked, MIN_SAMPLE);
    losses.push({ reason: "spam", points: Math.min(20, spamRate * 100), detail: `${evidence.warmup_spam} of ${evidence.warmup_checked} warm-up emails landed in spam` });
  }

  if (evidence.dns) {
    const missing: string[] = [];
    let points = 0;
    for (const key of ["spf", "dkim", "dmarc"] as const) {
      const status = evidence.dns[key];
      if (status === "pass") continue;
      points += DNS_COST[key][status];
      missing.push(`${DNS_COST[key].name} ${status === "fail" ? "missing" : "weak"}`);
    }
    if (points > 0) losses.push({ reason: "dns", points, detail: missing.join(", ") });
  }

  const lost = losses.reduce((sum, loss) => sum + loss.points, 0);
  return {
    score: Math.max(0, Math.min(100, Math.round(100 - lost))),
    losses: losses.map((loss) => ({ ...loss, points: Math.round(loss.points) })).sort((a, b) => b.points - a.points),
  };
}

export type ReputationBand = "good" | "fair" | "poor";

/** 90 and up is good, 75 and up fair, under that poor. */
export function reputationBand(score: number): ReputationBand {
  return score >= 90 ? "good" : score >= 75 ? "fair" : "poor";
}

/** Under this a mailbox is counted as needing attention. */
export const REPUTATION_LOW = 80;
