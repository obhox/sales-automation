/**
 * Pure sequence/pacing helpers used by the campaign runner. Kept out of the runner so
 * they can be unit tested without pulling in Playwright.
 */

/**
 * Resolve where a branch jump should actually land.
 *
 * A workflow branch names an ACTION step, but a sequence models "wait N days, then do X"
 * as [delay(N), X]. Jumping straight to X discards the wait, because X's own
 * delay_seconds is 0 and the runner then writes next_step_at = NULL (meaning "run now").
 * In production this collapsed a reply-gated 5-email sequence into ~40 minutes: every
 * follow-up fired back to back because each reply-gate branch hopped over its delay.
 *
 * Landing on the delay that guards the destination lets the normal wait/advance path
 * apply it. Walks back only over delay steps still ahead of currentIndex, so forward-only
 * branching is preserved and a branch can never land on or behind the current step.
 */
export function branchLandingIndex(
  steps: ReadonlyArray<{ step_type: string }>,
  currentIndex: number,
  branchIndex: number,
): number {
  let landing = branchIndex;
  while (landing - 1 > currentIndex && steps[landing - 1]?.step_type === "delay") landing -= 1;
  return landing;
}

/**
 * Gap to leave between two sends from the same email account.
 *
 * The daily cap is a ceiling, not a rate: alone it lets an account emit its whole
 * allowance in one burst and then idle. Spread the remaining quota over the remaining
 * working window, floored at minGapMs so a nearly-exhausted window cannot collapse the
 * gap to zero. `jitterMs` is added by the caller so spacing is not uniform - uniform
 * gaps are themselves a detectable automation signature.
 */
export function emailSendGapMs(
  remainingHours: number,
  remainingSends: number,
  minGapMs: number,
  jitterMs = 0,
): number {
  const spreadMs = (Math.max(0, remainingHours) * 3_600_000) / Math.max(1, remainingSends);
  return Math.max(minGapMs, spreadMs) + jitterMs;
}
