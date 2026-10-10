// Enough statistics to say whether one version of an email is really doing better than
// another, or only looks it on a handful of sends.

/** The standard normal distribution's cumulative probability (Abramowitz and Stegun 26.2.17, good to 7 decimal places). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const tail = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

/**
 * How likely a gap this big between two rates would be if the two were really the same
 * (two-sided, pooled two-proportion z-test). Small is "probably a real difference".
 */
export function proportionPValue(successA: number, totalA: number, successB: number, totalB: number): number {
  if (totalA <= 0 || totalB <= 0) return 1;
  const pooled = (successA + successB) / (totalA + totalB);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  if (spread === 0) return 1;
  return 2 * (1 - normalCdf(Math.abs(successA / totalA - successB / totalB) / spread));
}

export interface VersionResult { id: string | null; sent: number; replies: number; opened: number }
export interface LikelyWinner { id: string | null; metric: "replies" | "opens"; confidence: number }

/** A version needs this many sends before its rate means anything. */
export const MIN_SENDS = 30;
/** And the versions between them this many of the outcome, or the test is all noise. */
export const MIN_OUTCOMES = 5;
const SIGNIFICANT = 0.05;

function leader(versions: VersionResult[], outcome: (version: VersionResult) => number): { id: string | null; confidence: number } | null {
  if (versions.reduce((sum, version) => sum + outcome(version), 0) < MIN_OUTCOMES) return null;
  const ranked = [...versions].sort((a, b) => outcome(b) / b.sent - outcome(a) / a.sent);
  const [best, ...rest] = ranked;
  // It has to beat every other version, not just the worst one.
  const worstCase = Math.max(...rest.map((other) => proportionPValue(outcome(best), best.sent, outcome(other), other.sent)));
  return worstCase < SIGNIFICANT ? { id: best.id, confidence: 1 - worstCase } : null;
}

/**
 * The version that is ahead by more than chance would explain, or null while the test is
 * still too close or too small to call. Replies decide it when they separate the versions.
 * When they do not, opens may, and `metric` says so: an open is a weaker sign than a reply.
 */
export function likelyWinner(results: VersionResult[]): LikelyWinner | null {
  const versions = results.filter((version) => version.sent >= MIN_SENDS);
  if (versions.length < 2 || versions.length < results.filter((version) => version.sent > 0).length) return null;
  const byReplies = leader(versions, (version) => version.replies);
  if (byReplies) return { ...byReplies, metric: "replies" };
  const byOpens = leader(versions, (version) => version.opened);
  return byOpens ? { ...byOpens, metric: "opens" } : null;
}
