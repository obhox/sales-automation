import { describe, it, expect } from "vitest";
import { zonedParts, zonedTimeToUtcMs, slotInWindow, localDayBoundsUtc } from "@/lib/outreach/schedule";

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

describe("localDayBoundsUtc", () => {
  const LA = "America/Los_Angeles";

  it("keeps the whole working window inside ONE counting day", () => {
    // The defect this fixes: daily counters compared date(created_at) = date('now') — a UTC
    // day — while the window is 09:00-18:00 Los Angeles. UTC midnight is 17:00 PDT, so every
    // cap reset an hour before the window closed and an account could send a second full
    // quota in that last hour. 10:00 and 17:30 PDT must land in the same day.
    const morning = new Date("2026-07-20T17:00:00Z"); // 10:00 PDT
    const lateAfternoon = new Date("2026-07-21T00:30:00Z"); // 17:30 PDT, still the 20th locally
    expect(localDayBoundsUtc(LA, morning)).toEqual(localDayBoundsUtc(LA, lateAfternoon));
  });

  it("brackets the instant it is given", () => {
    const at = new Date("2026-07-21T00:30:00Z");
    const { start, end } = localDayBoundsUtc(LA, at);
    const stamp = at.toISOString().slice(0, 19).replace("T", " ");
    expect(start <= stamp).toBe(true);
    expect(stamp < end).toBe(true);
  });

  it("emits SQLite datetime('now') format, not ISO", () => {
    // logs.created_at is written as "YYYY-MM-DD HH:MM:SS" UTC and compared lexicographically.
    // An ISO string with T and Z would sort wrongly against it.
    const { start, end } = localDayBoundsUtc(LA, new Date("2026-07-20T17:00:00Z"));
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(start).toBe("2026-07-20 07:00:00"); // 00:00 PDT = 07:00Z
    expect(end).toBe("2026-07-21 07:00:00");
  });

  it("spans exactly 24h on an ordinary day", () => {
    const { start, end } = localDayBoundsUtc(LA, new Date("2026-07-20T17:00:00Z"));
    const hours = (Date.parse(`${end}Z`.replace(" ", "T")) - Date.parse(`${start}Z`.replace(" ", "T"))) / 3_600_000;
    expect(hours).toBe(24);
  });

  it("stays a real calendar day across a DST transition", () => {
    // 2026-11-01: US clocks fall back, so the local day is 25h. Naive +86_400_000 would land
    // an hour into the wrong day and mis-bucket every send made in that hour.
    const duringFallBack = new Date("2026-11-01T15:00:00Z"); // 08:00 PST
    const { start, end } = localDayBoundsUtc(LA, duringFallBack);
    const hours = (Date.parse(`${end}Z`.replace(" ", "T")) - Date.parse(`${start}Z`.replace(" ", "T"))) / 3_600_000;
    expect(hours).toBe(25);
    expect(start).toBe("2026-11-01 07:00:00");
    expect(end).toBe("2026-11-02 08:00:00");
  });

  it("falls back to UTC for an invalid timezone", () => {
    const { start } = localDayBoundsUtc("Not/AZone", new Date("2026-07-20T17:00:00Z"));
    expect(start).toBe("2026-07-20 00:00:00");
  });
});
