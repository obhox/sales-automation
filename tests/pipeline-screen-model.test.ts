// The pipeline screen's wording and small decisions (components/pipeline/model.ts): what
// the figures say, how a deal, a task, a meeting and a line of activity read. Plain
// functions; times are built where the reader is, so the day names hold in any time zone.
import { describe, expect, it } from "vitest";
import {
  activityLine, amountFrom, calendarReturnNotice, calendarStatus, calendarWhere, columnsOf, crmSyncNote, currencyNote, dealDate, dealSubline, dueFields, dueFromFields, dueLabel,
  localDay, meetingDetail, meetingWhen, meetingWho, ownerLabel, ownerOptions, probabilityFrom, signInUnavailable, sourceLabel, stageKind, summaryStats, taskCountsLine, taskSubline,
  todayQuery, viewOf,
  type ActivityItem, type CalendarItem, type MeetingItem, type Opportunity, type PipelineSummary, type Stage, type TaskItem,
} from "@/components/pipeline/model";

const NOW = new Date(2026, 10, 14, 14, 0, 0); // 14 November 2026, two in the afternoon, where the reader is
const at = (dayOffset: number, hour: number, minute = 0) => new Date(2026, 10, 14 + dayOffset, hour, minute, 0);
const dayText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const summary = (over: Partial<PipelineSummary> = {}): PipelineSummary => ({
  currency: "USD", other_currencies: 0, weighted_pipeline: 412_800, weighted_added_30d: 38_200, open_count: 38, open_from_replies: 11,
  won_quarter: 184_500, won_quarter_count: 9, quarter_start: "2026-10-01", average_deal_size: 12_400, sales_cycle_days: 34, win_rate: 0.241, closed_12m: 87, ...over,
});

describe("the figures above the board", () => {
  it("read as the design has them, with what stands behind each", () => {
    expect(summaryStats(summary()).map((stat) => [stat.label, stat.value, stat.note, stat.tone])).toEqual([
      ["Weighted pipeline", "$412,800", "+$38.2k added in 30 days", "good"],
      ["Open opportunities", "38", "11 created from replies", "plain"],
      ["Won this quarter", "$184,500", "9 deals", "good"],
      ["Average deal size", "$12,400", "sales cycle 34 days", "plain"],
      ["Win rate", "24.1%", "of 87 closed in 12 months", "plain"],
    ]);
  });

  it("say so plainly when there is nothing behind a figure, instead of showing a zero as if it were measured", () => {
    const empty = summaryStats(summary({ weighted_pipeline: 0, weighted_added_30d: 0, open_count: 0, open_from_replies: 0, won_quarter: 0, won_quarter_count: 0, average_deal_size: null, sales_cycle_days: null, win_rate: null, closed_12m: 0 }));
    expect(empty.map((stat) => [stat.value, stat.note, stat.tone])).toEqual([
      ["$0", "nothing added in 30 days", "plain"], ["0", "none created from replies", "plain"], ["$0", "no deals yet", "plain"],
      ["—", "no deal won in 12 months", "plain"], ["—", "nothing closed in 12 months", "plain"],
    ]);
    expect(summaryStats(summary({ won_quarter_count: 1, sales_cycle_days: 1 })).map((stat) => stat.note)).toEqual(expect.arrayContaining(["1 deal", "sales cycle 1 day"]));
  });

  it("use the workspace's currency, and mention the deals left out of the sums", () => {
    expect(summaryStats(summary({ currency: "EUR" }))[0]).toMatchObject({ value: "€412,800", note: "+€38.2k added in 30 days" });
    expect(currencyNote(summary())).toBeNull();
    expect(currencyNote(summary({ other_currencies: 1 }))).toBe("Amounts are in USD. 1 opportunity in another currency is counted but not added in.");
    expect(currencyNote(summary({ other_currencies: 3 }))).toBe("Amounts are in USD. 3 opportunities in another currency are counted but not added in.");
  });
});

const stage = (id: string, position: number, over: Partial<Stage> = {}): Stage => ({ id, name: id, position, probability: 20, is_won: 0, is_lost: 0, opportunity_count: 0, ...over });
const deal = (id: string, stageId: string | null, over: Partial<Opportunity> = {}): Opportunity => ({
  id, name: "Northwind Logistics", amount: 18_000, currency: "USD", expected_close_date: null, stage_id: stageId, owner_id: null, target_id: null, company_id: null, source: "manual",
  created_at: "2026-11-01 09:00:00", closed_at: null, contact_name: null, contact_title: null, company_name: null, owner_email: null, owner_name: null, open_task_count: 0, ...over,
});

