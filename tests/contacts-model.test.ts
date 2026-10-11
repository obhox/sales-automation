// The Contacts screen's wording and small rules: what a filter chip says, which columns
// a stored layout keeps, how intent, email checks and last activity read, and what the
// bulk actions report. No browser and no database.
import { describe, expect, it } from "vitest";
import {
  COLUMNS, DEFAULT_COLUMNS, FILTERS, batches, emailState, enrichOutcome, enrichSkips, enrolOutcome, fieldKeyFor, filterOptions, filterValueLabel, intentTone,
  lastActivityLabel, listsSummary, rangeLine, readLayout, sameQuery, viewQuery, type ContactFacets, type EnrichPreview, type EnrichProgress,
} from "@/components/contacts/model";

const FACETS: ContactFacets = {
  total: 320, verifying: 0,
  lists: [{ id: "list-1", name: "Enterprise EU", count: 148 }],
  campaigns: [{ id: "wf-1", name: "Q4 Logistics Ops", status: "running", run_id: "run-1" }, { id: "wf-2", name: "Old push", status: "completed", run_id: null }],
  members: [{ id: "user-1", name: "Priya Raghavan" }],
  tags: [{ id: "tag-1", name: "Champion", color: "good", count: 12 }, { id: "tag-2", name: "Odd colour", color: "chartreuse", count: 0 }],
  countries: ["Germany", "Spain"], seniorities: ["c_suite", "vp", "wizard"],
  apollo_connected: false, custom_fields: 0, max_selection: 5000,
};
const def = (key: string) => FILTERS.find((filter) => filter.key === key)!;

describe("a filter chip", () => {
  it("says what it is filtering by, in words", () => {
    expect(filterValueLabel(def("email"), "all", FACETS)).toBe("Any");
    expect(filterValueLabel(def("owner"), "all", FACETS)).toBe("Anyone");
    expect(filterValueLabel(def("email"), "catchall", FACETS)).toBe("Catch-all");
    expect(filterValueLabel(def("linkedin"), "invite_sent", FACETS)).toBe("Invite sent");
    expect(filterValueLabel(def("campaign"), "wf-1", FACETS)).toBe("Q4 Logistics Ops");
    expect(filterValueLabel(def("campaign"), "none", FACETS)).toBe("In no campaign");
    expect(filterValueLabel(def("owner"), "user-1", FACETS)).toBe("Priya Raghavan");
    expect(filterValueLabel(def("tag"), "tag-1", FACETS)).toBe("Champion");
    expect(filterValueLabel(def("seniority"), "c_suite", FACETS)).toBe("C-suite");
    expect(filterValueLabel(def("seniority"), "wizard", FACETS)).toBe("wizard");
  });

  it("shows an intent threshold that is not one of the offered ones", () => {
    expect(filterValueLabel(def("intent"), "60", FACETS)).toBe("≥ 60");
    expect(filterValueLabel(def("intent"), "55", FACETS)).toBe("≥ 55");
  });

  it("says so when the thing it names is gone, and waits while the choices load", () => {
    expect(filterValueLabel(def("tag"), "deleted-tag", FACETS)).toBe("No longer here");
    expect(filterValueLabel(def("tag"), "tag-1", undefined)).toBe("…");
  });

  it("offers campaigns with their state, and a tag in a colour the screen can draw", () => {
    const campaigns = filterOptions("campaign", FACETS);
    expect(campaigns.map((option) => option.label)).toEqual(["In a campaign", "In no campaign", "Q4 Logistics Ops", "Old push"]);
    expect(campaigns[2]).toMatchObject({ aside: "Running", dot: "brand", separated: true });
    expect(filterOptions("tag", FACETS).map((option) => option.dot)).toEqual([undefined, "good", "neutral"]);
  });

  it("is one of five that are always in the bar, in the frame's order", () => {
    expect(FILTERS.filter((filter) => filter.pinned).map((filter) => filter.name)).toEqual(["Email", "LinkedIn", "Campaign", "Intent", "Owner"]);
  });
});

describe("the table's layout", () => {
  it("starts with the columns of the design", () => {
    expect(DEFAULT_COLUMNS).toEqual(["company", "email", "linkedin", "list", "campaign", "intent", "last_activity"]);
    expect(readLayout(null)).toEqual({ columns: DEFAULT_COLUMNS, density: "regular" });
  });

  it("keeps what it knows from a stored layout, in the table's own order", () => {
    expect(readLayout({ columns: ["tags", "company", "no_such_column"], density: "compact" })).toEqual({ columns: ["company", "tags"], density: "compact" });
    expect(readLayout({ columns: [], density: "enormous" })).toEqual({ columns: [], density: "regular" });
    expect(readLayout("nonsense")).toEqual({ columns: DEFAULT_COLUMNS, density: "regular" });
  });

  it("lets every column be sorted only by a key the API accepts", () => {
    const accepted = ["name", "company", "email", "intent", "last_activity", "created"];
    for (const column of COLUMNS) if (column.sortKey) expect(accepted).toContain(column.sortKey);
  });
});

