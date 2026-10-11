// The Companies screen's wording and small rules: what a row of the list says, the facts
// on the enrichment card, the headcount bars, how a bounce is explained, what a look-up
// costs and what came of it, and what an edit sends. No browser and no database.
import { describe, expect, it } from "vitest";
import {
  EMPTY_COMPANY, FILTER_OPTIONS, SORT_OPTIONS, accountsNoun, addOutcome, batches, bounceDetail, bounceTitle, bouncingLine, changedFields, clearOutcome, contactsNoun, creditsNoun, departmentBars,
  departmentLabel, enrichNotes, enrichOutcome, enrichmentFields, firstOf, formOf, growthLabel, importOutcome, intentTone, markOf, markTone, metaLine, rangeLine, reverifyOutcome, searchOutcome,
  signalKind, signalSub, siteUrl, sourceLabel, subLine, techTone,
  type BounceFigures, type CompanyDetail, type EnrichPreview, type EnrichProgress,
} from "@/components/companies/model";
import { COMPANY_FILTERS, COMPANY_SORTS } from "@/lib/companies/overview";

const NOW = new Date("2026-10-10T12:00:00");

const company = (over: Partial<CompanyDetail["company"]> = {}): CompanyDetail["company"] => ({
  id: "co-1", name: "Northwind Logistics", domain: "northwindlog.com", website: null, linkedin_url: null, industry: "Freight & logistics", location: "Rotterdam, NL", city: "Rotterdam", country: "Netherlands",
  notes: null, description: null, logo_url: null, phone: null, employee_count: 1840, founded_year: 1998, annual_revenue: "310M", technologies: [], keywords: [],
  funding_stage: "Series D", funding_amount: "$120M", funding_at: "2026-09-12", funding_total: "$410M", departments: [], headcount_growth: 0.08, stock_symbol: null, stock_exchange: null,
  domain_rank: 41208, enrichment_source: "apollo", enriched_at: "2026-10-07T12:00:00", is_target: true, bouncing: false, bounce_cleared_at: null, intent: 86, created_at: "2026-09-01T09:00:00",
  ...over,
});

describe("what the list offers", () => {
  it("has a chip for every filter the server knows, and sorts only by keys it accepts", () => {
    expect(FILTER_OPTIONS.map((option) => option.value)).toEqual([...COMPANY_FILTERS]);
    for (const option of SORT_OPTIONS) {
      const [key, direction] = option.value.split(":");
      expect(Object.keys(COMPANY_SORTS)).toContain(key);
      expect(["asc", "desc"]).toContain(direction);
    }
    // The list opens sorted the way the first option says.
    expect(SORT_OPTIONS[0].value).toBe("intent:desc");
  });
});

describe("a row of the list", () => {
  it("says the domain and the size, or that there is no domain yet", () => {
    expect(subLine({ domain: "northwindlog.com", employee_count: 1840 })).toBe("northwindlog.com · 1,840 employees");
    expect(subLine({ domain: "solo.test", employee_count: 1 })).toBe("solo.test · 1 employee");
    expect(subLine({ domain: "northwindlog.com", employee_count: null })).toBe("northwindlog.com");
    expect(subLine({ domain: null, employee_count: 40 })).toBe("40 employees");
    expect(subLine({ domain: null, employee_count: null })).toBe("No domain yet");
  });

  it("counts in words", () => {
    expect(accountsNoun(3112)).toBe("3,112 accounts");
    expect(accountsNoun(1)).toBe("1 account");
    expect(contactsNoun(1)).toBe("1 contact");
    expect(contactsNoun(0)).toBe("0 contacts");
    expect(bouncingLine(2)).toBe("2 domains bouncing");
    expect(bouncingLine(1)).toBe("1 domain bouncing");
    expect(rangeLine(14, 3112)).toBe("14 of 3,112");
    expect(rangeLine(0, 0)).toBe("No companies");
  });

  it("colours intent as a contact's is coloured", () => {
    expect([86, 70, 69, 40, 39, 0].map(intentTone)).toEqual(["good", "good", "warn", "warn", "neutral", "neutral"]);
  });

  it("gives a company two letters and one colour, wherever it is shown", () => {
    expect(markOf("Northwind Logistics")).toBe("NL");
    expect(markOf("Veltrix")).toBe("VE");
    expect(markOf("Harbor & Co")).toBe("HC");
    expect(markOf("  ")).toBe("?");
    expect(markTone("Northwind Logistics")).toBe(markTone("Northwind Logistics"));
    expect(techTone("Salesforce")).toBe(techTone("Salesforce"));
  });
});