describe("the board", () => {
  const stages = [stage("Won", 4, { is_won: 1 }), stage("Discovery", 0), stage("Lost", 5, { is_lost: 1 }), stage("Qualified", 1)];

  it("puts the stages in order, each with its deals, worth and colour", () => {
    const columns = columnsOf(stages, [deal("a", "Discovery"), deal("b", "Discovery", { amount: null }), deal("c", "Won", { amount: 46_000 }), deal("d", "Discovery", { amount: 7_000, currency: "EUR" })], "USD");
    expect(columns.map((column) => [column.name, column.deals.length, column.value, column.tone])).toEqual([
      ["Discovery", 3, 18_000, "brand"], ["Qualified", 0, 0, "li"], ["Won", 1, 46_000, "good"], ["Lost", 0, 0, "bad"],
    ]);
  });

  it("gives deals in no stage a column of their own, only when there are any", () => {
    expect(columnsOf(stages, [deal("a", "Discovery")], "USD").map((column) => column.id)).not.toContain("none");
    const loose = columnsOf(stages, [deal("a", null), deal("b", "a-stage-since-deleted")], "USD").at(-1)!;
    expect(loose).toMatchObject({ id: "none", name: "No stage", stage: null, probability: null });
    expect(loose.deals).toHaveLength(2);
  });

  it("says who a deal is with, without repeating the company when that is its name", () => {
    expect(dealSubline(deal("a", "x", { contact_name: "Dana Whitfield", contact_title: "VP Sales", company_name: "Northwind Logistics" }))).toBe("Dana Whitfield · VP Sales");
    expect(dealSubline(deal("a", "x", { name: "Annual renewal", contact_name: "Dana Whitfield", contact_title: "VP Sales", company_name: "Northwind Logistics" }))).toBe("Dana Whitfield · Northwind Logistics");
    expect(dealSubline(deal("a", "x", { name: "Annual renewal", company_name: "Northwind Logistics" }))).toBe("Northwind Logistics");
    expect(dealSubline(deal("a", "x"))).toBe("No contact");
  });

  it("marks an open deal whose close date has gone by, and not one that has closed", () => {
    const open = stage("Discovery", 0), won = stage("Won", 4, { is_won: 1 });
    expect(dealDate(deal("a", "x", { expected_close_date: dayText(at(-2, 0)) }), open, NOW)).toEqual({ label: "Nov 12", late: true });
    expect(dealDate(deal("a", "x", { expected_close_date: dayText(at(0, 0)) }), open, NOW)).toEqual({ label: "Nov 14", late: false });
    expect(dealDate(deal("a", "x", { expected_close_date: dayText(at(-2, 0)) }), won, NOW)).toEqual({ label: "Nov 12", late: false });
    expect(dealDate(deal("a", "x"), open, NOW)).toBeNull();
    // A date with no time is that day where the reader is, not midnight in Greenwich.
    expect(localDay("2026-11-14")?.getDate()).toBe(14);
    expect(localDay("nonsense")).toBeNull();
  });

  it("names where a deal came from", () => {
    expect([sourceLabel("reply"), sourceLabel("manual"), sourceLabel("partner_referral"), sourceLabel(null)]).toEqual(["From a reply", "Added by hand", "Partner referral", "Not recorded"]);
  });

  it("offers every member, everyone, and nobody as the owner to show", () => {
    const members = [{ id: "u1", email: "jordan@acme.example", name: "Jordan Mertens", role: "owner" }, { id: "u2", email: "sam@acme.example", name: null, role: "member" }];
    expect(ownerOptions(members).map((option) => [option.value, option.label])).toEqual([["all", "All owners"], ["u1", "Jordan Mertens"], ["u2", "sam"], ["none", "No owner"]]);
    expect([ownerLabel("u2", members), ownerLabel("none", members), ownerLabel("someone-who-left", members)]).toEqual(["sam", "No owner", "All owners"]);
    expect([viewOf("tasks"), viewOf("nonsense"), viewOf(undefined)]).toEqual(["tasks", "board", "board"]);
  });
});

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: "t", title: "Send pricing", description: null, status: "open", due_date: null, due_at: null, overdue: false, priority: "medium", automatic: false,
  created_at: "2026-11-10 09:00:00", completed_at: null, contact: null, company: null, opportunity: null, assignee: null, ...over,
});

