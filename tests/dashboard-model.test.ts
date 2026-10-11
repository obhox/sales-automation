// What the dashboard says: the wording worked out from the figures, apart from how it is drawn.
import { describe, expect, it } from "vitest";
import {
  activityIsEmpty, activityPoints, activitySubtitle, funnelStages, funnelSubtitle, kpiViews, livePill, setupSteps, todayRows, topCampaigns,
  type Dashboard, type TopCampaign,
} from "@/components/dashboard/model";

const tally = (value: number, previous: number, spark: number[] = []) => ({ value, previous, spark });

function dashboard(change: Partial<Dashboard> = {}): Dashboard {
  const stages = (counts: number[]) => (["enrolled", "delivered", "engaged", "replied", "positive", "meeting"] as const).map((key, index) => ({ key, count: counts[index] }));
  return {
    range: "30d", filters: { workflow_id: null, list_id: null, owner_id: null },
    kpis: { emails: tally(12480, 11534), linkedin: tally(3912, 3758), reply: { value: 0.114, part: 2102, whole: 18439, previous: 0.101, spark: [0.1, null, 0.12] }, positive: tally(318, 296), meetings: tally(47, 50) },
    activity: { unit: "day", points: [{ start: "2026-10-09", email: 5, linkedin: 3, replies: 1 }, { start: "2026-10-10", email: 0, linkedin: 0, replies: 0 }] },
    funnel: { campaigns: 6, scope: "in_flight", stages: { both: stages([18420, 16803, 9114, 2102, 318, 47]), linkedin: stages([18420, 9000, 4000, 900, 100, 20]), email: stages([18420, 12000, 6000, 1300, 230, 30]) } },
    today: { emails: { sent: 412, cap: 900 }, invites: { sent: 38, cap: 60 }, visits: { sent: 120, cap: 200 }, replies: 23, meetings: 2 },
    campaigns: [], setup: { linkedin_accounts: 2, mailboxes: 3, lists: 4, campaigns: 6, launched: 6 },
    options: { campaigns: [{ id: "w1", name: "Q4 Enterprise" }], lists: [], members: [] },
    generated_at: "2026-10-10T12:00:00.000Z",
    ...change,
  };
}

describe("the figures along the top", () => {
  it("gives counts with a percentage or a plain difference, and the rate in points", () => {
    expect(kpiViews(dashboard()).map((kpi) => [kpi.label, kpi.value, kpi.change?.label, kpi.change?.direction])).toEqual([
      ["Emails sent", "12,480", "+8.2%", "up"], ["LinkedIn actions", "3,912", "+4.1%", "up"], ["Reply rate", "11.4%", "+1.3 pts", "up"],
      ["Positive replies", "318", "+22", "up"], ["Meetings booked", "47", "-3", "down"],
    ]);
    expect(kpiViews(dashboard())[2].spark).toEqual([0.1, 0, 0.12]);
    expect(kpiViews(dashboard())[2].basis).toBe("2,102 of 18,439 people written to in the last 30 days replied to a message sent in it");
  });

  it("shows a dash for a rate with nobody under it, and no change against nothing", () => {
    const empty = kpiViews(dashboard({ kpis: { emails: tally(0, 0), linkedin: tally(5, 0), reply: { value: null, part: 0, whole: 0, previous: null, spark: [] }, positive: tally(0, 0), meetings: tally(0, 0) } }));
    expect(empty[2]).toMatchObject({ value: "—", change: null, basis: "Nobody was written to in this period" });
    // Nothing now and nothing before: no pill at all.
    expect(empty[0].change).toBeNull();
    expect(empty[3].change).toBeNull();
    // From nothing to something is not a percentage.
    expect(empty[1].change).toBeNull();
  });
});

describe("the chart", () => {
  it("names days by their number and weeks by the day they start", () => {
    expect(activitySubtitle(dashboard().activity)).toBe("Sends and LinkedIn actions · last 2 days");
    expect(activityPoints(dashboard().activity)[0]).toEqual({ label: "09", title: "October 9", values: { linkedin: 3, email: 5, replies: 1 } });
    const weeks = { unit: "week" as const, points: [{ start: "2026-10-04", email: 9, linkedin: 4, replies: 2 }] };
    expect(activitySubtitle(weeks)).toBe("Sends and LinkedIn actions · last 1 weeks");
    expect(activityPoints(weeks)[0]).toMatchObject({ label: "Oct 4", title: "Week of October 4" });
    // Thirty days: every third is named.
    const month = { unit: "day" as const, points: Array.from({ length: 30 }, (_, index) => ({ start: `2026-09-${String(index + 1).padStart(2, "0")}`, email: 1, linkedin: 0, replies: 0 })) };
    expect(activityPoints(month).map((point) => point.label).slice(0, 4)).toEqual(["01", "", "", "04"]);
    expect(activityIsEmpty(dashboard().activity)).toBe(false);
    expect(activityIsEmpty({ unit: "day", points: [{ start: "2026-10-10", email: 0, linkedin: 0, replies: 0 }] })).toBe(true);
  });
});

