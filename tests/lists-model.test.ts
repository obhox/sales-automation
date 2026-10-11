// The Lists screens' wording and small rules: what a row says about a list, the figures
// across the top, what a selection adds up to, and how an import reads while it runs. No
// browser and no database. (How a CSV file's columns are matched to contact fields is in
// csv-imports.test.ts and csv-import-model.test.ts, with the import page that does it.)
import { describe, expect, it } from "vitest";
import {
  SORT_OPTIONS, SOURCE_OPTIONS, STATE_LABEL, STATE_OPTIONS, capLine, detailKpis, enrichedShare, footerLine, importBanner, jobIsLive, jobLine, jobState, kpis,
  ownerLine, pastCampaigns, planLine, runState, selectionLine, sourceLine, totalsLine, verifiedShare,
  type ImportJob, type ImportStatus, type ListDetail, type ListRow, type ListsOverlap, type ListsSummary,
} from "@/components/lists/model";
import { LIST_SORTS, LIST_SOURCES, LIST_STATES } from "@/lib/lists/overview";

const NOW = new Date("2026-10-10T12:00:00");

const list = (over: Partial<ListRow> = {}): ListRow => ({
  id: "list-1", name: "Enterprise EU", description: null, purpose: null, created_at: "2026-09-12T09:00:00", updated_at: null,
  contacts: 100, with_email: 80, enriched: 90, valid: 60, risky: 10, invalid: 4, enrichable: 6, verifiable: 6, verifying: 0,
  owner: { id: "user-1", name: "Mia Chen" }, source: "sales_navigator", source_detail: null, sales_nav_url: null, last_synced_at: null, archived: false,
  state: "ready", campaign: null, past_campaigns: 0, import: null,
  ...over,
} as ListRow);

const summary = (over: Partial<ListsSummary> = {}): ListsSummary => ({
  lists: 12, contacts: 48920, with_email: 40000, enriched: 41200, valid: 31000, risky: 2100, invalid: 900, enrichable: 0, verifiable: 0, verifying: 0,
  in_campaigns: 12230, apollo_lookups: 1840, apollo_connected: true, members: [], imports: { active: 0, today: 0, daily_cap: 1500 },
  ...over,
} as ListsSummary);

describe("what the screen offers", () => {
  it("has a label for every source and state the server knows, and sorts only by keys it accepts", () => {
    expect(SOURCE_OPTIONS.map((option) => option.value)).toEqual(["all", ...LIST_SOURCES]);
    expect(STATE_OPTIONS.map((option) => option.value)).toEqual(["all", ...LIST_STATES]);
    for (const state of LIST_STATES) expect(STATE_LABEL[state].label).toBeTruthy();
    for (const option of SORT_OPTIONS) {
      const [key, direction] = option.value.split(":");
      expect(LIST_SORTS as readonly string[]).toContain(key);
      expect(["asc", "desc"]).toContain(direction);
    }
  });
});

