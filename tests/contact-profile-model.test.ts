// The contact profile's wording: header pills, a campaign's state and each step's line,
// what a timeline item says, the notes' saved line, due dates and custom values. No
// browser and no database.
import { describe, expect, it } from "vitest";
import {
  campaignBadge, campaignPill, campaignSummary, careerDates, channelOptions, customValueText, dueBadge, emailBadge, emailCheckedLine, linkedinBadge, linkedinHandle, localTimeLine,
  notesByLine, notesSavedLine, replyBadge, stepLabel, stepLine, stopReason, timelineLine, verdictBadge,
  type CampaignHistory, type CampaignStep, type ContactProfile, type TimelineItem,
} from "@/components/contacts/profile/model";

const NOW = new Date("2026-10-10T12:00:00Z");
type Contact = ContactProfile["contact"];
const contact = (fields: Partial<Contact> = {}): Contact => ({
  id: "c1", full_name: "Marcus Oyelaran", first_name: "Marcus", last_name: "Oyelaran", title: "VP Revenue Ops", company: "Northwind", headline: null, summary: null, location: null, time_zone: null,
  email: "m@northwind.example", email_status: "verified", email_verified_at: "2026-10-02 09:00:00", verifying: false, phone: null, linkedin_url: "https://www.linkedin.com/in/marcusoyelaran/", sales_nav_url: null,
  linkedin_status: "connected", degree: 1, intent_score: 86, seniority: null, owner: null, tags: [], notes: null, notes_updated_at: null, notes_updated_by: null, reply: null, unsubscribed_at: null,
  apollo_enriched_at: null, profile_refreshed_at: null, last_activity_at: null, created_at: null, positions: [], ...fields,
});
const step = (fields: Partial<CampaignStep> = {}): CampaignStep => ({ id: "s", number: 2, track: "email", type: "email", subject: "Value", status: "sent", at: "2026-10-07 09:12:00", reason: null, email: null, accepted_at: null, ...fields });
const campaign = (fields: Partial<CampaignHistory> = {}): CampaignHistory => ({
  run_id: "r", workflow_id: "w", name: "Q4 Logistics Ops", run_status: "running", enrolled_at: null, state: "active", steps_total: 5, steps_sent: 2, next_number: 3, stop_reason: null,
  last_touch_at: "2026-10-07 09:12:00", replied: false, steps: [], ...fields,
});
const item = (fields: Partial<TimelineItem>): TimelineItem => ({ id: "i", at: "2026-10-07 09:12:00", channel: "email", kind: "email_sent", step: null, campaign: null, actor: null, label: null, list: null, opens: 0, clicks: 0, detail: null, activity_id: null, ...fields });

