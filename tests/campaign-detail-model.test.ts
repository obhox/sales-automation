// What a campaign's Overview, Prospects and Settings tabs say: the wording worked out
// from the figures, apart from how it is drawn.
import { describe, expect, it } from "vitest";
import {
  actionOutcome, addOutcome, changeFrom, changesSending, chartIsEmpty, chartSubtitle, deleteWarning, formFrom, formProblem, funnelRows, funnelSubtitle, kpiViews, opensRows, placeLine,
  poolOutcome, prospectTabs, shareLine, stepLabel, variantVerdict,
  type CampaignOverview, type CampaignSettings, type FunnelStage, type Rate, type TrackPlace, type VariantTest,
} from "@/components/campaigns/detail/model";

const rate = (part: number, whole: number, previous: number | null = null, spark: Array<number | null> = []): Rate => ({ part, whole, value: whole > 0 ? part / whole : null, previous, spark });

function overview(change: Partial<CampaignOverview> = {}): CampaignOverview {
  return {
    range: "14d", channel: "both",
    kpis: { acceptance: rate(382, 1000, 0.358), reply: rate(114, 1000, 0.103), open: rate(426, 1000, 0.434), click: rate(63, 1000, 0.059), completion: rate(0, 0) },
    daily: [{ day: "2026-10-09", linkedin: 3, email: 2, replies: 1 }, { day: "2026-10-10", linkedin: 0, email: 0, replies: 0 }],
    funnel: { both: [], linkedin: [], email: [] }, variants: [], auto_promote: false,
    opens: { raw: 1284, human: 892, scanners: 248, prefetch: 104, automation: 40 },
    generated_at: "2026-10-10T12:00:00.000Z",
    ...change,
  };
}

describe("the figures along the top", () => {
  it("gives each rate as a percentage with its change in points", () => {
    const views = kpiViews(overview());
    expect(views.map((view) => [view.label, view.value, view.change?.label])).toEqual([
      ["Acceptance rate", "38.2%", "+2.4 pts"], ["Reply rate", "11.4%", "+1.1 pts"], ["Open rate", "42.6%", "−0.8 pts"], ["Click rate", "6.3%", "+0.4 pts"], ["Completion", "—", undefined],
    ]);
    expect(views[2].change?.direction).toBe("down");
    expect(views[0].basis).toBe("382 of 1,000 people invited in the period accepted");
    // A rate with nothing under it is a dash, never 0%.
    expect(views[4].basis).toBe("Nothing to measure yet");
  });

  it("draws a slice nobody was enrolled in as the shortest bar", () => {
    const views = kpiViews(overview({ kpis: { ...overview().kpis, reply: rate(1, 10, null, [null, 0.2, null, 0.1]) } }));
    expect(views[1].spark).toEqual([0, 0.2, 0, 0.1]);
    expect(views[1].change).toBeNull();
  });
});

describe("the daily chart", () => {
  it("is named for the channels it shows", () => {
    expect(chartSubtitle(overview())).toBe("LinkedIn actions, emails and replies · last 2 days");
    expect(chartSubtitle(overview({ channel: "email" }))).toBe("Emails and replies · last 2 days");
    expect(chartSubtitle(overview({ channel: "linkedin" }))).toBe("LinkedIn actions and replies · last 2 days");
    expect(chartIsEmpty(overview().daily)).toBe(false);
    expect(chartIsEmpty([{ day: "2026-10-10", linkedin: 0, email: 0, replies: 0 }])).toBe(true);
  });
});

describe("the funnel", () => {
  const stages: FunnelStage[] = [
    { key: "enrolled", count: 1240, drop: null }, { key: "contacted", count: 1186, drop: { count: 54, reason: "skipped" } }, { key: "delivered", count: 1172, drop: { count: 14, reason: "bounced" } },
    { key: "engaged", count: 612, drop: { count: 560, reason: "no engagement" } }, { key: "replied", count: 141, drop: { count: 471, reason: "silent" } },
    { key: "positive", count: 58, drop: null }, { key: "meeting", count: 27, drop: null },
  ];

  it("names each stage, says who dropped out and why, and what share the outcomes are", () => {
    const rows = funnelRows(stages, "both");
    expect(rows.map((row) => [row.label, row.note])).toEqual([
      ["Enrolled", null], ["Contacted", "−54 skipped"], ["Delivered / visited", "−14 bounced"], ["Accepted or opened", "−560 no engagement"], ["Replied", "−471 silent"],
      ["Positive reply", "41% of replies"], ["Meeting booked", "47% of positives"],
    ]);
    expect(rows[1].share).toBeCloseTo(0.956, 3);
    expect(funnelSubtitle(stages, "both")).toBe("1,240 enrolled · both channels");
  });

  it("words the stages for one channel, and survives an empty campaign", () => {
    expect(funnelRows(stages, "email").map((row) => row.label).slice(1, 4)).toEqual(["Emailed", "Delivered", "Opened"]);
    expect(funnelRows(stages, "linkedin")[3].label).toBe("Accepted");
    const empty = funnelRows(stages.map((stage) => ({ ...stage, count: 0, drop: null })), "both");
    expect(empty.every((row) => row.share === 0 && row.note === null)).toBe(true);
  });
});