describe("a row of the lists table", () => {
  it("says who looks after the list and when it was made", () => {
    expect(ownerLine(list(), NOW)).toBe("Mia Chen · created Sep 12");
    expect(ownerLine(list({ owner: null }), NOW)).toBe("No owner · created Sep 12");
    expect(ownerLine(list({ owner: null, created_at: null as unknown as string }), NOW)).toBe("No owner");
  });

  it("says where the list was filled from and how lately", () => {
    expect(sourceLine(list({ last_synced_at: "2026-10-10T10:00:00" }), NOW)).toBe("synced 2 h ago");
    expect(sourceLine(list(), NOW)).toBe("not imported yet");
    expect(sourceLine(list({ source: "csv", source_detail: "webinar_sep24.csv", last_synced_at: "2026-09-24T10:00:00" }), NOW)).toBe("webinar_sep24.csv");
    expect(sourceLine(list({ source: "csv", last_synced_at: "2026-09-24T10:00:00" }), NOW)).toBe("imported Sep 24");
    expect(sourceLine(list({ source: "manual" }), NOW)).toBe("");
    expect(sourceLine(list({ source: "manual", last_synced_at: "2026-10-01T10:00:00" }), NOW)).toBe("last added to Oct 1");
    // An import under way matters more than when the last one finished.
    expect(sourceLine(list({ last_synced_at: "2026-10-10T10:00:00", import: { id: "job", status: "running", imported: 5, total: 40, scheduled_for: null } }), NOW)).toBe("importing now");
    expect(sourceLine(list({ import: { id: "job", status: "scheduled", imported: 0, total: 0, scheduled_for: "2026-10-11" } }), NOW)).toBe("import queued");
  });

  it("draws how complete a list is, and has nothing to draw for an empty one", () => {
    expect(enrichedShare(list())).toMatchObject({ ratio: 0.9, label: "90%", tone: "good" });
    expect(enrichedShare(list({ enriched: 60 }))).toMatchObject({ label: "60%", tone: "brand" });
    expect(enrichedShare(list({ enriched: 20 }))).toMatchObject({ label: "20%", tone: "warn" });
    expect(enrichedShare(list({ contacts: 0, enriched: 0 }))).toMatchObject({ ratio: null, label: "—" });
    // Verified is a share of the whole list, so a list half without addresses cannot read 100%.
    expect(verifiedShare(list())).toMatchObject({ ratio: 0.6, label: "60%" });
    expect(verifiedShare(list({ with_email: 0, valid: 0 }))).toMatchObject({ ratio: null, note: "No email addresses" });
    expect(verifiedShare(list({ contacts: 0, with_email: 0, valid: 0 }))).toMatchObject({ ratio: null, note: null });
  });

  it("counts the campaigns that have used a list", () => {
    expect(pastCampaigns(0)).toBe("—");
    expect(pastCampaigns(1)).toBe("1 past campaign");
    expect(pastCampaigns(3)).toBe("3 past campaigns");
  });
});

describe("the figures across every list", () => {
  it("name the lists and contacts in the title and under the table", () => {
    expect(totalsLine(summary())).toBe("12 lists · 48,920 contacts");
    expect(totalsLine(summary({ lists: 1, contacts: 1 }))).toBe("1 list · 1 contact");
    expect(footerLine(8, 12, summary())).toBe("Showing 8 of 12 lists · 48,920 contacts in all");
    expect(footerLine(8, 12, undefined)).toBe("Showing 8 of 12 lists");
    expect(footerLine(0, 0, summary())).toBe("No lists");
  });

  it("are five, each with a line under it", () => {
    const cards = kpis(summary());
    expect(cards.map((card) => card.label)).toEqual(["Contacts in lists", "Enriched", "Verified emails", "In active campaigns", "Apollo look-ups"]);
    expect(cards.map((card) => card.value)).toEqual(["48,920", "84.2%", "63.4%", "12,230", "1,840"]);
    expect(cards[0].note).toBe("across 12 lists");
    expect(cards[1].note).toBe("41,200 of 48,920 contacts");
    expect(cards[2]).toMatchObject({ note: "31,000 valid · 2,100 risky", noteTone: "warn" });
    expect(cards[3].note).toBe("25% of contacts in lists");
    expect(cards[4].note).toBe("in 30 days · one credit each");
  });

  it("say so when there is nothing to count, or Apollo is not connected", () => {
    const cards = kpis(summary({ lists: 0, contacts: 0, enriched: 0, valid: 0, risky: 0, in_campaigns: 0, apollo_lookups: 0, apollo_connected: false }));
    expect(cards.map((card) => card.value)).toEqual(["0", "—", "—", "0", "0"]);
    expect(cards[2].noteTone).toBeUndefined();
    expect(cards[3].note).toBe("No contacts yet");
    expect(cards[4].note).toBe("Apollo is not connected");
  });
});

describe("a selection of lists", () => {
  const overlap = (over: Partial<ListsOverlap> = {}) => ({ lists: 3, memberships: 7624, in_several: 212, contacts: 7412, with_email: 6128, ...over } as ListsOverlap);

  it("adds up with each contact counted once, and says how many are in several of the lists", () => {
    expect(selectionLine(overlap())).toBe("7,412 contacts · 1,284 without an email · 212 in more than one list");
  });

  it("has no overlap to speak of for one list", () => {
    expect(selectionLine(overlap({ lists: 1, in_several: 0, contacts: 1, with_email: 1 }))).toBe("1 contact · 0 without an email");
  });
});