describe("the header", () => {
  it("says a reply and its verdict, or just that there was one", () => {
    expect(replyBadge(null)).toBeNull();
    expect(replyBadge({ channel: "linkedin", at: "x", verdict: "positive" })).toEqual({ tone: "good", label: "Replied · Positive" });
    expect(replyBadge({ channel: "email", at: "x", verdict: "negative" })).toEqual({ tone: "bad", label: "Replied · Not interested" });
    expect(replyBadge({ channel: "email", at: "x", verdict: "out_of_office" })).toEqual({ tone: "good", label: "Replied · Out of office" });
    expect(replyBadge({ channel: "email", at: "x", verdict: null })).toEqual({ tone: "good", label: "Replied" });
  });

  it("reads a verdict it has not met in its own words", () => {
    expect(verdictBadge("wrong_person")).toEqual({ tone: "neutral", label: "Wrong person" });
    expect(verdictBadge(null)).toBeNull();
  });

  it("names the campaign the contact is in now, and the step it is on", () => {
    expect(campaignBadge([campaign()])).toEqual({ tone: "brand", label: "In campaign · Step 3" });
    expect(campaignBadge([campaign({ state: "completed" }), campaign({ state: "paused", next_number: 1 })])).toEqual({ tone: "warn", label: "Campaign paused · Step 1" });
    expect(campaignBadge([campaign({ state: "stopped" })])).toBeNull();
    expect(campaignBadge([])).toBeNull();
  });

  it("says where the email and LinkedIn stand", () => {
    expect(emailBadge(contact())).toEqual({ tone: "mail", label: "Email verified" });
    expect(emailBadge(contact({ email: null }))).toEqual({ tone: "neutral", label: "No email" });
    expect(emailBadge(contact({ verifying: true }))).toEqual({ tone: "brand", label: "Email being verified" });
    expect(emailBadge(contact({ email_status: "catchall" })).tone).toBe("warn");
    expect(emailBadge(contact({ email_status: null })).label).toBe("Email not checked");
    expect(emailCheckedLine(contact(), NOW)).toEqual({ tone: "good", label: "Verified Oct 2" });
    expect(emailCheckedLine(contact({ email_status: null }), NOW)).toBeNull();
    expect(linkedinBadge(contact())).toEqual({ tone: "li", label: "LinkedIn · 1st degree" });
    expect(linkedinBadge(contact({ linkedin_status: "invite_sent", degree: 2 }))).toEqual({ tone: "li", label: "LinkedIn · invite sent" });
    expect(linkedinBadge(contact({ linkedin_status: "not_connected", degree: 2 }))).toEqual({ tone: "neutral", label: "LinkedIn · 2nd degree" });
    expect(linkedinBadge(contact({ linkedin_url: null })).label).toBe("No LinkedIn profile");
  });

  it("shortens a LinkedIn address to its handle", () => {
    expect(linkedinHandle("https://www.linkedin.com/in/marcusoyelaran/")).toBe("/in/marcusoyelaran");
    expect(linkedinHandle("https://www.linkedin.com/sales/lead/ACwAAA,NAME")).toBe("/sales/lead/ACwAAA,NAME");
    expect(linkedinHandle("https://example.com/someone")).toBe("example.com/someone");
  });

  it("gives the contact's local time, and nothing for a zone it cannot read", () => {
    expect(localTimeLine("Europe/Amsterdam", NOW)).toMatch(/^(GMT\+2|CEST), 2:00 PM local$/);
    expect(localTimeLine("Mars/Olympus", NOW)).toBeNull();
    expect(localTimeLine(null, NOW)).toBeNull();
  });
});

describe("notes", () => {
  it("say whether they are saved", () => {
    expect(notesSavedLine("typing", null, NOW)).toBe("Not saved yet");
    expect(notesSavedLine("saving", null, NOW)).toBe("Saving…");
    expect(notesSavedLine("failed", null, NOW)).toBe("Not saved");
    expect(notesSavedLine("idle", "2026-10-10 11:59:00", NOW)).toBe("Saved 1 min ago");
    expect(notesSavedLine("idle", null, NOW)).toBe("");
  });

  it("are signed by whoever last changed them", () => {
    expect(notesByLine({ name: "Jonas Mertens" }, "2026-10-10 09:00:00", NOW)).toBe("— Jonas Mertens, Oct 10");
    expect(notesByLine(null, "2026-10-10 09:00:00", NOW)).toBe("— Oct 10");
    expect(notesByLine(null, null, NOW)).toBeNull();
  });
});

describe("career history", () => {
  it("writes the dates it has", () => {
    expect(careerDates({ start: "2022-03-01", end: null, current: true })).toBe("Mar 2022 — Present");
    expect(careerDates({ start: "2018-06-01", end: "2022-02-01", current: false })).toBe("Jun 2018 — Feb 2022");
    expect(careerDates({ start: null, end: null, current: true })).toBe("Present");
    expect(careerDates({ start: null, end: null, current: false })).toBe("");
  });
});

