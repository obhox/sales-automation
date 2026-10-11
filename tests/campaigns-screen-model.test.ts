import { describe, expect, it } from "vitest";
import { audienceLine, bulkOutcome, defaultDirection, hiddenColumnsFrom, statusTabs, type CampaignSummary } from "@/components/campaigns/model";

const campaign = (over: Partial<CampaignSummary>): CampaignSummary => ({
  id: "c1", name: "Q4 Enterprise", description: null, status: "draft", created_at: "2026-10-01 09:00:00", channels: [], steps: 0, gates: 0, list: null,
  enrolled: 0, done: 0, contacted: 0, replied: 0, reply_rate: null, invited: 0, accepted: 0, acceptance_rate: null, owner: null,
  last_activity_at: "2026-10-01 09:00:00", run: null, ...over,
});
const counts = { all: 5, active: 2, paused: 1, draft: 1, completed: 1, archived: 0 };

describe("the campaigns screen's wording", () => {
  it("offers the Archived tab only when it holds something or is the one open", () => {
    expect(statusTabs(counts, "all").map((tab) => tab.value)).toEqual(["all", "active", "paused", "draft", "completed"]);
    expect(statusTabs({ ...counts, archived: 3 }, "all").map((tab) => tab.value)).toContain("archived");
    expect(statusTabs(counts, "archived").map((tab) => tab.value)).toContain("archived");
    expect(statusTabs(counts, "all").find((tab) => tab.value === "active")).toEqual({ value: "active", label: "Active", count: 2 });
    // Before the first answer there are tabs and no counts.
    expect(statusTabs(undefined, "all").every((tab) => tab.count === undefined)).toBe(true);
  });

  it("says who a campaign is going to, or what it still lacks", () => {
    expect(audienceLine(campaign({ list: { id: "l1", name: "Enterprise VP Sales", contacts: 1240 } }))).toBe("Enterprise VP Sales · 1,240");
    expect(audienceLine(campaign({ steps: 0 }))).toBe("No steps yet");
    expect(audienceLine(campaign({ steps: 1 }))).toBe("1 step · no list yet");
    expect(audienceLine(campaign({ steps: 6 }))).toBe("6 steps · no list yet");
  });

  it("sorts names A to Z and everything else largest first", () => {
    expect(defaultDirection("name")).toBe("asc");
    expect(defaultDirection("last_activity")).toBe("desc");
    expect(defaultDirection("reply_rate")).toBe("desc");
  });

  it("keeps only real columns from what the browser stored", () => {
    expect(hiddenColumnsFrom(["owner", "nonsense", "status", 4])).toEqual(["status", "owner"]);
    expect(hiddenColumnsFrom("owner")).toEqual([]);
    expect(hiddenColumnsFrom(null)).toEqual([]);
  });

  it("reports an action on several campaigns: how many it took and why any were left", () => {
    const names = new Map([["a", "Alpha"], ["b", "Beta"]]);
    expect(bulkOutcome("pause", { done: 1, results: [{ id: "a", ok: true }, { id: "b", ok: false, error: "It is not running" }] }, names))
      .toEqual({ ok: "1 campaign paused", problems: ["Beta: It is not running"] });
    expect(bulkOutcome("archive", { done: 2, results: [{ id: "a", ok: true }, { id: "b", ok: true }] }, names)).toEqual({ ok: "2 campaigns archived", problems: [] });
    expect(bulkOutcome("resume", { done: 0, results: [{ id: "gone", ok: false }] }, names)).toEqual({ ok: null, problems: ["A campaign: could not be changed"] });
  });
});