describe("a task", () => {
  it("says when it is due the way a person would", () => {
    expect(dueLabel(task({ due_date: dayText(at(-1, 0)), due_at: at(-1, 17).toISOString() }), NOW)).toBe("Yesterday 17:00");
    expect(dueLabel(task({ due_date: dayText(at(0, 0)), due_at: at(0, 9, 5).toISOString() }), NOW)).toBe("Today 09:05");
    expect(dueLabel(task({ due_date: dayText(at(1, 0)) }), NOW)).toBe("Tomorrow");
    expect(dueLabel(task({ due_date: dayText(at(6, 0)), due_at: at(6, 10).toISOString() }), NOW)).toBe("Nov 20 10:00");
    expect(dueLabel(task(), NOW)).toBeNull();
  });

  it("says what it is about, then why it is there or when it was finished", () => {
    const about = { contact: { id: "c", name: "Sofia Ahlberg", title: "VP Growth" }, company: { id: "co", name: "Kestrel Analytics" } };
    expect(taskSubline(task({ ...about, description: "positive reply on 06 Nov" }), NOW)).toBe("Kestrel Analytics · positive reply on 06 Nov");
    expect(taskSubline(task({ ...about }), NOW)).toBe("Kestrel Analytics · Sofia Ahlberg");
    expect(taskSubline(task({ ...about, opportunity: { id: "o", name: "Annual renewal" } }), NOW)).toBe("Kestrel Analytics · Annual renewal");
    // A note that already starts with the company is not given the company twice.
    expect(taskSubline(task({ ...about, description: "Kestrel Analytics · Sofia Ahlberg" }), NOW)).toBe("Kestrel Analytics · Sofia Ahlberg");
    expect(taskSubline(task({ contact: about.contact }), NOW)).toBe("Sofia Ahlberg");
    expect(taskSubline(task(), NOW)).toBe("");
    expect(taskSubline(task({ ...about, status: "done", completed_at: at(0, 11, 20).toISOString(), description: "ignored once done" }), NOW)).toBe("Kestrel Analytics · completed 11:20");
    expect(taskSubline(task({ ...about, status: "done", completed_at: at(-3, 11).toISOString() }), NOW)).toBe("Kestrel Analytics · completed Nov 11");
    expect(taskSubline(task({ status: "done" }), NOW)).toBe("completed");
  });

  it("counts what is open and what was finished today", () => {
    expect(taskCountsLine({ open: 4, overdue: 1, mine: 2, completed_today: 1, done: 30 })).toBe("4 open · 1 completed today");
  });

  it("goes into the form's day and time and comes back out as the same moment", () => {
    const stored = { due_date: dayText(at(1, 0)), due_at: at(1, 9, 30).toISOString() };
    expect(dueFields(stored)).toEqual({ day: dayText(at(1, 0)), time: "09:30" });
    expect(dueFromFields(dayText(at(1, 0)), "09:30")).toEqual(stored);
    expect(dueFields({ due_date: "2026-11-20", due_at: null })).toEqual({ day: "2026-11-20", time: "" });
    expect(dueFromFields("2026-11-20", "")).toEqual({ due_date: "2026-11-20", due_at: null });
    expect(dueFromFields("", "09:30")).toEqual({ due_date: null, due_at: null });
    expect(dueFields(null)).toEqual({ day: "", time: "" });
  });

  it("is asked for with today's date and its start where the reader is", () => {
    expect(todayQuery(NOW)).toEqual({ today: "2026-11-14", day_start: at(0, 0).toISOString() });
  });
});

const meeting = (over: Partial<MeetingItem> = {}): MeetingItem => ({
  id: "m", title: "Discovery — Kestrel Analytics", starts_at: at(0, 15).toISOString(), ends_at: at(0, 15, 45).toISOString(), all_day: false, duration_minutes: 45, cancelled: false,
  contact: { id: "c", name: "Sofia Ahlberg", title: "VP Growth" }, company: { id: "co", name: "Kestrel Analytics" }, opportunity: null, calendar: { id: "cal", provider: "google_calendar", name: "Jordan's calendar" }, attendee_count: 1, ...over,
});
const calendar = (over: Partial<CalendarItem> = {}): CalendarItem => ({
  id: "cal", provider: "ical", name: "Team calendar", account_email: null, signed_in: false, host: "calendar.example.com", enabled: true, last_synced_at: null, sync_error: null, meeting_count: 0, ...over,
});