describe("campaign history", () => {
  it("labels a step by its number and what it does", () => {
    expect(stepLabel(step())).toBe("Step 2 · Email — Value");
    expect(stepLabel(step({ subject: "Re: {{company}} + 4 new AE reqs" }))).toBe("Step 2 · Email — {{company}} + 4 new AE reqs");
    expect(stepLabel(step({ number: 3, type: "connect", subject: null }))).toBe("Step 3 · LinkedIn invite");
    expect(stepLabel(step({ number: 1, type: "visit", subject: null }))).toBe("Step 1 · Profile visit");
    expect(stepLabel(step({ number: 4, type: "voice_note", subject: null }))).toBe("Step 4 · Voice note");
  });

  it("says what became of a step", () => {
    expect(stepLine(step({ email: { status: "delivered", opens: 4, clicks: 2, bounced: false } }), NOW)).toBe("Delivered · opened 4× · 2 clicks");
    expect(stepLine(step({ email: { status: "accepted", opens: 0, clicks: 1, bounced: false } }), NOW)).toBe("Sent · 1 click");
    expect(stepLine(step({ email: { status: "bounced", opens: 0, clicks: 0, bounced: true } }), NOW)).toBe("Bounced");
    expect(stepLine(step({ type: "connect", accepted_at: "2026-10-04 16:21:00" }), NOW)).toBe("Accepted Oct 4");
    expect(stepLine(step({ type: "connect" }), NOW)).toBe("Sent · not accepted yet");
    expect(stepLine(step({ type: "visit" }), NOW)).toBe("Visited");
    expect(stepLine(step({ status: "next", at: null }), NOW)).toBe("Next");
    expect(stepLine(step({ status: "next", at: null, reason: "Starts when the LinkedIn steps hand this contact over" }), NOW)).toBe("Starts when the LinkedIn steps hand this contact over");
    expect(stepLine(step({ status: "upcoming", at: null }), NOW)).toBe("Not reached yet");
    expect(stepLine(step({ status: "skipped", at: null }), NOW)).toBe("Skipped");
    expect(stepLine(step({ status: "stopped", at: null, reason: "Replied on linkedin - automation stopped" }), NOW)).toBe("Stopped: reply received");
    expect(stepLine(step({ status: "stopped", at: null }), NOW)).toBe("Not sent");
    expect(stepLine(step({ status: "failed", at: null, reason: "Mailbox rejected the message" }), NOW)).toBe("Failed: Mailbox rejected the message");
  });

  it("puts the engine's reasons for stopping in plain words", () => {
    expect(stopReason("Replied on email - automation stopped")).toBe("Reply received");
    expect(stopReason("Contact unsubscribed")).toBe("Unsubscribed");
    expect(stopReason("Recipient is suppressed")).toBe("On the do-not-contact list");
    expect(stopReason("Removed from the campaign - automation stopped")).toBe("Removed from the campaign");
    expect(stopReason(null)).toBeNull();
  });

  it("sums a campaign up in a pill and a line", () => {
    expect(campaignPill(campaign())).toEqual({ tone: "brand", label: "Active · Step 3 of 5" });
    expect(campaignPill(campaign({ state: "paused" }))).toEqual({ tone: "warn", label: "Paused · Step 3 of 5" });
    expect(campaignPill(campaign({ state: "completed", next_number: null }))).toEqual({ tone: "neutral", label: "Completed · no reply" });
    expect(campaignPill(campaign({ state: "completed", next_number: null, replied: true })).label).toBe("Completed · replied");
    expect(campaignPill(campaign({ state: "stopped", next_number: null, stop_reason: "Replied on linkedin - automation stopped" }))).toEqual({ tone: "good", label: "Stopped · reply received" });
    expect(campaignPill(campaign({ state: "stopped", next_number: null }))).toEqual({ tone: "neutral", label: "Stopped" });
    expect(campaignPill(campaign({ state: "failed", next_number: null })).tone).toBe("bad");
    expect(campaignSummary(campaign(), NOW)).toBe("2 of 5 steps · last touch Oct 7");
    expect(campaignSummary(campaign({ steps_sent: 0, steps_total: 1, last_touch_at: null }), NOW)).toBe("0 of 1 step · nothing sent");
  });
});

