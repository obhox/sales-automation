// The sentences the research dialog and its toast say. Pure: no DB, no network.
import { describe, expect, it } from "vitest";
import { researchOutcome, researchReady, researchSkips, type ResearchPreview, type ResearchProgress } from "@/components/contacts/model";

const preview = (over: Partial<ResearchPreview> = {}): ResearchPreview => ({
  firecrawl_connected: true, tinyfish_connected: false, selected: 20, eligible: 17, eligible_ids: [],
  no_website: 3, credits: 17, batch: 5, field_key: "hook_line", ...over,
});
const progress = (over: Partial<ResearchProgress> = {}): ResearchProgress => ({
  total: 17, done: 17, written: 12, noHook: 4, skipped: 1, state: "finished", ...over,
});

describe("researchReady", () => {
  it("is satisfied by either reader, since both can read a page", () => {
    expect(researchReady(preview())).toBe(true);
    expect(researchReady(preview({ firecrawl_connected: false, tinyfish_connected: true }))).toBe(true);
    expect(researchReady(preview({ firecrawl_connected: false, tinyfish_connected: false }))).toBe(false);
  });
});

describe("researchSkips", () => {
  it("says why a contact is left out, and nothing when none is", () => {
    expect(researchSkips(preview())).toEqual(["3 contacts have no company website to read"]);
    expect(researchSkips(preview({ no_website: 1 }))).toEqual(["1 contact has no company website to read"]);
    expect(researchSkips(preview({ no_website: 0 }))).toEqual([]);
  });
});

describe("researchOutcome", () => {
  it("reports nothing-specific-to-say as its own outcome, not as a failure", () => {
    // A thin website honestly earns no hook line. Counting it as a failure would send
    // someone looking for a fault that is not there.
    expect(researchOutcome(progress())).toBe("Researched 17 contacts: 12 hook lines written, 4 with nothing specific to say, 1 could not be read");
  });

  it("says where a stopped run got to", () => {
    expect(researchOutcome(progress({ done: 5, written: 4, noHook: 1, skipped: 0, state: "stopped" })))
      .toBe("Stopped after 5 of 17: 4 hook lines written, 1 with nothing specific to say");
  });

  it("drops the clauses that would be zero", () => {
    expect(researchOutcome(progress({ written: 9, noHook: 0, skipped: 0 }))).toBe("Researched 17 contacts: 9 hook lines written");
  });
});