describe("an A/B test", () => {
  const row = (label: string, variant_id: string | null, status: VariantTest["rows"][number]["status"]) => ({ variant_id, label, subject: `Subject ${label}`, sent: 274, open_rate: 0.45, reply_rate: 0.06, replies: 16, positive: 9, status });
  const test = (change: Partial<VariantTest> = {}): VariantTest => ({
    step_id: "s1", email_number: 1, even_split: true, rows: [row("A", null, "control"), row("B", "v-b", "leading")],
    confidence: 0.921, significant: false, more_sends_needed: 140, leader: { variant_id: "v-b", label: "B" }, decided: false, ...change,
  });

  it("says how sure it is, what it still needs, and offers to promote whoever is ahead", () => {
    expect(variantVerdict(test(), false)).toEqual({
      subtitle: "Email 1 · 2 variants · even split",
      pill: { text: "92% confidence · not yet significant", tone: "warn" },
      note: "Needs ~140 more sends per variant to reach 95% confidence. Auto-promote is off.",
      action: { label: "Promote B", winner: "v-b" },
    });
    expect(variantVerdict(test({ more_sends_needed: 1 }), true).note).toBe("Needs ~1 more send per variant to reach 95% confidence. Auto-promote is on.");
    expect(variantVerdict(test({ even_split: false }), false).subtitle).toBe("Email 1 · 2 variants · weighted split");
  });

  it("does not round a result up to certainty, or call one before there is enough to go on", () => {
    expect(variantVerdict(test({ confidence: 0.9996, significant: true, more_sends_needed: null }), false)).toMatchObject({
      pill: { text: "99% confidence · significant", tone: "good" }, note: "Version B is ahead by more than chance would explain. Auto-promote is off.",
    });
    expect(variantVerdict(test({ confidence: 0.97, significant: true, more_sends_needed: null }), true).note).toContain("Auto-promote will pause the others.");
    expect(variantVerdict(test({ confidence: null, more_sends_needed: null }), false)).toMatchObject({ pill: { text: "Too early to call", tone: "neutral" }, action: { label: "Promote B" } });
    // Level so far: no number of sends separates identical rates, and there is nobody to promote.
    expect(variantVerdict(test({ confidence: 0, more_sends_needed: null, leader: null }), false)).toMatchObject({ action: null, note: expect.stringContaining("level so far") });
    // The control ahead: promoting it names no variant.
    expect(variantVerdict(test({ leader: { variant_id: null, label: "A" } }), false).action).toEqual({ label: "Promote A", winner: null });
  });

  it("offers to reopen a test that has been decided", () => {
    const decided = test({ decided: true, leader: null, rows: [row("A", null, "paused"), row("B", "v-b", "winner")] });
    expect(variantVerdict(decided, false)).toEqual({
      subtitle: "Email 1 · 2 variants", pill: { text: "Winner chosen", tone: "good" },
      note: "Only version B is sending. The others are paused and keep their results.", action: { label: "Reopen test", reopen: true },
    });
  });

  it("leaves a removed version out of the count", () => {
    expect(variantVerdict(test({ rows: [row("A", null, "control"), row("B", "v-b", "leading"), row("Removed", "v-x", "removed")] }), false).subtitle).toBe("Email 1 · 2 variants · even split");
  });
});

describe("open-tracking quality", () => {
  it("splits the opens and says how much was filtered out", () => {
    const { rows, filtered } = opensRows(overview().opens);
    expect(rows.map((entry) => [entry.key, entry.count])).toEqual([["human", 892], ["scanners", 248], ["prefetch", 104], ["automation", 40]]);
    expect(rows[0].share).toBeCloseTo(0.695, 3);
    expect(filtered).toBeCloseTo(0.305, 3);
    expect(opensRows({ raw: 0, human: 0, scanners: 0, prefetch: 0, automation: 0 }).filtered).toBeNull();
  });
});

