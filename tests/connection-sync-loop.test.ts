// Where CRM and calendar syncing runs. It used to sit inside the LinkedIn loop, which meant
// a hung browser session stalled it, every pass queued behind a whole campaign tick, and
// the health watch could not see it stall because it held no lease of its own.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { loopLabel } from "@/lib/system/health";

const RUNNER = fs.readFileSync(path.join(__dirname, "..", "lib", "linkedin", "runner.ts"), "utf8");

/** The body of one function in the runner, so a call can be attributed to the right loop. */
function bodyOf(name: string): string {
  const start = RUNNER.indexOf(`async function ${name}(`);
  const alt = start === -1 ? RUNNER.indexOf(`function ${name}(`) : start;
  expect(alt, `${name} should exist`).toBeGreaterThan(-1);
  const from = RUNNER.slice(alt);
  // Up to the next top-level function, which is enough to scope these assertions.
  const end = from.indexOf("\nasync function ", 1) === -1 ? from.indexOf("\nfunction ", 1) : from.indexOf("\nasync function ", 1);
  return end === -1 ? from : from.slice(0, end);
}

describe("connection sync", () => {
  it("has its own leased loop, so one stalling stalls only itself", () => {
    expect(RUNNER).toContain('startLoop("Connection sync", "connections-runner"');
  });

  it("is not inside the LinkedIn loop any more", () => {
    // The LinkedIn loop is strictly sequential and browser-bound. Nothing in a CRM or
    // calendar sync touches a LinkedIn session, so being in there only coupled their fates.
    expect(bodyOf("linkedinLoop")).not.toContain("syncDueConnections");
  });

  it("keeps its watchdog, so a hung provider cannot wedge its own loop either", () => {
    expect(RUNNER).toContain('guard("Connection sync", CONNECTION_SYNC_TIMEOUT_MS, () => syncDueConnections())');
  });

  it("is named for the health watch, which reports a stalled loop by label", () => {
    // Without an entry here the warning would name the raw lease, and a loop nobody
    // recognises is a loop nobody acts on.
    expect(loopLabel("connections-runner")).toBe("CRM and calendar sync");
  });

  it("left LinkedIn's own accepted-connections sync where it belongs", () => {
    // That is the thing the old comment described, and it genuinely does drive a browser,
    // so it stays sequential with the tick it runs inside.
    expect(RUNNER).toContain("syncAcceptedConnections(accountId)");
  });
});
