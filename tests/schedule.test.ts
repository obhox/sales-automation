import { describe, it, expect } from "vitest";
import { zonedParts, zonedTimeToUtcMs, slotInWindow } from "@/lib/outreach/schedule";

const NY = "America/New_York";
const LAGOS = "Africa/Lagos"; // UTC+1, no DST

describe("zonedParts", () => {
  it("reads the wall clock in the target zone, not the host zone", () => {
    // 2026-07-20T16:00Z is 12:00 in New York (EDT, UTC-4).
    const p = zonedParts(NY, new Date("2026-07-20T16:00:00Z"));
    expect(p.hour).toBe(12);
    expect(p.year).toBe(2026);
    expect(p.month).toBe(7);
    expect(p.day).toBe(20);
    expect(p.isoWeekday).toBe(1); // Monday
  });

  it("reports the correct calendar day across a zone boundary", () => {
    // 03:00Z on the 21st is still 23:00 on the 20th in New York.
    const p = zonedParts(NY, new Date("2026-07-21T03:00:00Z"));
    expect(p.day).toBe(20);
    expect(p.hour).toBe(23);
  });

  it("falls back to UTC for an invalid timezone", () => {
    const p = zonedParts("Not/AZone", new Date("2026-07-20T16:00:00Z"));
    expect(p.hour).toBe(16);
  });
});

describe("zonedTimeToUtcMs", () => {
  it("resolves a wall-clock hour to the right UTC instant", () => {
    // 09:00 in New York on 2026-07-20 (EDT) === 13:00Z.
    const ms = zonedTimeToUtcMs(NY, 2026, 7, 20, 9);
    expect(new Date(ms).toISOString()).toBe("2026-07-20T13:00:00.000Z");
  });

  it("handles a positive offset zone", () => {
    // 09:00 Lagos (UTC+1) === 08:00Z.
    const ms = zonedTimeToUtcMs(LAGOS, 2026, 7, 20, 9);
    expect(new Date(ms).toISOString()).toBe("2026-07-20T08:00:00.000Z");
  });

  it("round-trips through zonedParts", () => {
    for (const tz of [NY, LAGOS, "UTC", "Asia/Tokyo"]) {
      const ms = zonedTimeToUtcMs(tz, 2026, 7, 20, 14.5);
      const p = zonedParts(tz, new Date(ms));
      expect(p.hour + p.minute / 60).toBeCloseTo(14.5, 2);
      expect(p.day).toBe(20);
    }
  });
});

describe("slotInWindow", () => {
  const dayInNy = new Date("2026-07-20T16:00:00Z"); // noon in NY

  it("generates slots inside the account's window, in the account's zone", () => {
    for (let i = 0; i < 40; i++) {
      const iso = slotInWindow(NY, dayInNy, 9, 18);
      expect(iso).not.toBeNull();
      const p = zonedParts(NY, new Date(iso!));
      const frac = p.hour + p.minute / 60;
      expect(frac).toBeGreaterThanOrEqual(9);
      expect(frac).toBeLessThan(18);
    }
  });

  it("never returns a slot before the notBefore clamp", () => {
    // This is the reschedule-loop fix: woken at 03:00 NY for a 09:00-18:00 account,
    // the old code could return a time seconds away that was STILL outside the window.
    const at3amNy = new Date("2026-07-20T07:00:00Z"); // 03:00 NY
    const notBefore = at3amNy.getTime();
    for (let i = 0; i < 40; i++) {
      const iso = slotInWindow(NY, at3amNy, 9, 18, notBefore);
      expect(iso).not.toBeNull();
      const ms = Date.parse(iso!);
      expect(ms).toBeGreaterThanOrEqual(notBefore);
      // and crucially, inside the window rather than seconds from now
      const frac = zonedParts(NY, new Date(ms)).hour;
      expect(frac).toBeGreaterThanOrEqual(9);
      expect(frac).toBeLessThan(18);
    }
  });

  it("clamps the lower bound to now when already mid-window", () => {
    const midWindow = new Date("2026-07-20T18:00:00Z"); // 14:00 NY
    const iso = slotInWindow(NY, midWindow, 9, 18, midWindow.getTime());
    expect(Date.parse(iso!)).toBeGreaterThanOrEqual(midWindow.getTime());
  });

  it("returns null once the window has closed", () => {
    const evening = new Date("2026-07-20T23:00:00Z"); // 19:00 NY, past an 18:00 close
    expect(slotInWindow(NY, evening, 9, 18, evening.getTime())).toBeNull();
  });

  it("returns null for an inverted window rather than a bogus time", () => {
    expect(slotInWindow(NY, dayInNy, 18, 9)).toBeNull();
  });

  it("is deterministic given a seeded random", () => {
    const a = slotInWindow(NY, dayInNy, 9, 18, undefined, () => 0);
    expect(new Date(a!).toISOString()).toBe("2026-07-20T13:00:00.000Z"); // 09:00 NY
  });
});