describe("report links", () => {
  it("says who made a link and whether it has been opened", () => {
    const share = { id: "s", hint: "abcd", created_at: "2026-10-01 10:00:00", revoked_at: null, last_viewed_at: null, views: 0, created_by: { id: "u", name: "Morgan Hale" } };
    expect(shareLine(share)).toBe("Made by Morgan Hale · never opened");
    expect(shareLine({ ...share, views: 1 })).toBe("Made by Morgan Hale · opened 1 time");
    expect(shareLine({ ...share, views: 1200, created_by: null })).toBe("Made automatically · opened 1,200 times");
  });
});

describe("the prospects table", () => {
  const place = (change: Partial<TrackPlace> = {}): TrackPlace => ({ state: "in_progress", position: 2, of: 5, step_id: "s", step_type: "message", next_step_at: null, note: null, hold: null, ...change });

  it("says where a prospect is on a track", () => {
    expect(placeLine(null)).toBe("Not on this channel");
    expect(placeLine(place())).toBe("Step 2 of 5 · linkedin message");
    expect(placeLine(place({ step_type: "delay" }))).toBe("Step 2 of 5 · waiting");
    expect(placeLine(place({ state: "pending", position: 1, step_type: "email", hold: "handover" }))).toBe("Waits for LinkedIn to hand over");
    expect(placeLine(place({ hold: "other_campaign" }))).toBe("Step 2 of 5 · linkedin message · held");
    expect(placeLine(place({ state: "completed", step_type: null }))).toBe("Finished");
    expect(placeLine(place({ state: "failed", note: "Profile not found" }))).toBe("Failed · Profile not found");
    expect(placeLine(place({ state: "skipped", note: "Lead replied" }))).toBe("Lead replied");
    expect(placeLine(place({ state: "skipped" }))).toBe("Skipped");
  });

  it("names a step for the filter", () => {
    expect(stepLabel({ track: "linkedin", position: 1, step_type: "connect", delay_seconds: null })).toBe("LinkedIn 1 · Connection request");
    expect(stepLabel({ track: "linkedin", position: 2, step_type: "delay", delay_seconds: 172_800 })).toBe("LinkedIn 2 · Wait 2 days");
    expect(stepLabel({ track: "email", position: 2, step_type: "delay", delay_seconds: 3600 })).toBe("Email 2 · Wait 1 hour");
    expect(stepLabel({ track: "email", position: 3, step_type: "email", delay_seconds: null })).toBe("Email 3 · Email");
  });

  it("keeps the held tab out of the way until someone is held", () => {
    const counts = { all: 6, active: 2, held: 0, failed: 1, replied: 1, completed: 1, skipped: 1 };
    expect(prospectTabs(counts).map((tab) => tab.value)).toEqual(["all", "active", "replied", "failed", "completed", "skipped"]);
    expect(prospectTabs({ ...counts, held: 2 }).map((tab) => [tab.label, tab.count])).toContainEqual(["Held", 2]);
    expect(prospectTabs(undefined)[0]).toEqual({ value: "all", label: "All", count: undefined });
  });

  it("reports what an action did, and what it left alone", () => {
    expect(actionOutcome("retry", { changed: 2, asked: 3, waiting: false })).toEqual({ tone: "success", message: "2 prospects back in line. 1 had nothing failed." });
    expect(actionOutcome("retry", { changed: 1, asked: 1, waiting: true }).message).toBe("1 prospect back in line. The campaign is not running, so they wait until it is.");
    expect(actionOutcome("retry", { changed: 0, asked: 2, waiting: false })).toEqual({ tone: "info", message: "None of those had a failed step to retry." });
    expect(actionOutcome("unenroll", { changed: 3, asked: 4, waiting: false }).message).toBe("3 prospects unenrolled. 1 was already out of the sequence.");
    expect(actionOutcome("unenroll", { changed: 0, asked: 1, waiting: false }).tone).toBe("info");
    expect(actionOutcome("remove", { changed: 1, asked: 1, waiting: false }).message).toBe("1 prospect removed from the campaign.");
  });

  it("reports who was added and who was not, and why", () => {
    const result = { run_id: "r", asked: 10, enrolled: 4, already_enrolled: 3, excluded: 2, in_another_campaign: 1 };
    expect(addOutcome(result)).toEqual({ tone: "success", message: "4 contacts enrolled. They start at the first step. Not added: 3 already in this campaign; 2 left out as customers or open deals; 1 part-way through another campaign." });
    expect(addOutcome({ ...result, enrolled: 1, already_enrolled: 0, excluded: 0, in_another_campaign: 0 }).message).toBe("1 contact enrolled. They start at the first step.");
    expect(addOutcome({ ...result, enrolled: 0, excluded: 0, in_another_campaign: 0 })).toEqual({ tone: "info", message: "Nobody was added. Not added: 3 already in this campaign." });
  });
});

