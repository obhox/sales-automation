import { describe, it, expect } from "vitest";
import { normalizeLinkedInUrl } from "@/lib/linkedin/url";

// The 8 URLs that produced net::ERR_TOO_MANY_REDIRECTS in the Amina Fasasi workspace.
// 7 of 8 were non-canonical hosts; only bodepedro was already canonical.
const REPORTED = [
  ["https://linkedin.com/in/gfagbure", "https://www.linkedin.com/in/gfagbure"],
  ["https://linkedin.com/in/dr-kehinde-osinowo-phd-5b881162", "https://www.linkedin.com/in/dr-kehinde-osinowo-phd-5b881162"],
  ["https://ch.linkedin.com/in/vivianne-ihekweazu-97a5583", "https://www.linkedin.com/in/vivianne-ihekweazu-97a5583"],
  ["https://linkedin.com/in/modupe-emmanuel-bb2231228", "https://www.linkedin.com/in/modupe-emmanuel-bb2231228"],
  ["https://ng.linkedin.com/in/stella-ndekile", "https://www.linkedin.com/in/stella-ndekile"],
  ["https://linkedin.com/in/damilola-roomes-872b59b6", "https://www.linkedin.com/in/damilola-roomes-872b59b6"],
  ["https://www.linkedin.com/in/bodepedro", "https://www.linkedin.com/in/bodepedro"],
  ["https://ng.linkedin.com/in/rotimi-osho-93819420", "https://www.linkedin.com/in/rotimi-osho-93819420"],
] as const;

describe("normalizeLinkedInUrl", () => {
  it.each(REPORTED)("canonicalises %s", (input, expected) => {
    expect(normalizeLinkedInUrl(input)).toBe(expected);
  });

  it("is idempotent", () => {
    const once = normalizeLinkedInUrl("https://ng.linkedin.com/in/stella-ndekile");
    expect(normalizeLinkedInUrl(once)).toBe(once);
  });

  it("adds a missing scheme", () => {
    expect(normalizeLinkedInUrl("linkedin.com/in/gfagbure")).toBe("https://www.linkedin.com/in/gfagbure");
  });

  it("upgrades http to https", () => {
    expect(normalizeLinkedInUrl("http://ng.linkedin.com/in/x")).toBe("https://www.linkedin.com/in/x");
  });

  it("strips tracking noise and trailing slashes from profile URLs", () => {
    expect(normalizeLinkedInUrl("https://ng.linkedin.com/in/stella-ndekile/?originalSubdomain=ng"))
      .toBe("https://www.linkedin.com/in/stella-ndekile");
  });

  it("preserves the query string on Sales Navigator deep links", () => {
    const salesNav = "https://www.linkedin.com/sales/lead/ACwAAA,NAME,abc?q=search&page=2";
    expect(normalizeLinkedInUrl(salesNav)).toBe(salesNav);
  });

  it("still rewrites the host on Sales Navigator links", () => {
    expect(normalizeLinkedInUrl("https://ng.linkedin.com/sales/lead/abc?q=1"))
      .toBe("https://www.linkedin.com/sales/lead/abc?q=1");
  });

  it("leaves non-LinkedIn hosts untouched", () => {
    for (const other of ["https://example.com/in/x", "https://notlinkedin.com/in/x"]) {
      expect(normalizeLinkedInUrl(other)).toBe(other);
    }
  });

  it("returns unparseable or empty input unchanged", () => {
    expect(normalizeLinkedInUrl("")).toBe("");
    expect(normalizeLinkedInUrl("   ")).toBe("");
    expect(normalizeLinkedInUrl("not a url at all")).toBe("not a url at all");
  });
});