describe("a timeline line", () => {
  it("names a campaign's step and the campaign", () => {
    expect(timelineLine(item({ step: 2, campaign: { id: "w", name: "Q4 Logistics Ops" } }))).toMatchObject({ title: "Step 2 email sent", icon: "mail", tone: "mail", badge: { tone: "brand", label: "Q4 Logistics Ops" } });
    expect(timelineLine(item({ kind: "linkedin_invite", channel: "linkedin", step: 1 })).title).toBe("Step 1 invite sent");
    expect(timelineLine(item({ kind: "linkedin_invite", channel: "linkedin" })).title).toBe("Invite sent");
    expect(timelineLine(item({ kind: "linkedin_message", channel: "linkedin", step: 4, detail: "Thanks for connecting." }))).toMatchObject({ title: "Step 4 message sent", quoted: true });
  });

  it("counts opens and clicks", () => {
    expect(timelineLine(item({ kind: "email_engaged", opens: 4, clicks: 2 })).title).toBe("Email opened 4× · 2 link clicks");
    expect(timelineLine(item({ kind: "email_engaged", opens: 1 })).title).toBe("Email opened 1×");
    expect(timelineLine(item({ kind: "email_engaged", clicks: 1 })).title).toBe("Email 1 link click");
  });

  it("says who sent a message by hand and what became of it", () => {
    expect(timelineLine(item({ kind: "linkedin_message", channel: "linkedin", actor: "Jonas Mertens", detail: "Hi" }))).toMatchObject({ title: "LinkedIn message sent by Jonas Mertens", badge: null });
    expect(timelineLine(item({ kind: "linkedin_message", channel: "linkedin", actor: "Jonas Mertens", label: "queued" }))).toMatchObject({ title: "LinkedIn message by Jonas Mertens", badge: { tone: "warn", label: "Waiting to send" } });
    expect(timelineLine(item({ kind: "linkedin_message", channel: "linkedin", label: "failed" })).badge).toEqual({ tone: "bad", label: "Not sent" });
  });

  it("quotes a reply and shows its verdict", () => {
    expect(timelineLine(item({ kind: "reply", channel: "linkedin", label: "positive", detail: "Makes sense." }))).toMatchObject({ title: "Replied on LinkedIn", tone: "li", quoted: true, badge: { tone: "good", label: "Positive" } });
    expect(timelineLine(item({ kind: "reply", channel: "email" }))).toMatchObject({ title: "Replied by email", tone: "mail", quoted: false, badge: null });
  });

  it("credits a logged activity to its author", () => {
    expect(timelineLine(item({ kind: "activity", channel: "other", label: "note", actor: "Jonas Mertens" }))).toMatchObject({ title: "Note added by Jonas Mertens", icon: "note" });
    expect(timelineLine(item({ kind: "activity", channel: "other", label: "call" }))).toMatchObject({ title: "Call logged", icon: "phone" });
    expect(timelineLine(item({ kind: "activity", channel: "other", label: "something" })).title).toBe("Activity logged");
  });

  it("names the list a contact joined or left, even one deleted since", () => {
    expect(timelineLine(item({ kind: "list_added", channel: "other", list: { id: "l", name: "Enterprise EU" } })).title).toBe("Added to list · Enterprise EU");
    expect(timelineLine(item({ kind: "list_removed", channel: "other", list: { id: "l", name: null } })).title).toBe("Removed from list · a list since deleted");
  });

  it("covers the rest", () => {
    const titles = (["email_bounced", "linkedin_visit", "linkedin_accepted", "linkedin_withdrawn", "linkedin_inmail", "meeting", "enriched", "created"] as const).map((kind) => timelineLine(item({ kind })).title);
    expect(titles).toEqual(["Email bounced", "Profile visited", "Connection accepted", "Invitation withdrawn", "InMail sent", "Meeting", "Enriched from Apollo", "Contact added"]);
  });

  it("counts each channel on its tab", () => {
    expect(channelOptions({ all: 1200, email: 2, linkedin: 5 }).map((option) => `${option.label} ${option.count}`)).toEqual(["All 1,200", "Email 2", "LinkedIn 5"]);
    expect(channelOptions(undefined).every((option) => option.count === undefined)).toBe(true);
  });
});

describe("tasks and custom fields", () => {
  it("colour a due date by how close it is", () => {
    const now = new Date(2026, 9, 10, 15, 0, 0);
    expect(dueBadge("2026-10-09", now)).toEqual({ tone: "bad", label: "Overdue · Oct 9" });
    expect(dueBadge("2026-10-10", now)).toEqual({ tone: "warn", label: "Due today" });
    expect(dueBadge("2026-11-15", now)).toEqual({ tone: "neutral", label: "Nov 15" });
    expect(dueBadge(null, now)).toBeNull();
  });

  it("write a custom value by its type", () => {
    expect(customValueText("date", "2026-11-14")).toBe("14 Nov 2026");
    expect(customValueText("number", 12500)).toBe("12,500");
    expect(customValueText("boolean", true)).toBe("Yes");
    expect(customValueText("boolean", false)).toBe("No");
    expect(customValueText("text", "SAP TM")).toBe("SAP TM");
    expect(customValueText("text", "")).toBe("—");
    expect(customValueText("number", null)).toBe("—");
    expect(customValueText("date", undefined)).toBe("—");
  });
});
