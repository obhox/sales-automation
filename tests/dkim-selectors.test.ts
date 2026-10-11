// Which DKIM selectors are tried for a domain whose provider has not been named.
import { describe, expect, it } from "vitest";
import { COMMON_DKIM_SELECTORS, lookupDomainDns, type DnsResolver } from "@/lib/email/dns";

/** A resolver that publishes one DKIM key, and records every name it was asked for. */
function resolver(published: { selector: string; record?: string }) {
  const asked: string[] = [];
  const key = published.record ?? "v=DKIM1; k=rsa; p=" + "A".repeat(392);
  const dns: DnsResolver = {
    txt: async (name) => {
      asked.push(name);
      if (name === `${published.selector}._domainkey.acmewidgets.com`) return [key];
      return [];
    },
    mx: async () => [{ exchange: "mx.acmewidgets.com", priority: 10 }],
  };
  return { dns, asked };
}

describe("the selectors tried when none is named", () => {
  it("finds a Migadu domain, which publishes under key1", async () => {
    // Migadu publishes its keys as CNAMEs under key1/key2/key3. Before they were on the
    // list, a correctly-signed Migadu domain reported DKIM as failing.
    const { dns } = resolver({ selector: "key1" });
    const result = await lookupDomainDns("acmewidgets.com", { resolver: dns });
    expect(result.dkim).toMatchObject({ status: "pass", selector: "key1" });
  });

  it("finds the other mailbox providers and ESPs on the list", async () => {
    for (const selector of ["key2", "key3", "fm1", "protonmail", "zoho", "titan1", "resend", "mandrill", "k2"]) {
      const { dns } = resolver({ selector });
      const result = await lookupDomainDns("acmewidgets.com", { resolver: dns });
      expect(result.dkim, selector).toMatchObject({ status: "pass", selector });
    }
  });

  it("still asks Google first, so the common case costs one lookup", async () => {
    const { dns, asked } = resolver({ selector: "google" });
    await lookupDomainDns("acmewidgets.com", { resolver: dns });
    expect(asked.filter((name) => name.includes("_domainkey"))).toEqual(["google._domainkey.acmewidgets.com"]);
  });

  it("asks only for a selector that was named, however long the list grows", async () => {
    // The guarantee a longer list must not erode: a workspace that knows its selector pays
    // for one lookup, not a sweep of every provider we have heard of.
    const { dns, asked } = resolver({ selector: "acme2026" });
    const result = await lookupDomainDns("acmewidgets.com", { resolver: dns, selector: "acme2026" });
    expect(result.dkim).toMatchObject({ status: "pass", selector: "acme2026" });
    expect(asked.filter((name) => name.includes("_domainkey"))).toEqual(["acme2026._domainkey.acmewidgets.com"]);
  });

  it("says which selectors it tried, so a miss is explainable", async () => {
    const { dns } = resolver({ selector: "nothing-published-here" });
    const result = await lookupDomainDns("acmewidgets.com", { resolver: dns });
    expect(result.dkim.status).toBe("fail");
    expect(result.dkim.selectors_checked).toEqual([...COMMON_DKIM_SELECTORS]);
  });

  it("keeps the list free of duplicates, which would each cost a wasted lookup", () => {
    expect(new Set(COMMON_DKIM_SELECTORS).size).toBe(COMMON_DKIM_SELECTORS.length);
  });
});