describe("a company's header", () => {
  it("opens the website as typed, or the domain", () => {
    expect(siteUrl({ website: "https://northwind.test/nl", domain: "northwind.test" })).toBe("https://northwind.test/nl");
    expect(siteUrl({ website: "northwind.test/nl", domain: null })).toBe("https://northwind.test/nl");
    expect(siteUrl({ website: null, domain: "northwind.test" })).toBe("https://northwind.test");
    expect(siteUrl({ website: " ", domain: null })).toBeNull();
  });

  it("counts its contacts and the campaigns they are in", () => {
    expect(metaLine({ contacts: { total: 4, items: [] }, campaigns: [{ id: "a", name: "A" }, { id: "b", name: "B" }] })).toBe("4 linked contacts · 2 active campaigns");
    expect(metaLine({ contacts: { total: 1, items: [] }, campaigns: [{ id: "a", name: "A" }] })).toBe("1 linked contact · 1 active campaign");
    expect(metaLine({ contacts: { total: 0, items: [] }, campaigns: [] })).toBe("0 linked contacts");
  });
});

describe("the enrichment card", () => {
  it("says where the fields came from and how long ago", () => {
    expect(sourceLabel(company(), NOW)).toBe("Source: Apollo · 3 d ago");
    // Filled as a side effect of a contact's look-up: the date was never recorded.
    expect(sourceLabel(company({ enriched_at: null }), NOW)).toBe("Source: Apollo");
    expect(sourceLabel(company({ enrichment_source: null, enriched_at: null }), NOW)).toBe("Not enriched yet");
    expect(sourceLabel(company({ enrichment_source: "a_new_source", enriched_at: null }), NOW)).toBe("Source: a_new_source");
  });

  it("words growth over a year", () => {
    expect(growthLabel(0.08)).toEqual({ label: "+8% YoY", tone: "good" });
    expect(growthLabel(-0.034)).toEqual({ label: "−3% YoY", tone: "warn" });
    expect(growthLabel(0.004)).toEqual({ label: "Flat YoY", tone: "neutral" });
    expect(growthLabel(null)).toBeNull();
  });

  it("lays out eight facts, with a dash for what is not known", () => {
    const [left, right] = enrichmentFields(company());
    expect(left).toEqual([
      { key: "Industry", value: "Freight & logistics" }, { key: "Employees", value: "1,840 (+8% YoY)" }, { key: "Revenue", value: "$310M" }, { key: "Founded", value: "1998" },
    ]);
    expect(right).toEqual([
      { key: "HQ", value: "Rotterdam, NL" }, { key: "Ownership", value: "Not listed" }, { key: "Last funding", value: "Series D · $120M" }, { key: "Domain rank", value: "41,208" },
    ]);
    const bare = enrichmentFields(company({
      industry: null, employee_count: null, annual_revenue: null, founded_year: null, location: null, city: null, country: null, funding_stage: null, funding_amount: null, funding_total: null,
      domain_rank: null, enriched_at: null, enrichment_source: null, headcount_growth: null,
    }));
    expect(bare.flat().map((field) => field.value)).toEqual(Array(8).fill("—"));
  });

  it("only claims a company is not listed once it has been looked up, and names the exchange when it is", () => {
    const ownership = (over: Partial<CompanyDetail["company"]>) => enrichmentFields(company(over))[1][1].value;
    expect(ownership({ stock_symbol: "NWL", stock_exchange: "nasdaq" })).toBe("Public · NASDAQ: NWL");
    expect(ownership({ stock_symbol: "NWL", stock_exchange: null })).toBe("Public · NWL");
    expect(ownership({ enriched_at: null })).toBe("—");
  });

  it("falls back for the facts that have another source", () => {
    const fields = (over: Partial<CompanyDetail["company"]>) => Object.fromEntries(enrichmentFields(company(over)).flat().map((field) => [field.key, field.value]));
    // No typed location: the city and country a look-up brought.
    expect(fields({ location: null }).HQ).toBe("Rotterdam, Netherlands");
    // No round on record, but a total.
    expect(fields({ funding_stage: null, funding_amount: null })["Last funding"]).toBe("$410M raised");
    expect(fields({ funding_amount: null })["Last funding"]).toBe("Series D");
    // A revenue that already carries its sign is left alone; flat growth is not worth a bracket.
    expect(fields({ annual_revenue: "€90M" }).Revenue).toBe("€90M");
    expect(fields({ headcount_growth: 0 }).Employees).toBe("1,840");
  });
});