describe("the settings form", () => {
  const settings: CampaignSettings = {
    name: "Q4 Enterprise", description: null, owner_id: null, send_in_recipient_tz: false, ab_auto_promote: false, archived: false, channels: ["linkedin", "email"],
    setup: { list_id: "l1", exclude: { customers: true, open_deals: true }, account_ids: ["a1"], rotation: "round_robin", email_account_ids: ["m1"], overlap: "skip" },
    tracking: [{ step_id: "e1", email_number: 1, subject: "Intro", opens: false, clicks: false }, { step_id: "e2", email_number: 2, subject: "Again", opens: true, clicks: false }],
    run: { id: "r1", status: "running", in_flight: 12 }, enrolled: 40, signal_rules: [],
  };
  const stored = formFrom(settings);

  it("sends back only what was changed", () => {
    expect(changeFrom(stored, stored)).toBeNull();
    expect(changeFrom({ ...stored, name: "  Q4 Enterprise  " }, stored)).toBeNull();
    expect(changeFrom({ ...stored, name: "Q4, US", description: " VPs ", owner_id: "u1" }, stored)).toEqual({ name: "Q4, US", description: "VPs", owner_id: "u1" });
    expect(changeFrom({ ...stored, exclude: { customers: false, open_deals: true }, account_ids: ["a1", "a2"] }, stored)).toEqual({ setup: { exclude: { customers: false, open_deals: true }, account_ids: ["a1", "a2"] } });
    expect(changeFrom({ ...stored, tracking: [{ step_id: "e1", opens: true, clicks: false }, { step_id: "e2", opens: true, clicks: false }] }, stored)).toEqual({ tracking: [{ step_id: "e1", opens: true, clicks: false }] });
    // Giving up the owner is a change too, and is sent as nobody.
    const owned = formFrom({ ...settings, owner_id: "u1" });
    expect(changeFrom({ ...owned, owner_id: "none" }, owned)).toEqual({ owner_id: null });
  });

  it("tells a change of name from a change of how the campaign sends", () => {
    expect(changesSending(null)).toBe(false);
    expect(changesSending({ name: "x", owner_id: "u" })).toBe(false);
    expect(changesSending({ name: "x", tracking: [] })).toBe(true);
    expect(changesSending({ setup: { exclude: {} } })).toBe(true);
    expect(changesSending({ ab_auto_promote: true })).toBe(true);
  });

  it("will not save a campaign with no name, or a running one with no LinkedIn account", () => {
    expect(formProblem(stored, settings)).toBeNull();
    expect(formProblem({ ...stored, name: "  " }, settings)).toBe("A campaign needs a name.");
    expect(formProblem({ ...stored, account_ids: [] }, settings)).toContain("at least one LinkedIn account");
    expect(formProblem({ ...stored, account_ids: [] }, { ...settings, run: null })).toBeNull();
    expect(formProblem({ ...stored, account_ids: [] }, { ...settings, channels: ["email"] })).toBeNull();
  });

  it("says what a change of LinkedIn accounts did, and what deleting would take with it", () => {
    expect(poolOutcome({ pool: ["a2"], rotation: null, reassigned: 8, finishing_elsewhere: 3 })).toBe("8 contacts not yet started were shared out again; 3 already started finish on the account that started them.");
    expect(poolOutcome({ pool: ["a2"], rotation: null, reassigned: 1, finishing_elsewhere: 0 })).toBe("1 contact not yet started was shared out again.");
    expect(deleteWarning({ enrolled: 0, run: null })).toContain("has enrolled nobody");
    expect(deleteWarning(settings)).toContain("the record of 40 enrolments. 12 are part-way through and would stop.");
    expect(deleteWarning({ enrolled: 1, run: null })).toContain("the record of 1 enrolment. Messages already sent");
  });
});