describe("a meeting and its calendar", () => {
  it("shows its time over its day", () => {
    expect(meetingWhen(meeting(), NOW)).toEqual({ time: "15:00", day: "Today" });
    expect(meetingWhen(meeting({ starts_at: at(1, 10).toISOString() }), NOW)).toEqual({ time: "10:00", day: "Tomorrow" });
    expect(meetingWhen(meeting({ starts_at: "2026-11-20", all_day: true }), NOW)).toEqual({ time: "All day", day: "Nov 20" });
    expect(meetingWhen(meeting({ starts_at: "nonsense" }), NOW)).toEqual({ time: "—", day: "" });
  });

  it("says who it is with and how long", () => {
    expect(meetingWho(meeting())).toBe("Sofia Ahlberg · 45 min");
    expect(meetingWho(meeting({ attendee_count: 3, duration_minutes: 60 }))).toBe("Sofia Ahlberg +2 · 60 min");
    expect(meetingWho(meeting({ contact: null, attendee_count: 3, duration_minutes: null }))).toBe("3 people invited");
    expect(meetingWho(meeting({ contact: null, attendee_count: 0 }))).toBe("Nobody invited · 45 min");
    expect(meetingDetail(meeting({ opportunity: { id: "o", name: "Kestrel Analytics" } }))).toEqual(["Kestrel Analytics", "45 min"]);
    expect(meetingDetail(meeting({ opportunity: { id: "o", name: "Annual renewal" } }))).toEqual(["Kestrel Analytics", "45 min", "Annual renewal"]);
  });

  it("says how a calendar stands", () => {
    expect(calendarStatus(calendar(), NOW)).toEqual({ tone: "neutral", label: "Not read yet" });
    expect(calendarStatus(calendar({ last_synced_at: new Date(NOW.getTime() - 9 * 60_000).toISOString() }), NOW)).toEqual({ tone: "good", label: "Read 9 min ago" });
    expect(calendarStatus(calendar({ last_synced_at: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() }), NOW)).toEqual({ tone: "good", label: "Read 3 h ago" });
    expect(calendarStatus(calendar({ enabled: false, last_synced_at: NOW.toISOString() }), NOW)).toEqual({ tone: "neutral", label: "Paused" });
    expect(calendarStatus(calendar({ sync_error: "iCal 404" }), NOW)).toEqual({ tone: "bad", label: "Could not be read" });
    expect(calendarStatus(calendar({ provider: "google_calendar", signed_in: true, sync_error: "Google Calendar needs signing in to again" }), NOW)).toEqual({ tone: "bad", label: "Needs signing in to again" });
  });

  it("says where a calendar is read from without giving away a feed's address", () => {
    expect(calendarWhere(calendar())).toBe("calendar.example.com");
    expect(calendarWhere(calendar({ provider: "microsoft_calendar", signed_in: true, account_email: "priya@acme.example", host: null }))).toBe("priya@acme.example");
    expect(calendarWhere(calendar({ provider: "google_calendar", host: null }))).toBe("Connected with a pasted token");
  });

  it("says plainly when a provider's sign-in cannot be offered, and what happened when a member comes back from one", () => {
    expect(signInUnavailable("google_calendar")).toBe("Google Calendar sign-in is not set up on this server.");
    expect(calendarReturnNotice({ view: "meetings" })).toBeNull();
    expect(calendarReturnNotice({ calendar: "connected", provider: "microsoft_calendar" })).toEqual({ tone: "good", message: "Microsoft Calendar is connected. Its meetings are being read now." });
    expect(calendarReturnNotice({ calendar_error: "not_set_up", provider: "google_calendar" })).toEqual({ tone: "bad", message: "Google Calendar sign-in is not set up on this server." });
    expect(calendarReturnNotice({ calendar_error: "declined", provider: "google_calendar" })?.message).toBe("Google Calendar was not connected: access was not given.");
    expect(calendarReturnNotice({ calendar_error: "expired", provider: "google_calendar" })?.message).toMatch(/Start it again/);
    expect(calendarReturnNotice({ calendar_error: "exchange", provider: ["nonsense"] })?.message).toBe("The calendar did not accept the sign-in. Nothing was connected.");
  });
});

const entry = (kind: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: kind, kind, at: NOW.toISOString(), actor: { id: "u", name: "Priya Raghavan" }, subject: "Meridian Labs", body: null, detail: null,
  contact: { id: "c", name: "Tom Berger" }, company: { id: "co", name: "Meridian Labs" }, opportunity: null, ...over,
});

