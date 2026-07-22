import { describe, it, expect, vi } from "vitest";
import { withTimeout, guard, WatchdogTimeoutError } from "@/lib/watchdog";

describe("withTimeout", () => {
  it("passes a promise that settles in time straight through", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "fast")).resolves.toBe("ok");
  });

  it("rejects a promise that never settles", async () => {
    // The exact failure that stalled outreach for two days: an await with no path to
    // settling. A try/catch cannot catch this — only a deadline can.
    const forever = new Promise<never>(() => { /* never resolves, never rejects */ });
    await expect(withTimeout(forever, 20, "hung IMAP session")).rejects.toBeInstanceOf(WatchdogTimeoutError);
  });

  it("names the operation and budget in the error, so a stall is diagnosable", () => {
    // Built directly rather than by waiting out a real deadline — the point is the message,
    // and a test that actually slept for the budget would be the slowest thing in the suite.
    const err = new WatchdogTimeoutError("Accepted-connections sync", 180_000);
    expect(err.message).toBe("Accepted-connections sync exceeded its 180s watchdog deadline");
    expect(err.label).toBe("Accepted-connections sync");
    expect(err.timeoutMs).toBe(180_000);
  });

  it("passes a genuine rejection through unchanged, distinct from a timeout", async () => {
    const boom = new Error("SMTP refused");
    await expect(withTimeout(Promise.reject(boom), 1000, "send")).rejects.toBe(boom);
    await expect(withTimeout(Promise.reject(boom), 1000, "send")).rejects.not.toBeInstanceOf(WatchdogTimeoutError);
  });
});

describe("guard", () => {
  it("reports success without throwing", async () => {
    await expect(guard("work", 1000, async () => "done")).resolves.toBe(true);
  });

  it("swallows a timeout so the caller's loop keeps running", async () => {
    // This is the property that matters: one hung subsystem must not halt the loop that
    // drives every other campaign.
    const forever = new Promise<never>(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(guard("hung", 20, () => forever)).resolves.toBe(false);
  });

  it("swallows a throw and reports it to the failure callback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn();
    const result = await guard("step", 1000, async () => { throw new Error("nope"); }, onFailure);
    expect(result).toBe(false);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "nope" }));
  });

  it("continues iterating after a failed item", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const processed: string[] = [];
    for (const item of ["a", "hang", "c"]) {
      await guard(item, 20, async () => {
        if (item === "hang") await new Promise<never>(() => {});
        processed.push(item);
      });
    }
    expect(processed).toEqual(["a", "c"]);
  });
});