describe("the funnel", () => {
  it("names its stages for the channel shown", () => {
    expect(funnelStages(dashboard(), "both").map((stage) => [stage.label, stage.count])).toEqual([
      ["Contacts enrolled", 18420], ["Delivered / visited", 16803], ["Opened or accepted", 9114], ["Replied", 2102], ["Positive", 318], ["Meeting booked", 47],
    ]);
    expect(funnelStages(dashboard(), "email").map((stage) => stage.label).slice(1, 3)).toEqual(["Delivered", "Opened"]);
    expect(funnelStages(dashboard(), "linkedin")[2].label).toBe("Accepted");
  });

  it("says which campaigns it adds up", () => {
    expect(funnelSubtitle(dashboard(), "both")).toBe("All active campaigns · both channels");
    expect(funnelSubtitle(dashboard({ filters: { workflow_id: null, list_id: "l1", owner_id: null } }), "email")).toBe("6 active campaigns · email");
    expect(funnelSubtitle(dashboard({ filters: { workflow_id: "w1", list_id: null, owner_id: null }, funnel: { ...dashboard().funnel, scope: "campaign", campaigns: 1 } }), "linkedin")).toBe("Q4 Enterprise · LinkedIn");
    expect(funnelSubtitle(dashboard({ funnel: { ...dashboard().funnel, scope: "all", campaigns: 3 } }), "both")).toBe("All campaigns · both channels");
    expect(funnelSubtitle(dashboard({ funnel: { ...dashboard().funnel, scope: "all", campaigns: 0 } }), "both")).toBe("No campaigns yet · both channels");
    expect(funnelSubtitle(dashboard({ filters: { workflow_id: null, list_id: null, owner_id: "u1" }, funnel: { ...dashboard().funnel, scope: "all", campaigns: 1 } }), "both")).toBe("1 campaign · both channels");
  });
});

describe("today, and whether sending is live", () => {
  it("sets the sends that have an allowance against it", () => {
    expect(todayRows(dashboard().today).map((row) => [row.label, row.count, row.cap])).toEqual([
      ["Emails sent", 412, 900], ["Invites sent", 38, 60], ["Profile visits", 120, 200], ["Replies received", 23, null], ["Meetings booked", 2, null],
    ]);
  });

  it("says so beside the title", () => {
    expect(livePill("healthy")).toEqual({ label: "Live", tone: "good", dot: true });
    expect(livePill("degraded")).toMatchObject({ label: "Delayed", tone: "warn" });
    expect(livePill("off")).toMatchObject({ label: "Background work off", dot: false });
    expect(livePill("idle")).toMatchObject({ label: "Idle" });
  });
});

describe("top campaigns", () => {
  const row = (name: string, contacted: number, replied: number, invited = 0, accepted = 0): TopCampaign => ({
    id: name, name, status: "active", channels: ["email"], enrolled: contacted, contacted, replied, reply_rate: contacted ? replied / contacted : null, invited, accepted, acceptance_rate: invited ? accepted / invited : null,
  });
  const campaigns = [row("Series B SaaS", 500, 91, 200, 60), row("RevOps push", 300, 44, 100, 45), row("Cold list A", 1000, 64), row("One lucky reply", 1, 1), row("Nobody yet", 0, 0)];

  it("ranks by reply rate with a bar against the best, leaving out a rate with too few people under it", () => {
    const top = topCampaigns(campaigns, "reply_rate");
    expect(top.map((entry) => [entry.name, entry.figure])).toEqual([["Series B SaaS", "18.2%"], ["RevOps push", "14.7%"], ["Cold list A", "6.4%"]]);
    expect(top[0].share).toBe(1);
    expect(top[1].share).toBeCloseTo(0.806, 2);
    expect(top[0].basis).toBe("91 of 500 people written to replied");
  });

  it("can rank by how many replied, or by acceptance", () => {
    expect(topCampaigns(campaigns, "replies").map((entry) => [entry.name, entry.figure])).toEqual([["Series B SaaS", "91"], ["Cold list A", "64"], ["RevOps push", "44"], ["One lucky reply", "1"]]);
    expect(topCampaigns(campaigns, "acceptance").map((entry) => [entry.name, entry.figure])).toEqual([["RevOps push", "45.0%"], ["Series B SaaS", "30.0%"]]);
    expect(topCampaigns(campaigns, "replies", 2)).toHaveLength(2);
    expect(topCampaigns([], "reply_rate")).toEqual([]);
  });
});

describe("the first-run checklist", () => {
  it("is gone once a campaign has been launched", () => {
    expect(setupSteps(dashboard().setup)).toBeNull();
  });

  it("walks a new workspace through senders, a list, a campaign and its launch", () => {
    const fresh = setupSteps({ linkedin_accounts: 0, mailboxes: 0, lists: 0, campaigns: 0, launched: 0 })!;
    expect(fresh.map((step) => [step.key, step.done])).toEqual([["sender", false], ["list", false], ["campaign", false], ["launch", false]]);
    expect(fresh[0].action).toEqual({ label: "Connect LinkedIn", href: "/linkedin-accounts" });
    expect(fresh[2].action).toEqual({ label: "New campaign", href: "/campaigns?new=1" });

    const under = setupSteps({ linkedin_accounts: 1, mailboxes: 2, lists: 3, campaigns: 1, launched: 0 })!;
    expect(under.map((step) => step.done)).toEqual([true, true, true, false]);
    expect(under[0].detail).toBe("1 LinkedIn account and 2 mailboxes ready.");
    expect(under[1].detail).toBe("3 lists so far.");
    expect(under[2].action).toEqual({ label: "Open campaigns", href: "/campaigns" });
  });
});