describe("a line of activity", () => {
  it("is a sentence, with who did it", () => {
    expect(activityLine(entry("log_call", { subject: "", body: "Twelve minutes." }))).toMatchObject({ icon: "call", text: "Call logged with Tom Berger", detail: "Twelve minutes.", by: "Priya Raghavan" });
    expect(activityLine(entry("log_note", { subject: "", contact: null })).text).toBe("Note on Meridian Labs");
    expect(activityLine(entry("opportunity_moved", { detail: { from_stage: "Qualified", to_stage: "Proposal" } }))).toMatchObject({ icon: "moved", text: "Meridian Labs moved to Proposal", detail: "from Qualified" });
    expect(activityLine(entry("opportunity_won", { detail: { to_stage: "Closed won", amount: 46_000, currency: "USD" } }))).toMatchObject({ icon: "won", tone: "good", text: "Meridian Labs moved to Closed won", detail: "$46,000" });
    expect(activityLine(entry("opportunity_lost", { detail: { to_stage: "Closed lost" } }))).toMatchObject({ icon: "lost", tone: "bad", detail: null });
    expect(activityLine(entry("opportunity_created", { detail: { amount: 9_000, currency: "USD" } }))).toMatchObject({ text: "Meridian Labs added to the pipeline", detail: "$9,000" });
    expect(activityLine(entry("opportunity_deleted"))).toMatchObject({ icon: "deleted", text: "Meridian Labs deleted" });
    expect(activityLine(entry("task_completed", { subject: "Send pricing" }))).toMatchObject({ icon: "done", text: "Task done: Send pricing", detail: "Meridian Labs" });
    expect(activityLine(entry("meeting_booked", { subject: "Pilot scope" })).text).toBe("Meeting booked: Pilot scope");
  });

  it("says Linki did what nobody did", () => {
    expect(activityLine(entry("opportunity_created", { actor: null, detail: { source: "reply" } }))).toMatchObject({ text: "Meridian Labs opened from a positive reply", by: "Linki" });
    expect(activityLine(entry("task_created", { actor: null, subject: "Follow up with Tom Berger" })).text).toBe("Task created automatically: Follow up with Tom Berger");
    expect(activityLine(entry("task_created", { subject: "Call Tom" })).text).toBe("Task added: Call Tom");
    // A change made with an API key is not something Linki decided.
    expect(activityLine(entry("opportunity_moved", { actor: null, detail: { to_stage: "Proposal", via: "api" } })).by).toBe("The API");
  });

  it("still reads when it is of a kind this screen was not told about", () => {
    expect(activityLine(entry("something_new", { subject: "Something happened" }))).toMatchObject({ icon: "note", text: "Something happened" });
  });
});

describe("the small readers behind the forms and the header", () => {
  it("read a stage's chance and an amount as typed, or say they cannot", () => {
    expect([probabilityFrom("40"), probabilityFrom(" 100 "), probabilityFrom("0")]).toEqual([40, 100, 0]);
    expect([probabilityFrom(""), probabilityFrom("101"), probabilityFrom("12.5"), probabilityFrom("-1"), probabilityFrom("lots")]).toEqual([null, null, null, null, null]);
    expect([amountFrom("18,000"), amountFrom(" 12 500.50 "), amountFrom("0")]).toEqual([18_000, 12_500.5, 0]);
    // Empty is "no amount", which is not zero; nonsense is neither.
    expect([amountFrom(""), amountFrom("-5"), amountFrom("lots")]).toEqual([null, undefined, undefined]);
    expect([stageKind({ is_won: 1, is_lost: 0 }), stageKind({ is_won: 0, is_lost: 1 }), stageKind({ is_won: 0, is_lost: 0 })]).toEqual(["won", "lost", "open"]);
  });

  it("say when the CRM last took the board, and when it could not", () => {
    const row = (over: Record<string, unknown>) => ({ id: "x", provider: "hubspot", name: "HubSpot", enabled: 1, last_synced_at: null, sync_error: null, ...over });
    expect(crmSyncNote([], NOW)).toBeNull();
    expect(crmSyncNote([row({ provider: "ical" })], NOW)).toBeNull();
    expect(crmSyncNote([row({ last_synced_at: new Date(NOW.getTime() - 6 * 60_000).toISOString() })], NOW)).toEqual({ label: "HubSpot synced 6 min ago", failed: false });
    expect(crmSyncNote([row({})], NOW)).toEqual({ label: "HubSpot not synced yet", failed: false });
    expect(crmSyncNote([row({ last_synced_at: NOW.toISOString() }), row({ provider: "salesforce", sync_error: "Salesforce 401" })], NOW)).toEqual({ label: "Salesforce sync failed", failed: true });
    expect(crmSyncNote([row({ enabled: 0, sync_error: "off" })], NOW)).toBeNull();
  });
});
