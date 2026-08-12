import { describe, it, expect } from "vitest";
import { emailStatusFor, suppressionSourceFor } from "@/lib/email/verify";

describe("verification status mapping", () => {
  it("only a probed mailbox becomes 'verified'", () => {
    expect(emailStatusFor("valid")).toBe("verified");
  });

  it("an unprobed result is never labelled verified", () => {
    // The verification API confirms the DOMAIN can receive mail; it never asks whether the
    // mailbox exists. Reporting that as "verified" is what put a verified badge on an address
    // that did not exist and then hard-bounced.
    expect(emailStatusFor("unknown")).toBe("unverified");
  });

  it("maps the remaining verdicts to the statuses the runner gates on", () => {
    expect(emailStatusFor("invalid")).toBe("invalid");
    expect(emailStatusFor("catch_all")).toBe("catchall");
  });
});

describe("do-not-send policy", () => {
  it("suppresses proven-dead mailboxes", () => {
    expect(suppressionSourceFor("invalid")).toBe("verification");
  });

  it("suppresses catch-all domains under their own source so they can be released in bulk", () => {
    expect(suppressionSourceFor("catch_all")).toBe("catchall");
  });

  it("leaves inconclusive and confirmed addresses sendable", () => {
    expect(suppressionSourceFor("unknown")).toBeNull();
    expect(suppressionSourceFor("valid")).toBeNull();
  });
});