describe("headcount by department", () => {
  it("shows the largest departments and gathers the rest", () => {
    const bars = departmentBars([
      { name: "operations", count: 820 }, { name: "sales", count: 240 }, { name: "engineering", count: 160 }, { name: "finance", count: 90 }, { name: "human_resources", count: 60 }, { name: "legal", count: 30 },
    ]);
    expect(bars.map((bar) => [bar.label, bar.count])).toEqual([["Operations", 820], ["Sales", 240], ["Engineering", 160], ["Finance", 90], ["Other", 90]]);
    // The bars are drawn against the largest, and the one a seller sells to stands out.
    expect(bars[0].share).toBe(1);
    expect(bars[1].share).toBeCloseTo(240 / 820);
    expect(bars.filter((bar) => bar.highlight).map((bar) => bar.label)).toEqual(["Sales"]);
  });

  it("shows up to five as they are, in order of size", () => {
    expect(departmentBars([{ name: "sales", count: 10 }, { name: "information_technology", count: 40 }]).map((bar) => bar.label)).toEqual(["Information technology", "Sales"]);
    expect(departmentBars([])).toEqual([]);
    expect(departmentLabel("customer_service")).toBe("Customer service");
  });

  it("folds a long list of chips", () => {
    expect(firstOf(["a", "b", "c", "d"], 3)).toEqual({ shown: ["a", "b", "c"], more: 1 });
    expect(firstOf(["a", "b"], 3)).toEqual({ shown: ["a", "b"], more: 0 });
  });
});

describe("a signal", () => {
  it("has an icon for each kind and falls back for one nobody defined", () => {
    expect(signalKind("funding")).toBe("funding");
    expect(signalKind("job_change")).toBe("job_change");
    expect(signalKind("something_new")).toBe("custom");
  });

  it("says what it is about and when", () => {
    expect(signalSub({ description: "Rotterdam", occurred_at: "2026-10-05T10:00:00" }, NOW)).toBe("Rotterdam · Oct 5");
    expect(signalSub({ description: "  ", occurred_at: "2026-10-05T10:00:00" }, NOW)).toBe("Oct 5");
    expect(signalSub({ description: null, occurred_at: "2025-07-19T10:00:00" }, NOW)).toBe("Jul 19, 2025");
  });
});