describe("an import job", () => {
  const job = (over: Partial<ImportJob> = {}): ImportJob => ({
    id: "job-1", list_id: "list-1", list_name: "Enterprise EU", status: "running", phase: null, page: 3, total_pages: 12, total: 290, imported: 60, skipped: 0,
    error: null, scheduled_for: null, batch_index: 1, started_at: "2026-10-10T11:00:00", finished_at: null, ...over,
  });

  it("is live while it runs or waits, and has a word for every way it can end", () => {
    expect(jobIsLive(job())).toBe(true);
    expect(jobIsLive(job({ status: "scheduled" }))).toBe(true);
    expect(jobIsLive(job({ status: "done" }))).toBe(false);
    expect(jobState("done")).toMatchObject({ label: "Finished", tone: "good" });
    expect(jobState("canceled").label).toBe("Cancelled");
    expect(jobState("error")).toMatchObject({ label: "Failed", tone: "bad" });
    expect(jobState("something_new")).toEqual({ label: "something_new", tone: "neutral" });
  });

  it("says how far it has got", () => {
    expect(jobLine(job(), NOW)).toBe("60 imported of 290 · page 3 of 12");
    expect(jobLine(job({ total: 0, total_pages: 0 }), NOW)).toBe("60 imported");
    expect(jobLine(job({ status: "scheduled", scheduled_for: "2026-10-11", batch_index: 2 }), NOW)).toBe("Batch 2 · starts Oct 11");
    expect(jobLine(job({ status: "scheduled" }), NOW)).toBe("waiting its turn");
    expect(jobLine(job({ status: "done", imported: 290, skipped: 12, finished_at: "2026-10-10T09:00:00" }), NOW)).toBe("290 imported, 12 already there · 3 h ago");
    expect(jobLine(job({ status: "error", error: "The account is signed out of LinkedIn" }), NOW)).toBe("The account is signed out of LinkedIn");
    expect(jobLine(job({ status: "error" }), NOW)).toBe("The import stopped with an error");
  });

  it("is counted against the daily cap", () => {
    expect(capLine(340, 1500)).toBe("340 of 1,500 imported today");
  });
});

