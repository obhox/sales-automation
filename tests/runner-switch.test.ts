// LINKI_RUNNER=off: a copy of the app that shows data and does nothing in the background.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureGlobalRunnerStarted, runnerDisabled } from "@/lib/linkedin/runner";

const g = global as typeof global & { __linkiGlobalRunnerStarted?: boolean };

afterEach(() => {
  delete process.env.LINKI_RUNNER;
  vi.restoreAllMocks();
});

describe("the runner off-switch", () => {
  it("is off only for the exact value", () => {
    expect(runnerDisabled()).toBe(false);
    process.env.LINKI_RUNNER = "off";
    expect(runnerDisabled()).toBe(true);
    for (const other of ["", "0", "false", "OFF", "on"]) {
      process.env.LINKI_RUNNER = other;
      expect(runnerDisabled(), `LINKI_RUNNER=${JSON.stringify(other)}`).toBe(false);
    }
  });

  it("starts no loop and leaves the door open for a later start", () => {
    process.env.LINKI_RUNNER = "off";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    ensureGlobalRunnerStarted();
    ensureGlobalRunnerStarted();
    // Not marked as started: nothing was started, and it says so once.
    expect(g.__linkiGlobalRunnerStarted).toBeFalsy();
    expect(log.mock.calls.filter(call => String(call[0]).includes("LINKI_RUNNER=off"))).toHaveLength(1);
  });
});