describe("a saved view", () => {
  it("stores the address-bar state without the page number", () => {
    expect(viewQuery({ page: "3", q: "revops", email: "verified" })).toEqual({ q: "revops", email: "verified" });
  });

  it("matches the screen when the same entries are set, in any order", () => {
    expect(sameQuery({ q: "revops", email: "verified" }, { email: "verified", q: "revops" })).toBe(true);
    expect(sameQuery({ q: "revops" }, { q: "revops", email: "verified" })).toBe(false);
    expect(sameQuery({}, {})).toBe(true);
  });
});

describe("cells", () => {
  it("colours intent as the design does", () => {
    expect([86, 70, 69, 40, 39, 0].map(intentTone)).toEqual(["good", "good", "warn", "warn", "neutral", "neutral"]);
  });

  it("reads an email check without calling a passed check a warning", () => {
    expect(emailState("verified")).toMatchObject({ kind: "verified", tone: "good" });
    expect(emailState("checked")).toMatchObject({ kind: "checked", tone: "good" });
    expect(emailState("catchall")).toMatchObject({ kind: "catchall", tone: "warn" });
    expect(emailState("invalid")).toMatchObject({ kind: "invalid", tone: "bad" });
    expect(emailState(null)).toMatchObject({ kind: "unchecked", tone: "neutral" });
    expect(emailState("something new")).toMatchObject({ kind: "unchecked" });
  });

  it("writes the last activity the short way", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(lastActivityLabel("2026-10-10 11:58:00", now)).toBe("2m ago");
    expect(lastActivityLabel("2026-10-10 11:59:50", now)).toBe("Just now");
    expect(lastActivityLabel(null, now)).toBe("—");
    expect(lastActivityLabel("2026-09-01 09:00:00", now)).toBe("Sep 1");
  });

  it("names the first list and counts the rest", () => {
    expect(listsSummary([])).toBeNull();
    expect(listsSummary([{ name: "Enterprise EU" }])).toEqual({ first: "Enterprise EU", more: 0 });
    expect(listsSummary([{ name: "A" }, { name: "B" }, { name: "C" }])).toEqual({ first: "A", more: 2 });
  });

  it("says which rows are showing", () => {
    expect(rangeLine(1, 50, 16, 148)).toBe("Showing 1–16 of 148 contacts");
    expect(rangeLine(3, 50, 48, 12480)).toBe("Showing 101–148 of 12,480 contacts");
    expect(rangeLine(1, 50, 1, 1)).toBe("Showing 1–1 of 1 contact");
    expect(rangeLine(1, 50, 0, 0)).toBe("No contacts");
  });
});

describe("what bulk actions report", () => {
  const preview: EnrichPreview = { apollo_connected: true, selected: 12, eligible: 8, eligible_ids: [], tried_before: 2, have_email: 3, no_profile_address: 1, credits: 8, batch: 25 };

  it("says why part of a selection is not looked up", () => {
    expect(enrichSkips(preview)).toEqual(["3 contacts already have an email address", "1 contact has no LinkedIn address to look up"]);
    expect(enrichSkips({ ...preview, have_email: 0, no_profile_address: 0 })).toEqual([]);
  });

  it("sums up an enrichment run, finished or stopped", () => {
    const run: EnrichProgress = { total: 8, done: 8, enriched: 6, emails: 5, notFound: 2, failed: 0, state: "finished" };
    expect(enrichOutcome(run)).toBe("Looked up 8 contacts: 5 emails found, 2 not on Apollo");
    expect(enrichOutcome({ ...run, done: 4, emails: 1, notFound: 0, failed: 1, state: "stopped" })).toBe("Stopped after 4 of 8: 1 email found, 1 could not be looked up");
  });

  it("cuts a selection into the batches the route takes", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 25)).toEqual([]);
  });

  it("says who was added to a campaign and who was passed over", () => {
    expect(enrolOutcome({ enrolled: 3, skipped_already_enrolled: 1, skipped_active_elsewhere: 2 }, "Q4 Logistics Ops")).toBe("3 contacts added to Q4 Logistics Ops · 1 already in it · 2 still active in another campaign");
    expect(enrolOutcome({ enrolled: 1, skipped_already_enrolled: 0, skipped_active_elsewhere: 0 }, "Q4")).toBe("1 contact added to Q4");
  });

  it("suggests a key for a custom field from its name", () => {
    expect(fieldKeyFor("Renewal date")).toBe("renewal_date");
    expect(fieldKeyFor("  ARR (USD) ")).toBe("arr_usd");
    expect(fieldKeyFor("2027 plan")).toBe("field_2027_plan");
    expect(fieldKeyFor("—")).toBe("");
  });
});
