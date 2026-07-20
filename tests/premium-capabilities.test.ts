import { describe, it, expect } from "vitest";
import { premium, hasPremium, capabilities } from "@/lib/premium";

// Guards the open-core capability boundary. The danger this protects against is
// advertising a capability the build cannot actually perform: the runner skips
// steps whose surface is missing (e.g. "Sales Nav InMail is not implemented in
// this build"), so a capability flag that outruns the implementation produces
// campaigns with steps that silently never execute.

describe("premium capability boundary", () => {
  it("derives every capability from an actual implementation", () => {
    expect(capabilities.ai).toBe(!!premium.ai);
    expect(capabilities.replies).toBe(!!premium.replies);
    expect(capabilities.inmail).toBe(!!premium.inmail);
  });

  it("exposes the surfaces that ship working community implementations", () => {
    expect(premium.ai).toBeDefined();
    expect(premium.replies).toBeDefined();
    expect(capabilities.ai).toBe(true);
    expect(capabilities.replies).toBe(true);
    expect(capabilities.crm).toBe(true);
    expect(capabilities.mcp).toBe(true);
  });

  it("keeps InMail disabled while no implementation exists", () => {
    // If someone adds a real InMailSurface, flip this expectation deliberately -
    // do not force capabilities.inmail true on its own.
    expect(premium.inmail).toBeUndefined();
    expect(capabilities.inmail).toBe(false);
  });

  it("unlocks the optional UI surfaces", () => {
    // hasPremium is UI-only; the runner must never gate on it.
    expect(hasPremium).toBe(true);
  });

  it("exposes the AI writer functions the UI toggles depend on", () => {
    expect(typeof premium.ai?.writeEmail).toBe("function");
    expect(typeof premium.ai?.writeLinkedInMessage).toBe("function");
    expect(typeof premium.ai?.getAgentConfig).toBe("function");
  });
});
