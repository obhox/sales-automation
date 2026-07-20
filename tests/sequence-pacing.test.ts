import { describe, it, expect } from "vitest";
import { branchLandingIndex, emailSendGapMs } from "@/lib/outreach/sequence";

// The exact email track of workflow fd6905dd ("2026 Founders — Wave 4"), which sent
// 5 emails to one prospect in 38 minutes. Reply-gate branches jumped email->email,
// hopping over every delay.
const WAVE4_EMAIL_TRACK = [
  { step_type: "email" }, // 0  initial
  { step_type: "delay" }, // 1  172800  (2d)
  { step_type: "email" }, // 2  follow-up 1
  { step_type: "delay" }, // 3  259200  (3d)
  { step_type: "email" }, // 4  follow-up 2
  { step_type: "delay" }, // 5  345600  (4d)
  { step_type: "email" }, // 6  follow-up 3
  { step_type: "delay" }, // 7  432000  (5d)
  { step_type: "email" }, // 8  follow-up 4 (final)
];

describe("branchLandingIndex", () => {
  it("lands on the delay guarding the destination, not the destination itself", () => {
    // Branch 5bb8a300 -> 212bddf8 : email idx 0 jumping to email idx 2.
    expect(branchLandingIndex(WAVE4_EMAIL_TRACK, 0, 2)).toBe(1);
  });

  it("fixes every reply-gate hop in the collapsed workflow", () => {
    // The four production branches, as (current, destination) pairs.
    expect(branchLandingIndex(WAVE4_EMAIL_TRACK, 0, 2)).toBe(1);
    expect(branchLandingIndex(WAVE4_EMAIL_TRACK, 2, 4)).toBe(3);
    expect(branchLandingIndex(WAVE4_EMAIL_TRACK, 4, 6)).toBe(5);
    expect(branchLandingIndex(WAVE4_EMAIL_TRACK, 6, 8)).toBe(7);
  });

  it("leaves a destination that is already delay-guarded alone", () => {
    expect(branchLandingIndex(WAVE4_EMAIL_TRACK, 0, 1)).toBe(1);
  });

  it("never lands on or behind the current step", () => {
    // Adjacent hop: nothing to walk back over.
    expect(branchLandingIndex(WAVE4_EMAIL_TRACK, 1, 2)).toBe(2);
    for (let current = 0; current < WAVE4_EMAIL_TRACK.length - 1; current++) {
      for (let dest = current + 1; dest < WAVE4_EMAIL_TRACK.length; dest++) {
        expect(branchLandingIndex(WAVE4_EMAIL_TRACK, current, dest)).toBeGreaterThan(current);
      }
    }
  });

  it("collapses contiguous delays onto the first one", () => {
    // Chaining still works: executing that delay advances into the next, which
    // applies its own wait in turn.
    const steps = [{ step_type: "email" }, { step_type: "delay" }, { step_type: "delay" }, { step_type: "email" }];
    expect(branchLandingIndex(steps, 0, 3)).toBe(1);
  });

  it("is a no-op when the destination is not delay-guarded", () => {
    const steps = [{ step_type: "email" }, { step_type: "email" }, { step_type: "email" }];
    expect(branchLandingIndex(steps, 0, 2)).toBe(2);
  });
});

describe("emailSendGapMs", () => {
  const MIN = 4 * 60_000;

  it("spreads the remaining quota across the remaining window", () => {
    // 8 sends left, 8 hours left -> ~1 hour apart.
    expect(emailSendGapMs(8, 8, MIN)).toBe(3_600_000);
  });

  it("never returns less than the floor, even with no window left", () => {
    expect(emailSendGapMs(0, 8, MIN)).toBe(MIN);
    expect(emailSendGapMs(0.1, 50, MIN)).toBe(MIN);
  });

  it("would have prevented the observed 8-sends-in-11-minutes burst", () => {
    // Observed: account 9f3c5c46 sent 8 in 11 min => ~94s apart.
    const observedGapMs = (11 * 60_000) / 8;
    expect(emailSendGapMs(8, 8, MIN)).toBeGreaterThan(observedGapMs);
    // Even in the worst case (window nearly over) the floor still dominates.
    expect(emailSendGapMs(0, 8, MIN)).toBeGreaterThan(observedGapMs);
  });

  it("applies jitter so gaps are not uniform", () => {
    expect(emailSendGapMs(8, 8, MIN, 90_000)).toBe(3_690_000);
    expect(emailSendGapMs(8, 8, MIN, -90_000)).toBe(3_510_000);
  });

  it("treats a zero or negative remaining-send count safely", () => {
    expect(emailSendGapMs(8, 0, MIN)).toBe(8 * 3_600_000);
    expect(Number.isFinite(emailSendGapMs(8, -3, MIN))).toBe(true);
  });
});