describe("the strip above a list being imported", () => {
  const status = (over: Partial<ImportStatus> = {}): ImportStatus => ({ status: "running", id: "job-1", phase: null, count: 60, total: 290, imported: 55, dailyCap: 1500, ...over });

  it("is not shown when nothing is happening", () => {
    expect(importBanner(undefined, NOW)).toBeNull();
    expect(importBanner({ status: "idle", dailyCap: 1500 }, NOW)).toBeNull();
    expect(importBanner(status({ status: "done" }), NOW)).toBeNull();
    expect(importBanner(status({ status: "canceled" }), NOW)).toBeNull();
  });

  it("says what a running batch is doing and how far it is, and can be cancelled", () => {
    expect(importBanner(status(), NOW)).toMatchObject({ tone: "info", title: "Reading the Sales Navigator search: 60 of 290 so far", progress: { value: 60, max: 290 }, cancel: "job-1" });
    expect(importBanner(status({ phase: "visiting" }), NOW)?.title).toBe("Visiting profiles: 60 of 290 so far");
    expect(importBanner(status({ phase: "enriching" }), NOW)?.title).toBe("Working out profile addresses: 60 of 290 so far");
    // Before the size of the search is known there is a count and no bar.
    expect(importBanner(status({ total: 0, count: 0 }), NOW)).toMatchObject({ title: "Reading the Sales Navigator search: 0 so far", progress: null });
  });

  it("says when a queued batch starts", () => {
    expect(importBanner(status({ status: "scheduled", scheduled_for: "2026-10-10" }), NOW)).toMatchObject({ title: "An import from Sales Navigator is queued", cancel: "job-1", progress: null });
    expect(importBanner(status({ status: "scheduled", scheduled_for: "2026-10-12" }), NOW)).toMatchObject({ title: "The next batch of this import is queued", body: "It starts on Oct 12, inside the daily cap." });
  });

  it("gives the reason a batch failed, and has nothing to cancel then", () => {
    expect(importBanner(status({ status: "error", error: "The account is signed out of LinkedIn" }), NOW)).toMatchObject({ tone: "bad", body: "The account is signed out of LinkedIn", cancel: null });
    expect(importBanner(status({ status: "error", error: null }), NOW)?.body).toMatch(/No reason was recorded/);
  });

  it("explains a search larger than the daily cap, while a batch is still to come", () => {
    const plan = { total: 4200, importedSoFar: 1500, remaining: 2700, exceedsCap: true, dailyCap: 1500 };
    const live = [{ id: "a", status: "done", scheduled_for: null }, { id: "b", status: "scheduled", scheduled_for: "2026-10-11" }];
    expect(planLine(status({ plan, batches: live }))).toBe("This search has 4,200 contacts, more than the cap of 1,500 a day, so it is imported in batches over several days. 1,500 imported, 2,700 to go.");
    // Cancelled or finished: the rest is no longer on its way.
    expect(planLine(status({ plan, batches: [{ id: "a", status: "done", scheduled_for: null }, { id: "b", status: "canceled", scheduled_for: "2026-10-11" }] }))).toBeNull();
    expect(planLine(status({ plan: { ...plan, exceedsCap: false }, batches: live }))).toBeNull();
    expect(planLine(status({ plan: { ...plan, remaining: 0 }, batches: live }))).toBeNull();
    expect(planLine(status())).toBeNull();
    expect(planLine(undefined)).toBeNull();
  });
});

describe("a list's own page", () => {
  const detail = (over: Partial<ListDetail> = {}, row: Partial<ListRow> = {}): ListDetail => ({
    list: list(row), connected: 45, replied: 10, in_campaign: 17, runs: [], accounts: [], other_lists: [], apollo_connected: false, imports: { today: 0, daily_cap: 1500 }, ...over,
  });

  it("has five figures", () => {
    const cards = detailKpis(detail());
    expect(cards.map((card) => card.label)).toEqual(["Contacts", "With an email", "Verified", "Connected on LinkedIn", "In a campaign now"]);
    expect(cards.map((card) => card.value)).toEqual(["100", "80%", "60%", "45%", "17"]);
    expect(cards[0].note).toBe("6 can be looked up on Apollo");
    expect(cards[1].note).toBe("80 of 100");
    expect(cards[2]).toMatchObject({ note: "60 valid · 10 risky · 4 invalid", noteTone: "warn" });
    expect(cards[3].note).toBe("45 of 100");
    expect(cards[4].note).toBe("10 have replied");
  });

  it("says so where there is nothing to count", () => {
    const cards = detailKpis(detail({ connected: 0, replied: 0, in_campaign: 0 }, { contacts: 0, with_email: 0, valid: 0, risky: 0, invalid: 0, enrichable: 0 }));
    expect(cards.map((card) => card.value)).toEqual(["0", "—", "—", "—", "0"]);
    expect(cards[0].note).toBe("None waiting for a look-up");
    expect(cards[2]).toMatchObject({ note: "No email addresses", noteTone: undefined });
    expect(cards[4].note).toBe("No replies yet");
    // All valid: nothing to warn about, and no "0 invalid".
    expect(detailKpis(detail({}, { with_email: 80, valid: 80, risky: 0, invalid: 0 }))[2]).toMatchObject({ note: "80 valid · 0 risky", noteTone: undefined });
  });

  it("words the state of a campaign run", () => {
    expect(runState("running")).toMatchObject({ label: "Running", tone: "good" });
    expect(runState("pending").label).toBe("Not started");
    expect(runState("failed")).toMatchObject({ label: "Stopped", tone: "bad" });
    expect(runState("odd")).toEqual({ label: "odd", tone: "neutral" });
  });
});