describe("the bounce warning", () => {
  const figures = (over: Partial<BounceFigures> = {}): BounceFigures => ({ bounces_7d: 3, sends_7d: 58, bounces_total: 3, last_bounce_at: "2026-10-08T12:00:00", contacts_with_email: 4, verifying: 0, ...over });

  it("names the domain", () => {
    expect(bounceTitle("northwindlog.com")).toBe("Email to northwindlog.com is bouncing");
    expect(bounceTitle(null)).toBe("Email to this company is bouncing");
  });

  it("says what happened and what it means for sending", () => {
    expect(bounceDetail(figures(), NOW)).toBe("3 hard bounces in the last 7 days (5.2% of 58 sends). Email steps for 4 contacts at this account are skipped while this is set; LinkedIn steps carry on.");
    expect(bounceDetail(figures({ bounces_7d: 1, sends_7d: 0, contacts_with_email: 1 }), NOW)).toBe("1 hard bounce in the last 7 days. Email steps for 1 contact at this account are skipped while this is set; LinkedIn steps carry on.");
    // Nothing lately: when the last one was.
    expect(bounceDetail(figures({ bounces_7d: 0, sends_7d: 0 }), NOW)).toMatch(/^The last hard bounce was 2 d ago\. /);
    // The flag was set before bounces were recorded one by one.
    expect(bounceDetail(figures({ bounces_7d: 0, bounces_total: 0, last_bounce_at: null, contacts_with_email: 0 }), NOW)).toBe("An address here hard-bounced. Email steps for anyone at this account are skipped while this is set; LinkedIn steps carry on.");
    expect(bounceDetail(figures({ verifying: 2 }), NOW)).toMatch(/ 2 addresses are being checked\.$/);
  });

  it("reports a re-verify and a cleared flag", () => {
    expect(reverifyOutcome({ queued: 3, restored: 1 }).title).toBe("3 addresses are being checked");
    expect(reverifyOutcome({ queued: 1, restored: 0 }).title).toBe("1 address is being checked");
    expect(reverifyOutcome({ queued: 0, restored: 0 })).toMatchObject({ title: "Nothing to check" });
    expect(clearOutcome({ cleared: true, restored: 2 }, "Northwind")).toEqual({ title: "Email to Northwind is no longer skipped", description: "2 colleagues' addresses are unchecked again. The address that bounced stays on the do-not-send list." });
    expect(clearOutcome({ cleared: true, restored: 1 }, "Northwind").description).toMatch(/^1 colleague's address is unchecked again\./);
    expect(clearOutcome({ cleared: true, restored: 0 }, "Northwind").description).toBe("The address that bounced stays on the do-not-send list.");
    expect(clearOutcome({ cleared: false, restored: 0 }, "Northwind")).toEqual({ title: "The flag was already clear" });
  });
});

describe("what Apollo costs, and what came of it", () => {
  const preview = (over: Partial<EnrichPreview> = {}): EnrichPreview => ({ apollo_connected: true, selected: 40, eligible: 36, eligible_ids: [], no_domain: 4, enriched_before: 30, capped: false, credits: 36, batch: 10, ...over });
  const progress = (over: Partial<EnrichProgress> = {}): EnrichProgress => ({ total: 40, done: 40, enriched: 36, notFound: 4, failed: 0, state: "finished", ...over });

  it("counts credits in words", () => {
    expect(creditsNoun(1)).toBe("1 Apollo credit");
    expect(creditsNoun(2000)).toBe("2,000 Apollo credits");
  });

  it("says who is left out of a look-up and who is being asked about again", () => {
    expect(enrichNotes(preview())).toEqual([
      "4 companies have no domain, so there is nothing to look up. Nothing is spent on them.",
      "30 were looked up before. Asking again spends a credit each and brings back what has changed.",
    ]);
    expect(enrichNotes(preview({ no_domain: 1, enriched_before: 1 }))).toEqual([
      "1 company has no domain, so there is nothing to look up. Nothing is spent on it.",
      "1 was looked up before. Asking again spends a credit each and brings back what has changed.",
    ]);
    expect(enrichNotes(preview({ no_domain: 0, enriched_before: 0 }))).toEqual([]);
    expect(enrichNotes(preview({ selected: 3112, eligible: 1900, no_domain: 100, enriched_before: 0, capped: true }))[1]).toBe("Only the first 2,000 of 3,112 are taken on at once. Run it again for the rest.");
  });

  it("sums a run of look-ups up in a sentence", () => {
    expect(enrichOutcome(progress())).toBe("36 companies enriched, 4 not known to Apollo");
    expect(enrichOutcome(progress({ enriched: 1, notFound: 0 }))).toBe("1 company enriched");
    expect(enrichOutcome(progress({ done: 20, enriched: 18, notFound: 1, failed: 1, state: "stopped" }))).toBe("18 companies enriched, 1 not known to Apollo, 1 failed, 20 not looked up");
  });

  it("splits ids into the batches a route takes", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 10)).toEqual([]);
    expect(batches([1, 2], 0)).toEqual([[1], [2]]);
  });

  it("reports a search for people", () => {
    expect(searchOutcome({ found: 0, added: 0 }).title).toBe("Apollo lists nobody senior at this domain");
    expect(searchOutcome({ found: 4, added: 0 })).toEqual({ title: "Nobody new", description: "Apollo named 4 people, all of them contacts already or put aside before." });
    expect(searchOutcome({ found: 4, added: 2 })).toEqual({ title: "2 people suggested", description: "2 more are contacts already or were put aside before." });
    expect(searchOutcome({ found: 1, added: 1 })).toEqual({ title: "1 person suggested", description: undefined });
  });

  it("reports adding suggested people", () => {
    expect(addOutcome({ added: 2, linked: 0, not_found: 0, failed: 0 })).toEqual({ title: "2 contacts added", description: undefined });
    expect(addOutcome({ added: 0, linked: 1, not_found: 1, failed: 0 })).toEqual({
      title: "1 contact added", description: "1 was a contact already and is now linked to this company. Apollo could not place 1, so that suggestion was put aside.",
    });
    expect(addOutcome({ added: 0, linked: 0, not_found: 2, failed: 1 })).toEqual({ title: "Nobody was added", description: "Apollo could not place 2, so those suggestions were put aside. 1 failed." });
  });
});

describe("a CSV import of companies", () => {
  it("is summed up in a sentence", () => {
    expect(importOutcome({ created: 1200, updated: 30, unchanged: 0, errors: [], ignored_columns: [] })).toBe("1,200 new, 30 updated");
    expect(importOutcome({ created: 1, updated: 0, unchanged: 5, errors: [], ignored_columns: [] })).toBe("1 new, 0 updated, 5 already up to date");
  });
});

describe("editing a company", () => {
  it("starts from what the company has", () => {
    expect(formOf(company({ notes: "Met in May", website: null }))).toEqual({
      name: "Northwind Logistics", domain: "northwindlog.com", website: "", industry: "Freight & logistics", location: "Rotterdam, NL", linkedin_url: "", notes: "Met in May",
    });
  });

  it("sends only what changed, so nothing it did not touch can be blanked", () => {
    const before = formOf(company({ notes: "Met in May" }));
    expect(changedFields(before, before)).toEqual({});
    expect(changedFields(before, { ...before, industry: "Freight forwarding " })).toEqual({ industry: "Freight forwarding" });
    // Emptied on purpose: sent as empty, which the route stores as nothing.
    expect(changedFields(before, { ...before, notes: "  " })).toEqual({ notes: "" });
    // Spaces alone are not a change.
    expect(changedFields(before, { ...before, name: " Northwind Logistics " })).toEqual({});
    expect(changedFields(EMPTY_COMPANY, { ...EMPTY_COMPANY, name: "New" })).toEqual({ name: "New" });
  });
});
